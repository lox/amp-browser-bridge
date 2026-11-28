import { expect, test } from 'bun:test'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import '../extension/crypto.js'
import { DEFAULT_RELAY, deriveRoot, formatKey, generateSecret, parseKey, sealRequest, verifyBanner } from '../plugin/crypto'

const Browser = (globalThis as any).BridgeCrypto

test('key formatting and parsing round-trips default and custom reflectors', () => {
  const secret = generateSecret()
  expect(Browser.generateSecret()).toHaveLength(43)

  const def = formatKey(secret)
  expect(def).toBe(`abb1_${secret}`)
  expect(Browser.formatKey(secret)).toBe(def)
  expect(parseKey(def)).toEqual({ secret, relay: DEFAULT_RELAY })
  expect(Browser.parseKey(def)).toEqual({ secret, relay: DEFAULT_RELAY })

  const custom = formatKey(secret, 'http://127.0.0.1:19989/')
  expect(custom).toBe(`abb1_${secret}@http://127.0.0.1:19989`)
  expect(parseKey(custom)).toEqual({ secret, relay: 'http://127.0.0.1:19989' })
  expect(Browser.parseKey(custom)).toEqual({ secret, relay: 'http://127.0.0.1:19989' })
  expect(parseKey(def, 'https://custom.fly.dev/sub/')).toEqual({ secret, relay: 'https://custom.fly.dev/sub' })

  for (const bad of ['', 'wrong_prefix', `abb1_${secret}@ftp://bad.example`, `abb1_${secret}@https://user:pass@bad.example`, `abb1_${secret}@https://bad.example?x=1`]) {
    expect(() => parseKey(bad)).toThrow()
    expect(() => Browser.parseKey(bad)).toThrow()
  }
})

test('plugin and extension derive matching gates, authenticate banners, and seal E2EE round-trips', async () => {
  const secret = Browser.generateSecret()
  const pluginRoot = deriveRoot(secret)
  const browserRoot = await Browser.deriveRoot(secret)
  expect(pluginRoot.gate).toBe(browserRoot.gate)
  expect(pluginRoot.gate).not.toBe(secret)

  const session = await Browser.createSession(browserRoot)
  expect(verifyBanner(pluginRoot, session.banner)).toBe(true)

  // A reflector trying to substitute its own P-256 public key cannot forge the banner HMAC.
  const attackerEcdh = createECDH('prime256v1')
  const evilPk = attackerEcdh.generateKeys().toString('base64url')
  const forgedBanner = { ...session.banner, b_pk: evilPk }
  expect(verifyBanner(pluginRoot, forgedBanner)).toBe(false)
  expect(() => sealRequest(pluginRoot, forgedBanner, { thread: 'T-1', method: 'GET', path: '/status', body: '' })).toThrow(/signature/)

  const sealed = sealRequest(pluginRoot, session.banner, {
    at: 1_000_000,
    thread: 'T-00000000-0000-0000-0000-00000000000a',
    method: 'POST',
    path: '/call',
    body: JSON.stringify({ tool: 'fill', args: { ref: 'e1', value: 'hunter2' } }),
  })
  const opened = await session.openRequest(sealed.envelope, 1_000_050)
  expect(opened).not.toBeNull()
  expect(opened.request).toEqual({
    at: 1_000_000,
    thread: 'T-00000000-0000-0000-0000-00000000000a',
    method: 'POST',
    path: '/call',
    body: JSON.stringify({ tool: 'fill', args: { ref: 'e1', value: 'hunter2' } }),
  })

  const resCt = await opened.sealResponse(200, JSON.stringify({ result: { filled: 'e1' } }))
  expect(sealed.openResponse(resCt)).toEqual({ status: 200, body: JSON.stringify({ result: { filled: 'e1' } }) })

  // Reflecting the request ciphertext back as a response fails directional AAD + distinct key.
  expect(sealed.openResponse(sealed.envelope.ct)).toBeNull()

  // Swapping a valid response from another request onto this request fails.
  const second = sealRequest(pluginRoot, session.banner, { at: 1_000_000, thread: '', method: 'GET', path: '/status', body: '' })
  const openedSecond = await session.openRequest(second.envelope, 1_000_050)
  const secondResCt = await openedSecond.sealResponse(200, '{"ok":true}')
  expect(sealed.openResponse(secondResCt)).toBeNull()

  // Large (>100 KB) payloads across 0x8000 chunk boundaries and all mod-4 padding lengths round-trip cleanly.
  for (const extra of [0, 1, 2, 3]) {
    const big = 'A'.repeat(100_000 + extra)
    const s = sealRequest(pluginRoot, session.banner, { at: 1_000_000, thread: '', method: 'POST', path: '/call', body: big })
    const o = await session.openRequest(s.envelope, 1_000_050)
    expect(o.request.body.length).toBe(big.length)
    const bigRes = await o.sealResponse(200, JSON.stringify({ data: big }))
    expect(s.openResponse(bigRes)?.body.length).toBe(big.length + 11)
  }
})

test('rejects replays, expired timestamps, and ciphertexts from an earlier ephemeral session (forward secrecy)', async () => {
  const secret = generateSecret()
  const pluginRoot = deriveRoot(secret)
  const browserRoot = await Browser.deriveRoot(secret)
  const session1 = await Browser.createSession(browserRoot)

  const req = sealRequest(pluginRoot, session1.banner, { at: 10_000_000, thread: '', method: 'GET', path: '/status', body: '' })
  expect(await session1.openRequest(req.envelope, 10_000_000)).not.toBeNull()
  // Exact replay within the time window is rejected.
  expect(await session1.openRequest(req.envelope, 10_000_100)).toBeNull()

  // Outside the 5-minute clock window is rejected on first sight.
  const stale = sealRequest(pluginRoot, session1.banner, { at: 10_000_000 - 5 * 60_000 - 1, thread: '', method: 'GET', path: '/status', body: '' })
  expect(await session1.openRequest(stale.envelope, 10_000_000)).toBeNull()

  // Wall-clock drift >30s relative to monotonic time (including an idle backward correction where wall > lastSeenWall)
  // expires the session so Chrome rotates `conn_id` instead of ever re-accepting a pruned nonce.
  const idleShifted = sealRequest(pluginRoot, session1.banner, { at: 10_120_000, thread: '', method: 'GET', path: '/status', body: '' })
  // 12 minutes of monotonic time elapsed (`+720_000`), while wall clock only advanced 2 minutes (`10_120_000`, i.e. 10m backward correction).
  expect(await session1.openRequest(idleShifted.envelope, 10_120_000, 720_000)).toEqual({ expired: true })
  expect(await session1.openRequest(idleShifted.envelope, 10_720_000, 720_000)).toEqual({ expired: true })

  // Reconnect creates a new ephemeral keypair: captured traffic from session1 cannot be opened by session2,
  // and someone who later learns `secret` still lacks both ephemeral private keys.
  const captured = sealRequest(pluginRoot, session1.banner, {
    at: 10_000_000,
    thread: 'T-00000000-0000-0000-0000-00000000000a',
    method: 'POST',
    path: '/call',
    body: '{"secret":"top-secret-otp"}',
  })
  const session2 = await Browser.createSession(browserRoot)
  expect(session2.banner.conn_id).not.toBe(session1.banner.conn_id)
  expect(session2.banner.b_pk).not.toBe(session1.banner.b_pk)
  expect(await session2.openRequest(captured.envelope, 10_000_000)).toBeNull()

  // Even knowing `secret` (so `psk` is known), guessing a fresh ECDH shared secret cannot decrypt `captured.envelope.ct`.
  const leakedRoot = deriveRoot(secret)
  const guessDh = createECDH('prime256v1')
  guessDh.generateKeys()
  const wrongShared = guessDh.computeSecret(Buffer.from(captured.envelope.c_pk, 'base64url'))
  const salt = `amp-browser-bridge-v3|req|${captured.envelope.conn_id}|${captured.envelope.req_id}|${captured.envelope.c_pk}|${session1.banner.b_pk}`
  const okm = Buffer.from(hkdfSync('sha256', Buffer.concat([wrongShared, leakedRoot.psk]), Buffer.from(salt), Buffer.from('amp-browser-bridge-v3|keys'), 88))
  const raw = Buffer.from(captured.envelope.ct, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', okm.subarray(0, 32), okm.subarray(32, 44))
  decipher.setAAD(Buffer.from(`c2b|${captured.envelope.conn_id}|${captured.envelope.req_id}`))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  expect(() => Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()])).toThrow()
})
