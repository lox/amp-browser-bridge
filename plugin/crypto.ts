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
const MAX_BANNER_BYTES = 8 * 1024
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 64 * 1024

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

/** Reads an HTTP body into a bounded buffer up to `maxBytes` without retaining per-fragment arrays. */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Reflector response exceeded ${maxBytes} bytes.`)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  let buf = Buffer.allocUnsafe(Math.min(Math.max(declared, 4096), Math.min(maxBytes, 65536)))
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const nextTotal = total + value.byteLength
      if (nextTotal > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`Reflector response exceeded ${maxBytes} bytes.`)
      }
      if (nextTotal > buf.byteLength) {
        let cap = buf.byteLength
        while (cap < nextTotal) cap = Math.min(maxBytes, cap * 2)
        const grown = Buffer.allocUnsafe(cap)
        buf.copy(grown, 0, 0, total)
        buf = grown
      }
      buf.set(value, total)
      total = nextTotal
    }
  } finally {
    reader.releaseLock()
  }
  return buf.toString('utf8', 0, total)
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
  readonly gateId: string
  requestRaw(thread: string, path: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<{ status: number; data: any }>
  request(thread: string, path: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<any>
  call(thread: string, tool: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<any>
}

/**
 * End-to-end encrypted client for one `abb1_…` setup key. Read-only requests (`/status`, handoff
 * polls) refresh a stale ephemeral banner once on HTTP 409; browser commands (`/call`) are NEVER
 * sent twice, and require an authenticated response ciphertext or report `{unknown: true}`.
 */
export function createClient(rawKey: string, relayOverride?: string): BridgeClient {
  const { secret, relay } = parseKey(rawKey, relayOverride)
  const root = deriveRoot(secret)
  const gateId = root.gate.slice(0, 12)
  let cachedBanner: Banner | null = null

  async function fetchBanner(signal?: AbortSignal): Promise<Banner | null> {
    const res = await fetch(`${relay}/banner`, { headers: { 'x-bridge-gate': root.gate }, redirect: 'manual', signal })
    if (res.status === 404) return null
    if (res.status >= 502 && res.status <= 504) {
      throw Object.assign(new Error(`The browser bridge reflector is temporarily unavailable (HTTP ${res.status}).`), { transient: true })
    }
    if (!res.ok) throw new Error(`Unexpected reflector response on /banner (HTTP ${res.status}).`)
    const text = await readBoundedText(res, MAX_BANNER_BYTES)
    const { banner } = JSON.parse(text) as { banner?: unknown }
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
    const maxAttempts = command ? 1 : 2

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
          redirect: 'manual',
          signal: init.signal,
          headers: { 'x-bridge-gate': root.gate, 'content-type': 'application/json' },
          body: JSON.stringify(sealed.envelope),
        })
        text = await readBoundedText(res, res.ok ? MAX_CIPHERTEXT_BYTES : MAX_BANNER_BYTES)
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

      if (res.status === 409) {
        let next: unknown
        try {
          next = JSON.parse(text)?.banner
        } catch {}
        if (verifyBanner(root, next)) cachedBanner = next
        else cachedBanner = null
        // A signed banner proves Chrome's new key, not that an untrusted reflector dropped our command.
        if (command) {
          return {
            status: 409,
            data: { error: 'Chrome reconnected with a new session key while sending the command; the outcome is unknown.', unknown: true },
          }
        }
        if (cachedBanner && attempt === 0) continue
        throw new Error("The reflector returned a browser key whose signature is missing or wrong. Check that BROWSER_BRIDGE_KEY matches Chrome's current setup key.")
      }

      if (!res.ok) {
        cachedBanner = null
        if (command) {
          const hint =
            res.status === 401
              ? 'Chrome or the reflector rejected this request (HTTP 401)'
              : res.status === 404 || res.status === 502
                ? 'The browser disconnected before answering'
                : `The reflector answered HTTP ${res.status} without an authenticated result`
          return { status: res.status, data: { error: `${hint}; the outcome is unknown.`, unknown: true } }
        }
        if (res.status === 404) return disconnectedReply(path)
        if (res.status === 401) {
          throw new Error("Chrome rejected this request (the setup key in Chrome may have been rotated, or one machine's clock is off). Ask the user to copy the current setup key from Chrome (Setup and status → Copy setup key) and update BROWSER_BRIDGE_KEY.")
        }
        if (res.status >= 502 && res.status <= 504) {
          throw Object.assign(new Error(`The browser bridge reflector is temporarily unavailable (HTTP ${res.status}).`), { transient: true })
        }
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
    gateId,
    requestRaw,
    request: async (thread, path, init) => (await requestRaw(thread, path, init)).data,
    call: async (thread, tool, args = {}, signal) =>
      (await requestRaw(thread, '/call', { method: 'POST', body: JSON.stringify({ tool, args }), signal })).data,
  }
}
