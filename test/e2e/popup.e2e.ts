// The toolbar popup, clicked as a person does: Finish setup when disconnected, Lend this tab, the
// permission boxes, Release, Continue during a handoff, Let Amp open its own tabs with Show and
// Close, and Stop lending.
import { EXT, PAGE, api, call, check, done, evaluate, message, openPopup, pair, shot, targets, until, wakeWorker } from './lib'

const A = 'T-00000000-0000-0000-0000-0000000000e1'
let { send: sw } = await wakeWorker()
const ev = (expression: string) => evaluate(sw, expression)
const setupTabs = async () => (await targets()).filter((t) => t.type === 'page' && t.url === `chrome-extension://${EXT}/setup.html`).length

// Disconnected from reflector: the popup offers Finish setup and focuses the existing setup tab.
await message({ action: 'setRelay', relay: 'http://127.0.0.1:19999' })
await until(async () => (await message({ action: 'state' })).bridgeError !== '')
let popup = await openPopup(`${PAGE}/`)
check('disconnected: popup says so and offers Finish setup', (await popup.text('status')) === 'Disconnected' && (await popup.visible('openSetup')), await popup.text('status'))
await shot('1-disconnected')
const before = await setupTabs()
await popup.click('openSetup')
check('Finish setup focuses the open setup page', await until(async () => (await ev(`chrome.tabs.query({active: true, currentWindow: true}).then(t => t[0].url)`)) === `chrome-extension://${EXT}/setup.html`))
check('…without opening another', (await setupTabs()) === before && before === 1, { before, after: await setupTabs() })

await pair()
await until(async () => (await api('/status', null)).extension_connected)
popup = await openPopup(`${PAGE}/`)
check('connected: Connected, no tab lent', (await popup.text('status')) === 'Connected' && (await popup.text('detail')) === 'No tab lent.')
check('agent-tab box shows, unticked', (await popup.visible('allowAgentTabs')) && !(await popup.checked('allowAgentTabs')))

await popup.click('lend')
check('Lend this tab lends the active tab read-only', await until(async () => (await popup.text('status')) === 'Lent read-only'))
const st = await api('/status', null)
check('Amp sees the page, read-only', st.tab?.url === `${PAGE}/` && st.tab.allow_actions === false, st.tab)
check('popup names the page', (await popup.text('detail')) === 'Bridge test page')
await shot('2-lent')
await popup.click('allowActions')
check('ticking Allow clicks lets Amp act', await until(async () => (await api('/status', null)).tab?.allow_actions === true))
check('popup says Lent', (await popup.text('status')) === 'Lent')
check('the site box names the site', (await popup.text('origin')) === PAGE)
await popup.close()

// A thread takes the tab; Release hands it to the next one.
await call(A, 'snapshot')
popup = await openPopup(`${PAGE}/`)
check('popup shows which thread holds the tab', (await popup.visible('release')) && (await popup.text('leaseThread')) === A)
await popup.click('release')
check('Release frees the tab and keeps it lent', await until(async () => (await api('/status', null)).lease === null) && (await api('/status', null)).tab?.url === `${PAGE}/`)
await popup.close()

// A handoff ends with Continue in the popup, too.
const id = (await call(A, 'handoff', { message: 'Check the page, then Continue' })).result?.handoff_id
popup = await openPopup(`${PAGE}/`)
check('during a handoff the popup says Amp is waiting', (await popup.text('status')) === 'Amp is waiting for you' && (await popup.text('detail')) === 'Check the page, then Continue')
await shot('3-waiting')
await popup.click('continue')
check('Continue in the popup ends the handoff', (await api(`/handoff/${id}?wait=3000`, A)).result?.continued === true)
await popup.close()

// Let Amp open its own tabs.
check('open_tab is refused while the box is off', /hasn't let Amp open/.test((await call(A, 'open_tab', { url: `${PAGE}/other.html` })).error ?? ''))
popup = await openPopup(`${PAGE}/`)
await popup.click('allowAgentTabs')
check('ticking Let Amp open its own tabs turns it on', await until(async () => (await api('/status', A)).agent_tabs?.enabled === true))
await popup.close()
const own = (await call(A, 'open_tab', { url: `${PAGE}/other.html` })).result?.tab
check('then a thread opens a tab of its own', Number.isInteger(own))
popup = await openPopup(`${PAGE}/`)
check('the popup lists it', await until(async () => (await evaluate(popup.page, `document.querySelectorAll('#agentTabs li').length`)) === 1))
await shot('4-agent-tab')
await popup.clickText('Show')
check('Show brings it to the front', await until(async () => (await ev(`chrome.tabs.get(${own}).then(t => t.active)`)) === true))
popup = await openPopup(`${PAGE}/`)
await popup.clickText('Close')
check('Close closes it', await until(async () => !(await ev(`chrome.tabs.get(${own}).then(() => true, () => false)`))))
const second = (await call(A, 'open_tab', { url: `${PAGE}/other.html` })).result?.tab
await popup.close()
popup = await openPopup(`${PAGE}/`)
await popup.click('allowAgentTabs')
check("unticking it closes Amp's tabs", await until(async () => !(await ev(`chrome.tabs.get(${second}).then(() => true, () => false)`))))
check('…but not the lent tab', (await api('/status', null)).tab?.url === `${PAGE}/`)

await popup.click('stop')
check('Stop lending takes the tab back', await until(async () => (await api('/status', null)).tab === null))
check('…and ungroups it', await until(async () => (await ev(`chrome.tabs.query({url: '${PAGE}/'}).then(t => t[0].groupId)`)) === -1))
check('popup says Connected again', await until(async () => (await popup.text('status')) === 'Connected'))
done()
