// A lend from start to finish, driven over the bridge's HTTP API as two threads: pairing, read-only,
// the lease, a worker restart, click and type, overlays, the site limit, stale refs and a handoff.
import { PAGE, api, call, cdp, check, done, evaluate, pageTarget, message, pair, refOf, restartWorker, trustedClick, until, wakeWorker, showTab } from './lib'

const A = 'T-00000000-0000-0000-0000-00000000000a', B = 'T-00000000-0000-0000-0000-00000000000b'
let { send: sw } = await wakeWorker()
await pair()
check('extension pairs and connects', await until(async () => (await api('/status', null)).extension_connected))

const tabId = await evaluate(sw, `chrome.tabs.query({url: '${PAGE}/*'}).then(t => t[0].id)`)
// A person lends the tab they're looking at; Chrome drops input to a tab that was never shown.
await showTab(`${PAGE}/`)
await message({ action: 'lend', tabId: tabId })
const st = await api('/status', null)
check('status shows lent tab read-only', st.tab?.url === `${PAGE}/` && st.tab.allow_actions === false, st)

let snap = (await call(A, 'snapshot')).result
const button = refOf(snap, /button "Press me"/), box = refOf(snap, /textbox "Search"/)
check('snapshot outlines refs', button && box, snap.outline)
check('snapshot hides field contents', !snap.outline.includes('"old"'), snap.outline)
{
  const d = (await call(A, 'describe', { ref: button })).result
  check('describe returns role and name', d?.ref === button && d.role === 'button' && d.name === 'Press me' && d.url === `${PAGE}/`, d)
}
check('read-only refuses click', /read-only/.test((await call(A, 'click', { ref: button })).error ?? ''))
check('lease blocks second thread', /in use by thread T-0{8}-0{4}-0{4}-0{4}-0{11}a/.test((await call(B, 'snapshot')).error ?? ''))

await message({ action: 'permissions', allowActions: true, anyOrigin: false })
// Refs and the lend must survive a service worker restart, in session storage.
await evaluate(sw, 'self.__marker = 1')
;({ send: sw } = await restartWorker())
check('extension reconnects after worker restart', await until(async () => (await api('/status', null)).extension_connected))
check('worker really restarted (marker gone)', (await evaluate(sw, 'typeof self.__marker')) === 'undefined')
const clicked = await call(A, 'click', { ref: button })
check('click with ref from before the restart', clicked.result?.clicked === button, clicked)
snap = (await call(A, 'snapshot')).result
check('page shows the click', snap.outline.includes('"Clicked!"'), snap.outline)

const typed = await call(A, 'type', { ref: refOf(snap, /textbox "Search"/), text: 'hello', submit: true })
check('type with submit', typed.result?.submitted === true, typed)
snap = (await call(A, 'snapshot')).result
check('page shows the submission', snap.outline.includes('"Submitted: hello"'), snap.outline)

{
  const pg = cdp((await pageTarget()).webSocketDebuggerUrl)
  await pg('Runtime.evaluate', { expression: 'document.getElementById("overlay").style.display = "block"' })
  const s1 = (await call(A, 'snapshot')).result
  const covered = await call(A, 'click', { ref: refOf(s1, /button "Covered"/) })
  check('click refused when an overlay covers the element', /covers/.test(covered.error ?? '') && !covered.unknown, covered)
  check('overlay received nothing', !(await call(A, 'snapshot')).result.outline.includes('Overlay got it'))
  await pg('Runtime.evaluate', { expression: 'document.getElementById("overlay").style.display = "none"' })
  await call(A, 'click', { ref: refOf((await call(A, 'snapshot')).result, /button "Covered"/) })
  check('same click lands once the overlay is gone', (await call(A, 'snapshot')).result.outline.includes('"Covered clicked!"'))
  // A page that overrides focus() can't steer typing elsewhere.
  await pg('Runtime.evaluate', { expression: 'document.getElementById("q").focus = () => document.querySelector("a").focus()' })
  const t = await call(A, 'type', { ref: refOf((await call(A, 'snapshot')).result, /textbox "Search"/), text: 'safe' })
  const v = await pg('Runtime.evaluate', { expression: 'document.getElementById("q").value', returnByValue: true })
  check('typing ignores a page override of focus()', t.result?.typed && v.result.value === 'safe', { t, v: v.result.value })
}
{
  const cb = await call(A, 'click', { ref: refOf((await call(A, 'snapshot')).result, /checkbox "Agree"/) })
  const s5 = (await call(A, 'snapshot')).result
  check('label-covered custom checkbox can be clicked', cb.result && /checkbox "Agree" \(checked\)/.test(s5.outline), { cb, o: s5.outline })
  const tb = await call(A, 'click', { ref: refOf(s5, /textbox "Search"/) })
  check('click on a plain text input', tb.result, tb)
}
check('navigate to another site refused', /limited to http:\/\/127.0.0.1:8765/.test((await call(A, 'navigate', { url: 'https://example.com/' })).error ?? ''))
const staleRef = refOf(snap, /button "Press me"/)
check('navigate on the same site', (await call(A, 'navigate', { url: `${PAGE}/other.html` })).result?.url === `${PAGE}/other.html`)
await Bun.sleep(500)
check('stale ref refused after navigation', /changed|Unknown ref/.test((await call(A, 'click', { ref: staleRef })).error ?? ''))
await call(A, 'navigate', { url: `${PAGE}/` })
await Bun.sleep(500)

// Handoff: the card appears, and only a trusted click on Continue finishes it.
const id = (await call(A, 'handoff', { message: 'Sign in, then click Continue' })).result?.handoff_id
check('handoff starts at once', typeof id === 'string')
const page = cdp((await pageTarget()).webSocketDebuggerUrl)
const badgeIs = (want: string) => until(async () => { ({ send: sw } = await wakeWorker()); return (await evaluate(sw, `chrome.action.getBadgeText({tabId: ${tabId}})`)) === want })
check('badge shows WAIT', await badgeIs('WAIT'))
check('handoff still waiting', (await api(`/handoff/${id}?wait=200`, A)).result?.waiting === true)
const rect = await page('Runtime.evaluate', { expression: 'JSON.stringify(document.getElementById("__amp_handoff")?.getBoundingClientRect())', returnByValue: true })
check('card injected', rect.result.value, rect)
check('reading refused during handoff', /handoff/.test((await call(A, 'snapshot')).error ?? '') && /handoff/.test((await call(A, 'screenshot')).error ?? ''))
check('input refused during handoff', /handoff/.test((await call(A, 'click', { ref: 'e2' })).error ?? ''))
await page('Runtime.evaluate', { expression: 'document.getElementById("__amp_handoff").click()' })
check('untrusted click does not continue', (await api(`/handoff/${id}?wait=300`, A)).result?.waiting === true)
// The Continue button sits at the bottom-left of the card. Clicking it means looking at the tab first.
const r = JSON.parse(rect.result.value)
await page('Page.bringToFront')
await trustedClick(page, r.left + 30, r.bottom - 26)
const finished = await api(`/handoff/${id}?wait=3000`, A)
check('trusted click on Continue finishes the handoff', finished.result?.continued === true, finished)
check('badge back to ON', await badgeIs('ON'))
await message({ action: 'stop' })
check('stop lending clears the tab', (await api('/status', null)).tab === null)
done()
