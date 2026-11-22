// Amp's own tabs, with two threads: off by default, opening in the background in a collapsed Amp
// group, page tools in them, ownership, a handoff in one ended from the popup, idle close by the
// extension's own alarm, turning it off, and tabs that become the user's.
import { PAGE, api, call, check, done, known, evaluate, message, openPopup, pair, refOf, shot, until, wakeWorker } from './lib'

const A = 'T-00000000-0000-0000-0000-00000000000a', B = 'T-00000000-0000-0000-0000-00000000000b'
const IDLE_MS = 10 * 60_000 // AGENT_TAB_IDLE_MS in extension/background.js
let { send: sw } = await wakeWorker()
const ev = async (expression: string) => {
  ;({ send: sw } = await wakeWorker())
  return evaluate(sw, expression)
}
const exists = (id: number) => ev(`chrome.tabs.get(${id}).then(() => true, () => false)`)
const records = () => ev(`chrome.storage.local.get('agentTabs').then(r => r.agentTabs ?? {})`)
const setRecord = (id: number, change: string) => ev(`chrome.storage.local.get('agentTabs').then(r => { const t = r.agentTabs ?? {}; t[${id}] = {...t[${id}], ...${change}}; return chrome.storage.local.set({agentTabs: t}) })`)
// The extension's idle sweep runs on the "close-idle-agent-tabs" alarm; fire it now, then put the minute alarm back.
async function sweep() {
  await ev(`chrome.alarms.create('close-idle-agent-tabs', {when: Date.now()})`)
  await until(async () => !(await ev(`chrome.alarms.get('close-idle-agent-tabs')`)))
  await Bun.sleep(500)
  await ev(`chrome.alarms.create('close-idle-agent-tabs', {periodInMinutes: 1})`)
}

await pair()
check('extension pairs', await until(async () => (await api('/status', null)).extension_connected))

// Off by default: nothing opens.
const before = await ev(`chrome.tabs.query({}).then(t => t.length)`)
check('open_tab refused while off', /hasn't let Amp open/.test((await call(A, 'open_tab', { url: `${PAGE}/` })).error ?? ''))
check('no tab opened while off', (await ev(`chrome.tabs.query({}).then(t => t.length)`)) === before)

// A lends the page tab (read-only); B is locked out of it, but not out of its own tabs.
const lentId = await ev(`chrome.tabs.query({url: '${PAGE}/'}).then(t => t[0].id)`)
await message({ action: 'lend', tabId: lentId })
await call(A, 'snapshot')
await message({ action: 'agentTabs', enabled: true })
check('status reports agent tabs enabled', (await api('/status', B)).agent_tabs?.enabled === true)
const opened = await call(B, 'open_tab', { url: `${PAGE}/other.html` })
const tabB = opened.result?.tab
check('B opens its own tab while A holds the lent tab', Number.isInteger(tabB), opened)
const info = await ev(`chrome.tabs.get(${tabB}).then(async t => ({active: t.active, status: t.status, url: t.url, group: t.groupId < 0 ? null : await chrome.tabGroups.get(t.groupId)}))`)
check('it opens in the background, loaded', info.active === false && info.status === 'complete' && info.url.endsWith('/other.html'), info)
check('in a collapsed green Amp group', info.group?.title === 'Amp' && info.group.color === 'green' && info.group.collapsed === true, info.group)
check("not in the lent tab's group", info.group?.id !== (await ev(`chrome.tabs.get(${lentId}).then(t => t.groupId)`)))
check('badge ON on the agent tab', (await ev(`chrome.action.getBadgeText({tabId: ${tabB}})`)) === 'ON')
const tabB2 = (await call(B, 'open_tab', { url: `${PAGE}/` })).result?.tab
check('a second tab joins the same group', (await ev(`chrome.tabs.get(${tabB2}).then(t => t.groupId)`)) === info.group?.id)
await shot('1-agent-tabs')

let snap = (await call(B, 'snapshot', { tab: tabB2 })).result
const button = refOf(snap, /button "Press me"/), box = refOf(snap, /textbox "Search"/)
check('snapshot of a background tab', !!button && !!box, snap)
// A real window drops mouse and key input to a tab that was never shown, though the tools report success.
const NEVER_SHOWN = 'input to a never-shown background tab is dropped'
check('click reports success in its own tab (no lent-tab read-only)', (await call(B, 'click', { tab: tabB2, ref: button })).result?.clicked === button)
known('…and the page got the click', /"Clicked!"/.test((await call(B, 'snapshot', { tab: tabB2 })).result?.outline), NEVER_SHOWN)
const typed = await call(B, 'type', { tab: tabB2, ref: box, text: 'hub', submit: true })
check('type works in a background tab', typed.result?.typed === box, typed)
snap = (await call(B, 'snapshot', { tab: tabB2 })).result
known('…and Enter submitted the form', /Submitted: hub/.test(snap?.outline), NEVER_SHOWN)
const nav = await call(B, 'navigate', { tab: tabB2, url: 'http://localhost:8765/other.html' })
check('navigate to another site in its own tab', nav.result?.url?.includes('localhost'), nav)
const shotB = (await call(B, 'screenshot', { tab: tabB })).result
check('screenshot of a never-shown background tab', shotB?.mime_type === 'image/jpeg' && shotB.data.length > 2000, shotB?.data?.length ?? shotB)

// Ownership and the lent tab's own limits are unchanged.
check("A cannot use B's tab", /belongs to another thread/.test((await call(A, 'snapshot', { tab: tabB })).error ?? ''))
check('a tab Amp did not open is refused', /not one of Amp's/.test((await call(B, 'snapshot', { tab: lentId })).error ?? ''))
check('lent tab still read-only', /read-only/.test((await call(A, 'click', { ref: 'e1' })).error ?? ''))
check('B still locked out of the lent tab', /in use by thread/.test((await call(B, 'snapshot')).error ?? ''))
const sB = await api('/status', B), sA = await api('/status', A)
check('status shows each thread only its own tabs', sB.agent_tabs.tabs.length === 2 && sA.agent_tabs.tabs.length === 0, { sA: sA.agent_tabs, sB: sB.agent_tabs })

// A handoff in a background tab: its group opens, WAIT shows everywhere, the popup says where, and
// its Continue button ends it.
await ev(`chrome.tabGroups.update(${info.group.id}, {collapsed: true})`)
const h = await call(B, 'handoff', { tab: tabB, message: 'Sign in here' })
check('handoff on an agent tab starts', !!h.result?.handoff_id, h)
check('its group expands', await until(async () => (await ev(`chrome.tabGroups.get(${info.group.id}).then(g => g.collapsed)`)) === false))
check('WAIT on the agent tab', (await ev(`chrome.action.getBadgeText({tabId: ${tabB}})`)) === 'WAIT')
check('WAIT shown on other tabs too', (await ev(`chrome.action.getBadgeText({})`)) === 'WAIT')
check('lent tab shows WAIT too', (await ev(`chrome.action.getBadgeText({tabId: ${lentId}})`)) === 'WAIT')
const st = await message({ action: 'state' })
check('popup state names the waiting tab', st.waitingTab === tabB && st.agentTabs.tabs.length === 2, { w: st.waitingTab, n: st.agentTabs.tabs.length })
check("the tab is the user's during the handoff", /handoff/.test((await call(B, 'snapshot', { tab: tabB })).error ?? ''))
check('close_tab refused during its handoff', /handoff/.test((await call(B, 'close_tab', { tab: tabB })).error ?? ''))
check('the lent tab still works for A', !!(await call(A, 'snapshot')).result?.outline)
const popup = await openPopup(`${PAGE}/`)
check('the popup says Amp waits in one of its tabs', (await popup.text('status')) === 'Amp is waiting for you in one of its tabs')
check('…and marks that tab in its list', /Amp needs you/.test(await popup.text('agentTabs')))
await shot('2-handoff-in-agent-tab')
await popup.click('continue')
check('Continue in the popup ends it', (await api(`/handoff/${h.result.handoff_id}?wait=5000`, B)).result?.continued === true)
check('global WAIT cleared', await until(async () => (await ev(`chrome.action.getBadgeText({})`)) === ''))
check('lent tab back to ON', (await ev(`chrome.action.getBadgeText({tabId: ${lentId}})`)) === 'ON')

// Close, idle close, and turning it off.
check('close_tab closes it', (await call(B, 'close_tab', { tab: tabB2 })).result?.closed === tabB2 && !(await exists(tabB2)))
check("A cannot close B's tab", /belongs to another thread/.test((await call(A, 'close_tab', { tab: tabB })).error ?? ''))
await setRecord(tabB, `{lastUsed: Date.now() - ${IDLE_MS} + 60_000}`)
await sweep()
check('not closed before 10 idle minutes', await exists(tabB))
await setRecord(tabB, `{lastUsed: Date.now() - ${IDLE_MS}}`)
await sweep()
check('closed by the idle alarm after 10 idle minutes', await until(async () => !(await exists(tabB))))
const t3 = (await call(B, 'open_tab', { url: `${PAGE}/` })).result?.tab
const userTab = await ev(`chrome.tabs.create({url: '${PAGE}/other.html', active: false}).then(t => t.id)`)
await message({ action: 'agentTabs', enabled: false })
check("turning it off closes Amp's tabs", !(await exists(t3)))
check("…but not the user's or the lent tab", (await exists(userTab)) && (await exists(lentId)))
check('lent tab still lent', (await api('/status', A)).tab?.url === `${PAGE}/`)

// The user closing one of Amp's tabs by hand.
await message({ action: 'agentTabs', enabled: true })
const t4 = (await call(B, 'open_tab', { url: `${PAGE}/` })).result?.tab
await ev(`chrome.tabs.remove(${t4})`)
check('a tab the user closed is forgotten', await until(async () => (await api('/status', B)).agent_tabs.tabs.length === 0))

// A stale record (Chrome restarted without onStartup) naming one of the user's tabs: never used, never closed.
const mine = await ev(`chrome.tabs.create({url: '${PAGE}/', active: false}).then(t => t.id)`)
await setRecord(mine, `{thread: '${B}', lastUsed: 0, groupId: 999999}`)
check('stale record: the user tab is refused', /not one of Amp's/.test((await call(B, 'snapshot', { tab: mine })).error ?? ''))
await setRecord(mine, `{thread: '${B}', lastUsed: 0, groupId: 999999}`)
await sweep()
await message({ action: 'agentTabs', enabled: false })
await message({ action: 'agentTabs', enabled: true })
check('stale record: the user tab is never closed', await exists(mine))
check('stale record: forgotten', !((mine as number) in (await records())))

// Dragging a tab out of the group makes it the user's.
const t5 = (await call(B, 'open_tab', { url: `${PAGE}/` })).result?.tab
await ev(`chrome.tabs.ungroup(${t5})`)
check('dragged out of the group: refused', await until(async () => /not one of Amp's/.test((await call(B, 'snapshot', { tab: t5 })).error ?? '')))
check('dragged out of the group: still open', await exists(t5))

// Lending one of Amp's tabs makes it the user's; Stop leaves it ungrouped.
const t6 = (await call(B, 'open_tab', { url: `${PAGE}/` })).result?.tab
await message({ action: 'lend', tabId: t6 })
check("a lent Amp tab is no longer Amp's", !((t6 as number) in (await records())))
await message({ action: 'stop' })
check('…and Stop leaves it ungrouped', (await ev(`chrome.tabs.get(${t6}).then(t => t.groupId)`)) === -1)
done()
