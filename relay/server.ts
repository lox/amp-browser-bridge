// Stateless blind ciphertext reflector for Amp Browser Bridge.
//
// Chrome connects outbound on `GET /ext` (WebSocket) and sends `{type: "register", gate, banner}`.
// Amp plugin clients call `GET /banner` and `POST /forward` with `x-bridge-gate: <gate>`.
// The reflector hashes `SHA-256(gate)` in RAM to pair callers with Chrome's WebSocket and forwards
// opaque AES-256-GCM envelopes. It holds no disk state, no user accounts, and no encryption keys.
import type { Server, ServerWebSocket } from 'bun'
import { createHash, randomBytes } from 'node:crypto'

export const DEFAULT_PORT = 19989
const REGISTER_TIMEOUT_MS = 10_000
const DEFAULT_FORWARD_TIMEOUT_MS = 70_000
const IDLE_TIMEOUT_S = 90
const MAX_REQ_BYTES = 256 * 1024
const MAX_WS_BYTES = 8 * 1024 * 1024
const MAX_PENDING_PER_CHANNEL = 32

type Banner = { conn_id: string; b_pk: string; sig: string }
type Pending = { resolve: (res: Response) => void; timer: Timer }
type Channel = { ws: ServerWebSocket<SocketData>; banner: Banner; pending: Map<string, Pending> }
type SocketData = { channelId?: string; regTimer?: Timer }

export interface RelayOptions {
  port?: number
  hostname?: string
  forwardTimeoutMs?: number
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
  const log = options.log ?? (() => {})
  const channels = new Map<string, Channel>()

  function dropPending(channel: Channel, status = 502, body: object = { dropped: true }) {
    for (const [id, p] of channel.pending) {
      clearTimeout(p.timer)
      p.resolve(Response.json(body, { status }))
      channel.pending.delete(id)
    }
  }

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? DEFAULT_PORT,
    idleTimeout: IDLE_TIMEOUT_S,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/healthz' && req.method === 'GET') return new Response('ok')

      if (url.pathname === '/ext') {
        // Web pages send an http(s) Origin; Chrome extensions send chrome-extension://<id>.
        const origin = req.headers.get('origin') ?? ''
        if (origin && !origin.startsWith('chrome-extension://')) {
          return new Response('forbidden', { status: 403 })
        }
        return server.upgrade(req, { data: {} }) ? undefined : new Response('upgrade failed', { status: 400 })
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

        const relayId = randomBytes(8).toString('hex')
        return new Promise<Response>((resolve) => {
          const timer = setTimeout(() => {
            slot.pending.delete(relayId)
            resolve(Response.json({ timeout: true }, { status: 504 }))
          }, forwardTimeoutMs)
          slot.pending.set(relayId, { resolve, timer })
          req.signal.addEventListener(
            'abort',
            () => {
              const p = slot.pending.get(relayId)
              if (!p) return
              clearTimeout(p.timer)
              slot.pending.delete(relayId)
            },
            { once: true },
          )
          slot.ws.send(JSON.stringify({ type: 'req', relay_id: relayId, req_id: env.req_id, c_pk: env.c_pk, ct: env.ct }))
        })
      }

      return new Response('not found', { status: 404 })
    },
    websocket: {
      maxPayloadLength: MAX_WS_BYTES,
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

        if (msg?.type === 'res' && typeof msg.relay_id === 'string') {
          const slot = channels.get(ws.data.channelId)
          const p = slot?.pending.get(msg.relay_id)
          if (!p) return
          clearTimeout(p.timer)
          slot!.pending.delete(msg.relay_id)
          if (msg.error === 'unauthorized') {
            p.resolve(new Response('unauthorized', { status: 401 }))
            return
          }
          if (typeof msg.ct === 'string' && msg.ct.length >= 22) {
            p.resolve(Response.json({ ct: msg.ct }))
          } else {
            p.resolve(Response.json({ dropped: true }, { status: 502 }))
          }
        }
      },
      close(ws) {
        clearTimeout(ws.data.regTimer)
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
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const hostname = process.env.HOST ?? (process.env.FLY_APP_NAME ? '0.0.0.0' : '127.0.0.1')
  const port = Number(process.env.PORT ?? process.env.BROWSER_BRIDGE_PORT ?? DEFAULT_PORT)
  startRelay({ hostname, port, log: console.log })
}
