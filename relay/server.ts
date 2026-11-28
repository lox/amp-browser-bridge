// Stateless blind ciphertext reflector for Amp Browser Bridge.
//
// Chrome connects outbound on `GET /ext` (WebSocket) and sends `{type: "register", gate, banner}`.
// Amp plugin clients call `GET /banner` and `POST /forward` with `x-bridge-gate: <gate>`.
// The reflector hashes `SHA-256(gate)` in RAM to pair callers with Chrome's WebSocket and streams
// opaque AES-256-GCM ciphertexts with pull-driven backpressure, global byte budgets, and longest-source
// fair preemption so neither shared NATs nor multi-IP floods can starve legitimate users or OOM the VM.
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
const MAX_STREAM_QUEUE_BYTES = 256 * 1024
const MAX_GLOBAL_STREAM_BYTES = 32 * 1024 * 1024
const MAX_PENDING_PER_CHANNEL = 4
const MAX_GLOBAL_PENDING = 2048
const MAX_UNREGISTERED_SOCKETS = 256
const MAX_TOTAL_SOCKETS = 2048
const MAX_UPGRADES_PER_IP_PER_MIN = 300
const RATE_WINDOW_MS = 60_000
const MAX_RATE_ENTRIES = 4096

const encoder = new TextEncoder()

type Banner = { conn_id: string; b_pk: string; sig: string }
type Pending = {
  id: string
  slot: Channel
  callerIp: string
  browserIp: string
  resolve: (res: Response) => void
  timer: Timer
  totalChars: number
  queue: Uint8Array[]
  inFlightBytes: number
  bufferedBytes: number
  wantPull: boolean
  inputDone: boolean
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
  served?: boolean
}

export interface RelayOptions {
  port?: number
  hostname?: string
  forwardTimeoutMs?: number
  maxUnregistered?: number
  maxTotalSockets?: number
  maxUpgradesPerIpPerMin?: number
  maxGlobalPending?: number
  maxStreamQueueBytes?: number
  maxGlobalStreamBytes?: number
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

function addSet<K, V>(map: Map<K, Set<V>>, key: K, item: V) {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(item)
}

function delSet<K, V>(map: Map<K, Set<V>>, key: K, item: V) {
  const set = map.get(key)
  if (!set) return
  set.delete(item)
  if (set.size === 0) map.delete(key)
}

function heaviestKey<V>(map: Map<string, Set<V>>): { key: string; set: Set<V> } | null {
  let best: { key: string; set: Set<V> } | null = null
  for (const [key, set] of map) {
    if (set.size > (best?.set.size ?? 0)) best = { key, set }
  }
  return best
}

export function startRelay(options: RelayOptions = {}) {
  const forwardTimeoutMs = options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS
  const maxUnregistered = options.maxUnregistered ?? MAX_UNREGISTERED_SOCKETS
  const maxTotalSockets = options.maxTotalSockets ?? MAX_TOTAL_SOCKETS
  const maxUpgradesPerIpPerMin = options.maxUpgradesPerIpPerMin ?? MAX_UPGRADES_PER_IP_PER_MIN
  const maxGlobalPending = options.maxGlobalPending ?? MAX_GLOBAL_PENDING
  const maxStreamQueueBytes = options.maxStreamQueueBytes ?? MAX_STREAM_QUEUE_BYTES
  const maxGlobalStreamBytes = options.maxGlobalStreamBytes ?? MAX_GLOBAL_STREAM_BYTES
  const maxResChars = options.maxResChars ?? MAX_RES_CHARS
  const trustFlyHeader = options.trustFlyHeader ?? Boolean(process.env.FLY_APP_NAME)
  const log = options.log ?? (() => {})

  const channels = new Map<string, Channel>()
  const socketsByIp = new Map<string, Set<ServerWebSocket<SocketData>>>()
  const unregisteredSockets = new Set<ServerWebSocket<SocketData>>()
  const pendingByCallerIp = new Map<string, Set<Pending>>()
  const streamsByBrowserIp = new Map<string, Set<Pending>>()
  const bufferedBytesByIp = new Map<string, number>()
  const ipRates = new Map<string, { count: number; resetAt: number }>()
  let totalSockets = 0
  let globalPending = 0
  let activeStreams = 0
  let globalStreamBytes = 0

  /** Groups IPv6 addresses by /64 subnet so a single host with a /64 block cannot rotate addresses past per-source tracking. */
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

  function addBufferedBytes(p: Pending, delta: number) {
    if (delta <= 0) return
    p.bufferedBytes += delta
    globalStreamBytes += delta
    bufferedBytesByIp.set(p.browserIp, (bufferedBytesByIp.get(p.browserIp) ?? 0) + delta)
  }

  function subBufferedBytes(p: Pending, delta: number) {
    if (delta <= 0) return
    const actual = Math.min(p.bufferedBytes, delta)
    p.bufferedBytes -= actual
    globalStreamBytes = Math.max(0, globalStreamBytes - actual)
    const prev = bufferedBytesByIp.get(p.browserIp) ?? 0
    if (prev <= actual) bufferedBytesByIp.delete(p.browserIp)
    else bufferedBytesByIp.set(p.browserIp, prev - actual)
  }

  function releaseUnregistered(ws: ServerWebSocket<SocketData>) {
    if (!ws.data.countedUnregistered) return
    ws.data.countedUnregistered = false
    unregisteredSockets.delete(ws)
  }

  function releaseSocket(ws: ServerWebSocket<SocketData>) {
    releaseUnregistered(ws)
    if (!ws.data.countedSocket) return
    ws.data.countedSocket = false
    totalSockets = Math.max(0, totalSockets - 1)
    delSet(socketsByIp, ws.data.ip, ws)
  }

  function evictSocket(victim: ServerWebSocket<SocketData>) {
    releaseSocket(victim)
    const id = victim.data.channelId
    if (id && channels.get(id)?.ws === victim) {
      const slot = channels.get(id)!
      channels.delete(id)
      dropPending(slot)
    }
    victim.data.channelId = undefined
    victim.close(1013, 'evicted under load')
  }

  /** When total sockets hit capacity, evicts from the heaviest IP (preferring sockets that never served a response). */
  function ensureSocketSlot(incomingIp: string): boolean {
    if (totalSockets < maxTotalSockets) return true
    const heaviest = heaviestKey(socketsByIp)
    const mine = socketsByIp.get(incomingIp)?.size ?? 0
    if (heaviest && heaviest.set.size > Math.max(1, mine)) {
      let victim: ServerWebSocket<SocketData> | undefined
      for (const s of heaviest.set) {
        if (!s.data.served) {
          victim = s
          break
        }
      }
      evictSocket(victim ?? heaviest.set.values().next().value!)
      return totalSockets < maxTotalSockets
    }
    if (mine === 0) {
      for (const set of socketsByIp.values()) {
        for (const s of set) {
          if (!s.data.served) {
            evictSocket(s)
            return totalSockets < maxTotalSockets
          }
        }
      }
    }
    return false
  }

  /** When global pending requests hit capacity, preempts the oldest wait of the heaviest caller IP if it holds more than `callerIp`. */
  function ensurePendingSlot(callerIp: string): boolean {
    if (globalPending < maxGlobalPending) return true
    const heaviest = heaviestKey(pendingByCallerIp)
    const mine = pendingByCallerIp.get(callerIp)?.size ?? 0
    if (!heaviest || heaviest.set.size <= mine) return false
    const victim = heaviest.set.values().next().value
    if (!victim) return false
    settlePending(victim.slot, victim, { response: Response.json({ error: 'preempted under load' }, { status: 503 }) })
    return globalPending < maxGlobalPending
  }

  /** Reclaims queued stream bytes from the heaviest other browser IP when global stream memory reaches `maxGlobalStreamBytes`. */
  function ensureGlobalStreamSpace(requesterIp: string, neededBytes: number): boolean {
    while (globalStreamBytes + neededBytes > maxGlobalStreamBytes) {
      const mine = bufferedBytesByIp.get(requesterIp) ?? 0
      let bestIp = ''
      let bestBytes = 0
      for (const [ip, bytes] of bufferedBytesByIp) {
        if (ip !== requesterIp && bytes > bestBytes) {
          bestIp = ip
          bestBytes = bytes
        }
      }
      if (!bestIp || bestBytes <= mine) return false
      const victim = streamsByBrowserIp.get(bestIp)?.values().next().value
      if (!victim) return false
      settlePending(victim.slot, victim)
    }
    return true
  }

  function settlePending(slot: Channel, p: Pending, action?: { response?: Response }) {
    if (p.released) return
    p.released = true
    clearTimeout(p.timer)
    slot.pending.delete(p.id)
    globalPending = Math.max(0, globalPending - 1)
    delSet(pendingByCallerIp, p.callerIp, p)
    if (p.bufferedBytes > 0) subBufferedBytes(p, p.bufferedBytes)
    p.queue.length = 0
    p.inFlightBytes = 0
    if (p.streaming) {
      p.streaming = false
      activeStreams = Math.max(0, activeStreams - 1)
      delSet(streamsByBrowserIp, p.browserIp, p)
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

  function onStreamPull(slot: Channel, p: Pending) {
    if (p.released || !p.streamCtrl) return
    // `highWaterMark: 0` calls `pull` only once the previous chunk was consumed by the HTTP writer.
    if (p.inFlightBytes > 0) {
      subBufferedBytes(p, p.inFlightBytes)
      p.inFlightBytes = 0
    }
    const next = p.queue.shift()
    if (next) {
      p.inFlightBytes = next.byteLength
      p.wantPull = false
      try {
        p.streamCtrl.enqueue(next)
      } catch {
        settlePending(slot, p)
      }
      return
    }
    if (p.inputDone) {
      settlePending(slot, p)
      return
    }
    p.wantPull = true
  }

  function dropPending(channel: Channel, status = 502, body: object = { dropped: true }) {
    for (const p of [...channel.pending.values()]) {
      settlePending(channel, p, { response: Response.json(body, { status }) })
    }
  }

  function forwardToBrowser(slot: Channel, callerIp: string, signal: AbortSignal, outboundFrame: string, relayId: string): Promise<Response> {
    const browserIp = slot.ws.data.ip
    return new Promise<Response>((resolve) => {
      const entry: Pending = {
        id: relayId,
        slot,
        callerIp,
        browserIp,
        resolve,
        totalChars: 0,
        queue: [],
        inFlightBytes: 0,
        bufferedBytes: 0,
        wantPull: false,
        inputDone: false,
        streaming: false,
        released: false,
        timer: setTimeout(() => {
          settlePending(slot, entry, { response: Response.json({ timeout: true }, { status: 504 }) })
        }, forwardTimeoutMs),
      }
      slot.pending.set(relayId, entry)
      globalPending++
      addSet(pendingByCallerIp, callerIp, entry)
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
        if (!allowUpgradeRate(ip)) {
          return new Response('upgrade rate exceeded', { status: 429 })
        }
        if (unregisteredSockets.size >= maxUnregistered) {
          return new Response('too many pending connections', { status: 503 })
        }
        if (!ensureSocketSlot(ip)) {
          return new Response('too many connections', { status: 429 })
        }
        if (!server.upgrade(req, { data: { ip } })) {
          return new Response('upgrade failed', { status: 400 })
        }
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
        if (slot.pending.size >= MAX_PENDING_PER_CHANNEL) {
          return Response.json({ error: 'too many concurrent requests' }, { status: 429 })
        }
        const callerIp = clientIp(req, server)
        if (!ensurePendingSlot(callerIp)) {
          return Response.json({ error: 'too many concurrent requests' }, { status: 429 })
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
        ws.data.countedUnregistered = true
        ws.data.countedSocket = true
        unregisteredSockets.add(ws)
        totalSockets++
        addSet(socketsByIp, ws.data.ip, ws)
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
          if (!p || p.inputDone || !msg.chunk.length) return
          const bytes = encoder.encode(msg.chunk)
          if (
            p.totalChars + msg.chunk.length > maxResChars ||
            p.bufferedBytes + bytes.byteLength > maxStreamQueueBytes ||
            !ensureGlobalStreamSpace(p.browserIp, bytes.byteLength)
          ) {
            settlePending(slot!, p, { response: Response.json({ dropped: true }, { status: 502 }) })
            return
          }
          if (!p.streaming) {
            p.streaming = true
            activeStreams++
            addSet(streamsByBrowserIp, p.browserIp, p)
            const stream = new ReadableStream<Uint8Array>(
              {
                start(ctrl) {
                  p.streamCtrl = ctrl
                },
                pull() {
                  onStreamPull(slot!, p)
                },
                cancel() {
                  settlePending(slot!, p)
                },
              },
              { highWaterMark: 0 },
            )
            p.resolve(new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
          }
          p.totalChars += msg.chunk.length
          addBufferedBytes(p, bytes.byteLength)
          if (p.wantPull && p.streamCtrl) {
            p.wantPull = false
            p.inFlightBytes = bytes.byteLength
            try {
              p.streamCtrl.enqueue(bytes)
            } catch {
              settlePending(slot!, p)
            }
          } else {
            p.queue.push(bytes)
          }
          return
        }

        if (msg?.type === 'res' && typeof msg.relay_id === 'string') {
          const slot = channels.get(ws.data.channelId)
          const p = slot?.pending.get(msg.relay_id)
          if (!p) return
          if (msg.error === 'unauthorized') {
            settlePending(slot!, p, { response: new Response('unauthorized', { status: 401 }) })
            return
          }
          if (msg.done === true && p.streaming) {
            if (p.totalChars < 22 || p.totalChars > maxResChars) {
              settlePending(slot!, p)
              return
            }
            ws.data.served = true
            p.inputDone = true
            if (p.wantPull && p.queue.length === 0) {
              if (p.inFlightBytes > 0) {
                subBufferedBytes(p, p.inFlightBytes)
                p.inFlightBytes = 0
              }
              settlePending(slot!, p)
            }
            return
          }
          const ok = typeof msg.ct === 'string' && msg.ct.length >= 22 && msg.ct.length <= maxResChars
          if (ok) ws.data.served = true
          const res = ok
            ? new Response(msg.ct, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
            : Response.json({ dropped: true }, { status: 502 })
          settlePending(slot!, p, { response: res })
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
    stats: () => ({ totalSockets, unregistered: unregisteredSockets.size, globalPending, activeStreams, globalStreamBytes }),
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const hostname = process.env.HOST ?? (process.env.FLY_APP_NAME ? '0.0.0.0' : '127.0.0.1')
  const port = Number(process.env.PORT ?? process.env.BROWSER_BRIDGE_PORT ?? DEFAULT_PORT)
  startRelay({ hostname, port, log: console.log })
}
