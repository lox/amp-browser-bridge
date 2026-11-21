// The per-tab badge and the green "Amp" tab group, and where Stop puts the tab back.
import { PAGE, check, done, evaluate, message, pair, restartWorker, wakeWorker } from './lib'

let { send: sw } = await wakeWorker()
const ev = (expression: string) => evaluate(sw, expression)
const groupOf = (id: number) => ev(`chrome.tabs.get(${id}).then(t => t.groupId < 0 ? null : chrome.tabGroups.get(t.groupId)).then(g => g && {title: g.title, color: g.color, id: g.id})`)
const badge = (id: number) => ev(`chrome.action.getBadgeText({tabId: ${id}})`)
await pair()
await Bun.sleep(800)

// The tab we lend starts inside the user's own "Work" group.
const lentId = await ev(`chrome.tabs.query({url: '${PAGE}/*'}).then(t => t[0].id)`)
const other = await ev(`chrome.tabs.create({url: '${PAGE}/other.html', active: false}).then(t => t.id)`)
const workGroup = await ev(`chrome.tabs.group({tabIds: [${lentId}]}).then(g => chrome.tabGroups.update(g, {title: 'Work', color: 'blue'})).then(g => g.id)`)
// A global badge, as 0.1.0 left behind; the worker clears it when it starts.
await ev(`chrome.action.setBadgeText({text: 'ON'})`)
;({ send: sw } = await restartWorker())
await Bun.sleep(800)

await message({ action: 'lend', tabId: lentId })
const g = await groupOf(lentId)
check('lent tab is in a green "Amp" group', g?.title === 'Amp' && g.color === 'green', g)
check('the Amp group is a new group, not Work', g?.id !== workGroup)
check('badge ON on the lent tab', (await badge(lentId)) === 'ON')
check('no badge on another tab', (await badge(other)) === '', await badge(other))
await message({ action: 'stop' })
const back = await groupOf(lentId)
check('stop puts the tab back in a "Work" group (recreated, same colour)', back?.title === 'Work' && back.color === 'blue', back)
check('stop clears the badge on that tab', (await badge(lentId)) === '')

// A tab with no earlier group ends up ungrouped; a tab the user moved meanwhile is left alone.
await message({ action: 'lend', tabId: other })
await message({ action: 'stop' })
check('ungrouped tab returns ungrouped', (await ev(`chrome.tabs.get(${other}).then(t => t.groupId)`)) === -1)
await message({ action: 'lend', tabId: other })
const mine = await ev(`chrome.tabs.group({tabIds: [${other}]})`)
await message({ action: 'stop' })
check('user-moved tab stays where the user put it', (await ev(`chrome.tabs.get(${other}).then(t => t.groupId)`)) === mine)
done()
