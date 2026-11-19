// The bridge: a loopback-only server on the computer that runs Chrome. The extension dials
// ws://127.0.0.1:<port>/ext; Amp threads call the HTTP API, either directly on this computer or
// from an orb through a runner portal. Every HTTP request needs the shared token, and the
// extension authenticates with a key it receives once for a one-time pairing code.
import type { Server, ServerWebSocket } from 'bun'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_PORT = 19989
/** A thread that hasn't used the tab for this long loses it to the next thread that asks. */
export const LEASE_IDLE_MS = 10 * 60_000
const COMMAND_TIMEOUT_MS = 60_000
const HANDOFF_TIMEOUT_MS = 30 * 60_000
const LONG_POLL_MAX_MS = 25_000

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

type Outcome = { result?: unknown; error?: string; unknown?: boolean }
type Handoff = { message: string; outcome?: Outcome; timer?: Timer; waiters: Set<(o: Outcome) => void> }
type Socket = ServerWebSocket<{ authed: boolean }>

function same(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function readOrCreate(file: string, create: () => string) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const value = create()
  writeFileSync(file, value + '\n', { mode: 0o600 })
  return value
}

export function tokenFile(dir: string) {
  return join(dir, 'token')
}

export function startBridge(options: BridgeOptions) {
  const { dir } = options
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const token = readOrCreate(tokenFile(dir), () => randomBytes(24).toString('hex'))
  const keyFile = join(dir, 'extension-key')
  let extensionKey = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : ''

  let pairingCode = ''
  let pairingExpires = 0
  let pairingFailures = 0
  function newPairingCode() {
    const raw = randomBytes(5).toString('hex').toUpperCase()
    pairingCode = `${raw.slice(0, 5)}-${raw.slice(5)}`
    pairingExpires = now() + 10 * 60_000
    pairingFailures = 0
    writeFileSync(join(dir, 'pairing-code'), pairingCode + '\n', { mode: 0o600 })
    return pairingCode
  }

  let extension: Socket | null = null
  let tab: unknown = null
  let lease: Lease | null = null
  const pending = new Map<string, { resolve: (o: Outcome) => void; timer: Timer }>()
  const handoffs = new Map<string, Handoff>()

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

  function command(tool: string, args: unknown): Promise<Outcome> {
    const id = randomBytes(8).toString('hex')
    if (!extension) return Promise.resolve({ error: 'The browser extension is not connected to the bridge. Ask the user to open Chrome.' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ error: `The extension did not answer within ${COMMAND_TIMEOUT_MS / 1000}s; the outcome is unknown.`, unknown: true })
      }, COMMAND_TIMEOUT_MS)
      pending.set(id, { resolve, timer })
      sendExtension({ type: 'command', id, tool, args })
    })
  }

  function finishHandoff(id: string, outcome: Outcome) {
    const h = handoffs.get(id)
    if (!h || h.outcome) return
    h.outcome = outcome
    clearTimeout(h.timer)
    for (const w of h.waiters) w(outcome)
    h.waiters.clear()
    // Keep the outcome around long enough for a client that is between polls.
    setTimeout(() => handoffs.delete(id), 5 * 60_000).unref?.()
  }

  function startHandoff(message: string) {
    if (!extension) return { error: 'The browser extension is not connected to the bridge. Ask the user to open Chrome.' }
    for (const h of handoffs.values()) if (!h.outcome) return { error: 'A handoff is already waiting for the user.' }
    // A command still running could otherwise land on the card once it appears.
    if (pending.size) return { error: 'Wait for the running browser command to finish before handing off.' }
    const id = randomBytes(8).toString('hex')
    const h: Handoff = { message, waiters: new Set() }
    handoffs.set(id, h)
    h.timer = setTimeout(() => {
      sendExtension({ type: 'cancel_handoff', id })
      finishHandoff(id, { error: 'The user did not click Continue within 30 minutes.' })
    }, HANDOFF_TIMEOUT_MS)
    h.timer.unref?.()
    sendExtension({ type: 'handoff', id, message })
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

  function status() {
    return {
      extension_connected: !!extension,
      paired: !!extensionKey,
      tab,
      lease: lease && { thread: lease.thread, since: new Date(lease.since).toISOString(), idle_seconds: Math.round((now() - lease.lastUsed) / 1000) },
      pairing_code_active: now() < pairingExpires,
    }
  }

  const server: Server<{ authed: boolean }> = Bun.serve<{ authed: boolean }>({
    hostname: '127.0.0.1',
    port: options.port ?? DEFAULT_PORT,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/ext') {
        // Only extension pages send a chrome-extension:// Origin. Local programs can forge it,
        // so the pairing key is what actually authenticates the extension.
        if (!req.headers.get('origin')?.startsWith('chrome-extension://')) return new Response('forbidden', { status: 403 })
        return server.upgrade(req, { data: { authed: false } }) ? undefined : new Response('upgrade failed', { status: 400 })
      }
      if (!same(req.headers.get('x-bridge-token') ?? '', token)) return new Response('unauthorized', { status: 401 })
      if (url.pathname === '/status' && req.method === 'GET') return Response.json(status())
      if (url.pathname === '/pair' && req.method === 'POST') {
        // The code goes only to a file on this computer, never to the caller.
        newPairingCode()
        return Response.json({ result: { pairing_code_file: join(dir, 'pairing-code'), valid_minutes: 10 } })
      }

      const handoffRoute = url.pathname.match(/^\/handoff\/([0-9a-f]{16})(\/cancel)?$/)
      if (!(url.pathname === '/call' && req.method === 'POST') && !handoffRoute) return new Response('not found', { status: 404 })
      // The lease keeps cooperating threads from interleaving; it is not a security boundary, since
      // any token holder can send any thread ID.
      const thread = req.headers.get('x-amp-thread') ?? ''
      if (!/^T-[0-9a-f-]{36}$/.test(thread)) return Response.json({ error: 'Missing or invalid x-amp-thread header.' }, { status: 400 })
      const denied = acquire(thread)
      if (denied) return Response.json({ error: denied }, { status: 409 })

      if (url.pathname === '/call') {
        const body = (await req.json().catch(() => null)) as { tool?: unknown; args?: unknown } | null
        if (!body || typeof body.tool !== 'string') return Response.json({ error: 'Expected {tool, args}.' }, { status: 400 })
        if (body.tool === 'handoff') {
          const text = (body.args as { message?: unknown } | undefined)?.message
          const message = typeof text === 'string' ? text.slice(0, 500) : 'Your turn'
          return Response.json(startHandoff(message))
        }
        return Response.json(await command(body.tool, body.args ?? {}))
      }
      const match = handoffRoute!
      if (match[2] && req.method === 'POST') {
        sendExtension({ type: 'cancel_handoff', id: match[1] })
        finishHandoff(match[1], { error: 'The handoff was cancelled.' })
        return Response.json({ result: { cancelled: true } })
      }
      if (!match[2] && req.method === 'GET') {
        return Response.json(await waitHandoff(match[1], Number(url.searchParams.get('wait') ?? 0)))
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws: Socket, raw) {
        let message: any
        try {
          message = JSON.parse(String(raw))
        } catch {
          return ws.close(1003, 'bad json')
        }
        if (!ws.data.authed) {
          if (message.type !== 'hello') return ws.close(1008, 'hello first')
          if (typeof message.key === 'string' && extensionKey && same(message.key, extensionKey)) {
            ws.data.authed = true
          } else if (typeof message.code === 'string' && now() < pairingExpires && same(message.code.trim().toUpperCase(), pairingCode)) {
            extensionKey = randomBytes(32).toString('base64url')
            writeFileSync(keyFile, extensionKey + '\n', { mode: 0o600 })
            pairingExpires = 0
            ws.data.authed = true
            ws.send(JSON.stringify({ type: 'paired', key: extensionKey }))
          } else {
            if (typeof message.code === 'string' && ++pairingFailures >= 5) pairingExpires = 0
            return ws.close(1008, 'not paired')
          }
          // 4001 tells the old connection not to reconnect, so two paired browsers don't take turns.
          if (extension && extension !== ws) extension.close(4001, 'replaced')
          extension = ws
          tab = message.tab ?? null
          ws.send(JSON.stringify({ type: 'ready' }))
          publishLease()
          // A service worker restart keeps a waiting handoff in session storage; anything else is stale.
          for (const [id, h] of handoffs) {
            if (!h.outcome && message.handoff !== id) sendExtension({ type: 'handoff', id, message: h.message })
          }
          // A card this bridge isn't waiting for (another Amp process restarted the bridge, say) would
          // otherwise block input forever.
          if (typeof message.handoff === 'string' && (!handoffs.has(message.handoff) || handoffs.get(message.handoff)!.outcome)) {
            sendExtension({ type: 'cancel_handoff', id: message.handoff })
          }
          log('extension connected')
          return
        }
        if (message.type === 'tab') tab = message.tab ?? null
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
        if (extension !== ws) return
        extension = null
        tab = null
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
  return { server, token, newPairingCode, status, stop: () => server.stop(true) }
}

// `bun plugin/host.ts` runs the bridge on its own, without Amp.
if (import.meta.main) {
  const { homedir } = await import('node:os')
  startBridge({ dir: join(homedir(), '.amp-browser-bridge'), port: Number(process.env.BROWSER_BRIDGE_PORT ?? DEFAULT_PORT), log: console.log })
}
