import type { PluginAPI, PluginToolContext } from '@ampcode/plugin'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PORT, startBridge, tokenFile } from './host'

export const description = "Lets Amp threads, including orbs, use one Chrome tab you lend on your Mac. On the Mac it runs the bridge; elsewhere it reaches the bridge through a runner portal."

const dir = join(homedir(), '.amp-browser-bridge')
const port = Number(process.env.BROWSER_BRIDGE_PORT ?? DEFAULT_PORT)

/** host: run the bridge here (the computer with Chrome). client: reach it through BROWSER_BRIDGE_URL. */
function role(): 'host' | 'client' | 'off' {
  const r = process.env.AMP_BROWSER_BRIDGE_ROLE
  if (r === 'host' || r === 'client' || r === 'off') return r
  return process.platform === 'darwin' ? 'host' : 'client'
}

// ---- Talking to the bridge ----

type Target = { base: string; token: string; portal: boolean }
let portalCookie = ''

async function portalLogin(base: string, signal?: AbortSignal) {
  const proc = Bun.spawn(['amp', 'portal', 'login-url', base + '/'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`amp portal login-url failed: ${(await new Response(proc.stderr).text()).trim()}`)
  const loginURL = out.split(/\s+/).find((word) => word.startsWith('https://'))
  if (!loginURL) throw new Error('amp portal login-url printed no URL.')
  const res = await fetch(loginURL, { redirect: 'manual', signal })
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0])
  if (!cookies.length) throw new Error(`Portal sign-in set no cookie (HTTP ${res.status}). Is the bridge still published?`)
  portalCookie = cookies.join('; ')
}

/**
 * Sends one request to the bridge. Only a portal sign-in redirect, which the bridge never saw, is
 * retried. When a command may have reached the bridge and its answer was lost (a proxy error or a
 * dropped connection), the reply is `{unknown: true}`: browser actions are never sent twice.
 */
async function request(target: Target, thread: string, path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<any> {
  const command = path === '/call'
  for (let attempt = 0; attempt < 2; attempt++) {
    if (target.portal && !portalCookie) await portalLogin(target.base, init.signal)
    let res: Response
    try {
      res = await fetch(target.base + path, {
        ...init,
        redirect: 'manual',
        headers: { ...(init.headers ?? {}), ...(target.portal ? { cookie: portalCookie } : {}), 'x-bridge-token': target.token, 'x-amp-thread': thread, 'content-type': 'application/json' },
      })
    } catch (error: any) {
      // Even a cancelled call may already be running on the bridge.
      if (command) return { error: `The request to the bridge ${init.signal?.aborted ? 'was cancelled' : `failed (${error?.message ?? error})`}; the outcome is unknown.`, unknown: true }
      throw error
    }
    // The portal answers 502-504 while the runner restarts; the bridge itself never does.
    if (!command && target.portal && res.status >= 502 && res.status <= 504) {
      throw Object.assign(new Error(`The bridge portal is temporarily unavailable (HTTP ${res.status}).`), { transient: true })
    }
    if ((res.headers.get('content-type') ?? '').includes('application/json')) return res.json()
    const text = await res.text()
    if (res.status === 401 && text === 'unauthorized') throw new Error('The bridge rejected BROWSER_BRIDGE_TOKEN. Publish the bridge again from a thread on the Mac.')
    if (target.portal && res.status >= 300 && res.status < 400 && attempt === 0) {
      // The portal wants a fresh sign-in; the request never reached the bridge.
      portalCookie = ''
      continue
    }
    if (command) return { error: `The bridge answered HTTP ${res.status} without a result; the outcome is unknown.`, unknown: true }
    throw new Error(`Unexpected bridge response (HTTP ${res.status}). If this persists, publish the bridge again from a thread on the Mac.`)
  }
  throw new Error('Could not sign in to the bridge portal. Publish the bridge again from a thread on the Mac.')
}

async function call(target: Target, ctx: PluginToolContext, tool: string, args: Record<string, unknown>) {
  const reply = await request(target, ctx.thread.id, '/call', { method: 'POST', body: JSON.stringify({ tool, args }), signal: ctx.signal })
  if (reply.error) throw new Error(reply.unknown ? `${reply.error} Check the page before retrying.` : reply.error)
  return reply.result
}

// ---- Approval for actions that change the page ----

/** "Allow for this thread" answers, per thread and site: `${thread} ${origin}`. */
const allowed = new Set<string>()

async function approve(target: Target, ctx: PluginToolContext, tool: string, input: Record<string, unknown>) {
  // Don't ask the user to approve something the extension will refuse anyway.
  const { tab } = await request(target, ctx.thread.id, '/status', { signal: ctx.signal })
  if (!tab) throw new Error('No tab is lent. Ask the user to open the page and click Lend this tab in the extension popup.')
  if (!tab.allow_actions) throw new Error('This tab is lent read-only. Ask the user to turn on "Allow clicks, typing and navigation" in the extension popup.')
  let url: URL | null = null
  let d: { role: string; name: string; url: string } | null = null
  if (tool === 'navigate') {
    try {
      url = new URL(String(input.url))
    } catch {
      throw new Error('navigate needs an absolute http(s) URL.')
    }
  } else {
    d = await call(target, ctx, 'describe', { ref: input.ref })
  }
  // An allowance covers one thread on one site: the page's current site, or where navigation goes.
  const site = url ? url.origin : new URL(d!.url).origin
  const key = `${ctx.thread.id} ${site}`
  if (allowed.has(key)) return
  let what: string
  if (url) {
    what = `Open ${url.href} (site **${url.origin}**) in the tab lent on ${tab.origin}.`
  } else {
    const element = `${d!.role}${d!.name ? ` “${d!.name}”` : ''}`
    what = tool === 'click'
      ? `Click ${element} on ${d!.url}.`
      : `Type into ${element} on ${d!.url}${input.submit ? ', then press Enter' : ''}:\n\n> ${String(input.text).slice(0, 300) || '(clear the field)'}`
  }
  const answer = await ctx.ui.select({
    title: `Amp wants to ${tool} in your browser`,
    message: what,
    options: ['Allow once', `Allow on ${site} for this thread`, 'Deny'],
    requireHuman: true,
  })
  if (answer?.startsWith('Allow on ')) allowed.add(key)
  else if (answer !== 'Allow once') throw new Error('The user denied this browser action.')
}

// ---- Tools ----

const ref = { type: 'string', description: 'Element ref such as e12 from the latest browser_snapshot.' }
const tools: { name: string; title: string; description: string; properties?: Record<string, object>; required?: string[] }[] = [
  { name: 'status', title: 'Browser status', description: "Check whether the user's Chrome is connected, which tab is lent, and which thread holds it. Call first." },
  { name: 'snapshot', title: 'Read page', description: "Outline of the lent tab's accessibility tree. Interactive elements get refs (e1, e2, ...) for click and type; refs expire when the page changes." },
  { name: 'screenshot', title: 'Screenshot', description: "JPEG of the lent tab's viewport." },
  { name: 'scroll', title: 'Scroll', description: 'Scroll the page by delta_y pixels (negative scrolls up).', properties: { delta_y: { type: 'number' } }, required: ['delta_y'] },
  { name: 'click', title: 'Click', description: 'Click an element by ref. The user approves each action unless they allowed this thread.', properties: { ref }, required: ['ref'] },
  { name: 'type', title: 'Type', description: "Replace a field's contents by ref; submit presses Enter afterwards. Needs the user's approval.", properties: { ref, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] },
  { name: 'navigate', title: 'Navigate', description: "Load an HTTP(S) URL in the lent tab. Needs the user's approval; the tab stays on its lent site unless the user allowed other sites.", properties: { url: { type: 'string' } }, required: ['url'] },
  { name: 'handoff', title: 'Hand tab to user', description: 'Show the user a card on the lent tab and wait (up to 30 minutes) until they click Continue. Use for logins, 2FA, captchas and payments; never do those yourself.', properties: { message: { type: 'string', description: 'What the user should do, e.g. "Sign in to GitHub, then click Continue".' } }, required: ['message'] },
]

async function handoff(target: Target, ctx: PluginToolContext, message: string) {
  const { handoff_id: id } = await call(target, ctx, 'handoff', { message })
  try {
    // Poll in short requests: a single half-hour request would not survive the portal proxy.
    let outage = 0
    while (!ctx.signal.aborted) {
      let reply: any
      try {
        reply = await request(target, ctx.thread.id, `/handoff/${id}?wait=25000`, { signal: ctx.signal })
        outage = 0
      } catch (error: any) {
        // Keep waiting through a short portal outage; the card stays on the page meanwhile.
        if (!error?.transient || ++outage > 40) throw error
        await Bun.sleep(3000)
        continue
      }
      if (reply.error) throw new Error(reply.error)
      if (!reply.result?.waiting) return JSON.stringify(reply.result)
    }
    throw new Error('Cancelled.')
  } catch (error) {
    if (ctx.signal.aborted) await request(target, ctx.thread.id, `/handoff/${id}/cancel`, { method: 'POST' }).catch(() => {})
    throw error
  }
}

export default async function (amp: PluginAPI) {
  const mode = role()
  if (mode === 'off') return

  let local: Target | null = null
  if (mode === 'host') {
    let bridge: ReturnType<typeof startBridge> | null = null
    // Several Amp processes on one Mac load this plugin; the first to bind the port runs the bridge
    // and the others keep trying, so the bridge survives whichever process owns it exiting.
    const tryStart = () => {
      if (bridge) return
      try {
        bridge = startBridge({ dir, port, log: (m) => amp.logger.log(m) })
      } catch (error: any) {
        if (error?.code !== 'EADDRINUSE') amp.logger.log(`bridge failed to start: ${error?.message ?? error}`)
      }
    }
    tryStart()
    const retry = setInterval(tryStart, 15_000)
    amp.onDispose(() => {
      clearInterval(retry)
      bridge?.stop()
    })
    local = { base: `http://127.0.0.1:${port}`, token: '', portal: false }

    amp.registerTool({
      name: 'browser_bridge_publish',
      title: 'Publish browser bridge',
      description: "Expose this Mac's browser bridge to the user's orbs: registers this thread's portal for it and stores BROWSER_BRIDGE_URL and BROWSER_BRIDGE_TOKEN as the user's personal Amp secrets. Run it in a thread on the Mac when the user asks to set up or republish the browser bridge. The portal lives as long as this thread, so tell the user not to archive it.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        const ok = await ctx.ui.confirm({
          title: 'Publish the browser bridge to your orbs?',
          message: `This thread's portal will serve the bridge on port ${port}, and your personal Amp secrets BROWSER_BRIDGE_URL and BROWSER_BRIDGE_TOKEN will be updated so new orbs can reach it. Only you can open the portal.`,
          confirmButtonText: 'Publish',
          requireHuman: true,
        })
        if (!ok) throw new Error('The user cancelled publishing.')
        const run = async (args: string[], stdin?: string) => {
          const proc = Bun.spawn(['amp', ...args], { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
          const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
          if (code !== 0) throw new Error(`amp ${args.slice(0, 3).join(' ')} failed: ${(err || out).trim()}`)
          return out
        }
        // Runner portals get an auto-generated hostname (custom hostnames answer 503 on runners), so
        // the URL is published as a secret and republishing from another thread updates it.
        const out = await run(['orb', 'portal', String(port), '--thread', ctx.thread.id, '--title', 'Browser bridge', '--description', 'Amp browser bridge; requires its token'])
        const url = out.split(/\s+/).filter((w) => w.startsWith('https://')).pop()?.replace(/\/$/, '')
        if (!url) throw new Error(`amp orb portal printed no URL: ${out.trim()}`)
        await run(['secrets', 'set', '--user', 'BROWSER_BRIDGE_TOKEN', '--data-file', tokenFile(dir)])
        await run(['secrets', 'set', '--user', '--env', 'BROWSER_BRIDGE_URL', '--data-file', '-'], url)
        return JSON.stringify({ portal_url: url, note: 'New orbs get these secrets when they start; running orbs need `amp orb restart-processes`. Keep this thread unarchived: the portal belongs to it.' })
      },
    })

    amp.registerTool({
      name: 'browser_bridge_pair',
      title: 'New pairing code',
      description: 'Make a new one-time pairing code for the Chrome extension, valid for 10 minutes. The code is written to a file on this Mac and never returned; tell the user to run `cat ~/.amp-browser-bridge/pairing-code` and enter it in the extension popup.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        const reply = await request(target(), ctx.thread.id, '/pair', { method: 'POST', signal: ctx.signal })
        if (reply.error) throw new Error(reply.error)
        return JSON.stringify({ ...reply.result, next: 'Ask the user to run `cat ~/.amp-browser-bridge/pairing-code` and enter the code in the extension popup.' })
      },
    })
  }

  function target(): Target {
    if (local) {
      const token = existsSync(tokenFile(dir)) ? readFileSync(tokenFile(dir), 'utf8').trim() : ''
      if (!token) throw new Error('The bridge on this Mac has not started yet.')
      return { ...local, token }
    }
    const base = (process.env.BROWSER_BRIDGE_URL ?? '').trim().replace(/\/$/, '')
    const token = (process.env.BROWSER_BRIDGE_TOKEN ?? '').trim()
    if (!base || !token) throw new Error('The browser bridge is not set up for this machine: BROWSER_BRIDGE_URL and BROWSER_BRIDGE_TOKEN are missing. Ask the user to run browser_bridge_publish in an Amp thread on their Mac (see the amp-browser-bridge README).')
    // An https URL is an Amp portal and needs a portal sign-in; plain http reaches the bridge directly.
    return { base, token, portal: base.startsWith('https://') }
  }

  for (const t of tools) {
    amp.registerTool({
      name: `browser_${t.name}`,
      title: t.title,
      transcriptGroup: { active: 'Using your browser', complete: 'Used your browser' },
      description: `${t.description} Acts in the user's real, signed-in Chrome.`,
      inputSchema: { type: 'object', properties: t.properties ?? {}, required: t.required ?? [], additionalProperties: false },
      async execute(input, ctx) {
        const to = target()
        if (t.name === 'status') {
          const s = await request(to, ctx.thread.id, '/status', { signal: ctx.signal })
          if (!s.extension_connected) return JSON.stringify({ ...s, next: 'Ask the user to open Chrome; the extension connects to the bridge by itself.' })
          if (!s.tab) return JSON.stringify({ ...s, next: 'Ask the user to open the page and click Lend this tab in the extension popup.' })
          return JSON.stringify(s)
        }
        if (t.name === 'handoff') return handoff(to, ctx, String(input.message ?? ''))
        if (t.name === 'click' || t.name === 'type' || t.name === 'navigate') await approve(to, ctx, t.name, input)
        if (ctx.signal.aborted) throw new Error('Cancelled.')
        const result = await call(to, ctx, t.name, input)
        if (t.name === 'screenshot') {
          try {
            const { url } = await amp.attachments.upload({ data: Buffer.from(result.data, 'base64'), mimeType: 'image/jpeg' })
            return [{ type: 'image', mimeType: 'image/jpeg', url }]
          } catch {
            return [{ type: 'image', mimeType: 'image/jpeg', data: result.data }]
          }
        }
        if (t.name === 'snapshot') return `${result.title}\n${result.url}${result.truncated ? '\n(truncated)' : ''}\n\n${result.outline}`
        return JSON.stringify(result)
      },
    })
  }
}
