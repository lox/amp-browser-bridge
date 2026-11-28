// Stateless blind ciphertext reflector for Amp Browser Bridge.
//
// Chrome connects outbound on `GET /ext` (WebSocket) and sends `{type: "register", gate, banner}`.
// Amp plugin clients call `GET /banner` and `POST /forward` with `x-bridge-gate: <gate>`.
// The reflector hashes `SHA-256(gate)` in RAM to pair callers with Chrome's WebSocket and forwards
// opaque AES-256-GCM envelopes. It holds no disk state, no user accounts, and no encryption keys.
import type { Server, ServerWebSocket } from 'bun'
import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

export const DEFAULT_PORT = 19989
const REGISTER_TIMEOUT_MS = 10_000
const DEFAULT_FORWARD_TIMEOUT_MS = 70_000
const IDLE_TIMEOUT_S = 90
const MAX_REQ_BYTES = 256 * 1024
const MAX_WS_FRAME_BYTES = 64 * 1024
const MAX_RES_CHARS = 4 * 1024 * 1024
const MAX_CHANNEL_BUFFER_CHARS = 4 * 1024 * 1024
const MAX_GLOBAL_BUFFER_CHARS = 32 * 1024 * 1024
const MAX_PENDING_PER_CHANNEL = 4
const MAX_GLOBAL_PENDING = 128
const MAX_UNREGISTERED_SOCKETS = 64
const MAX_TOTAL_SOCKETS = 512
const MAX_SOCKETS_PER_IP = 8
const MAX_UPGRADES_PER_IP_PER_MIN = 30
const RATE_WINDOW_MS = 60_000
const MAX_RATE_ENTRIES = 4096

type Banner = { conn_id: string; b_pk: string; sig: string }
type Pending = {
  id: string
  resolve: (res: Response) => void
  timer: Timer
  chunks: string[]
  chars: number
  released: boolean
}
type Channel = {
  ws: ServerWebSocket<SocketData>
  banner: Banner
  pending: Map<string, Pending>
  bufferedChars: number
}
type SocketData = {
  ip: string
  channelId?: string
  regTimer?: Timer
  countedUnregistered?: boolean
  countedSocket?: boolean
}

export interface RelayOptions {
  port?: number
  hostname?: string
  forwardTimeoutMs?: number
  maxUnregistered?: number
  maxSocketsPerIp?: number
  maxTotalSockets?: number
  maxUpgradesPerIpPerMin?: number
  maxChannelBufferChars?: number
  maxGlobalBufferChars?: number
  trustFlyHeader?: boolean
  log?: (message: string) => void
}

const validGate = (g: unknown): g is string => typeof g === 'string' && /^[A-Za-z0-9_-]{43}$/.test(g)
const channelOf = (gate: string) => createHash('sha256').update(gate).digest('hex')

function validBanner(b: unknown): b is Banner {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  return (
    typeof o.conn_id === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(o.conn_id) &&
    typeof o.b_pk === 'string' &&
    /^[A-Za-z0-9_-]{87}$/.test(o.b_pk) &&
    typeof o.sig === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(o.sig)
  )
}

function validEnvelope(e: unknown): e is { conn_id: string; req_id: string; c_pk: string; ct: string } {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.conn_id === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(o.conn_id) &&
    typeof o.req_id === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(o.req_id) &&
    typeof o.c_pk === 'string' &&
    /^[A-Za-z0-9_-]{87}$/.test(o.c_pk) &&
    typeof o.ct === 'string' &&
    o.ct.length >= 22 &&
    o.ct.length <= MAX_REQ_BYTES
  )
}

export function startRelay(options: RelayOptions = {}) {
  const forwardTimeoutMs = options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS
  const maxUnregistered = options.maxUnregistered ?? MAX_UNREGISTERED_SOCKETS
  const maxSocketsPerIp = options.maxSocketsPerIp ?? MAX_SOCKETS_PER_IP
  const maxTotalSockets = options.maxTotalSockets ?? MAX_TOTAL_SOCKETS
  const maxUpgradesPerIpPerMin = options.maxUpgradesPerIpPerMin ?? MAX_UPGRADES_PER_IP_PER_MIN
  const maxChannelBufferChars = options.maxChannelBufferChars ?? MAX_CHANNEL_BUFFER_CHARS
  const maxGlobalBufferChars = options.maxGlobalBufferChars ?? MAX_GLOBAL_BUFFER_CHARS
  const trustFlyHeader = options.trustFlyHeader ?? Boolean(process.env.FLY_APP_NAME)
  const log = options.log ?? (() => {})

  const channels = new Map<string, Channel>()
  const socketsByIp = new Map<string, number>()
  const ipRates = new Map<string, { count: number; resetAt: number }>()
  let unregistered = 0
  let totalSockets = 0
  let globalPending = 0
  let globalBufferedChars = 0

  /** Groups IPv6 addresses by /64 subnet so a single host with a /64 block cannot rotate addresses past per-IP limits. */
  function normalizeIpKey(raw: string): string {
    const clean = raw.replace(/^::ffff:/i, '')
    const kind = isIP(clean)
    if (kind === 4) return clean
    if (kind !== 6) return 'unknown'
    const [head, tail] = clean.toLowerCase().split('::')
    const left = head ? head.split(':') : []
    const right = tail ? tail.split(':') : []
    const fill = clean.includes('::') ? Array(Math.max(0, 8 - left.length - right.length)).fill('0') : []
    const groups = [...left, ...fill, ...right].slice(0, 4).map((g) => g.padStart(4, '0'))
    return `${groups.join(':')}::/64`
  }

  function clientIp(req: Request, srv: Server<SocketData>): string {
    if (trustFlyHeader) {
      const flyIp = req.headers.get('fly-client-ip')?.trim()
      if (flyIp) return normalizeIpKey(flyIp)
    }
    return normalizeIpKey(srv.requestIP(req)?.address ?? '')
  }

  function allowUpgradeRate(ip: string): boolean {
    const now = Date.now()
    if (ipRates.size > 1024) {
      for (const [k, v] of ipRates) if (now >= v.resetAt) ipRates.delete(k)
      while (ipRates.size >= MAX_RATE_ENTRIES) {
        const oldest = ipRates.keys().next().value
        if (oldest === undefined) break
        ipRates.delete(oldest)
      }
    }
    const existing = ipRates.get(ip)
    if (!existing || now >= existing.resetAt) {
      ipRates.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
      return true
    }
    if (existing.count >= maxUpgradesPerIpPerMin) return false
    existing.count++
    return true
  }

  function releaseUnregistered(ws: ServerWebSocket<SocketData>) {
    if (!ws.data.countedUnregistered) return
    ws.data.countedUnregistered = false
    unregistered = Math.max(0, unregistered - 1)
  }

  function releaseSocket(ws: ServerWebSocket<SocketData>) {
    releaseUnregistered(ws)
    if (!ws.data.countedSocket) return
    ws.data.countedSocket = false
    totalSockets = Math.max(0, totalSockets - 1)
    const prev = socketsByIp.get(ws.data.ip) ?? 0
    if (prev <= 1) socketsByIp.delete(ws.data.ip)
    else socketsByIp.set(ws.data.ip, prev - 1)
  }

  function settlePending(slot: Channel, p: Pending, res?: Response) {
    if (p.released) return
    p.released = true
    clearTimeout(p.timer)
    slot.pending.delete(p.id)
    globalPending = Math.max(0, globalPending - 1)
    if (p.chars > 0) {
      slot.bufferedChars = Math.max(0, slot.bufferedChars - p.chars)
      globalBufferedChars = Math.max(0, globalBufferedChars - p.chars)
      p.chars = 0
      p.chunks.length = 0
    }
    if (res) p.resolve(res)
  }

  function dropPending(channel: Channel, status = 502, body: object = { dropped: true }) {
    for (const p of [...channel.pending.values()]) {
      settlePending(channel, p, Response.json(body, { status }))
    }
  }

  function forwardToBrowser(slot: Channel, signal: AbortSignal, outboundFrame: string, relayId: string): Promise<Response> {
    return new Promise<Response>((resolve) => {
      const entry: Pending = {
        id: relayId,
        resolve,
        chunks: [],
        chars: 0,
        released: false,
        timer: setTimeout(() => {
          settlePending(slot, entry, Response.json({ timeout: true }, { status: 504 }))
        }, forwardTimeoutMs),
      }
      slot.pending.set(relayId, entry)
      globalPending++
      signal.addEventListener('abort', () => settlePending(slot, entry), { once: true })
      slot.ws.send(outboundFrame)
    })
  }

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? DEFAULT_PORT,
    idleTimeout: IDLE_TIMEOUT_S,
    maxRequestBodySize: MAX_REQ_BYTES,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/healthz' && req.method === 'GET') return new Response('ok')

      if (url.pathname === '/ext') {
        // Web pages send an http(s) Origin; Chrome extensions send chrome-extension://<id>.
        const origin = req.headers.get('origin') ?? ''
        if (origin && !origin.startsWith('chrome-extension://')) {
          return new Response('forbidden', { status: 403 })
        }
        const ip = clientIp(req, server)
        if ((socketsByIp.get(ip) ?? 0) >= maxSocketsPerIp || !allowUpgradeRate(ip)) {
          return new Response('too many connections from this address', { status: 429 })
        }
        if (unregistered >= maxUnregistered || totalSockets >= maxTotalSockets) {
          return new Response('too many connections', { status: 503 })
        }
        if (!server.upgrade(req, { data: { ip, countedUnregistered: true, countedSocket: true } })) {
          return new Response('upgrade failed', { status: 400 })
        }
        unregistered++
        totalSockets++
        socketsByIp.set(ip, (socketsByIp.get(ip) ?? 0) + 1)
        return undefined
      }

      const site = req.headers.get('sec-fetch-site')
      if (site && site !== 'none' && site !== 'same-origin') return new Response('forbidden', { status: 403 })

      const gate = req.headers.get('x-bridge-gate')
      if (!validGate(gate)) return new Response('unauthorized', { status: 401 })
      const channelId = channelOf(gate)

      if (url.pathname === '/banner' && req.method === 'GET') {
        const slot = channels.get(channelId)
        if (!slot) return Response.json({ connected: false }, { status: 404 })
        return Response.json({ banner: slot.banner })
      }

      if (url.pathname === '/forward' && req.method === 'POST') {
        const declared = Number(req.headers.get('content-length') ?? 0)
        if (declared > MAX_REQ_BYTES) return new Response('payload too large', { status: 413 })
        if (globalPending >= MAX_GLOBAL_PENDING) {
          return Response.json({ error: 'reflector busy' }, { status: 503 })
        }
        const raw = await req.text()
        if (Buffer.byteLength(raw) > MAX_REQ_BYTES) return new Response('payload too large', { status: 413 })
        let env: unknown
        try {
          env = JSON.parse(raw)
        } catch {
          return new Response('bad json', { status: 400 })
        }
        if (!validEnvelope(env)) return new Response('bad envelope', { status: 400 })

        const slot = channels.get(channelId)
        if (!slot) return Response.json({ connected: false }, { status: 404 })
        // Ephemeral key rotated since the caller cached it: return the new banner before touching Chrome.
        if (env.conn_id !== slot.banner.conn_id) return Response.json({ banner: slot.banner }, { status: 409 })
        if (slot.pending.size >= MAX_PENDING_PER_CHANNEL || globalPending >= MAX_GLOBAL_PENDING) {
          return Response.json({ error: 'too many concurrent requests' }, { status: 429 })
        }

        const relayId = randomBytes(8).toString('hex')
        const outboundFrame = JSON.stringify({ type: 'req', relay_id: relayId, req_id: env.req_id, c_pk: env.c_pk, ct: env.ct })
        return forwardToBrowser(slot, req.signal, outboundFrame, relayId)
      }

      return new Response('not found', { status: 404 })
    },
    websocket: {
      maxPayloadLength: MAX_WS_FRAME_BYTES,
      open(ws) {
        ws.data.regTimer = setTimeout(() => {
          if (!ws.data.channelId) ws.close(1008, 'registration timed out')
        }, REGISTER_TIMEOUT_MS)
      },
      message(ws, raw) {
        const text = String(raw)
        if (!ws.data.channelId && text.length > 4096) return ws.close(1008, 'bad registration')
        let msg: any
        try {
          msg = JSON.parse(text)
        } catch {
          return ws.close(1003, 'bad json')
        }

        if (!ws.data.channelId) {
          if (msg?.type !== 'register' || !validGate(msg.gate) || !validBanner(msg.banner)) {
            return ws.close(1008, 'bad registration')
          }
          clearTimeout(ws.data.regTimer)
          releaseUnregistered(ws)
          const channelId = channelOf(msg.gate)
          const previous = channels.get(channelId)
          if (previous && previous.ws !== ws) {
            previous.ws.data.channelId = undefined
            dropPending(previous)
            previous.ws.close(4001, 'replaced')
          }
          ws.data.channelId = channelId
          channels.set(channelId, { ws, banner: msg.banner, pending: new Map(), bufferedChars: 0 })
          ws.send(JSON.stringify({ type: 'registered' }))
          return
        }

        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }

        if (msg?.type === 'res_part' && typeof msg.relay_id === 'string' && typeof msg.chunk === 'string') {
          const slot = channels.get(ws.data.channelId)
          const p = slot?.pending.get(msg.relay_id)
          if (!p) return
          const len = msg.chunk.length
          if (
            p.chars + len > MAX_RES_CHARS ||
            slot!.bufferedChars + len > maxChannelBufferChars ||
            globalBufferedChars + len > maxGlobalBufferChars
          ) {
            settlePending(slot!, p, Response.json({ dropped: true }, { status: 502 }))
            return
          }
          p.chars += len
          slot!.bufferedChars += len
          globalBufferedChars += len
          p.chunks.push(msg.chunk)
          return
        }

        if (msg?.type === 'res' && typeof msg.relay_id === 'string') {
          const slot = channels.get(ws.data.channelId)
          const p = slot?.pending.get(msg.relay_id)
          if (!p) return
          if (msg.error === 'unauthorized') {
            settlePending(slot!, p, new Response('unauthorized', { status: 401 }))
            return
          }
          const ct = msg.done === true ? p.chunks.join('') : msg.ct
          const res =
            typeof ct === 'string' && ct.length >= 22 && ct.length <= MAX_RES_CHARS
              ? Response.json({ ct })
              : Response.json({ dropped: true }, { status: 502 })
          settlePending(slot!, p, res)
        }
      },
      close(ws) {
        clearTimeout(ws.data.regTimer)
        releaseSocket(ws)
        const id = ws.data.channelId
        if (!id) return
        const slot = channels.get(id)
        if (slot?.ws !== ws) return
        channels.delete(id)
        dropPending(slot)
      },
    },
  })

  log(`browser bridge reflector listening on http://${server.hostname}:${server.port}`)
  return {
    server,
    stats: () => ({ totalSockets, unregistered, globalPending, globalBufferedChars }),
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const hostname = process.env.HOST ?? (process.env.FLY_APP_NAME ? '0.0.0.0' : '127.0.0.1')
  const port = Number(process.env.PORT ?? process.env.BROWSER_BRIDGE_PORT ?? DEFAULT_PORT)
  startRelay({ hostname, port, log: console.log })
}
