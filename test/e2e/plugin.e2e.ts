// Runs the real plugin against the blind reflector: tool registration, approval dialogs, per-site
// allowances, screenshot inline fallback, and handoff polling and cancelling.
import { PAGE, cdp, check, done, evaluate, message, pageTarget, pair, readSetupKey, showTab, trustedClick, until, wakeWorker } from './lib'

const { send: sw } = await wakeWorker()
await pair()
process.env.BROWSER_BRIDGE_KEY = await readSetupKey()

const plugin = (await import('../../plugin/index')).default
const tools = new Map<string, any>()
await plugin({ registerTool: (t: any) => tools.set(t.name, t), logger: { log() {} }, onDispose() {}, attachments: { upload: async () => { throw new Error('offline') } } } as any)
const dialogs: any[] = []
let answer = 'Allow once'
const ctx = (thread = 'T-00000000-0000-0000-0000-0000000000c1') => ({ thread: { id: thread }, signal: new AbortController().signal, ui: { select: async (o: any) => (dialogs.push(o), answer) }, logger: { log() {} } })
const run = async (name: string, input: any = {}, c: any = ctx()) => { try { return { ok: await tools.get(name).execute(input, c) } } catch (e: any) { return { err: e.message as string } } }
const snapshot = async () => (await run('browser_snapshot')).ok as string
const ref = (re: RegExp, s: string) => s.split('\n').find((l) => re.test(l))?.match(/\[(e\d+)\]/)?.[1]

{
  const names = [...tools.keys()]
  const core = ['status', 'snapshot', 'screenshot', 'scroll', 'click', 'type', 'navigate', 'handoff', 'open_tab', 'close_tab'].map((t) => `browser_${t}`)
  check('registers the page tools and browser_bridge_connect (no host-only pair or publish)', core.every((t) => tools.has(t)) && tools.has('browser_bridge_connect') && !tools.has('browser_bridge_publish') && !tools.has('browser_bridge_pair'), names)
  // A thread only sees undeferred tools before it searches, so "I lent you a tab" has to land on browser_status.
  const upFront = names.filter((t) => tools.get(t).defer === false)
  check('only browser_status is in the tool list up front, and it says what lending means', upFront.join() === 'browser_status' && /lent \(or will lend\) you a tab/.test(tools.get('browser_status').description), upFront)
}

check('extension connects through the reflector', await until(async () => JSON.parse((await run('browser_status')).ok ?? '{}').extension_connected))
const lend = (tabId: number) => message({ action: 'lend', tabId })
const permissions = (allowActions: boolean, anyOrigin: boolean) => message({ action: 'permissions', allowActions, anyOrigin })
const tabId = await evaluate(sw, `chrome.tabs.query({url: '${PAGE}/*'}).then(t => t[0].id)`)
// A person lends the tab they're looking at; Chrome drops input to a tab that was never shown.
await showTab(`${PAGE}/`)
await lend(tabId)
await message({ action: 'release' })

const status = JSON.parse((await run('browser_status')).ok)
check('status: connected, lent read-only', status.extension_connected && status.tab?.allow_actions === false, status)
const snap = await snapshot()
check('snapshot text has title, url and outline', snap.startsWith(`Bridge test page\n${PAGE}/`) && ref(/button "Press me"/, snap), snap)
const ro = await run('browser_click', { ref: ref(/button "Press me"/, snap) })
check('read-only: refused before asking the user', /read-only/.test(ro.err ?? '') && dialogs.length === 0, ro)

await permissions(true, false)
answer = 'Deny'
const denied = await run('browser_click', { ref: ref(/button "Press me"/, snap) })
check('deny: tool fails and nothing is clicked', /denied/.test(denied.err ?? '') && !(await snapshot()).includes('Clicked!'), denied)
check('dialog names the element and requires a human', /button “Press me” on http:\/\/127.0.0.1:8765\//.test(dialogs[0]?.message) && dialogs[0]?.requireHuman === true, dialogs[0])
answer = 'Allow once'
check('allow once: click lands', (await run('browser_click', { ref: ref(/button "Press me"/, await snapshot()) })).ok && (await snapshot()).includes('"Clicked!"'))
answer = `Allow on ${PAGE} in the lent tab for this thread`
const before = dialogs.length
await run('browser_type', { ref: ref(/textbox "Search"/, await snapshot()), text: 'from plugin', submit: true })
check('type dialog quotes the text', /from plugin/.test(dialogs.at(-1).message) && /press Enter/.test(dialogs.at(-1).message))
await run('browser_type', { ref: ref(/textbox "Search"/, await snapshot()), text: 'again' })
check('allow for this thread: no second dialog', dialogs.length === before + 1, dialogs.length - before)
check('other thread still asks and is blocked by the lease', /in use by thread/.test((await run('browser_snapshot', {}, ctx('T-00000000-0000-0000-0000-0000000000c2'))).err ?? ''))

const shot = (await run('browser_screenshot')).ok as any
check('screenshot falls back to inline base64 when upload fails', shot?.[0]?.type === 'image' && shot[0].data?.length > 1000, shot?.[0]?.type)

// Handoff through the plugin: it polls until a trusted click on Continue.
const handoff = run('browser_handoff', { message: 'Please click Continue' })
const page = cdp((await pageTarget()).webSocketDebuggerUrl)
let rect: any
for (let i = 0; i < 50 && !rect; i++) {
  await Bun.sleep(100)
  rect = JSON.parse((await page('Runtime.evaluate', { expression: 'JSON.stringify(document.getElementById("__amp_handoff")?.getBoundingClientRect() ?? null)', returnByValue: true })).result.value)
}
await Bun.sleep(1500)
await page('Page.bringToFront')
await trustedClick(page, rect.left + 30, rect.bottom - 26)
const h = await handoff
check('handoff tool returns after Continue', JSON.parse(h.ok ?? '{}').continued === true, h)

// Cancelling the tool call cancels the handoff and removes the card.
const ac = new AbortController()
const cancelled = run('browser_handoff', { message: 'will be cancelled' }, { ...ctx(), signal: ac.signal })
await Bun.sleep(800)
ac.abort()
const cr = await cancelled
await Bun.sleep(500)
const cardLeft = (await page('Runtime.evaluate', { expression: '!!document.getElementById("__amp_handoff")', returnByValue: true })).result.value
check('aborted handoff tool cancels and removes the card', cr.err && cardLeft === false, { cr, cardLeft })

// "Allow on <site> for this thread" doesn't carry over to another site.
await permissions(true, true)
answer = 'Allow once'
const n0 = dialogs.length
await run('browser_navigate', { url: 'http://localhost:8765/' })
check('navigate dialog shows the normalised URL and site', /http:\/\/localhost:8765\/ \(site \*\*http:\/\/localhost:8765\*\*\)/.test(dialogs.at(-1)?.message ?? ''), dialogs.at(-1)?.message)
await Bun.sleep(500)
await lend(tabId)
await permissions(true, false)
await run('browser_click', { ref: ref(/button "Press me"/, await snapshot()) })
check('allowance on one site does not cover another', dialogs.length === n0 + 2, dialogs.length - n0)
await message({ action: 'stop' })
done()
