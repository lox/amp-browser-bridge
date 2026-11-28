import { afterEach, expect, test } from 'bun:test'
import '../extension/crypto.js'
import { deriveRoot, generateSecret, sealRequest } from '../plugin/crypto'
import { startRelay } from '../relay/server'

const Browser = (globalThis as any).BridgeCrypto
const ORIGIN = 'chrome-extension://goknnphohomgekkahpdiphdfladfnmoc'
const THREAD = 'T-00000000-0000-0000-0000-00000000000a'

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})

function setupRelay(forwardTimeoutMs = 2000) {
  const r = startRelay({ port: 0, forwardTimeoutMs })
  stops.push(r.stop)
  return { r, base: `http://127.0.0.1:${r.server.port}` }
}

async function connectFakeBrowser(base: string, secret: string, handler?: (req: any) => { status: number; body: string } | Promise<{ status: number; body: string }>) {
  const root = await Browser.deriveRoot(secret)
  const session = await Browser.createSession(root)
  const wireFrames: string[] = []
  const ws = new WebSocket(base.replace('http', 'ws') + '/ext', { headers: { origin: ORIGIN } } as any)
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
        const out = JSON.stringify({ type: 'res', relay_id: msg.relay_id, ct })
        wireFrames.push(out)
        ws.send(out)
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
  const { ct } = JSON.parse(rawRes)
  const opened = sealed.openResponse(ct)
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
