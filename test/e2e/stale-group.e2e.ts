// Release keeps the tab grouped; a lend that ends without Stop (Reload in chrome://extensions) still clears
// the Amp group and leaves the user's own groups alone.
import { PAGE, check, done, evaluate, message, pair, reloadExtension, restartWorker, until, wakeWorker } from './lib'

let { send: sw } = await wakeWorker()
const ev = (expression: string) => evaluate(sw, expression)
const groupOf = (id: number) => ev(`chrome.tabs.get(${id}).then(t => t.groupId < 0 ? null : chrome.tabGroups.get(t.groupId)).then(g => g && g.title)`)
const groupId = (id: number) => ev(`chrome.tabs.get(${id}).then(t => t.groupId)`)
const cleanupRecord = () => ev(`chrome.storage.local.get('ampGroup').then(r => r.ampGroup ?? null)`)
await pair()
await Bun.sleep(800)

// The user's own tabs: one in a group they also named "Amp" in green, and the lent tab starts in "Work".
const tab = await ev(`chrome.tabs.query({url: '${PAGE}/*'}).then(t => t[0].id)`)
const mine = await ev(`chrome.tabs.create({url: '${PAGE}/other.html', active: false}).then(t => t.id)`)
const mineGroup = await ev(`chrome.tabs.group({tabIds: [${mine}]}).then(g => chrome.tabGroups.update(g, {title: 'Amp', color: 'green'})).then(g => g.id)`)
await ev(`chrome.tabs.group({tabIds: [${tab}]}).then(g => chrome.tabGroups.update(g, {title: 'Work', color: 'blue'}))`)
await message({ action: 'lend', tabId: tab })
check("lent tab is in a new Amp group, not the user's", (await groupOf(tab)) === 'Amp' && (await groupId(tab)) !== mineGroup)
await message({ action: 'release' }) // what the popup's Release does
check('Release keeps the tab lent and grouped', (await message({ action: 'state' })).lend && (await groupOf(tab)) === 'Amp')

// An idle worker restart keeps session storage, so the group must stay.
;({ send: sw } = await restartWorker())
await Bun.sleep(800)
check('worker restart while lent keeps the group', (await message({ action: 'state' })).lend && (await groupOf(tab)) === 'Amp')

// Reload on chrome://extensions, as after a change to extension/: session storage is wiped and a
// fresh worker starts.
;({ send: sw } = await reloadExtension())
await Bun.sleep(800)
check('after extension reload nothing is lent', (await message({ action: 'state' })).lend === null)
check('after extension reload it reconnects without pairing again', await until(async () => (await message({ action: 'state' })).connected))
check('after extension reload the lent tab is back in Work', (await groupOf(tab)) === 'Work', await groupOf(tab))
check("the user's own green \"Amp\" group is untouched", (await groupId(mine)) === mineGroup)
check('the cleanup record is cleared', (await cleanupRecord()) === null)

// Stop still restores an earlier group, and leaves no record behind.
await message({ action: 'reconnect' })
await Bun.sleep(800)
await message({ action: 'lend', tabId: tab })
await message({ action: 'stop' })
check('Stop still puts the tab back in Work', (await groupOf(tab)) === 'Work')
check('Stop clears the cleanup record', (await cleanupRecord()) === null)
check("the user's group still untouched", (await groupId(mine)) === mineGroup)
done()
