// The setup page as a new user meets it: it opens on install, a wrong code is refused, the plugin's
// setup.html#code= link pairs by itself and leaves no code behind, the checklist goes green step by
// step, and the extension pairs no more after Reload in chrome://extensions.
import { EXT, PAGE, api, cdp, check, clickElement, dir, done, evaluate, openPopup, openTarget, readPairingCode, reloadExtension, shot, targets, until } from './lib'
import { setupPageID, writePublished } from '../../plugin/host'
import { EXTENSION_IDS } from '../../plugin/extension-id'

const SETUP = `chrome-extension://${EXT}/setup.html`
const steps = (page: any) => evaluate(page, `Object.fromEntries([...document.querySelectorAll('.step')].map(s => [s.id, s.className.replace('step', '').trim()]))`)
const detail = (page: any, id: string) => evaluate(page, `document.querySelector('#${id} .detail').textContent`)

const installed = await until(async () => (await targets()).some((t) => t.type === 'page' && t.url === SETUP))
check('the setup page opens by itself on install', installed)
let setup = cdp((await targets()).find((t) => t.url === SETUP).webSocketDebuggerUrl)
check('it finds the bridge and asks to pair', await until(async () => { const s = await steps(setup); return s.bridge === 'ok' && s.paired === 'fail' }), await steps(setup))
// The plugin opens setup.html#code= under the build that last probed the bridge; without that it
// would guess the Chrome Web Store build, and Chrome would show its "blocked" page.
check('the bridge will open pairing in the unpacked build, not the Store one', EXTENSION_IDS[0] !== EXT && setupPageID(dir) === EXT, setupPageID(dir))
check('it shows the pairing form', await evaluate(setup, `!document.getElementById('pairForm').classList.contains('hidden')`))
await shot('1-not-paired')

// A wrong code typed into the form is refused and says so.
await clickElement(setup, `document.getElementById('code')`)
await setup('Input.insertText', { text: 'WRONG-CODE1' })
await clickElement(setup, `document.getElementById('connect')`)
check('a wrong code is refused', await until(async () => /code|pair/i.test(await evaluate(setup, `document.querySelector('#paired .error')?.textContent ?? ''`))), await detail(setup, 'paired'))
check('the bridge is still unpaired', !(await api('/status', null)).extension_connected)

// What browser_bridge_pair opens on the Mac: the setup page with the code in its fragment.
const code = await readPairingCode()
const paired = await openTarget(`${SETUP}#code=${encodeURIComponent(code)}`)
setup = cdp(paired.webSocketDebuggerUrl)
check('setup.html#code= pairs by itself', await until(async () => (await steps(setup)).paired === 'ok'), await detail(setup, 'paired'))
check('the code is gone from the address bar', (await evaluate(setup, 'location.href')) === SETUP && !(await targets()).some((t) => t.url.includes(code)))
check('the bridge sees the extension', (await api('/status', null)).extension_connected)
check('not published yet: that step says so', (await steps(setup)).published === 'fail' && /Not published/.test(await detail(setup, 'published')))
check('nothing lent yet', (await steps(setup)).lent === '')
await shot('2-paired')

// Publishing, as browser_bridge_publish records it; the bridge passes it on to the extension.
const url = 'https://t-example-p19989.onamp.dev', thread = 'T-00000000-0000-0000-0000-0000000000d1'
writePublished(dir, { url, thread, at: new Date().toISOString() })
check('published: that step goes green and names the portal', await until(async () => (await steps(setup)).published === 'ok' && (await detail(setup, 'published')).includes(url), 50), await detail(setup, 'published'))

// Lend the test page from the real toolbar popup.
const popup = await openPopup(`${PAGE}/`)
await popup.click('lend')
check('Lend this tab in the popup lends it', await until(async () => (await popup.text('status')) === 'Lent read-only'), { status: await popup.text('status'), detail: await popup.text('detail'), error: await popup.text('error') })
await popup.close()
await setup('Page.bringToFront')
check('every step is green', await until(async () => Object.values(await steps(setup)).every((s) => s === 'ok')), await steps(setup))
check('the lent step names the tab', /Lent read-only: Bridge test page/.test(await detail(setup, 'lent')), await detail(setup, 'lent'))
await shot('3-all-green')

// Reload on chrome://extensions: the lend ends, the key stays, and it reconnects by itself.
await reloadExtension()
check('after Reload the bridge sees the extension again without pairing', await until(async () => (await api('/status', null)).extension_connected))
check('after Reload nothing is lent', (await api('/status', null)).tab === null)
setup = cdp((await openTarget(SETUP)).webSocketDebuggerUrl)
check('the setup page shows paired and published, and nothing lent', await until(async () => { const s = await steps(setup); return s.bridge === 'ok' && s.paired === 'ok' && s.published === 'ok' && s.lent === '' }), await steps(setup))
await shot('4-after-reload')
done()
