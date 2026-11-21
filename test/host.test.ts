import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEASE_IDLE_MS, startBridge, writePublished } from '../plugin/host'

const A = 'T-00000000-0000-0000-0000-00000000000a'
const B = 'T-00000000-0000-0000-0000-00000000000b'

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})

function bridge() {
  const dir = mkdtempSync(join(tmpdir(), 'abb-'))
  let clock = 1_000_000
  const b = startBridge({ dir, port: 0, now: () => clock })
  stops.push(b.stop)
  const base = `http://127.0.0.1:${b.server.port}`
  const api = (path: string, thread: string | null, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { 'x-bridge-token': b.token, 'content-type': 'application/json', ...(thread ? { 'x-amp-thread': thread } : {}), ...(init.headers ?? {}) } })
  const call = async (thread: string, tool: string, args: object = {}) =>
    (await api('/call', thread, { method: 'POST', body: JSON.stringify({ tool, args }) })).json()
  return { b, dir, base, api, call, advance: (ms: number) => (clock += ms), code: () => readFileSync(join(dir, 'pairing-code'), 'utf8').trim() }
}

/** A fake extension: answers commands with an echo, or holds them when `answer` is false. */
function extension(base: string, hello: object, answer = true) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: 'chrome-extension://test' } } as any)
  const messages: any[] = []
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)))
  const ready = new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      messages.push(m)
      if (m.type === 'ready') resolve()
      if (m.type === 'command' && answer) ws.send(JSON.stringify({ type: 'result', id: m.id, result: { echoed: m.tool, args: m.args } }))
    }
  })
  ws.onopen = () => ws.send(JSON.stringify(hello))
  return { ws, messages, closed, ready, send: (m: object) => ws.send(JSON.stringify(m)) }
}

const until = async (check: () => boolean, ms = 1000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await Bun.sleep(10)
}

test('rejects requests without the token or the extension origin', async () => {
  const { base, api } = bridge()
  expect((await fetch(base + '/status')).status).toBe(401)
  expect((await fetch(base + '/ext')).status).toBe(403)
  expect((await api('/call', null, { method: 'POST', body: '{}' })).status).toBe(400)
})

test('pairs once with a code, then reconnects with the key', async () => {
  const { base, api, code } = bridge()
  expect((await extension(base, { type: 'hello', code: 'WRONG-00000' }).closed)).toBe(1008)

  const first = extension(base, { type: 'hello', code: code().toLowerCase(), tab: { url: 'https://example.com/' } })
  await first.ready
  const key = first.messages.find((m) => m.type === 'paired')?.key
  expect(key).toBeString()
  expect((await (await api('/status', null)).json()).tab.url).toBe('https://example.com/')
  first.ws.close()
  await first.closed

  expect(await extension(base, { type: 'hello', code: code() }).closed).toBe(1008)
  const second = extension(base, { type: 'hello', key })
  await second.ready
  expect((await (await api('/status', null)).json()).extension_connected).toBe(true)
})

test('one thread holds the tab until it is released or goes idle', async () => {
  const { base, call, api, code, advance } = bridge()
  const ext = extension(base, { type: 'hello', code: code() })
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
  const ext = extension(base, { type: 'hello', code: code() }, false)
  await ext.ready
  const pending = call(A, 'type', { ref: 'e1', text: 'hi' })
  await until(() => ext.messages.some((m) => m.type === 'command'))
  ext.ws.close()
  expect(await pending).toMatchObject({ unknown: true })
})

test('handoff returns at once and completes when the user continues, even across a reconnect', async () => {
  const { base, call, api, code } = bridge()
  const ext = extension(base, { type: 'hello', code: code() })
  await ext.ready
  const key = ext.messages.find((m) => m.type === 'paired').key

  const started = await call(A, 'handoff', { message: 'Sign in' })
  const id = started.result.handoff_id
  await until(() => ext.messages.some((m) => m.type === 'handoff'))
  expect(ext.messages.find((m) => m.type === 'handoff')).toEqual({ type: 'handoff', id, message: 'Sign in' })
  expect((await (await api(`/handoff/${id}?wait=50`, A)).json()).result).toEqual({ waiting: true })

  // The service worker restarts: the card survives in session storage and reports on reconnect.
  ext.ws.close()
  await ext.closed
  const again = extension(base, { type: 'hello', key, handoff: id })
  await again.ready
  expect(again.messages.some((m) => m.type === 'handoff')).toBe(false)

  const poll = api(`/handoff/${id}?wait=5000`, A).then((r) => r.json())
  await Bun.sleep(50)
  again.send({ type: 'result', id, result: { continued: true } })
  expect(await poll).toEqual({ result: { continued: true } })
})

test('a thread that lost its handoff wait can ask again, and status reports the outcome', async () => {
  const { base, call, api, code, advance } = bridge()
  const ext = extension(base, { type: 'hello', code: code() })
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
  const ext = extension(base, { type: 'hello', code: code() })
  await ext.ready
  const key = ext.messages.find((m) => m.type === 'paired').key
  const id = (await call(A, 'handoff', { message: 'Approve the payment' })).result.handoff_id
  ext.ws.close()
  await ext.closed
  const again = extension(base, { type: 'hello', key })
  await again.ready
  await until(() => again.messages.some((m) => m.type === 'handoff'))
  expect(again.messages.find((m) => m.type === 'handoff')).toEqual({ type: 'handoff', id, message: 'Approve the payment' })
})

test('cancelling a handoff tells the extension and ends the wait', async () => {
  const { base, call, api, code } = bridge()
  const ext = extension(base, { type: 'hello', code: code() })
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
  const ext = extension(base, { type: 'hello', code: code() }, false)
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
  const first = extension(base, { type: 'hello', code: code() })
  await first.ready
  const key = first.messages.find((m) => m.type === 'paired').key
  first.ws.close()
  await first.closed
  const again = extension(base, { type: 'hello', key, handoff: '0123456789abcdef' })
  await again.ready
  await until(() => again.messages.some((m) => m.type === 'cancel_handoff'))
  expect(again.messages.find((m) => m.type === 'cancel_handoff')).toEqual({ type: 'cancel_handoff', id: '0123456789abcdef' })
})

test('tells the extension where the bridge is published, and when that changes', async () => {
  const { b, base, dir, api, code } = bridge()
  const ext = extension(base, { type: 'hello', code: code() })
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
