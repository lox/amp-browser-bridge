// The Amp plugin's half of the blind reflector protocol (extension/crypto.js has Chrome's half).
//
// From one 256-bit secret K (`abb1_<secret>`), HKDF derives:
// - `gate`: routing token sent to the reflector in `x-bridge-gate` (reveals nothing about K).
// - `auth`: verifies the browser's signed ephemeral P-256 public key (`banner`), blocking MITM.
// - `psk`: combined with a fresh per-request P-256 ECDH secret to derive single-use AES-256-GCM
//   request and response keys. Once the call finishes, the client's ephemeral key is discarded.
import { createCipheriv, createDecipheriv, createECDH, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export const DEFAULT_RELAY = 'https://amp-browser-bridge.fly.dev'
const ROOT_SALT = 'amp-browser-bridge-v3|root'
const BANNER_CONTEXT = 'amp-browser-bridge-v3|banner'
const REQ_CONTEXT = 'amp-browser-bridge-v3|req'
const KEYS_INFO = 'amp-browser-bridge-v3|keys'
const GCM_TAG_BYTES = 16

export type Banner = { conn_id: string; b_pk: string; sig: string }
export type RootKeys = { gate: string; auth: Buffer; psk: Buffer }
export type ParsedKey = { secret: string; relay: string }
export type RequestPlaintext = { at?: number; thread: string; method: string; path: string; body: string }
export type RequestEnvelope = { conn_id: string; req_id: string; c_pk: string; ct: string }

function same(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function normalizeRelay(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error('Reflector URL must be an http:// or https:// URL.')
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw new Error('Reflector URL must be a plain http(s) origin without credentials, query or hash.')
  }
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  return u.origin + path
}

export const generateSecret = () => randomBytes(32).toString('base64url')

export function formatKey(secret: string, relay?: string): string {
  const norm = relay ? normalizeRelay(relay) : DEFAULT_RELAY
  return norm === DEFAULT_RELAY ? `abb1_${secret}` : `abb1_${secret}@${norm}`
}

export function parseKey(raw: string, relayOverride?: string): ParsedKey {
  const m = /^abb1_([A-Za-z0-9_-]{43})(?:@(\S+))?$/.exec(raw.trim())
  if (!m) throw new Error("Expected a setup key starting with abb1_ from the Chrome extension's Setup and status page.")
  const relay = normalizeRelay(relayOverride?.trim() || m[2] || DEFAULT_RELAY)
  return { secret: m[1], relay }
}

const hkdf = (ikm: Buffer, salt: string, info: string, len: number) =>
  Buffer.from(hkdfSync('sha256', ikm, Buffer.from(salt), Buffer.from(info), len))

export function deriveRoot(secret: string): RootKeys {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid bridge secret.')
  const raw = Buffer.from(secret, 'base64url')
  if (raw.length !== 32) throw new Error('Invalid bridge secret.')
  return {
    gate: hkdf(raw, ROOT_SALT, 'gate', 32).toString('base64url'),
    auth: hkdf(raw, ROOT_SALT, 'auth', 32),
    psk: hkdf(raw, ROOT_SALT, 'psk', 32),
  }
}

export function bannerMac(auth: Buffer, connId: string, bPk: string): string {
  return createHmac('sha256', auth).update(`${BANNER_CONTEXT}|${connId}|${bPk}`).digest('base64url')
}

export function verifyBanner(root: RootKeys, banner: unknown): banner is Banner {
  if (!banner || typeof banner !== 'object') return false
  const b = banner as Record<string, unknown>
  if (typeof b.conn_id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(b.conn_id)) return false
  if (typeof b.b_pk !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(b.b_pk)) return false
  if (typeof b.sig !== 'string') return false
  return same(bannerMac(root.auth, b.conn_id, b.b_pk), b.sig)
}

function gcmEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad: string): string {
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64url')
}

function gcmDecrypt(key: Buffer, iv: Buffer, encoded: string, aad: string): Buffer | null {
  if (typeof encoded !== 'string') return null
  const raw = Buffer.from(encoded, 'base64url')
  if (raw.length < GCM_TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(raw.subarray(raw.length - GCM_TAG_BYTES))
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - GCM_TAG_BYTES)), decipher.final()])
  } catch {
    return null
  }
}

/**
 * Seals one HTTP-like request to Chrome's current ephemeral `banner`, returning the wire envelope
 * and an opener that accepts only the matching response ciphertext from that exact request.
 */
export function sealRequest(root: RootKeys, banner: Banner, req: RequestPlaintext) {
  if (!verifyBanner(root, banner)) {
    throw new Error("The reflector returned a browser key whose signature is missing or wrong. Check that BROWSER_BRIDGE_KEY matches Chrome's current setup key.")
  }
  const ecdh = createECDH('prime256v1')
  const cPkBuf = ecdh.generateKeys()
  let dh: Buffer
  try {
    dh = ecdh.computeSecret(Buffer.from(banner.b_pk, 'base64url'))
  } catch {
    throw new Error('The browser reported an invalid P-256 ephemeral key.')
  }
  const cPk = cPkBuf.toString('base64url')
  const reqId = randomBytes(16).toString('base64url')
  const salt = `${REQ_CONTEXT}|${banner.conn_id}|${reqId}|${cPk}|${banner.b_pk}`
  const okm = hkdf(Buffer.concat([dh, root.psk]), salt, KEYS_INFO, 88)
  const reqKey = okm.subarray(0, 32)
  const reqIv = okm.subarray(32, 44)
  const resKey = okm.subarray(44, 76)
  const resIv = okm.subarray(76, 88)

  const payload = Buffer.from(
    JSON.stringify({
      at: req.at ?? Date.now(),
      thread: req.thread,
      method: req.method.toUpperCase(),
      path: req.path,
      body: req.body,
    }),
  )
  const ct = gcmEncrypt(reqKey, reqIv, payload, `c2b|${banner.conn_id}|${reqId}`)
  const envelope: RequestEnvelope = { conn_id: banner.conn_id, req_id: reqId, c_pk: cPk, ct }

  function openResponse(resCt: unknown): { status: number; body: string } | null {
    if (typeof resCt !== 'string') return null
    const plain = gcmDecrypt(resKey, resIv, resCt, `b2c|${banner.conn_id}|${reqId}`)
    if (!plain) return null
    try {
      const parsed = JSON.parse(plain.toString('utf8'))
      if (!parsed || typeof parsed.status !== 'number' || typeof parsed.body !== 'string') return null
      return { status: parsed.status, body: parsed.body }
    } catch {
      return null
    }
  }

  return { envelope, openResponse }
}

export interface BridgeClient {
  readonly relay: string
  requestRaw(thread: string, path: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<{ status: number; data: any }>
  request(thread: string, path: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<any>
  call(thread: string, tool: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<any>
}

/**
 * End-to-end encrypted client for one `abb1_…` setup key. Caches Chrome's signed ephemeral P-256
 * banner in memory and refreshes it once on HTTP 409 (when Chrome reconnected and rotated its
 * ephemeral key before the reflector forwarded anything). Browser actions (`/call`) are never
 * retried once forwarded: a dropped socket or lost answer returns `{unknown: true}`.
 */
export function createClient(rawKey: string, relayOverride?: string): BridgeClient {
  const { secret, relay } = parseKey(rawKey, relayOverride)
  const root = deriveRoot(secret)
  let cachedBanner: Banner | null = null

  async function fetchBanner(signal?: AbortSignal): Promise<Banner | null> {
    const res = await fetch(`${relay}/banner`, { headers: { 'x-bridge-gate': root.gate }, signal })
    if (res.status === 404) return null
    if (res.status >= 502 && res.status <= 504) {
      throw Object.assign(new Error(`The browser bridge reflector is temporarily unavailable (HTTP ${res.status}).`), { transient: true })
    }
    if (!res.ok) throw new Error(`Unexpected reflector response on /banner (HTTP ${res.status}).`)
    const { banner } = (await res.json()) as { banner?: unknown }
    if (!verifyBanner(root, banner)) {
      throw new Error("The reflector returned a browser key whose signature is missing or wrong. Check that BROWSER_BRIDGE_KEY matches Chrome's current setup key.")
    }
    cachedBanner = banner
    return banner
  }

  function disconnectedReply(path: string): { status: number; data: any } {
    if (path === '/status') {
      return {
        status: 200,
        data: { handoff: null, extension_connected: false, tab: null, agent_tabs: { enabled: false, tabs: [] }, lease: null },
      }
    }
    return {
      status: 503,
      data: { error: 'The browser extension is not connected to the reflector. Ask the user to open Chrome.' },
    }
  }

  async function requestRaw(thread: string, path: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}): Promise<{ status: number; data: any }> {
    const command = path === '/call'
    const method = init.method ?? 'GET'
    const body = init.body ?? ''

    for (let attempt = 0; attempt < 2; attempt++) {
      let banner = cachedBanner
      if (!banner) {
        banner = await fetchBanner(init.signal)
        if (!banner) return disconnectedReply(path)
      }

      const sealed = sealRequest(root, banner, { thread, method, path, body })
      let res: Response
      let text: string
      try {
        res = await fetch(`${relay}/forward`, {
          method: 'POST',
          signal: init.signal,
          headers: { 'x-bridge-gate': root.gate, 'content-type': 'application/json' },
          body: JSON.stringify(sealed.envelope),
        })
        text = await res.text()
      } catch (error: any) {
        if (command) {
          return {
            status: 502,
            data: {
              error: `The request to the browser ${init.signal?.aborted ? 'was cancelled' : `failed (${error?.message ?? error})`}; the outcome is unknown.`,
              unknown: true,
            },
          }
        }
        throw error
      }

      // Chrome reconnected with a new ephemeral key; the reflector rejected our stale conn_id before touching Chrome.
      if (res.status === 409 && attempt === 0) {
        let next: unknown
        try {
          next = JSON.parse(text)?.banner
        } catch {}
        if (!verifyBanner(root, next)) {
          throw new Error("The reflector returned a browser key whose signature is missing or wrong. Check that BROWSER_BRIDGE_KEY matches Chrome's current setup key.")
        }
        cachedBanner = next
        continue
      }

      if (res.status === 404) {
        cachedBanner = null
        return disconnectedReply(path)
      }

      if (res.status === 401) {
        cachedBanner = null
        throw new Error("Chrome rejected this request (the setup key in Chrome may have been rotated, or one machine's clock is off). Ask the user to copy the current setup key from Chrome (Setup and status → Copy setup key) and run browser_bridge_connect.")
      }

      if (res.status >= 502 && res.status <= 504) {
        cachedBanner = null
        if (command) {
          return {
            status: res.status,
            data: {
              error:
                res.status === 502
                  ? 'The browser disconnected before answering; the outcome is unknown.'
                  : `The browser did not answer before the reflector timed out (HTTP ${res.status}); the outcome is unknown.`,
              unknown: true,
            },
          }
        }
        throw Object.assign(new Error(`The browser bridge reflector is temporarily unavailable (HTTP ${res.status}).`), { transient: true })
      }

      if (!res.ok) {
        if (command) return { status: res.status, data: { error: `The reflector answered HTTP ${res.status} without a result; the outcome is unknown.`, unknown: true } }
        throw new Error(`Unexpected reflector response (HTTP ${res.status}).`)
      }

      const opened = sealed.openResponse(text)
      if (!opened) {
        const why = "The answer could not be decrypted with this request's ephemeral key."
        if (command) return { status: 502, data: { error: `${why} The outcome is unknown.`, unknown: true } }
        throw new Error(why)
      }

      try {
        return { status: opened.status, data: JSON.parse(opened.body) }
      } catch {
        const why = 'The browser returned malformed JSON.'
        if (command) return { status: 502, data: { error: `${why} The outcome is unknown.`, unknown: true } }
        throw new Error(why)
      }
    }
    throw new Error('Could not agree an ephemeral session with Chrome. Try again.')
  }

  return {
    relay,
    requestRaw,
    request: async (thread, path, init) => (await requestRaw(thread, path, init)).data,
    call: async (thread, tool, args = {}, signal) =>
      (await requestRaw(thread, '/call', { method: 'POST', body: JSON.stringify({ tool, args }), signal })).data,
  }
}
