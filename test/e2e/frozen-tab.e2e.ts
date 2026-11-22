// Chrome freezes background tabs, and Amp's own tabs sit hidden in a collapsed group. A frozen page
// runs no injected script, timer or event handler, yet snapshots must answer, clicks take effect,
// waits see the page change and handoff cards appear.
import { PAGE, api, call, cdp, check, done, evaluate, message, pair, targets, until, wakeWorker } from './lib'

const A = 'T-00000000-0000-0000-0000-00000000000a'
const refOf = (s: any, pattern: RegExp) => s?.outline.split('\n').find((l: string) => pattern.test(l))?.match(/\[(e\d+)\]/)?.[1]

const { send: sw } = await wakeWorker()
await pair()
check('extension pairs and connects', await until(async () => (await api('/status', null)).extension_connected))
await message({ action: 'agentTabs', enabled: true })
const tab = (await call(A, 'open_tab', { url: `${PAGE}/?frozen` })).result?.tab
check('open_tab opens a hidden tab', (await evaluate(sw, `chrome.tabs.get(${tab}).then(t => !t.active)`)) === true)

// Chrome freezes a hidden tab within seconds; a Chromium that doesn't is frozen the same way by hand.
const page = cdp((await targets()).find((t) => t.url === `${PAGE}/?frozen`).webSocketDebuggerUrl)
const frozen = () => evaluate(sw, `chrome.tabs.get(${tab}).then(t => t.frozen)`)
const forceFreeze = () => page('Page.setWebLifecycleState', { state: 'frozen' })
const freeze = async () => (await until(frozen, 50)) || (await forceFreeze(), until(frozen))
const runsTasks = () => Promise.race([evaluate(page, 'new Promise((r) => setTimeout(() => r(true), 0))'), Bun.sleep(2000).then(() => false)])

check('the tab is frozen', await freeze())
const handoff = (await call(A, 'handoff', { tab, message: 'Please check' })).result?.handoff_id
const card = () => evaluate(page, '!!document.getElementById("__amp_handoff")')
check('a handoff on a frozen tab shows its card', handoff && (await until(card, 50)), handoff)
await api(`/handoff/${handoff}/cancel`, A, { method: 'POST' })
const button = refOf((await call(A, 'snapshot', { tab })).result, /button "Press me"/)

check('the tab is frozen again', await freeze())
// The bridge gives up after 60s and reports the outcome as unknown.
const started = Date.now()
const snap = await call(A, 'snapshot', { tab })
check('snapshot of a frozen tab answers within 5s', snap.result?.outline.includes('"Nothing yet"') && Date.now() - started < 5000, { ...snap, ms: Date.now() - started })

// The handler runs during dispatch either way; a page like React's renders the result in a later
// task, and a frozen page runs none.
check('the tab is frozen again', await freeze())
const clicked = await call(A, 'click', { tab, ref: button })
check('after a click on a frozen tab, the page runs its tasks', clicked.result && (await runsTasks()), clicked)

// The page changes on a timer that comes due after the tab froze again during the wait.
await evaluate(page, `setTimeout(() => document.getElementById('out').textContent = 'Later', 1500)`)
const waiting = call(A, 'wait_for', { tab, text: 'Later', timeout_ms: 8000 })
await Bun.sleep(300)
await forceFreeze()
const waited = await waiting
check('wait_for sees a change the page makes after it froze again', waited.result?.matched, waited)

// The bot-check probe reads the page the same way.
await call(A, 'navigate', { tab, url: `${PAGE}/challenge.html` })
check('the challenge page is frozen', await freeze())
const challenge = (await call(A, 'snapshot', { tab })).result?.challenge
check('snapshot of a frozen tab reports a bot check', challenge?.vendor === 'cloudflare' && challenge.kind === 'interactive', challenge)
await call(A, 'close_tab', { tab })
done()
