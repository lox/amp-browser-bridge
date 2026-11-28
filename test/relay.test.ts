import { afterEach, expect, test } from 'bun:test'
import '../extension/crypto.js'
import { createClient, deriveRoot, formatKey, generateSecret, sealRequest } from '../plugin/crypto'
import { startRelay } from '../relay/server'

const Browser = (globalThis as any).BridgeCrypto
const ORIGIN = 'chrome-extension://goknnphohomgekkahpdiphdfladfnmoc'
const THREAD = 'T-00000000-0000-0000-0000-00000000000a'

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})

function setupRelay(forwardTimeoutMs = 2000, extra: Record<string, unknown> = {}) {
  const r = startRelay({ port: 0, forwardTimeoutMs, ...extra })
  stops.push(r.stop)
  return { r, base: `http://127.0.0.1:${r.server.port}` }
}

async function connectFakeBrowser(
  base: string,
  secret: string,
  handler?: (req: any) => { status: number; body: string } | Promise<{ status: number; body: string }>,
  ip?: string,
) {
  const root = await Browser.deriveRoot(secret)
  const session = await Browser.createSession(root)
  const wireFrames: string[] = []
  const ws = new WebSocket(base.replace('http', 'ws') + '/ext', {
    headers: { origin: ORIGIN, ...(ip ? { 'fly-client-ip': ip } : {}) },
  } as any)
  stops.push(() => ws.close())

  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)))
  const registered = new Promise<void>((resolve, reject) => {
    ws.onmessage = async (e) => {
      const raw = String(e.data)
      wireFrames.push(raw)
      const msg = JSON.parse(raw)
      if (msg.type === 'registered') return resolve()
      if (msg.type === 'req' && handler) {
        const opened = await session.openRequest(msg)
        if (!opened) {
          ws.send(JSON.stringify({ type: 'res', relay_id: msg.relay_id, error: 'unauthorized' }))
          return
        }
        const ans = await handler(opened.request)
        const ct = await opened.sealResponse(ans.status, ans.body)
        if (ct.length <= 48_000) {
          const out = JSON.stringify({ type: 'res', relay_id: msg.relay_id, ct })
          wireFrames.push(out)
          ws.send(out)
        } else {
          for (let i = 0; i < ct.length; i += 48_000) {
            const part = JSON.stringify({ type: 'res_part', relay_id: msg.relay_id, chunk: ct.slice(i, i + 48_000) })
            wireFrames.push(part)
            ws.send(part)
          }
          const done = JSON.stringify({ type: 'res', relay_id: msg.relay_id, done: true })
          wireFrames.push(done)
          ws.send(done)
        }
      }
    }
    ws.onerror = reject
  })
  ws.onopen = () => {
    const reg = JSON.stringify({ type: 'register', gate: session.gate, banner: session.banner })
    wireFrames.push(reg)
    ws.send(reg)
  }
  await registered
  return { ws, session, closed, wireFrames }
}

test('reflector routes E2EE calls with zero plaintext or secret visibility on the wire', async () => {
  const { base } = setupRelay()
  const secret = generateSecret()
  const pluginRoot = deriveRoot(secret)
  const sensitiveUrl = 'https://synology.internal:5001/webman/index.cgi'
  const sensitivePass = 'super-secret-dsm-password'

  const browser = await connectFakeBrowser(base, secret, (req) => ({
    status: 200,
    body: JSON.stringify({ echoedPath: req.path, sawThread: req.thread, pageTitle: 'DSM Control Panel' }),
  }))

  const bannerRes = await fetch(`${base}/banner`, { headers: { 'x-bridge-gate': pluginRoot.gate } })
  expect(bannerRes.status).toBe(200)
  const { banner } = await bannerRes.json()

  const reqBody = JSON.stringify({ tool: 'fill', args: { url: sensitiveUrl, value: sensitivePass } })
  const sealed = sealRequest(pluginRoot, banner, { thread: THREAD, method: 'POST', path: '/call', body: reqBody })
  const forwardPayload = JSON.stringify(sealed.envelope)

  const res = await fetch(`${base}/forward`, {
    method: 'POST',
    headers: { 'x-bridge-gate': pluginRoot.gate, 'content-type': 'application/json' },
    body: forwardPayload,
  })
  expect(res.status).toBe(200)
  const rawRes = await res.text()
  const opened = sealed.openResponse(rawRes)
  expect(opened).toEqual({
    status: 200,
    body: JSON.stringify({ echoedPath: '/call', sawThread: THREAD, pageTitle: 'DSM Control Panel' }),
  })

  // Everything the reflector saw (HTTP bodies + WebSocket frames) contains zero secrets, URLs, thread IDs, or page titles.
  const allWire = [forwardPayload, rawRes, ...browser.wireFrames].join('\n')
  for (const forbidden of [secret, THREAD, sensitiveUrl, sensitivePass, 'DSM Control Panel', '/call', 'fill']) {
    expect(allWire).not.toContain(forbidden)
  }
})

test('blocks web origins, missing gates, offline channels, and stale banners without touching Chrome', async () => {
  const { base } = setupRelay()
  expect((await fetch(`${base}/healthz`)).status).toBe(200)
  expect((await fetch(`${base}/ext`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  expect((await fetch(`${base}/banner`)).status).toBe(401)
  expect((await fetch(`${base}/banner`, { headers: { 'x-bridge-gate': 'short' } })).status).toBe(401)

  // Oversized pre-registration WebSocket frames are closed with 1008 before JSON parsing.
  {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN } } as any)
    const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)))
    ws.onopen = () => ws.send('x'.repeat(5000))
    expect(await closed).toBe(1008)
  }

  const secret = generateSecret()
  const root = deriveRoot(secret)
  expect((await fetch(`${base}/banner`, { headers: { 'x-bridge-gate': root.gate } })).status).toBe(404)
  expect((await fetch(`${base}/banner`, { headers: { 'x-bridge-gate': root.gate, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)

  // Connect browser 1, seal against its banner, then replace with browser 2 (new ephemeral key).
  const first = await connectFakeBrowser(base, secret, () => ({ status: 200, body: '{}' }))
  const staleSealed = sealRequest(root, first.session.banner, { thread: THREAD, method: 'POST', path: '/call', body: '{"tool":"click"}' })

  let secondSawRequest = false
  const second = await connectFakeBrowser(base, secret, () => {
    secondSawRequest = true
    return { status: 200, body: '{}' }
  })
  expect(await first.closed).toBe(4001)

  // Stale conn_id gets 409 with the new banner, and the second browser never received the stale request.
  const staleRes = await fetch(`${base}/forward`, {
    method: 'POST',
    headers: { 'x-bridge-gate': root.gate, 'content-type': 'application/json' },
    body: JSON.stringify(staleSealed.envelope),
  })
  expect(staleRes.status).toBe(409)
  expect(secondSawRequest).toBe(false)
  const { banner: freshBanner } = await staleRes.json()
  expect(freshBanner).toEqual(second.session.banner)

  // A client's `/status` refreshes a stale banner on 409 and succeeds, whereas `/call` NEVER retries on 409 (reports unknown: true and caches the new banner for next time).
  const thirdSecret = generateSecret()
  let thirdCalls = 0
  const thirdA = await connectFakeBrowser(base, thirdSecret, () => {
    thirdCalls++
    return { status: 200, body: '{"result":{"ok":true}}' }
  })
  const client = createClient(formatKey(thirdSecret, base))
  expect((await client.request(THREAD, '/status')).result).toEqual({ ok: true })
  expect(thirdCalls).toBe(1)

  const thirdB = await connectFakeBrowser(base, thirdSecret, () => {
    thirdCalls++
    return { status: 200, body: '{"result":{"clicked":"e1"}}' }
  })
  await thirdA.closed
  // Cached banner still points at thirdA -> `/call` receives 409, does NOT resend to thirdB, returns unknown: true!
  const cmdOn409 = await client.call(THREAD, 'click', { ref: 'e1' })
  expect(cmdOn409.unknown).toBe(true)
  expect(thirdCalls).toBe(1)
  // Subsequent call uses the newly cached verified banner from 409 and reaches thirdB once.
  const nextCmd = await client.call(THREAD, 'click', { ref: 'e1' })
  expect(nextCmd.result).toEqual({ clicked: 'e1' })
  expect(thirdCalls).toBe(2)
  thirdB.ws.close()
})

test('disconnect mid-flight returns 502 dropped, and unresponsive browser times out with 504', async () => {
  const { base } = setupRelay(150)
  const secret = generateSecret()
  const root = deriveRoot(secret)

  // Browser receives request and never replies -> 504 timeout.
  const silent = await connectFakeBrowser(base, secret)
  const s1 = sealRequest(root, silent.session.banner, { thread: THREAD, method: 'POST', path: '/call', body: '{}' })
  const r1 = await fetch(`${base}/forward`, {
    method: 'POST',
    headers: { 'x-bridge-gate': root.gate, 'content-type': 'application/json' },
    body: JSON.stringify(s1.envelope),
  })
  expect(r1.status).toBe(504)
  silent.ws.close()
  await silent.closed

  // Browser disconnects mid-flight -> 502 dropped.
  const dropping = await connectFakeBrowser(base, secret, async () => {
    dropping.ws.close()
    await Bun.sleep(500)
    return { status: 200, body: '{}' }
  })
  const s2 = sealRequest(root, dropping.session.banner, { thread: THREAD, method: 'POST', path: '/call', body: '{}' })
  const r2 = await fetch(`${base}/forward`, {
    method: 'POST',
    headers: { 'x-bridge-gate': root.gate, 'content-type': 'application/json' },
    body: JSON.stringify(s2.envelope),
  })
  expect(r2.status).toBe(502)
  expect(await r2.json()).toEqual({ dropped: true })
})

test('fair-shares sockets across shared NATs, preempts pending hogs, and enforces exact pull-stream byte budgets', async () => {
  const { r, base } = setupRelay(2000, {
    maxUnregistered: 2,
    maxTotalSockets: 6,
    maxGlobalPending: 3,
    maxGlobalStreamBytes: 180_000,
    maxStreamQueueBytes: 250_000,
    maxResChars: 220_000,
    trustFlyHeader: true,
  })

  // Unauthenticated >64 KiB WebSocket frames are rejected at the socket layer (1009 Message Too Big).
  {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN } } as any)
    stops.push(() => ws.close())
    const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)))
    ws.onopen = () => ws.send('x'.repeat(70 * 1024))
    expect(await closed).toBe(1009)
  }

  // Unregistered connection cap evicts from the heaviest unregistered IP instead of blocking a newcomer on a fresh IP!
  const idle1 = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN, 'fly-client-ip': '203.0.113.10' } } as any)
  const idle2 = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN, 'fly-client-ip': '203.0.113.10' } } as any)
  stops.push(() => {
    idle1.close()
    idle2.close()
  })
  const idle1Closed = new Promise<number>((res) => (idle1.onclose = (e) => res(e.code)))
  await Promise.all([new Promise((res) => (idle1.onopen = res)), new Promise((res) => (idle2.onopen = res))])
  // Plain HTTP GET /ext (not a WebSocket upgrade) returns 400 WITHOUT evicting anyone.
  expect((await fetch(`${base}/ext`, { headers: { origin: ORIGIN, 'fly-client-ip': '203.0.113.99' } })).status).toBe(400)
  expect(r.stats().unregistered).toBe(2)
  // A real WebSocket from a fresh IP preempts 203.0.113.10's oldest unregistered socket (1013).
  const freshWs = await connectFakeBrowser(base, generateSecret(), undefined, '203.0.113.99')
  expect(await idle1Closed).toBe(1013)
  idle2.close()
  freshWs.ws.close()
  await Bun.sleep(30)

  // Shared-NAT users can use all available capacity (all 6 sockets on one IP succeed when idle),
  // AND when full, a new user on another IP evicts the heaviest IP's oldest socket instead of failing!
  const natBrowsers = []
  for (let i = 0; i < 6; i++) {
    natBrowsers.push(await connectFakeBrowser(base, generateSecret(), undefined, '198.51.100.7'))
  }
  expect(r.stats().totalSockets).toBe(6)
  // Another IP arrives while all 6 slots are held by 198.51.100.7 -> evicts 1 of 198.51.100.7's sockets (1013) and succeeds!
  const newcomer = await connectFakeBrowser(base, generateSecret(), () => ({ status: 200, body: '{"ok":true}' }), '198.51.100.99')
  expect(await natBrowsers[0]!.closed).toBe(1013)
  expect(r.stats().totalSockets).toBe(6)
  for (const b of natBrowsers.slice(1)) b.ws.close()
  newcomer.ws.close()
  await Bun.sleep(30)
  expect(r.stats().totalSockets).toBe(0)

  // Filling maxGlobalPending (3) from a heavy caller IP is preempted when a fresh caller IP sends /forward!
  const hogSecret = generateSecret()
  const hogRoot = deriveRoot(hogSecret)
  const hogBrowser = await connectFakeBrowser(base, hogSecret, undefined, '192.0.2.99') // never replies
  const hogReqs = [1, 2, 3].map(() => {
    const s = sealRequest(hogRoot, hogBrowser.session.banner, { thread: THREAD, method: 'POST', path: '/call', body: '{}' })
    return fetch(`${base}/forward`, {
      method: 'POST',
      headers: { 'x-bridge-gate': hogRoot.gate, 'content-type': 'application/json', 'fly-client-ip': '192.0.2.99' },
      body: JSON.stringify(s.envelope),
    })
  })
  await Bun.sleep(30)
  expect(r.stats().globalPending).toBe(3)

  // Legitimate user on another IP preempts one of 192.0.2.99's stalled waits and streams a >140 KB screenshot cleanly!
  const secret = generateSecret()
  const root = deriveRoot(secret)
  const bigImage = 'J'.repeat(140_000)
  const browser = await connectFakeBrowser(
    base,
    secret,
    () => ({
      status: 200,
      body: JSON.stringify({ result: { mime_type: 'image/jpeg', data: bigImage } }),
    }),
    '198.51.100.42',
  )
  const sealed = sealRequest(root, browser.session.banner, { thread: THREAD, method: 'POST', path: '/call', body: '{"tool":"screenshot"}' })
  const res = await fetch(`${base}/forward`, {
    method: 'POST',
    headers: { 'x-bridge-gate': root.gate, 'content-type': 'application/json', 'fly-client-ip': '198.51.100.42' },
    body: JSON.stringify(sealed.envelope),
  })
  expect(res.status).toBe(200)
  expect((await hogReqs[0]!).status).toBe(503)
  const ct = await res.text()
  const opened = sealed.openResponse(ct)
  expect(JSON.parse(opened!.body).result.data).toBe(bigImage)
  expect(browser.wireFrames.filter((f) => f.includes('"res_part"')).length).toBeGreaterThanOrEqual(4)
  expect(r.stats().activeStreams).toBe(0)
  expect(r.stats().globalStreamBytes).toBe(0)

  hogBrowser.ws.close()
  await Promise.allSettled(hogReqs)
  await Bun.sleep(30)
  expect(r.stats().globalPending).toBe(0)

  // Oversized streamed response (> maxResChars) terminates cleanly and returns globalStreamBytes to 0.
  const secret2 = generateSecret()
  const root2 = deriveRoot(secret2)
  const tooBigBrowser = await connectFakeBrowser(base, secret2, () => ({
    status: 200,
    body: JSON.stringify({ result: { data: 'Z'.repeat(240_000) } }),
  }))
  const sealedTooBig = sealRequest(root2, tooBigBrowser.session.banner, { thread: THREAD, method: 'POST', path: '/call', body: '{"tool":"screenshot"}' })
  let abortedOrInvalid = false
  try {
    const resTooBig = await fetch(`${base}/forward`, {
      method: 'POST',
      headers: { 'x-bridge-gate': root2.gate, 'content-type': 'application/json', 'fly-client-ip': '198.51.100.43' },
      body: JSON.stringify(sealedTooBig.envelope),
    })
    const textTooBig = await resTooBig.text()
    abortedOrInvalid = !resTooBig.ok || sealedTooBig.openResponse(textTooBig) === null
  } catch {
    abortedOrInvalid = true
  }
  expect(abortedOrInvalid).toBe(true)
  expect(r.stats().activeStreams).toBe(0)
  expect(r.stats().globalStreamBytes).toBe(0)
  expect(r.stats().globalPending).toBe(0)

  // Exact boundary HTTP envelope (in the final 8 bytes before 256 KiB, so WS reframing exceeds 262,144 bytes)
  // forwards cleanly under the 512 KiB WS socket limit without disconnecting the browser.
  const nearLimitSecret = generateSecret()
  const nearLimitRoot = deriveRoot(nearLimitSecret)
  const nearLimitBrowser = await connectFakeBrowser(base, nearLimitSecret, (req) => ({
    status: 200,
    body: JSON.stringify({ len: req.body.length }),
  }))
  // Measure overhead on an empty body, then pick exact plaintext size so JSON(envelope) lands in [262138, 262144].
  const probePayload = JSON.stringify(sealRequest(nearLimitRoot, nearLimitBrowser.session.banner, { thread: THREAD, method: 'POST', path: '/call', body: '' }).envelope)
  const targetCtIncrease = 262_142 - Buffer.byteLength(probePayload)
  const targetPlainIncrease = Math.floor((targetCtIncrease * 3) / 4)
  const exactBody = 'P'.repeat(targetPlainIncrease)
  const nearLimitSealed = sealRequest(nearLimitRoot, nearLimitBrowser.session.banner, {
    thread: THREAD,
    method: 'POST',
    path: '/call',
    body: exactBody,
  })
  const nearLimitPayload = JSON.stringify(nearLimitSealed.envelope)
  expect(Buffer.byteLength(nearLimitPayload)).toBeGreaterThanOrEqual(256 * 1024 - 7)
  expect(Buffer.byteLength(nearLimitPayload)).toBeLessThanOrEqual(256 * 1024)
  const nearLimitRes = await fetch(`${base}/forward`, {
    method: 'POST',
    headers: { 'x-bridge-gate': nearLimitRoot.gate, 'content-type': 'application/json', 'fly-client-ip': '198.51.100.44' },
    body: nearLimitPayload,
  })
  expect(nearLimitRes.status).toBe(200)
  expect(JSON.parse(nearLimitSealed.openResponse(await nearLimitRes.text())!.body).len).toBe(exactBody.length)
  nearLimitBrowser.ws.close()
})
