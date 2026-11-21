import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../extension/pairing.js'
import { EXTENSION_ID } from '../plugin/extension-id'
import { LEASE_IDLE_MS, signRequest, startBridge, verifyResponse, writePublished } from '../plugin/host'

/** The extension's half of the handshake, as background.js loads it. */
const P = (globalThis as any).BridgePairing
const ORIGIN = `chrome-extension://${EXTENSION_ID}`

const A = 'T-00000000-0000-0000-0000-00000000000a'
const B = 'T-00000000-0000-0000-0000-00000000000b'

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})

function bridge(setup?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'abb-'))
  setup?.(dir)
  let clock = 1_000_000
  const b = startBridge({ dir, port: 0, now: () => clock })
  stops.push(b.stop)
  const base = `http://127.0.0.1:${b.server.port}`
  /** A request signed as the plugin signs it; `sign` overrides what the signature covers. */
  const signed = (path: string, thread: string | null, init: RequestInit = {}, sign: { path?: string; at?: number; token?: string } = {}) => {
    const method = init.method ?? 'GET'
    const auth = signRequest(sign.token ?? b.token, { method, path: sign.path ?? path, thread: thread ?? '', body: typeof init.body === 'string' ? init.body : '', at: sign.at ?? clock })
    const headers = { 'x-bridge-auth': auth.header, 'content-type': 'application/json', ...(thread ? { 'x-amp-thread': thread } : {}), ...(init.headers ?? {}) }
    return { auth, headers, response: fetch(base + path, { ...init, headers }) }
  }
  const api = (path: string, thread: string | null, init: RequestInit = {}) => signed(path, thread, init).response
  const call = async (thread: string, tool: string, args: object = {}) =>
    (await api('/call', thread, { method: 'POST', body: JSON.stringify({ tool, args }) })).json()
  return { b, dir, base, api, signed, call, advance: (ms: number) => (clock += ms), code: () => readFileSync(join(dir, 'pairing-code'), 'utf8').trim() }
}

type Pairing = { key?: string; code?: string; tab?: object; handoff?: string }

/**
 * A fake extension that runs the handshake with extension/pairing.js, then answers commands with an
 * echo, or holds them when `answer` is false. It records what it sent and whether the bridge proved itself.
 */
function extension(base: string, pairing: Pairing, answer = true) {
  const port = Number(new URL(base).port)
  const ws = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN } } as any)
  const messages: any[] = []
  const sent: any[] = []
  const out = (m: object) => {
    sent.push(m)
    ws.send(JSON.stringify(m))
  }
  let key = pairing.key
  let bridgeProved = false
  const nonce = P.nonce()
  const exchange = pairing.code ? P.codeExchange(pairing.code) : null
  let bridgeNonce = ''
  let session: Uint8Array
  const auth = async () => out({ type: 'auth', proof: await P.keyProof(key, 'extension', port, nonce, bridgeNonce), tab: pairing.tab, handoff: pairing.handoff })
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)))
  const ready = new Promise<void>((resolve) => {
    ws.onmessage = async (e) => {
      const m = JSON.parse(String(e.data))
      messages.push(m)
      if (m.type === 'ready') resolve()
      if (m.type === 'command' && answer) ws.send(JSON.stringify({ type: 'result', id: m.id, result: { echoed: m.tool, args: m.args } }))
      if (m.type === 'challenge') {
        bridgeNonce = m.nonce
        const ex = await exchange
        if (!ex) {
          bridgeProved = P.same(await P.keyProof(key, 'bridge', port, nonce, bridgeNonce), m.proof)
          return auth()
        }
        session = await ex.session(port, nonce, bridgeNonce, m.ecdh)
        out({ type: 'pair', proof: await P.codeProof(session, 'extension') })
      }
      if (m.type === 'paired') {
        bridgeProved = P.same(await P.codeProof(session, 'bridge'), m.proof)
        key = await P.unwrapKey(session, m.wrapped)
        await auth()
      }
    }
  })
  ws.onopen = async () => {
    const ex = await exchange
    out({ type: 'hello', nonce, ...(ex ? { ecdh: ex.publicKey } : {}) })
  }
  return { ws, messages, sent, closed, ready, key: () => key!, proved: () => bridgeProved, send: (m: object) => ws.send(JSON.stringify(m)) }
}

const until = async (check: () => boolean, ms = 1000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await Bun.sleep(10)
}

test('HTTP requests need a fresh, single-use signature, and answers are signed', async () => {
  const { b, base, signed, advance } = bridge()
  expect((await fetch(base + '/status')).status).toBe(401)
  // The old bearer header is no longer accepted: the token itself never goes over the wire.
  expect((await fetch(base + '/status', { headers: { 'x-bridge-token': b.token } })).status).toBe(401)

  const ok = signed('/status', A)
  const res = await ok.response
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(verifyResponse(b.token, ok.auth.nonce, 200, text, res.headers.get('x-bridge-proof'))).toBe(true)
  // The proof covers this request's nonce and the body, so it can't vouch for another answer.
  expect(verifyResponse(b.token, signRequest(b.token, { method: 'GET', path: '/status', thread: A, body: '' }).nonce, 200, text, res.headers.get('x-bridge-proof'))).toBe(false)
  expect(verifyResponse(b.token, ok.auth.nonce, 200, text.replace('false', 'true '), res.headers.get('x-bridge-proof'))).toBe(false)

  // A captured signature works once, for the request it was made for, within five minutes.
  expect((await fetch(base + '/status', { headers: ok.headers })).status).toBe(401)
  expect((await signed('/pair', null, { method: 'POST' }, { path: '/status' }).response).status).toBe(401)
  expect((await signed('/status', A, {}, { token: 'not-the-token' }).response).status).toBe(401)
  const late = signed('/status', A, {}, { at: 1_000_000 - 5 * 60_000 - 1 })
  expect((await late.response).status).toBe(401)
  advance(5 * 60_000)
  expect((await signed('/status', A, {}, { at: 1_000_000 }).response).status).toBe(200)

  // Cross-site browser requests are refused before anything else.
  expect((await signed('/status', A, { headers: { 'sec-fetch-site': 'cross-site' } }).response).status).toBe(403)
  expect((await signed('/call', null, { method: 'POST', body: '{}' }).response).status).toBe(400)
})

test('the extension link only takes our extension, dialled on loopback', async () => {
  const { base } = bridge()
  const port = new URL(base).port
  const upgrade = (headers: Record<string, string>) => fetch(base + '/ext', { headers })
  expect((await upgrade({})).status).toBe(403)
  expect((await upgrade({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })).status).toBe(403)
  expect((await upgrade({ origin: 'https://example.com' })).status).toBe(403)
  // DNS rebinding: a page on another name that resolves to 127.0.0.1.
  expect((await upgrade({ origin: ORIGIN, host: `evil.example:${port}` })).status).toBe(403)
  // The checks pass; this plain GET is just not a WebSocket upgrade.
  expect((await upgrade({ origin: ORIGIN, host: `127.0.0.1:${port}` })).status).toBe(400)
})

test('pairs over a key agreement: neither the code nor the key crosses the connection', async () => {
  const { base, dir, api, code } = bridge()
  const pairingCode = code()
  const first = extension(base, { code: pairingCode.toLowerCase(), tab: { url: 'https://example.com/' } })
  await first.ready
  expect(first.proved()).toBe(true)
  const key = first.key()
  expect(key).toBe(readFileSync(join(dir, 'browser-key'), 'utf8').trim())
  expect((await (await api('/status', null)).json()).tab.url).toBe('https://example.com/')
  const wire = JSON.stringify([first.sent, first.messages])
  for (const secret of [key, pairingCode, pairingCode.replace('-', '')]) expect(wire).not.toContain(secret)
  // The lent tab is told only after the bridge proved itself.
  expect(first.sent.map((m) => m.type)).toEqual(['hello', 'pair', 'auth'])
  first.ws.close()
  await first.closed

  // The code worked once; the key reconnects, with the bridge proving itself first.
  expect(await extension(base, { code: pairingCode }).closed).toBe(1008)
  const second = extension(base, { key })
  await second.ready
  expect(second.proved()).toBe(true)
  expect(JSON.stringify(second.sent)).not.toContain(key)
  expect((await (await api('/status', null)).json()).extension_connected).toBe(true)
})

test('refuses a wrong key, a replayed handshake, and anything before the handshake', async () => {
  const { base, api, code } = bridge()
  const paired = extension(base, { code: code() })
  await paired.ready
  paired.ws.close()
  await paired.closed

  // A wrong key: the bridge's proof doesn't check out, and the bridge refuses the extension's.
  const wrong = extension(base, { key: P.nonce() })
  expect(await wrong.closed).toBe(1008)
  expect(wrong.proved()).toBe(false)

  // Replaying a recorded handshake fails: the bridge picks a fresh nonce every time.
  const recorded = extension(base, { key: paired.key() })
  await recorded.ready
  recorded.ws.close()
  await recorded.closed
  const [hello, auth] = recorded.sent
  const replay = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN } } as any)
  const replayClosed = new Promise<number>((resolve) => (replay.onclose = (e) => resolve(e.code)))
  replay.onopen = () => replay.send(JSON.stringify(hello))
  replay.onmessage = () => replay.send(JSON.stringify(auth))
  expect(await replayClosed).toBe(1008)

  // An old extension's hello, and a result before any handshake, are refused outright.
  for (const first of [{ type: 'hello', key: paired.key() }, { type: 'result', id: 'x', result: {} }]) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN } } as any)
    const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)))
    ws.onopen = () => ws.send(JSON.stringify(first))
    expect(await closed).toBe(1008)
  }
  expect((await (await api('/status', null)).json()).extension_connected).toBe(false)
})

test('a wrong pairing code is refused without using up the code, and five void it', async () => {
  const { base, api, code } = bridge()
  for (let i = 0; i < 4; i++) expect(await extension(base, { code: '00000-00000' }).closed).toBe(1008)
  const paired = extension(base, { code: code() })
  await paired.ready
  paired.ws.close()
  await paired.closed

  await api('/pair', null, { method: 'POST' })
  for (let i = 0; i < 5; i++) expect(await extension(base, { code: '00000-00000' }).closed).toBe(1008)
  expect(await extension(base, { code: code() }).closed).toBe(1008)
})

test('a key from before the handshake is dropped, so the browser pairs again', async () => {
  const { b, dir } = bridge((d) => writeFileSync(join(d, 'extension-key'), 'old-plain-text-key\n'))
  expect(existsSync(join(dir, 'extension-key'))).toBe(false)
  expect(b.status()).toMatchObject({ paired: false, pairing_code_active: true })
})

test('one thread holds the tab until it is released or goes idle', async () => {
  const { base, call, api, code, advance } = bridge()
  const ext = extension(base, { code: code() })
  await ext.ready

  expect((await call(A, 'click', { ref: 'e3' })).result).toEqual({ echoed: 'click', args: { ref: 'e3' } })
  const lastLease = () => ext.messages.filter((m) => m.type === 'lease').at(-1)
  expect(lastLease()).toMatchObject({ lease: { thread: A } })

  const blocked = await api('/call', B, { method: 'POST', body: JSON.stringify({ tool: 'snapshot' }) })
  expect(blocked.status).toBe(409)
  expect((await blocked.json()).error).toContain(A)

  // Just short of the idle limit A still holds it; status never takes or refreshes the lease.
  advance(LEASE_IDLE_MS - 1)
  expect((await api('/status', B)).status).toBe(200)
  expect((await api('/call', B, { method: 'POST', body: JSON.stringify({ tool: 'snapshot' }) })).status).toBe(409)
  advance(1)
  expect((await call(B, 'snapshot')).result.echoed).toBe('snapshot')

  ext.send({ type: 'release' })
  await until(() => lastLease()?.lease === null)
  expect(lastLease().lease).toBeNull()
  expect((await call(A, 'snapshot')).result.echoed).toBe('snapshot')
})

test('a disconnect mid-command reports an unknown outcome', async () => {
  const { base, call, code } = bridge()
  const ext = extension(base, { code: code() }, false)
  await ext.ready
  const pending = call(A, 'type', { ref: 'e1', text: 'hi' })
  await until(() => ext.messages.some((m) => m.type === 'command'))
  ext.ws.close()
  expect(await pending).toMatchObject({ unknown: true })
})

test('handoff returns at once and completes when the user continues, even across a reconnect', async () => {
  const { base, call, api, code } = bridge()
  const ext = extension(base, { code: code() })
  await ext.ready
  const key = ext.key()

  const started = await call(A, 'handoff', { message: 'Sign in' })
  const id = started.result.handoff_id
  await until(() => ext.messages.some((m) => m.type === 'handoff'))
  expect(ext.messages.find((m) => m.type === 'handoff')).toEqual({ type: 'handoff', id, message: 'Sign in', thread: A })
  expect((await (await api(`/handoff/${id}?wait=50`, A)).json()).result).toEqual({ waiting: true })

  // The service worker restarts: the card survives in session storage and reports on reconnect.
  ext.ws.close()
  await ext.closed
  const again = extension(base, { key, handoff: id })
  await again.ready
  expect(again.messages.some((m) => m.type === 'handoff')).toBe(false)

  const poll = api(`/handoff/${id}?wait=5000`, A).then((r) => r.json())
  await Bun.sleep(50)
  again.send({ type: 'result', id, result: { continued: true } })
  expect(await poll).toEqual({ result: { continued: true } })
})

test('a thread that lost its handoff wait can ask again, and status reports the outcome', async () => {
  const { base, call, api, code, advance } = bridge()
  const ext = extension(base, { code: code() })
  await ext.ready
  const status = async (thread: string) => (await (await api('/status', thread)).json()).handoff
  expect(await status(A)).toBeNull()

  const id = (await call(A, 'handoff', { message: 'Create the key, copy it, then Continue' })).result.handoff_id
  expect(await status(A)).toMatchObject({ state: 'waiting', message: 'Create the key, copy it, then Continue' })
  // Asking again rejoins the card already shown instead of showing a second one.
  expect((await call(A, 'handoff', { message: 'something else' })).result).toEqual({ handoff_id: id, resumed: true, message: 'Create the key, copy it, then Continue' })
  expect(ext.messages.filter((m) => m.type === 'handoff')).toHaveLength(1)
  // Another thread past the lease's idle limit still can't take over a waiting card.
  advance(LEASE_IDLE_MS + 1)
  expect((await call(B, 'handoff', { message: 'x' })).error).toContain('already waiting')
  expect(await status(B)).toBeNull()

  // The user continues while nobody is polling; the outcome stays visible after the poll window.
  ext.send({ type: 'result', id, result: { continued: true } })
  await until(() => false, 50)
  advance(60 * 60_000)
  expect(await status(A)).toMatchObject({ state: 'continued' })
  expect((await status(A)).ended).toBeString()
  // The next call is a new handoff, not a resumed one.
  expect((await call(A, 'handoff', { message: 'again' })).result.resumed).toBeUndefined()
})

test('a reconnecting extension that lost the handoff is asked to show it again', async () => {
  const { base, call, code } = bridge()
  const ext = extension(base, { code: code() })
  await ext.ready
  const key = ext.key()
  const id = (await call(A, 'handoff', { message: 'Approve the payment' })).result.handoff_id
  ext.ws.close()
  await ext.closed
  const again = extension(base, { key })
  await again.ready
  await until(() => again.messages.some((m) => m.type === 'handoff'))
  expect(again.messages.find((m) => m.type === 'handoff')).toEqual({ type: 'handoff', id, message: 'Approve the payment', thread: A })
})

test('cancelling a handoff tells the extension and ends the wait', async () => {
  const { base, call, api, code } = bridge()
  const ext = extension(base, { code: code() })
  await ext.ready
  const id = (await call(A, 'handoff', { message: 'x' })).result.handoff_id
  const poll = api(`/handoff/${id}?wait=5000`, A).then((r) => r.json())
  await api(`/handoff/${id}/cancel`, A, { method: 'POST' })
  expect((await poll).error).toContain('cancelled')
  await until(() => ext.messages.some((m) => m.type === 'cancel_handoff'))
  expect(ext.messages.find((m) => m.type === 'cancel_handoff')).toEqual({ type: 'cancel_handoff', id })
})

test('/pair rotates the code without returning it', async () => {
  const { api, code } = bridge()
  const old = code()
  const reply = await (await api('/pair', null, { method: 'POST' })).json()
  expect(JSON.stringify(reply)).not.toContain(code())
  expect(code()).not.toBe(old)
})

test('no handoff while a command is still running', async () => {
  const { base, call, code } = bridge()
  const ext = extension(base, { code: code() }, false)
  await ext.ready
  const click = call(A, 'click', { ref: 'e1' })
  await until(() => ext.messages.some((m) => m.type === 'command'))
  expect((await call(A, 'handoff', { message: 'x' })).error).toContain('running browser command')
  const id = ext.messages.find((m) => m.type === 'command').id
  ext.send({ type: 'result', id, result: { clicked: 'e1' } })
  await click
  expect((await call(A, 'handoff', { message: 'x' })).result.handoff_id).toBeString()
})

test('a card the bridge is not waiting for is cancelled on reconnect', async () => {
  const { base, code } = bridge()
  const first = extension(base, { code: code() })
  await first.ready
  const key = first.key()
  first.ws.close()
  await first.closed
  const again = extension(base, { key, handoff: '0123456789abcdef' })
  await again.ready
  await until(() => again.messages.some((m) => m.type === 'cancel_handoff'))
  expect(again.messages.find((m) => m.type === 'cancel_handoff')).toEqual({ type: 'cancel_handoff', id: '0123456789abcdef' })
})

test('tells the extension where the bridge is published, and when that changes', async () => {
  const { b, base, dir, api, code } = bridge()
  const ext = extension(base, { code: code() })
  await ext.ready
  const last = () => ext.messages.filter((m) => m.type === 'published').at(-1)
  await until(() => !!last())
  expect(last()).toEqual({ type: 'published', published: null })

  // Another Amp process on the Mac publishes; the bridge notices the file.
  const p = { url: 'https://port-19989--abc.onamp.dev', thread: A, at: '2026-11-21T00:00:00.000Z' }
  writePublished(dir, p)
  await until(() => last()?.published !== null, 3000)
  expect(last()).toEqual({ type: 'published', published: p })
  expect((await (await api('/status', null)).json()).published).toEqual(p)

  writePublished(dir, null)
  await until(() => last()?.published === null, 3000)
  expect(last()).toEqual({ type: 'published', published: null })
  expect(JSON.stringify(ext.messages)).not.toContain(b.token)
})

test("Amp's own tabs skip the lent tab's lease, and each thread sees only its own", async () => {
  const { base, call, api, code } = bridge()
  const ext = extension(base, { type: 'hello', code: code(), agent_tabs: { enabled: true, tabs: [{ tab: 7, thread: A, title: 'a', url: 'https://a.test/' }] } })
  await ext.ready
  expect((await call(A, 'snapshot')).result.echoed).toBe('snapshot')
  // B can't take the lent tab from A, but can open and use tabs of its own; the extension checks ownership.
  expect((await api('/call', B, { method: 'POST', body: JSON.stringify({ tool: 'snapshot' }) })).status).toBe(409)
  expect((await call(B, 'open_tab', { url: 'https://b.test/' })).result.echoed).toBe('open_tab')
  expect((await call(B, 'snapshot', { tab: 8 })).result.echoed).toBe('snapshot')
  expect(ext.messages.filter((m) => m.type === 'command').map((m) => m.thread)).toEqual([A, B, B])

  ext.send({ type: 'agent_tabs', enabled: true, tabs: [{ tab: 7, thread: A, title: 'a', url: 'https://a.test/' }, { tab: 8, thread: B, title: 'b', url: 'https://b.test/' }] })
  await until(() => false, 50)
  expect((await (await api('/status', B)).json()).agent_tabs).toEqual({ enabled: true, tabs: [{ tab: 8, title: 'b', url: 'https://b.test/' }] })
  // A handoff on B's own tab doesn't touch the lease either.
  expect((await call(B, 'handoff', { message: 'Sign in', tab: 8 })).result.handoff_id).toBeString()
  expect(ext.messages.find((m) => m.type === 'handoff')).toMatchObject({ thread: B, tab: 8 })
})

test("an agent-tab handoff can't skip the lease with a bad tab id, and only its thread can wait on it", async () => {
  const { base, call, api, code } = bridge()
  const ext = extension(base, { type: 'hello', code: code() })
  await ext.ready
  await call(A, 'snapshot')
  const bad = await api('/call', B, { method: 'POST', body: JSON.stringify({ tool: 'handoff', args: { message: 'x', tab: '8' } }) })
  expect(bad.status).toBe(400)
  expect(ext.messages.some((m) => m.type === 'handoff')).toBe(false)
  const id = (await call(B, 'handoff', { message: 'x', tab: 8 })).result.handoff_id
  expect((await api(`/handoff/${id}?wait=0`, A)).status).toBe(409)
  expect((await (await api(`/handoff/${id}?wait=0`, B)).json()).result).toEqual({ waiting: true })
})
