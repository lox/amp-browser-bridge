// Stateless blind ciphertext reflector for Amp Browser Bridge.
//
// Chrome connects outbound on `GET /ext` (WebSocket) and sends `{type: "register", gate, banner}`.
// Amp plugin clients call `GET /banner` and `POST /forward` with `x-bridge-gate: <gate>`.
// The reflector hashes `SHA-256(gate)` in RAM to pair callers with Chrome's WebSocket and streams
// opaque AES-256-GCM ciphertexts through without retaining multi-frame buffers on the server.
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
const STREAM_HIGH_WATER_BYTES = 256 * 1024
const MAX_PENDING_PER_CHANNEL = 4
const MAX_PENDING_PER_IP = 128
const MAX_STREAMS_PER_IP = 32
const MAX_GLOBAL_PENDING = 2048
const MAX_UNREGISTERED_SOCKETS = 128
const MAX_TOTAL_SOCKETS = 2048
const MAX_SOCKETS_PER_IP = 64
const MAX_UPGRADES_PER_IP_PER_MIN = 120
const RATE_WINDOW_MS = 60_000
const MAX_RATE_ENTRIES = 4096

const encoder = new TextEncoder()

type Banner = { conn_id: string; b_pk: string; sig: string }
type Pending = {
  id: string
  callerIp: string
  browserIp: string
  resolve: (res: Response) => void
  timer: Timer
  totalChars: number
  streamCtrl?: ReadableStreamDefaultController<Uint8Array>
  streaming: boolean
  released: boolean
}
type Channel = {
  ws: ServerWebSocket<SocketData>
  banner: Banner
  pending: Map<string, Pending>
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
  maxPendingPerIp?: number
  maxStreamsPerIp?: number
  maxResChars?: number
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

function incCounter(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function decCounter(map: Map<string, number>, key: string) {
  const prev = map.get(key) ?? 0
  if (prev <= 1) map.delete(key)
  else map.set(key, prev - 1)
}

export function startRelay(options: RelayOptions = {}) {
  const forwardTimeoutMs = options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS
  const maxUnregistered = options.maxUnregistered ?? MAX_UNREGISTERED_SOCKETS
  const maxSocketsPerIp = options.maxSocketsPerIp ?? MAX_SOCKETS_PER_IP
  const maxTotalSockets = options.maxTotalSockets ?? MAX_TOTAL_SOCKETS
  const maxUpgradesPerIpPerMin = options.maxUpgradesPerIpPerMin ?? MAX_UPGRADES_PER_IP_PER_MIN
  const maxPendingPerIp = options.maxPendingPerIp ?? MAX_PENDING_PER_IP
  const maxStreamsPerIp = options.maxStreamsPerIp ?? MAX_STREAMS_PER_IP
  const maxResChars = options.maxResChars ?? MAX_RES_CHARS
  const trustFlyHeader = options.trustFlyHeader ?? Boolean(process.env.FLY_APP_NAME)
  const log = options.log ?? (() => {})

  const channels = new Map<string, Channel>()
  const socketsByIp = new Map<string, number>()
  const pendingByCallerIp = new Map<string, number>()
  const pendingByBrowserIp = new Map<string, number>()
  const streamsByBrowserIp = new Map<string, number>()
  const ipRates = new Map<string, { count: number; resetAt: number }>()
  let unregistered = 0
  let totalSockets = 0
  let globalPending = 0
  let activeStreams = 0

  /** Groups IPv6 addresses by /64 subnet so a single host with a /64 block cannot rotate addresses past per-source limits. */
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
    decCounter(socketsByIp, ws.data.ip)
  }

  function settlePending(slot: Channel, p: Pending, action?: { response?: Response; closeStream?: boolean; abortStream?: string }) {
    if (p.released) return
    p.released = true
    clearTimeout(p.timer)
    slot.pending.delete(p.id)
    globalPending = Math.max(0, globalPending - 1)
    decCounter(pendingByCallerIp, p.callerIp)
    decCounter(pendingByBrowserIp, p.browserIp)
    if (p.streaming) {
      p.streaming = false
      activeStreams = Math.max(0, activeStreams - 1)
      decCounter(streamsByBrowserIp, p.browserIp)
    }
    if (p.streamCtrl) {
      const ctrl = p.streamCtrl
      p.streamCtrl = undefined
      try {
        ctrl.close()
      } catch {}
      return
    }
    if (action?.response) p.resolve(action.response)
  }

  function dropPending(channel: Channel, status = 502, body: object = { dropped: true }) {
    for (const p of [...channel.pending.values()]) {
      settlePending(channel, p, { response: Response.json(body, { status }), abortStream: 'browser disconnected' })
    }
  }

  function forwardToBrowser(slot: Channel, callerIp: string, signal: AbortSignal, outboundFrame: string, relayId: string): Promise<Response> {
    const browserIp = slot.ws.data.ip
    return new Promise<Response>((resolve) => {
      const entry: Pending = {
        id: relayId,
        callerIp,
        browserIp,
        resolve,
        totalChars: 0,
        streaming: false,
        released: false,
        timer: setTimeout(() => {
          settlePending(slot, entry, { response: Response.json({ timeout: true }, { status: 504 }), abortStream: 'forward timed out' })
        }, forwardTimeoutMs),
      }
      slot.pending.set(relayId, entry)
      globalPending++
      incCounter(pendingByCallerIp, callerIp)
      incCounter(pendingByBrowserIp, browserIp)
      signal.addEventListener('abort', () => settlePending(slot, entry, { abortStream: 'client aborted' }), { once: true })
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
        incCounter(socketsByIp, ip)
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
        const callerIp = clientIp(req, server)
        if ((pendingByCallerIp.get(callerIp) ?? 0) >= maxPendingPerIp) {
          return Response.json({ error: 'too many concurrent requests from this address' }, { status: 429 })
        }
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
        const browserIp = slot.ws.data.ip
        if (
          slot.pending.size >= MAX_PENDING_PER_CHANNEL ||
          (pendingByCallerIp.get(callerIp) ?? 0) >= maxPendingPerIp ||
          (pendingByBrowserIp.get(browserIp) ?? 0) >= maxPendingPerIp
        ) {
          return Response.json({ error: 'too many concurrent requests' }, { status: 429 })
        }
        if (globalPending >= MAX_GLOBAL_PENDING) {
          return Response.json({ error: 'reflector busy' }, { status: 503 })
        }

        const relayId = randomBytes(8).toString('hex')
        const outboundFrame = JSON.stringify({ type: 'req', relay_id: relayId, req_id: env.req_id, c_pk: env.c_pk, ct: env.ct })
        return forwardToBrowser(slot, callerIp, req.signal, outboundFrame, relayId)
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
          channels.set(channelId, { ws, banner: msg.banner, pending: new Map() })
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
          if (!p || !msg.chunk.length) return
          if (p.totalChars + msg.chunk.length > maxResChars) {
            settlePending(slot!, p, { response: Response.json({ dropped: true }, { status: 502 }), abortStream: 'response exceeded size limit' })
            return
          }
          if (!p.streamCtrl) {
            if ((streamsByBrowserIp.get(p.browserIp) ?? 0) >= maxStreamsPerIp) {
              settlePending(slot!, p, { response: Response.json({ dropped: true }, { status: 502 }) })
              return
            }
            p.streaming = true
            activeStreams++
            incCounter(streamsByBrowserIp, p.browserIp)
            const stream = new ReadableStream<Uint8Array>(
              {
                start(ctrl) {
                  p.streamCtrl = ctrl
                },
                cancel() {
                  settlePending(slot!, p)
                },
              },
              new ByteLengthQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER_BYTES }),
            )
            p.resolve(new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
          }
          // Bound unread queue if the HTTP caller stalls reading while Chrome keeps streaming chunks.
          if ((p.streamCtrl!.desiredSize ?? 0) < -STREAM_HIGH_WATER_BYTES) {
            settlePending(slot!, p, { abortStream: 'slow client' })
            return
          }
          p.totalChars += msg.chunk.length
          try {
            p.streamCtrl!.enqueue(encoder.encode(msg.chunk))
          } catch {
            settlePending(slot!, p)
          }
          return
        }

        if (msg?.type === 'res' && typeof msg.relay_id === 'string') {
          const slot = channels.get(ws.data.channelId)
          const p = slot?.pending.get(msg.relay_id)
          if (!p) return
          if (msg.error === 'unauthorized') {
            settlePending(slot!, p, { response: new Response('unauthorized', { status: 401 }), abortStream: 'unauthorized' })
            return
          }
          if (msg.done === true && p.streamCtrl) {
            if (p.totalChars >= 22 && p.totalChars <= maxResChars) {
              settlePending(slot!, p, { closeStream: true })
            } else {
              settlePending(slot!, p, { abortStream: 'invalid streamed ciphertext' })
            }
            return
          }
          const res =
            typeof msg.ct === 'string' && msg.ct.length >= 22 && msg.ct.length <= maxResChars
              ? new Response(msg.ct, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
              : Response.json({ dropped: true }, { status: 502 })
          settlePending(slot!, p, { response: res, abortStream: 'unexpected non-stream finish' })
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
    stats: () => ({ totalSockets, unregistered, globalPending, activeStreams }),
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const hostname = process.env.HOST ?? (process.env.FLY_APP_NAME ? '0.0.0.0' : '127.0.0.1')
  const port = Number(process.env.PORT ?? process.env.BROWSER_BRIDGE_PORT ?? DEFAULT_PORT)
  startRelay({ hostname, port, log: console.log })
}
