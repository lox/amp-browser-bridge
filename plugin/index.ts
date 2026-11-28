import type { PluginAPI, PluginToolContext } from '@ampcode/plugin'
import { createClient, type BridgeClient } from './crypto'

export const description = 'Lets Amp threads across orbs and runners use one Chrome tab you lend, or background tabs they open, end-to-end encrypted through a blind reflector.'

let cachedKey = ''
let cachedClient: BridgeClient | null = null

function clientFor(): BridgeClient {
  const raw = (process.env.BROWSER_BRIDGE_KEY ?? '').trim()
  if (!raw) {
    throw new Error(
      'BROWSER_BRIDGE_KEY is not set. Ask the user to copy the setup key from Chrome (Amp Browser Bridge icon → Setup and status → Copy setup key). To store it for orbs and `--amp-env` runners, call `manage_amp` (`topic: "secrets"`, `operation: "set"`, `parameters: { scope: "personal", name: "BROWSER_BRIDGE_KEY" }`) so they can paste it into Amp\'s secret dialog, then run `amp orb restart-processes` in a running orb. On a runner without `--amp-env`, enable `"amp.runner.env.enabled": true` in `~/.config/amp/settings.json` or set `BROWSER_BRIDGE_KEY` in the runner environment.',
    )
  }
  if (!cachedClient || cachedKey !== raw) {
    cachedClient = createClient(raw)
    cachedKey = raw
  }
  return cachedClient
}

async function call(client: BridgeClient, ctx: PluginToolContext, tool: string, args: Record<string, unknown>) {
  const reply = await client.call(ctx.thread.id, tool, args, ctx.signal)
  if (reply.error) throw new Error(reply.unknown ? `${reply.error} Check the page before retrying.` : reply.error)
  return reply.result
}

// ---- Approval for actions that change the page ----

/** "Allow for this thread" answers, scoped to browser key, thread, tab kind and site. */
const allowed = new Set<string>()

async function approve(client: BridgeClient, ctx: PluginToolContext, tool: string, input: Record<string, unknown>) {
  // Don't ask the user to approve something the extension will refuse anyway.
  const { extension_connected, tab, agent_tabs, lease } = await client.request(ctx.thread.id, '/status', { signal: ctx.signal })
  if (!extension_connected) throw new Error('The browser extension is not connected to the reflector. Ask the user to open Chrome.')
  const own = tool === 'open_tab' || input.tab != null
  if (own) {
    if (!agent_tabs?.enabled) throw new Error('The user has not let Amp open its own tabs. Ask them to turn on "Let Amp open its own tabs" in the extension popup.')
    if (input.tab != null && !agent_tabs.tabs.some((t: { tab: number }) => t.tab === input.tab)) throw new Error(`Tab ${input.tab} is not one of this thread's tabs. Open one with browser_open_tab.`)
  } else {
    if (!tab) throw new Error('No tab is lent. Ask the user to open the page and click Lend this tab in the extension popup, or open a tab of your own with browser_open_tab.')
    if (!tab.allow_actions) throw new Error('This tab is lent read-only. Ask the user to turn on "Allow clicks, typing and navigation" in the extension popup.')
    if (lease && lease.thread !== ctx.thread.id) {
      throw new Error(`The lent tab is in use by thread ${lease.thread}. Ask the user to release it from the extension popup, or wait until it has been idle for 10 minutes.`)
    }
  }
  let url: URL | null = null
  let d: { role?: string; name?: string; url: string; secret?: boolean; doc?: string; focused?: number } | null = null
  if (tool === 'navigate' || tool === 'open_tab') {
    try {
      url = new URL(String(input.url))
    } catch {
      throw new Error('navigate needs an absolute http(s) URL.')
    }
    // The extension refuses these too; say so before asking the user to approve.
    if (url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && /^\/webstore(\/|$)/.test(url.pathname))) {
      throw new Error("Chrome never lets extensions control Chrome Web Store pages (chromewebstore.google.com and chrome.google.com/webstore), so Amp can't open or use this page, now or on a retry. Ask the user to do this step in Chrome by hand.")
    }
  } else {
    // Without a ref (press on whatever has focus), describe returns only the page's URL.
    d = await call(client, ctx, 'describe', { ref: input.ref, tab: input.tab })
    // A key for whatever has focus goes only to the page the user approved it on.
    if (tool === 'press' && !input.ref && d?.doc) Object.assign(input, { doc: d.doc, url: d.url, focused: d.focused })
    // A value the prompt hid stays hidden in the result, even if the field stops being a password.
    if (tool === 'fill' && d?.secret) input.secret = true
  }
  // An allowance covers one browser key and one thread on one site.
  const site = url ? url.origin : new URL(d!.url).origin
  const key = `${client.gateId} ${ctx.thread.id} ${own ? 'own' : 'lent'} ${site}`
  if (allowed.has(key)) return
  let what: string
  if (url) {
    what =
      tool === 'open_tab'
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

// ---- Bot challenges ----

type Challenge = { vendor: string; kind: 'non-interactive' | 'interactive' | 'block'; signal: string; url: string; waited_ms: number }

/** What the agent should do about a bot challenge the extension found on the page (extension/challenge.js). */
export function challengeAdvice(c: Challenge): string {
  let site = c.url
  try {
    site = new URL(c.url).origin
  } catch {}
  if (c.kind === 'block') {
    return `${site} refused the visit (${c.vendor} block page, ${c.signal}). Don't retry or reload: that makes the block worse for the user's IP and account. Stop and tell the user.`
  }
  const still = c.waited_ms > 0 ? `, still there after ${Math.round(c.waited_ms / 1000)} s` : ''
  return `${site} shows a ${c.vendor} bot check (${c.signal}${still}). Don't retry, reload or try to solve it: call browser_handoff with a message like "Complete the security check on ${site}, then click Continue", then take a new snapshot.`
}

// ---- Tools ----

const ref = { type: 'string', description: 'Element ref such as e12 from the latest browser_snapshot of the same tab.' }
const tab = { type: 'number', description: 'One of your own tabs, from browser_open_tab. Omit for the tab the user lent.' }
/** Tools that change the page: the extension refuses them on a read-only tab, and the user approves each. */
const MUTATING = new Set(['click', 'type', 'fill', 'press', 'select', 'navigate'])
const tools: { name: string; title: string; description: string; properties?: Record<string, object>; required?: string[]; defer?: boolean }[] = [
  // The only tool in every thread's tool list, so a thread knows what "I lent you a tab" means
  // without first searching for the deferred browser_* tools.
  { name: 'status', title: 'Browser status', defer: false, description: "Amp Browser Bridge: the user can lend you a tab in their own Chrome through its extension. Call this first when the user says they lent (or will lend) you a tab, or asks you to use their browser, their Chrome or a site they're signed in to; don't use agent-browser or a sandbox browser for that. It reports whether their Chrome is connected, which tab is lent and whether it allows actions, which thread holds it, and how this thread's latest handoff stands (waiting, continued or ended). Call it again after a browser_handoff call fails. When it returns `next`, tell the user that step and wait for them; don't retry. The other browser_* tools (snapshot, screenshot, click, type, navigate, handoff and more) may come through tool_search." },
  { name: 'open_tab', title: 'Open tab', description: "Open a URL in a new background tab of your own, in a collapsed Amp tab group, and return its `tab` id for the other tools. Only you can use it; it closes after 10 idle minutes. Needs the user's approval and their \"Let Amp open its own tabs\" setting. Close it with browser_close_tab when done. Like browser_navigate, it reports a bot check or block page in challenge and next.", properties: { url: { type: 'string' } }, required: ['url'] },
  { name: 'close_tab', title: 'Close tab', description: 'Close one of your own tabs.', properties: { tab }, required: ['tab'] },
  { name: 'snapshot', title: 'Read page', description: "Outline of a tab's accessibility tree, with refs (e1, e2, ...) on interactive elements for the action tools; refs expire when the page changes. Work in a loop: read the page, act with the narrowest tool, then read it again to check, since an action that returned may not have worked. If the page is a bot check or block page, the outline starts with what to do instead.", properties: { tab } },
  { name: 'screenshot', title: 'Screenshot', description: "JPEG of a tab's viewport.", properties: { tab } },
  { name: 'wait_for', title: 'Wait for page', description: 'Wait until the page shows text, its URL contains url, or an element with role (and name) appears; all given conditions must hold. Fails after timeout_ms. Read the page again afterwards.', properties: { text: { type: 'string', description: 'Text on the page; case-insensitive.' }, url: { type: 'string', description: 'A substring of the URL.' }, role: { type: 'string', description: 'A role as browser_snapshot shows it, such as button or heading.' }, name: { type: 'string', description: "Part of the element's name; needs role." }, timeout_ms: { type: 'number', description: 'Default 10000, at most 20000.' }, tab } },
  { name: 'scroll', title: 'Scroll', description: 'Scroll the page by delta_y pixels (negative scrolls up).', properties: { delta_y: { type: 'number' }, tab }, required: ['delta_y'] },
  { name: 'click', title: 'Click', description: 'Click an element by ref. The user approves each action unless they allowed this thread.', properties: { ref, tab }, required: ['ref'] },
  { name: 'type', title: 'Type', description: "Replace a field's contents by ref; submit presses Enter afterwards. Needs the user's approval. Use browser_fill for passwords and one-time codes.", properties: { ref, text: { type: 'string' }, submit: { type: 'boolean' }, tab }, required: ['ref', 'text'] },
  { name: 'fill', title: 'Fill field', description: "Like browser_type, but on password and one-time-code fields the value is hidden in the approval prompt and the result. Only enter credentials the user gave you; otherwise hand off. Needs the user's approval.", properties: { ref, value: { type: 'string' }, submit: { type: 'boolean' }, tab }, required: ['ref', 'value'] },
  { name: 'press', title: 'Press key', description: "Press a key such as Enter, Escape, Tab or ArrowDown, optionally with Shift+, Control+, Alt+ or Meta+. With ref it focuses that element first; without, the key goes to whatever has focus. Needs the user's approval.", properties: { key: { type: 'string' }, ref, tab }, required: ['key'] },
  { name: 'select', title: 'Select option', description: "Choose an option of a <select> by ref, by its value or label. For a custom dropdown, click it, then click the option. Needs the user's approval.", properties: { ref, value: { type: 'string', description: "The option's value or label." }, tab }, required: ['ref', 'value'] },
  { name: 'navigate', title: 'Navigate', description: "Load an HTTP(S) URL in a tab and wait for it to load. Needs the user's approval; the lent tab stays on its lent site unless the user allowed other sites. Returns url and title, plus download when the URL started a download instead of loading a page (the tab stays where it was); when the page is a bot check (Cloudflare, a captcha wall) or an \"access denied\" block page, also challenge and next: follow next, usually browser_handoff, and never retry the navigation.", properties: { url: { type: 'string' }, tab }, required: ['url'] },
  { name: 'handoff', title: 'Hand tab to user', description: 'Show the user a card on a tab and wait (up to 30 minutes) until they click Continue. Use for logins, 2FA, captchas, bot checks and payments; never solve a captcha or do those yourself, and don\'t retry a site that blocks you. If an earlier call failed while this thread\'s card was still showing, calling it again waits for that card instead of showing a new one.', properties: { message: { type: 'string', description: 'What the user should do, e.g. "Sign in to GitHub, then click Continue".' }, tab }, required: ['message'] },
]

async function handoff(client: BridgeClient, ctx: PluginToolContext, message: string, tab: unknown) {
  // If this thread's earlier call lost its wait, Chrome hands back that card instead of a new one.
  const { handoff_id: id, resumed, message: shown } = await call(client, ctx, 'handoff', { message, tab })
  // Poll in 25s slices so idle HTTP timeouts on proxies never cut off a 30-minute wait.
  let outage = 0
  while (!ctx.signal.aborted) {
    let reply: any
    try {
      reply = await client.request(ctx.thread.id, `/handoff/${id}?wait=25000`, { signal: ctx.signal })
      outage = 0
    } catch (error: any) {
      if (ctx.signal.aborted) break
      if (error?.transient && ++outage <= 40) {
        await Bun.sleep(3000)
        continue
      }
      throw new Error(`Lost the wait for the handoff (${error?.message ?? error}). The card may still be showing: call browser_handoff again to keep waiting for it, or browser_status to see whether the user continued.`)
    }
    if (reply.error) throw new Error(reply.error)
    if (!reply.result?.waiting) return JSON.stringify(resumed ? { ...reply.result, resumed_handoff: shown } : reply.result)
  }
  await client.request(ctx.thread.id, `/handoff/${id}/cancel`, { method: 'POST' }).catch(() => {})
  throw new Error('Cancelled.')
}

export default async function (amp: PluginAPI) {
  if (process.env.AMP_BROWSER_BRIDGE_ROLE === 'off') return

  for (const t of tools) {
    amp.registerTool({
      name: `browser_${t.name}`,
      title: t.title,
      defer: t.defer,
      transcriptGroup: { active: 'Using your browser', complete: 'Used your browser' },
      description: `${t.description} Acts in the user's real, signed-in Chrome.`,
      inputSchema: { type: 'object', properties: t.properties ?? {}, required: t.required ?? [], additionalProperties: false },
      async execute(input, ctx) {
        const client = clientFor()
        if (t.name === 'status') {
          const s = await client.request(ctx.thread.id, '/status', { signal: ctx.signal })
          if (!s.extension_connected) return JSON.stringify({ ...s, next: 'Ask the user to open Chrome; the extension connects by itself.' })
          if (!s.tab && !s.agent_tabs?.enabled) return JSON.stringify({ ...s, next: 'Ask the user to open the page and click Lend this tab in the extension popup.' })
          if (s.handoff?.state === 'waiting') return JSON.stringify({ ...s, next: 'Your handoff card is still waiting for the user. Call browser_handoff again to wait for it; the tab stays theirs until they click Continue.' })
          return JSON.stringify(s)
        }
        if (t.name === 'handoff') return handoff(client, ctx, String(input.message ?? ''), input.tab)
        if (MUTATING.has(t.name) || t.name === 'open_tab') await approve(client, ctx, t.name, input)
        if (ctx.signal.aborted) throw new Error('Cancelled.')
        const result = await call(client, ctx, t.name, input)
        if (t.name === 'screenshot') {
          try {
            const { url } = await amp.attachments.upload({ data: Buffer.from(result.data, 'base64'), mimeType: 'image/jpeg' })
            return [{ type: 'image', mimeType: 'image/jpeg', url }]
          } catch {
            return [{ type: 'image', mimeType: 'image/jpeg', data: result.data }]
          }
        }
        const advice = result.challenge ? challengeAdvice(result.challenge) : ''
        if (t.name === 'snapshot') return `${advice ? `${advice}\n\n` : ''}${result.title}\n${result.url}${result.truncated ? '\n(truncated)' : ''}\n\n${result.outline}`
        return JSON.stringify(advice ? { ...result, next: advice } : result)
      },
    })
  }
}
