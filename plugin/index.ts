import type { PluginAPI, PluginToolContext } from '@ampcode/plugin'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EXTENSION_ID } from './extension-id'
import { DEFAULT_PORT, readPublished, signRequest, startBridge, tokenFile, verifyResponse, writePublished, type Published } from './host'

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
  const method = init.method ?? 'GET'
  const body = typeof init.body === 'string' ? init.body : ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (target.portal && !portalCookie) await portalLogin(target.base, init.signal)
    // The token never goes over the wire: whatever holds the bridge's port sees only a single-use signature.
    const auth = signRequest(target.token, { method, path, thread, body })
    let res: Response
    let text: string
    try {
      res = await fetch(target.base + path, {
        ...init,
        redirect: 'manual',
        headers: { ...(init.headers ?? {}), ...(target.portal ? { cookie: portalCookie } : {}), 'x-bridge-auth': auth.header, 'x-amp-thread': thread, 'content-type': 'application/json' },
      })
      text = await res.text()
    } catch (error: any) {
      // Even a cancelled call may already be running on the bridge.
      if (command) return { error: `The request to the bridge ${init.signal?.aborted ? 'was cancelled' : `failed (${error?.message ?? error})`}; the outcome is unknown.`, unknown: true }
      throw error
    }
    // The portal answers 502-504 while the runner restarts; the bridge itself never does.
    if (!command && target.portal && res.status >= 502 && res.status <= 504) {
      throw Object.assign(new Error(`The bridge portal is temporarily unavailable (HTTP ${res.status}).`), { transient: true })
    }
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      if (verifyResponse(target.token, auth.nonce, res.status, text, res.headers.get('x-bridge-proof'))) return JSON.parse(text)
      // A program other than the bridge holds its port, or the answer was changed on the way.
      const why = "The answer did not come from your browser bridge (its signature is missing or wrong). Check that no other program holds the bridge's port on the Mac and that the plugin is the same version there and here."
      if (command) return { error: `${why} The outcome is unknown.`, unknown: true }
      throw new Error(why)
    }
    if (res.status === 401 && text === 'unauthorized') {
      throw new Error("The bridge rejected this request's signature. Publish the bridge again from a thread on the Mac so BROWSER_BRIDGE_TOKEN is current, update the plugin if the Mac's is a different version, and check that both clocks are right.")
    }
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

// ---- Publishing and pairing on the Mac ----

async function ampCLI(args: string[], stdin?: string) {
  // A runner portal's hostname depends on the directory `amp orb portal` runs in. The plugin's own
  // directory changes with every plugin version, so run from the bridge's directory to keep the URL.
  const proc = Bun.spawn(['amp', ...args], { cwd: dir, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`amp ${args.slice(0, 3).join(' ')} failed: ${(err || out).trim()}`)
  return out
}

/**
 * Serves the bridge through `thread`'s runner portal and points the orbs' secrets at it. Every
 * portal belongs to a thread; the bridge calls this again on every start to keep the portal
 * registered and the secrets current.
 */
async function publish(thread: string, force: boolean): Promise<Published> {
  // Runner portals get an auto-generated hostname (custom hostnames answer 503 on runners).
  const out = await ampCLI(['orb', 'portal', String(port), '--thread', thread, '--title', 'Browser bridge', '--description', 'Amp browser bridge; requires its token'])
  const url = out.split(/\s+/).filter((w) => w.startsWith('https://')).pop()?.replace(/\/$/, '')
  if (!url) throw new Error(`amp orb portal printed no URL: ${out.trim()}`)
  if (force || readPublished(dir)?.url !== url) {
    await ampCLI(['secrets', 'set', '--user', 'BROWSER_BRIDGE_TOKEN', '--data-file', tokenFile(dir)])
    await ampCLI(['secrets', 'set', '--user', '--env', 'BROWSER_BRIDGE_URL', '--data-file', '-'], url)
  }
  const published = { url, thread, at: new Date().toISOString() }
  writePublished(dir, published)
  return published
}

/** Publishes again through the thread the user last published from, if any. */
async function republish(log: (m: string) => void, stopped: () => boolean) {
  const previous = readPublished(dir)
  if (!previous) return
  // The runner may still be starting; give up after about five minutes.
  for (let attempt = 1; !stopped(); attempt++) {
    try {
      const { url } = await publish(previous.thread, false)
      log(`republished the bridge at ${url}`)
      return
    } catch (error: any) {
      if (attempt === 4) {
        log(`could not republish the bridge through thread ${previous.thread}: ${error?.message ?? error}`)
        // Tell the setup page, so it asks the user to publish again from a thread on the Mac.
        writePublished(dir, null)
        return
      }
      await Bun.sleep(attempt * 30_000)
    }
  }
}

/** Opens the extension's setup page in Chrome on this Mac. The code stays in the URL fragment, on this Mac. */
async function openSetupPage(code: string) {
  if (process.platform !== 'darwin') return false
  const url = `chrome-extension://${EXTENSION_ID}/setup.html#code=${encodeURIComponent(code)}`
  for (const args of [['-a', 'Google Chrome', url], [url]]) {
    if ((await Bun.spawn(['open', ...args], { stdout: 'ignore', stderr: 'ignore' }).exited) === 0) return true
  }
  return false
}

// ---- Approval for actions that change the page ----

/** "Allow for this thread" answers, per thread and site: `${thread} ${origin}`. */
const allowed = new Set<string>()

async function approve(target: Target, ctx: PluginToolContext, tool: string, input: Record<string, unknown>) {
  // Don't ask the user to approve something the extension will refuse anyway.
  const { tab, agent_tabs } = await request(target, ctx.thread.id, '/status', { signal: ctx.signal })
  const own = tool === 'open_tab' || input.tab != null
  if (own) {
    if (!agent_tabs?.enabled) throw new Error('The user has not let Amp open its own tabs. Ask them to turn on "Let Amp open its own tabs" in the extension popup.')
    if (input.tab != null && !agent_tabs.tabs.some((t: { tab: number }) => t.tab === input.tab)) throw new Error(`Tab ${input.tab} is not one of this thread's tabs. Open one with browser_open_tab.`)
  } else {
    if (!tab) throw new Error('No tab is lent. Ask the user to open the page and click Lend this tab in the extension popup, or open a tab of your own with browser_open_tab.')
    if (!tab.allow_actions) throw new Error('This tab is lent read-only. Ask the user to turn on "Allow clicks, typing and navigation" in the extension popup.')
  }
  let url: URL | null = null
  let d: { role?: string; name?: string; url: string; secret?: boolean; doc?: string } | null = null
  if (tool === 'navigate' || tool === 'open_tab') {
    try {
      url = new URL(String(input.url))
    } catch {
      throw new Error('navigate needs an absolute http(s) URL.')
    }
  } else {
    // Without a ref (press on whatever has focus), describe returns only the page's URL.
    d = await call(target, ctx, 'describe', { ref: input.ref, tab: input.tab })
    // A key for whatever has focus goes only to the page the user approved it on.
    if (tool === 'press' && !input.ref && d?.doc) Object.assign(input, { doc: d.doc, url: d.url })
    // A value the prompt hid stays hidden in the result, even if the field stops being a password.
    if (tool === 'fill' && d?.secret) input.secret = true
  }
  // An allowance covers one thread on one site: the page's current site, or where navigation goes.
  const site = url ? url.origin : new URL(d!.url).origin
  // Allowing a site in your own tabs doesn't allow it in the lent tab, and the other way round.
  const key = `${ctx.thread.id} ${own ? 'own' : 'lent'} ${site}`
  if (allowed.has(key)) return
  let what: string
  if (url) {
    what = tool === 'open_tab'
      ? `Open ${url.href} (site **${url.origin}**) in a new background tab.`
      : `Open ${url.href} (site **${url.origin}**) in ${own ? `Amp's tab ${input.tab}` : `the tab lent on ${tab.origin}`}.`
  } else {
    const element = d!.role ? `${d!.role}${d!.name ? ` “${d!.name}”` : ''}` : 'the focused element'
    const enter = input.submit ? ', then press Enter' : ''
    const text = String((tool === 'fill' ? input.value : input.text) ?? '')
    // Fill never shows what goes into a password or one-time-code field.
    const shown = tool === 'fill' && d!.secret ? `(hidden: ${[...text].length} characters)` : text.slice(0, 300) || '(clear the field)'
    what = {
      click: () => `Click ${element} on ${d!.url}.`,
      press: () => `Press ${String(input.key)} on ${element} on ${d!.url}.`,
      select: () => `Select “${String(input.value)}” in ${element} on ${d!.url}.`,
      fill: () => `Fill ${element} on ${d!.url}${enter}:\n\n> ${shown}`,
      type: () => `Type into ${element} on ${d!.url}${enter}:\n\n> ${shown}`,
    }[tool]!()
  }
  const answer = await ctx.ui.select({
    title: `Amp wants to ${tool} in your browser`,
    message: what,
    options: ['Allow once', `Allow on ${site} ${own ? "in this thread's own tabs" : 'in the lent tab'} for this thread`, 'Deny'],
    requireHuman: true,
  })
  if (answer?.startsWith('Allow on ')) allowed.add(key)
  else if (answer !== 'Allow once') throw new Error('The user denied this browser action.')
}

// ---- Tools ----

const ref = { type: 'string', description: 'Element ref such as e12 from the latest browser_snapshot of the same tab.' }
const tab = { type: 'number', description: 'One of your own tabs, from browser_open_tab. Omit for the tab the user lent.' }
/** Tools that change the page: the extension refuses them on a read-only tab, and the user approves each. */
const MUTATING = new Set(['click', 'type', 'fill', 'press', 'select', 'navigate'])
const tools: { name: string; title: string; description: string; properties?: Record<string, object>; required?: string[] }[] = [
  { name: 'status', title: 'Browser status', description: "Check whether the user's Chrome is connected, which tab is lent, which thread holds it, and how this thread's latest handoff stands (waiting, continued or ended). Call first, and after a browser_handoff call fails. When it returns `next`, tell the user that step and wait for them; don't retry." },
  { name: 'open_tab', title: 'Open tab', description: "Open a URL in a new background tab of your own, in a collapsed Amp tab group, and return its `tab` id for the other tools. Only you can use it; it closes after 10 idle minutes. Needs the user's approval and their \"Let Amp open its own tabs\" setting. Close it with browser_close_tab when done.", properties: { url: { type: 'string' } }, required: ['url'] },
  { name: 'close_tab', title: 'Close tab', description: 'Close one of your own tabs.', properties: { tab }, required: ['tab'] },
  { name: 'snapshot', title: 'Read page', description: "Outline of a tab's accessibility tree, with refs (e1, e2, ...) on interactive elements for the action tools; refs expire when the page changes. Work in a loop: read the page, act with the narrowest tool, then read it again to check, since an action that returned may not have worked.", properties: { tab } },
  { name: 'screenshot', title: 'Screenshot', description: "JPEG of a tab's viewport.", properties: { tab } },
  { name: 'wait_for', title: 'Wait for page', description: 'Wait until the page shows text, its URL contains url, or an element with role (and name) appears; all given conditions must hold. Fails after timeout_ms. Read the page again afterwards.', properties: { text: { type: 'string', description: 'Text on the page; case-insensitive.' }, url: { type: 'string', description: 'A substring of the URL.' }, role: { type: 'string', description: 'A role as browser_snapshot shows it, such as button or heading.' }, name: { type: 'string', description: "Part of the element's name; needs role." }, timeout_ms: { type: 'number', description: 'Default 10000, at most 20000.' }, tab } },
  { name: 'scroll', title: 'Scroll', description: 'Scroll the page by delta_y pixels (negative scrolls up).', properties: { delta_y: { type: 'number' }, tab }, required: ['delta_y'] },
  { name: 'click', title: 'Click', description: 'Click an element by ref. The user approves each action unless they allowed this thread.', properties: { ref, tab }, required: ['ref'] },
  { name: 'type', title: 'Type', description: "Replace a field's contents by ref; submit presses Enter afterwards. Needs the user's approval. Use browser_fill for passwords and one-time codes.", properties: { ref, text: { type: 'string' }, submit: { type: 'boolean' }, tab }, required: ['ref', 'text'] },
  { name: 'fill', title: 'Fill field', description: "Like browser_type, but on password and one-time-code fields the value is hidden in the approval prompt and the result. Only enter credentials the user gave you; otherwise hand off. Needs the user's approval.", properties: { ref, value: { type: 'string' }, submit: { type: 'boolean' }, tab }, required: ['ref', 'value'] },
  { name: 'press', title: 'Press key', description: "Press a key such as Enter, Escape, Tab or ArrowDown, optionally with Shift+, Control+, Alt+ or Meta+. With ref it focuses that element first; without, the key goes to whatever has focus. Needs the user's approval.", properties: { key: { type: 'string' }, ref, tab }, required: ['key'] },
  { name: 'select', title: 'Select option', description: "Choose an option of a <select> by ref, by its value or label. For a custom dropdown, click it, then click the option. Needs the user's approval.", properties: { ref, value: { type: 'string', description: "The option's value or label." }, tab }, required: ['ref', 'value'] },
  { name: 'navigate', title: 'Navigate', description: "Load an HTTP(S) URL in a tab. Needs the user's approval; the lent tab stays on its lent site unless the user allowed other sites.", properties: { url: { type: 'string' }, tab }, required: ['url'] },
  { name: 'handoff', title: 'Hand tab to user', description: 'Show the user a card on a tab and wait (up to 30 minutes) until they click Continue. Use for logins, 2FA, captchas and payments; never solve a captcha or do those yourself, and don\'t retry a site that blocks you. If an earlier call failed while this thread\'s card was still showing, calling it again waits for that card instead of showing a new one.', properties: { message: { type: 'string', description: 'What the user should do, e.g. "Sign in to GitHub, then click Continue".' }, tab }, required: ['message'] },
]

async function handoff(target: Target, ctx: PluginToolContext, message: string, tab: unknown) {
  // If this thread's earlier call lost its wait, the bridge hands back that card instead of a new one.
  const { handoff_id: id, resumed, message: shown } = await call(target, ctx, 'handoff', { message, tab })
  // Poll in short requests: a single half-hour request would not survive the portal proxy.
  let outage = 0
  while (!ctx.signal.aborted) {
    let reply: any
    try {
      reply = await request(target, ctx.thread.id, `/handoff/${id}?wait=25000`, { signal: ctx.signal })
      outage = 0
    } catch (error: any) {
      if (ctx.signal.aborted) break
      // Keep waiting through a short portal outage; the card stays on the page meanwhile.
      if (error?.transient && ++outage <= 40) {
        await Bun.sleep(3000)
        continue
      }
      // The card may still be on the page, and the user may still finish there.
      throw new Error(`Lost the wait for the handoff (${error?.message ?? error}). The card may still be showing: call browser_handoff again to keep waiting for it, or browser_status to see whether the user continued.`)
    }
    if (reply.error) throw new Error(reply.error)
    if (!reply.result?.waiting) return JSON.stringify(resumed ? { ...reply.result, resumed_handoff: shown } : reply.result)
  }
  await request(target, ctx.thread.id, `/handoff/${id}/cancel`, { method: 'POST' }).catch(() => {})
  throw new Error('Cancelled.')
}

export default async function (amp: PluginAPI) {
  const mode = role()
  if (mode === 'off') return

  let local: Target | null = null
  if (mode === 'host') {
    let bridge: ReturnType<typeof startBridge> | null = null
    let stopped = false
    // Several Amp processes on one Mac load this plugin; the first to bind the port runs the bridge
    // and the others keep trying, so the bridge survives whichever process owns it exiting.
    const tryStart = () => {
      if (bridge) return
      try {
        bridge = startBridge({ dir, port, log: (m) => amp.logger.log(m) })
        void republish((m) => amp.logger.log(m), () => stopped)
      } catch (error: any) {
        if (error?.code !== 'EADDRINUSE') amp.logger.log(`bridge failed to start: ${error?.message ?? error}`)
      }
    }
    tryStart()
    const retry = setInterval(tryStart, 15_000)
    amp.onDispose(() => {
      stopped = true
      clearInterval(retry)
      bridge?.stop()
    })
    local = { base: `http://127.0.0.1:${port}`, token: '', portal: false }

    amp.registerTool({
      name: 'browser_bridge_publish',
      title: 'Publish browser bridge',
      description: "Expose this Mac's browser bridge to the user's orbs: registers this thread's portal for it and stores BROWSER_BRIDGE_URL and BROWSER_BRIDGE_TOKEN as the user's personal Amp secrets. Run it in a thread on the Mac when the user asks to set up or republish the browser bridge. Afterwards the bridge publishes itself again whenever it starts, through the same thread, so tell the user not to archive it.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        const ok = await ctx.ui.confirm({
          title: 'Publish the browser bridge to your orbs?',
          message: `This thread's portal will serve the bridge on port ${port}, and your personal Amp secrets BROWSER_BRIDGE_URL and BROWSER_BRIDGE_TOKEN will be updated so new orbs can reach it. Whenever the bridge starts again it re-registers the portal and updates these secrets itself. Only you can open the portal.`,
          confirmButtonText: 'Publish',
          requireHuman: true,
        })
        if (!ok) throw new Error('The user cancelled publishing.')
        const { url } = await publish(ctx.thread.id, true)
        return JSON.stringify({ portal_url: url, note: 'New orbs get these secrets when they start; running orbs need `amp orb restart-processes`. The bridge publishes itself again on every start through this thread, so keep it unarchived.' })
      },
    })

    amp.registerTool({
      name: 'browser_bridge_pair',
      title: 'Pair Chrome extension',
      description: "Pair the Chrome extension with this Mac's bridge: makes a one-time pairing code, valid for 10 minutes, and opens the extension's setup page in Chrome on this Mac with the code in it, so the extension pairs by itself. The code never leaves the Mac and is never returned.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        const reply = await request(target(), ctx.thread.id, '/pair', { method: 'POST', signal: ctx.signal })
        if (reply.error) throw new Error(reply.error)
        const code = readFileSync(join(dir, 'pairing-code'), 'utf8').trim()
        const opened = await openSetupPage(code)
        return JSON.stringify({
          valid_minutes: reply.result.valid_minutes,
          next: opened
            ? "The extension's setup page opened in Chrome on this Mac and pairs by itself. If it shows an error, ask the user to load the extension (see the README) and pair again."
            : 'Chrome could not be opened. Ask the user to run `cat ~/.amp-browser-bridge/pairing-code` on the Mac and enter the code on the extension\'s setup page (extension popup → Setup and status).',
        })
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
          if (!s.tab && !s.agent_tabs?.enabled) return JSON.stringify({ ...s, next: 'Ask the user to open the page and click Lend this tab in the extension popup.' })
          if (s.handoff?.state === 'waiting') return JSON.stringify({ ...s, next: 'Your handoff card is still waiting for the user. Call browser_handoff again to wait for it; the tab stays theirs until they click Continue.' })
          return JSON.stringify(s)
        }
        if (t.name === 'handoff') return handoff(to, ctx, String(input.message ?? ''), input.tab)
        if (MUTATING.has(t.name) || t.name === 'open_tab') await approve(to, ctx, t.name, input)
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
