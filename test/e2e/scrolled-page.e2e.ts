// Forms are long, and sites often scroll smoothly. Acting on a field must work wherever the page is
// scrolled or zoomed to, and browser_scroll must move the page before it returns.
import { PAGE, api, call, cdp, check, done, evaluate, message, pageTarget, pair, refOf, showTab, until, wakeWorker } from './lib'

const A = 'T-00000000-0000-0000-0000-00000000000a'
const { send: sw } = await wakeWorker()
await pair()
check('extension pairs and connects', await until(async () => (await api('/status', null)).extension_connected))
const page = cdp((await pageTarget()).webSocketDebuggerUrl)
await page('Page.navigate', { url: `${PAGE}/long.html` })
await until(async () => (await evaluate(page, 'document.readyState')) === 'complete')
const tabId = await evaluate(sw, `chrome.tabs.query({url: '${PAGE}/long.html'}).then(t => t[0].id)`)
// A person lends the tab they're looking at; Chrome drops input to a tab that was never shown.
await showTab(`${PAGE}/long.html`)
await message({ action: 'lend', tabId })
await message({ action: 'permissions', allowActions: true, anyOrigin: false })
const value = (id: string) => evaluate(page, `document.getElementById(${JSON.stringify(id)}).value`)
const scrollY = () => evaluate(page, 'scrollY')

const snap = (await call(A, 'snapshot')).result
const far = await call(A, 'type', { ref: refOf(snap, /textbox "Model API URL"/), text: 'https://ampcode.com' })
check('type into a field below the fold', far.result?.typed && (await value('model-field')) === 'https://ampcode.com', { far, scrollY: await scrollY() })

const before = await scrollY()
const scrolled = await call(A, 'scroll', { delta_y: -1000 })
const y = await scrollY()
check('scroll has moved a smooth-scrolling page when it returns', scrolled.result && y === before - 1000, { scrolled, before, y })

// The field stays in view, so nothing scrolls it to the top before the action.
await evaluate(page, `window.scrollTo({top: 40, behavior: 'instant'})`)
const visible = await call(A, 'type', { ref: refOf((await call(A, 'snapshot')).result, /textbox "Name"/), text: 'Amp' })
check('type into a visible field of a page scrolled a little', visible.result?.typed && (await value('name-field')) === 'Amp', visible)
// Pinch zoom (a Mac trackpad) moves the visual viewport away from the layout viewport.
await page('Input.synthesizePinchGesture', { x: 200, y: 100, scaleFactor: 2, relativeSpeed: 2000 })
const zoomed = await call(A, 'type', { ref: refOf((await call(A, 'snapshot')).result, /textbox "Name"/), text: 'Zoomed' })
check('type into a visible field of a pinch-zoomed page', zoomed.result?.typed && (await value('name-field')) === 'Zoomed', zoomed)
await evaluate(page, `document.getElementById('overlay').style.display = 'block'`)
const covered = await call(A, 'type', { ref: refOf((await call(A, 'snapshot')).result, /textbox "Name"/), text: 'Overlay' })
check('type refused when an overlay covers the field of a scrolled page', /covers/.test(covered.error ?? '') && (await value('name-field')) === 'Zoomed', covered)
done()
