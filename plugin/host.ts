// The bridge: a loopback-only server on the computer that runs Chrome. The extension dials
// ws://127.0.0.1:<port>/ext; Amp threads call the HTTP API, either directly on this computer or
// from an orb through a runner portal.
//
// Another program can take the port while the bridge isn't running, so neither side ever sends a
// secret: HTTP requests carry an HMAC of the shared token (and the bridge signs its answers with
// it), and the extension and the bridge prove to each other that they hold the browser's key, which
// they agreed on once for a one-time pairing code (extension/pairing.js has the extension's half).
import type { Server, ServerWebSocket } from 'bun'
import { createECDH, createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION_IDS } from './extension-id'

export const DEFAULT_PORT = 19989
/** A thread that hasn't used the tab for this long loses it to the next thread that asks. */
export const LEASE_IDLE_MS = 10 * 60_000
const COMMAND_TIMEOUT_MS = 60_000
const HANDOFF_TIMEOUT_MS = 30 * 60_000
const LONG_POLL_MAX_MS = 25_000
/** Seconds a request may wait for its answer; Bun's default of 10 would cut off long polls and slow commands. */
const IDLE_TIMEOUT_S = COMMAND_TIMEOUT_MS / 1000 + 30
/** How far a signed request's time may be from the bridge's clock; a request is accepted only once. */
const REQUEST_WINDOW_MS = 5 * 60_000
/** An extension link that hasn't finished the handshake by then is closed. */
const HANDSHAKE_TIMEOUT_MS = 10_000
const PAIRING_CONTEXT = 'amp-browser-bridge-pairing-v2'
const HTTP_CONTEXT = 'amp-browser-bridge-http-v1'

export interface BridgeOptions {
  dir: string
  port?: number
  log?: (message: string) => void
  now?: () => number
}

export interface Lease {
  thread: string
  since: number
  lastUsed: number
}

/** Where the bridge is published to orbs: its portal URL, the thread that owns the portal, and when. */
export type Published = { url: string; thread: string; at: string }

type Outcome = { result?: unknown; error?: string; unknown?: boolean }
type Handoff = { id: string; thread: string; tab?: number; message: string; started: number; ended?: number; outcome?: Outcome; timer?: Timer; waiters: Set<(o: Outcome) => void> }
/** Where an extension link is in the handshake (see onHandshake), and what it has agreed so far. */
type Link = { phase: 'hello' | 'pair' | 'auth' | 'ready'; nonce?: string; bridgeNonce?: string; session?: Buffer; code?: string; timer?: Timer }
type Socket = ServerWebSocket<Link>

function same(a: unknown, b: string) {
  if (typeof a !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const hmac = (key: string | Buffer, message: string | Buffer) => createHmac('sha256', key).update(message).digest()
const sha256 = (text: string) => createHash('sha256').update(text).digest('base64url')
const randomNonce = () => randomBytes(32).toString('base64url')

// ---- HTTP request signing ----
// Only an HMAC of the token goes over the wire, so a program that holds the port while the bridge is
// down learns nothing it can use later. Its answers can't pass for the bridge's either.

function requestMac(token: string, at: number, nonce: string, method: string, path: string, thread: string, body: string) {
  return hmac(token, [HTTP_CONTEXT, 'request', at, nonce, method.toUpperCase(), path, thread, sha256(body)].join('|')).toString('base64url')
}

function responseMac(token: string, nonce: string, status: number, body: string) {
  return hmac(token, [HTTP_CONTEXT, 'response', nonce, status, sha256(body)].join('|')).toString('base64url')
}

/** The x-bridge-auth header for one request to the bridge, and the nonce its answer is signed with. */
export function signRequest(token: string, r: { method: string; path: string; thread: string; body: string; at?: number }) {
  const at = r.at ?? Date.now()
  const nonce = randomBytes(16).toString('base64url')
  return { header: `${at}.${nonce}.${requestMac(token, at, nonce, r.method, r.path, r.thread, r.body)}`, nonce }
}

/** Whether an answer came from a bridge that holds `token`, for the request signed with `nonce`. */
export function verifyResponse(token: string, nonce: string, status: number, body: string, proof: string | null) {
  return same(proof, responseMac(token, nonce, status, body))
}

// ---- Pairing and the extension handshake (extension/pairing.js has the other half) ----

const endpoint = (port: number) => `127.0.0.1:${port}/ext`
const keyProof = (key: string, role: 'bridge' | 'extension', port: number, extensionNonce: string, bridgeNonce: string) =>
  hmac(key, `${PAIRING_CONTEXT}|key|${role}|${endpoint(port)}|${extensionNonce}|${bridgeNonce}`).toString('base64url')
const codeProof = (session: Buffer, role: 'bridge' | 'extension') => hmac(session, `${PAIRING_CONTEXT}|code|${role}`).toString('base64url')
/** The code stretched with PBKDF2, so one proof seen by a program posing as either side can't be tried against every code in time. */
const codeMaterial = (code: string) =>
  pbkdf2Sync(code.toUpperCase().replace(/[\s-]/g, ''), `${PAIRING_CONTEXT}|code`, 100_000, 32, 'sha256')

function readOrCreate(file: string, create: () => string) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const value = create()
  writeFileSync(file, value + '\n', { mode: 0o600 })
  return value
}

export function tokenFile(dir: string) {
  return join(dir, 'token')
}

function publishedFile(dir: string) {
  return join(dir, 'published.json')
}

export function readPublished(dir: string): Published | null {
  try {
    return JSON.parse(readFileSync(publishedFile(dir), 'utf8'))
  } catch {
    return null
  }
}

function extensionIDFile(dir: string) {
  return join(dir, 'extension-id')
}

/**
 * The ID to open the extension's setup page under: the known build (store or unpacked) that last
 * reached the bridge, else the most preferred one. Opening an ID that isn't installed only shows
 * Chrome's "blocked" page, so this has to guess right.
 */
export function setupPageID(dir: string) {
  const seen = existsSync(extensionIDFile(dir)) ? readFileSync(extensionIDFile(dir), 'utf8').trim() : ''
  return EXTENSION_IDS.includes(seen) ? seen : EXTENSION_IDS[0]
}

/** Records where the bridge is published, or that it is not (null). A running bridge passes it on to the extension. */
export function writePublished(dir: string, p: Published | null) {
  if (p) writeFileSync(publishedFile(dir), JSON.stringify(p) + '\n', { mode: 0o600 })
  else rmSync(publishedFile(dir), { force: true })
}

export function startBridge(options: BridgeOptions) {
  const { dir } = options
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const token = readOrCreate(tokenFile(dir), () => randomBytes(24).toString('hex'))
  // Keys from before the handshake crossed the connection in plain text; browsers paired with one pair again.
  rmSync(join(dir, 'extension-key'), { force: true })
  const keyFile = join(dir, 'browser-key')
  let extensionKey = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : ''
  /** Nonces of signed requests still inside the time window, so none is accepted twice. */
  const seen = new Map<string, number>()
  let published = readPublished(dir)
  // Any Amp process on this computer may publish; the bridge tells the extension when it does.
  const watcher = (current: { mtimeMs: number }, previous: { mtimeMs: number }) => {
    if (current.mtimeMs === previous.mtimeMs) return
    published = readPublished(dir)
    sendExtension({ type: 'published', published })
  }
  watchFile(publishedFile(dir), { interval: 1000, persistent: false }, watcher)

  let pairingCode = ''
  let pairingMaterial = Buffer.alloc(0)
  let pairingExpires = 0
  let pairingFailures = 0
  function newPairingCode() {
    const raw = randomBytes(5).toString('hex').toUpperCase()
    pairingCode = `${raw.slice(0, 5)}-${raw.slice(5)}`
    pairingMaterial = codeMaterial(pairingCode)
    pairingExpires = now() + 10 * 60_000
    pairingFailures = 0
    writeFileSync(join(dir, 'pairing-code'), pairingCode + '\n', { mode: 0o600 })
    return pairingCode
  }

  /** Remembers which known build reached the bridge, for setupPageID. Unknown IDs are ignored, so a forged one can't redirect pairing. */
  let seenID = ''
  function noteExtension(id: string | null | undefined) {
    if (!id || id === seenID || !EXTENSION_IDS.includes(id)) return
    seenID = id
    writeFileSync(extensionIDFile(dir), id + '\n', { mode: 0o600 })
  }

  let extension: Socket | null = null
  let tab: unknown = null
  /** Tabs Amp threads opened themselves, as the extension last reported them. */
  let agentTabs: { enabled: boolean; tabs: { tab: number; thread: string; title: string; url: string }[] } = { enabled: false, tabs: [] }
  let lease: Lease | null = null
  const pending = new Map<string, { resolve: (o: Outcome) => void; timer: Timer }>()
  const handoffs = new Map<string, Handoff>()
  /** Each thread's latest handoff, kept after it ends so a thread that lost its wait can still learn the outcome. */
  const latestHandoff = new Map<string, Handoff>()

  function sendExtension(message: object) {
    extension?.send(JSON.stringify(message))
  }

  function publishLease() {
    sendExtension({ type: 'lease', lease: lease && { thread: lease.thread, since: lease.since } })
  }

  /** Gives the tab to `thread` unless another thread used it recently. */
  function acquire(thread: string): string | null {
    const t = now()
    if (lease && lease.thread !== thread && t - lease.lastUsed < LEASE_IDLE_MS) {
      return `The lent tab is in use by thread ${lease.thread}. Ask the user to release it from the extension popup, or wait until it has been idle for ${LEASE_IDLE_MS / 60_000} minutes.`
    }
    const changed = lease?.thread !== thread
    lease = changed ? { thread, since: t, lastUsed: t } : { ...lease!, lastUsed: t }
    if (changed) publishLease()
    return null
  }

  function command(thread: string, tool: string, args: unknown): Promise<Outcome> {
    const id = randomBytes(8).toString('hex')
    if (!extension) return Promise.resolve({ error: 'The browser extension is not connected to the bridge. Ask the user to open Chrome.' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ error: `The extension did not answer within ${COMMAND_TIMEOUT_MS / 1000}s; the outcome is unknown.`, unknown: true })
      }, COMMAND_TIMEOUT_MS)
      pending.set(id, { resolve, timer })
      sendExtension({ type: 'command', id, thread, tool, args })
    })
  }

  function finishHandoff(id: string, outcome: Outcome) {
    const h = handoffs.get(id)
    if (!h || h.outcome) return
    h.outcome = outcome
    h.ended = now()
    clearTimeout(h.timer)
    for (const w of h.waiters) w(outcome)
    h.waiters.clear()
    // Keep the outcome around long enough for a client that is between polls.
    setTimeout(() => handoffs.delete(id), 5 * 60_000).unref?.()
  }

  function startHandoff(thread: string, message: string, tab?: number) {
    for (const h of handoffs.values()) {
      if (h.outcome) continue
      // The thread lost its wait (a dropped tool call, say) and asks again: wait on the card already shown.
      if (h.thread === thread) return { result: { handoff_id: h.id, resumed: true, message: h.message } }
      return { error: 'A handoff is already waiting for the user.' }
    }
    if (!extension) return { error: 'The browser extension is not connected to the bridge. Ask the user to open Chrome.' }
    // A command still running could otherwise land on the card once it appears.
    if (pending.size) return { error: 'Wait for the running browser command to finish before handing off.' }
    const id = randomBytes(8).toString('hex')
    const h: Handoff = { id, thread, tab, message, started: now(), waiters: new Set() }
    handoffs.set(id, h)
    latestHandoff.set(thread, h)
    h.timer = setTimeout(() => {
      sendExtension({ type: 'cancel_handoff', id })
      finishHandoff(id, { error: 'The user did not click Continue within 30 minutes.' })
    }, HANDOFF_TIMEOUT_MS)
    h.timer.unref?.()
    sendExtension({ type: 'handoff', id, message, thread, tab })
    return { result: { handoff_id: id } }
  }

  function waitHandoff(id: string, waitMs: number): Promise<Outcome> {
    const h = handoffs.get(id)
    if (!h) return Promise.resolve({ error: 'Unknown handoff.' })
    if (h.outcome) return Promise.resolve(h.outcome)
    return new Promise((resolve) => {
      const done = (o: Outcome) => {
        clearTimeout(timer)
        resolve(o)
      }
      const timer = setTimeout(() => {
        h.waiters.delete(done)
        resolve({ result: { waiting: true } })
      }, Math.min(Math.max(waitMs, 0), LONG_POLL_MAX_MS))
      h.waiters.add(done)
    })
  }

  /** How `thread`'s latest handoff stands: waiting, continued (the user clicked Continue), or ended without it. */
  function handoffStatus(thread: string) {
    const h = latestHandoff.get(thread)
    if (!h) return null
    const state = !h.outcome ? 'waiting' : (h.outcome.result as { continued?: boolean } | undefined)?.continued ? 'continued' : 'ended'
    return {
      state,
      message: h.message,
      started: new Date(h.started).toISOString(),
      ...(h.ended ? { ended: new Date(h.ended).toISOString() } : {}),
      ...(h.outcome?.error ? { error: h.outcome.error } : {}),
    }
  }

  function status(thread = '') {
    return {
      handoff: handoffStatus(thread),
      extension_connected: !!extension,
      paired: !!extensionKey,
      tab,
      // A thread sees only the tabs it opened, and whether it may open more.
      agent_tabs: { enabled: agentTabs.enabled, tabs: agentTabs.tabs.filter((t) => t.thread === thread).map(({ thread: _, ...t }) => t) },
      lease: lease && { thread: lease.thread, since: new Date(lease.since).toISOString(), idle_seconds: Math.round((now() - lease.lastUsed) / 1000) },
      pairing_code_active: now() < pairingExpires,
      published,
    }
  }

  /** The nonce a request was signed with, when it is signed with the token, fresh, and new; null otherwise. */
  function authenticate(req: Request, path: string, thread: string, body: string) {
    const m = /^(\d{1,15})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(req.headers.get('x-bridge-auth') ?? '')
    if (!m) return null
    const at = Number(m[1])
    const t = now()
    if (Math.abs(t - at) > REQUEST_WINDOW_MS || !same(m[3], requestMac(token, at, m[2], req.method, path, thread, body))) return null
    for (const [nonce, when] of seen) if (Math.abs(t - when) > REQUEST_WINDOW_MS) seen.delete(nonce)
    if (seen.has(m[2])) return null
    seen.set(m[2], at)
    return m[2]
  }

  async function route(method: string, url: URL, thread: string, body: string): Promise<Response> {
    if (url.pathname === '/status' && method === 'GET') return Response.json(status(thread))
    if (url.pathname === '/pair' && method === 'POST') {
      // The code goes only to a file on this computer, never to the caller.
      newPairingCode()
      return Response.json({ result: { pairing_code_file: join(dir, 'pairing-code'), valid_minutes: 10 } })
    }

    const handoffRoute = url.pathname.match(/^\/handoff\/([0-9a-f]{16})(\/cancel)?$/)
    if (!(url.pathname === '/call' && method === 'POST') && !handoffRoute) return new Response('not found', { status: 404 })
    // The lease keeps cooperating threads from interleaving; it is not a security boundary, since
    // any token holder can send any thread ID.
    if (!/^T-[0-9a-f-]{36}$/.test(thread)) return Response.json({ error: 'Missing or invalid x-amp-thread header.' }, { status: 400 })

    if (url.pathname === '/call') {
      let call: { tool?: unknown; args?: { tab?: unknown; message?: unknown } } | null = null
      try {
        call = JSON.parse(body)
      } catch {}
      if (!call || typeof call.tool !== 'string') return Response.json({ error: 'Expected {tool, args}.' }, { status: 400 })
      const args = call.args ?? {}
      if (args.tab != null && !Number.isInteger(args.tab)) return Response.json({ error: 'tab must be a tab id from browser_open_tab.' }, { status: 400 })
      // The lease is for the lent tab. Amp's own tabs belong to the thread that opened them, which
      // the extension checks.
      if (call.tool !== 'open_tab' && args.tab == null) {
        const denied = acquire(thread)
        if (denied) return Response.json({ error: denied }, { status: 409 })
      }
      if (call.tool === 'handoff') {
        const message = typeof args.message === 'string' ? args.message.slice(0, 500) : 'Your turn'
        return Response.json(startHandoff(thread, message, args.tab as number | undefined))
      }
      return Response.json(await command(thread, call.tool, args))
    }
    const match = handoffRoute!
    const h = handoffs.get(match[1])
    if (h?.tab == null) {
      const denied = acquire(thread)
      if (denied) return Response.json({ error: denied }, { status: 409 })
    } else if (h.thread !== thread) return Response.json({ error: 'This handoff belongs to another thread.' }, { status: 409 })
    if (match[2] && method === 'POST') {
      sendExtension({ type: 'cancel_handoff', id: match[1] })
      finishHandoff(match[1], { error: 'The handoff was cancelled.' })
      return Response.json({ result: { cancelled: true } })
    }
    if (!match[2] && method === 'GET') {
      return Response.json(await waitHandoff(match[1], Number(url.searchParams.get('wait') ?? 0)))
    }
    return new Response('not found', { status: 404 })
  }

  const refuse = (ws: Socket, reason: string) => ws.close(1008, reason)
  const send = (ws: Socket, message: object) => void ws.send(JSON.stringify(message))

  /**
   * The extension link's handshake. Each side sends a fresh nonce; then either
   * - with a key: the bridge proves it holds the browser's key (challenge), or
   * - with a pairing code: both sides agree a session key over ECDH and the code (challenge), the
   *   extension proves it (pair), and the bridge proves it too and sends a new key masked under it (paired).
   * Then the extension proves the key (auth), and only then is it the extension. Nothing secret is
   * ever sent, and a refused attempt closes with 1008.
   */
  function onHandshake(ws: Socket, message: any) {
    const link = ws.data
    const port = server.port!
    if (link.phase === 'hello') {
      if (message.type !== 'hello' || typeof message.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.nonce)) {
        return refuse(ws, 'update the extension')
      }
      const bridgeNonce = randomNonce()
      link.nonce = message.nonce
      link.bridgeNonce = bridgeNonce
      if (message.ecdh === undefined) {
        if (!extensionKey) return refuse(ws, 'not paired')
        link.phase = 'auth'
        return send(ws, { type: 'challenge', nonce: bridgeNonce, proof: keyProof(extensionKey, 'bridge', port, message.nonce, bridgeNonce) })
      }
      if (now() >= pairingExpires) return refuse(ws, 'no pairing code')
      const ecdh = createECDH('prime256v1')
      const bridgeKey = ecdh.generateKeys().toString('base64url')
      let secret: Buffer
      try {
        secret = ecdh.computeSecret(Buffer.from(String(message.ecdh), 'base64url'))
      } catch {
        return refuse(ws, 'bad key')
      }
      const transcript = `${PAIRING_CONTEXT}|session|${endpoint(port)}|${link.nonce}|${link.bridgeNonce}|${message.ecdh}|${bridgeKey}|`
      link.session = hmac(pairingMaterial, Buffer.concat([Buffer.from(transcript), secret]))
      link.code = pairingCode
      link.phase = 'pair'
      return send(ws, { type: 'challenge', nonce: link.bridgeNonce, ecdh: bridgeKey })
    }
    if (link.phase === 'pair') {
      // The code must still be the one the session was agreed for, unexpired and not yet used.
      if (message.type !== 'pair' || link.code !== pairingCode || now() >= pairingExpires || !same(message.proof, codeProof(link.session!, 'extension'))) {
        if (++pairingFailures >= 5) pairingExpires = 0
        return refuse(ws, 'wrong pairing code')
      }
      const key = randomBytes(32)
      extensionKey = key.toString('base64url')
      writeFileSync(keyFile, extensionKey + '\n', { mode: 0o600 })
      pairingExpires = 0
      link.phase = 'auth'
      const mask = hmac(link.session!, `${PAIRING_CONTEXT}|wrap`)
      const wrapped = Buffer.from(key.map((byte, i) => byte ^ mask[i]!)).toString('base64url')
      return send(ws, { type: 'paired', proof: codeProof(link.session!, 'bridge'), wrapped })
    }
    if (message.type !== 'auth' || !extensionKey || !same(message.proof, keyProof(extensionKey, 'extension', port, link.nonce!, link.bridgeNonce!))) {
      return refuse(ws, 'not paired')
    }
    link.phase = 'ready'
    clearTimeout(link.timer)
    onAuthenticated(ws, message)
  }

  function onAuthenticated(ws: Socket, message: any) {
    // 4001 tells the old connection not to reconnect, so two paired browsers don't take turns.
    if (extension && extension !== ws) extension.close(4001, 'replaced')
    extension = ws
    tab = message.tab ?? null
    if (message.agent_tabs) agentTabs = message.agent_tabs
    ws.send(JSON.stringify({ type: 'ready' }))
    sendExtension({ type: 'published', published })
    publishLease()
    // A service worker restart keeps a waiting handoff in session storage; anything else is stale.
    for (const [id, h] of handoffs) {
      if (!h.outcome && message.handoff !== id) sendExtension({ type: 'handoff', id, message: h.message, thread: h.thread, tab: h.tab })
    }
    // A card this bridge isn't waiting for (another Amp process restarted the bridge, say) would
    // otherwise block input forever.
    if (typeof message.handoff === 'string' && (!handoffs.has(message.handoff) || handoffs.get(message.handoff)!.outcome)) {
      sendExtension({ type: 'cancel_handoff', id: message.handoff })
    }
    log('extension connected')
  }

  const server: Server<Link> = Bun.serve<Link>({
    hostname: '127.0.0.1',
    port: options.port ?? DEFAULT_PORT,
    idleTimeout: IDLE_TIMEOUT_S,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/ext') {
        // Chrome sends the extension's own Origin, and the Host it dialled. Any local program can
        // send both, so the handshake is what authenticates; these turn away web pages, other
        // extensions and DNS rebinding before it starts. Either known build (store or unpacked) may connect.
        const host = req.headers.get('host')
        const origin = req.headers.get('origin') ?? ''
        const id = origin.startsWith('chrome-extension://') ? origin.slice('chrome-extension://'.length) : ''
        if (!EXTENSION_IDS.includes(id) || (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`)) {
          return new Response('forbidden', { status: 403 })
        }
        noteExtension(id)
        return server.upgrade(req, { data: { phase: 'hello' } }) ? undefined : new Response('upgrade failed', { status: 400 })
      }
      // An unpaired extension never opens /ext; it probes /status, and Chrome sends no Origin there.
      if (url.pathname === '/status') noteExtension(req.headers.get('x-extension-id'))
      // Web pages can't sign requests, but there is no reason to let one try. Requests through a
      // portal keep the portal's Host, so the Host can't be checked here.
      const site = req.headers.get('sec-fetch-site')
      if (site && site !== 'none' && site !== 'same-origin') return new Response('forbidden', { status: 403 })
      const body = await req.text()
      const path = url.pathname + url.search
      const thread = req.headers.get('x-amp-thread') ?? ''
      const nonce = authenticate(req, path, thread, body)
      if (!nonce) return new Response('unauthorized', { status: 401 })
      const res = await route(req.method, url, thread, body)
      const text = await res.text()
      const headers = { 'content-type': res.headers.get('content-type') ?? 'text/plain', 'x-bridge-proof': responseMac(token, nonce, res.status, text) }
      return new Response(text, { status: res.status, headers })
    },
    websocket: {
      open(ws: Socket) {
        ws.data.timer = setTimeout(() => ws.data.phase !== 'ready' && ws.close(1008, 'handshake timed out'), HANDSHAKE_TIMEOUT_MS)
      },
      message(ws: Socket, raw) {
        let message: any
        try {
          message = JSON.parse(String(raw))
        } catch {
          return ws.close(1003, 'bad json')
        }
        if (ws.data.phase !== 'ready') return onHandshake(ws, message)
        if (message.type === 'tab') tab = message.tab ?? null
        if (message.type === 'agent_tabs') agentTabs = { enabled: !!message.enabled, tabs: message.tabs ?? [] }
        if (message.type === 'release') {
          lease = null
          publishLease()
        }
        if (message.type === 'result') {
          const outcome: Outcome = message.error ? { error: message.error, unknown: !!message.unknown } : { result: message.result }
          if (handoffs.has(message.id)) return finishHandoff(message.id, outcome)
          const p = pending.get(message.id)
          if (!p) return
          pending.delete(message.id)
          clearTimeout(p.timer)
          p.resolve(outcome)
        }
      },
      close(ws: Socket) {
        clearTimeout(ws.data.timer)
        if (extension !== ws) return
        extension = null
        tab = null
        agentTabs = { enabled: false, tabs: [] }
        for (const [id, p] of pending) {
          clearTimeout(p.timer)
          p.resolve({ error: 'The extension disconnected before answering; the outcome is unknown.', unknown: true })
          pending.delete(id)
        }
        // Handoffs survive a disconnect: the card stays on the page and reports back on reconnect.
        log('extension disconnected')
      },
    },
  })

  if (!extensionKey) newPairingCode()
  log(`browser bridge listening on http://127.0.0.1:${server.port}`)
  const stop = () => {
    unwatchFile(publishedFile(dir), watcher)
    server.stop(true)
  }
  return { server, token, newPairingCode, status, stop }
}

// `bun plugin/host.ts` runs the bridge on its own, without Amp.
if (import.meta.main) {
  const { homedir } = await import('node:os')
  startBridge({ dir: join(homedir(), '.amp-browser-bridge'), port: Number(process.env.BROWSER_BRIDGE_PORT ?? DEFAULT_PORT), log: console.log })
}
