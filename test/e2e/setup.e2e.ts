// The setup page from first install through lending, extension reload, and key rotation.
import { createClient } from '../../plugin/crypto'
import { BRIDGE, EXT, PAGE, api, cdp, check, clickElement, done, evaluate, openPopup, openTarget, readSetupKey, reloadExtension, shot, showTab, targets, until } from './lib'

const SETUP = `chrome-extension://${EXT}/setup.html`
const steps = (page: any) => evaluate(page, `Object.fromEntries([...document.querySelectorAll('.step')].map(s => [s.id, s.className.replace('step', '').trim()]))`)
const detail = (page: any, id: string) => evaluate(page, `document.querySelector('#${id} .detail').textContent`)

const installed = await until(async () => (await targets()).some((t) => t.type === 'page' && t.url === SETUP))
check('the setup page opens by itself on install', installed)
let setup = cdp((await targets()).find((t) => t.url === SETUP).webSocketDebuggerUrl)
await showTab(SETUP)

// Point at a bad URL first, then at the local reflector via the setup page's form.
await clickElement(setup, `document.getElementById('toggleRelay')`)
await evaluate(setup, `document.getElementById('relayInput').value = ''`)
await clickElement(setup, `document.getElementById('relayInput')`)
await setup('Input.insertText', { text: 'not-a-url' })
await clickElement(setup, `document.getElementById('saveRelay')`)
check('an invalid reflector URL shows an error', await until(async () => /http/i.test(await evaluate(setup, `document.getElementById('relayError').textContent`))))

await evaluate(setup, `document.getElementById('relayInput').value = ''`)
await clickElement(setup, `document.getElementById('relayInput')`)
await setup('Input.insertText', { text: BRIDGE })
await clickElement(setup, `document.getElementById('saveRelay')`)
check('connecting to the reflector turns step 1 green', await until(async () => (await steps(setup)).relay === 'ok'), await steps(setup))
check('step 1 names the reflector URL', (await detail(setup, 'relay')).includes(BRIDGE), await detail(setup, 'relay'))
check('step 2 waits for Amp before first use', (await steps(setup)).amp === '' && /Copy setup key/.test(await detail(setup, 'amp')), await detail(setup, 'amp'))
check('nothing lent yet', (await steps(setup)).lent === '')
check('no raw setup key is rendered into the page text', !(await evaluate(setup, `document.body.textContent`)).includes('abb1_'))
await shot('1-relay-connected')

// Copy setup key, then connect from Amp: step 2 turns green.
await clickElement(setup, `document.getElementById('copyKey')`)
check('Copy setup key confirms the copy', await until(async () => /Copied/.test(await evaluate(setup, `document.getElementById('copyNote').textContent`))))
const oldKey = await readSetupKey()
const oldClient = createClient(oldKey)
check('Amp reaches the extension end-to-end', (await api('/status', null)).extension_connected === true)
await showTab(SETUP)
check('step 2 turns green once Amp has connected', await until(async () => (await steps(setup)).amp === 'ok'), await detail(setup, 'amp'))
await shot('2-amp-connected')

// Lend the test page from the real toolbar popup.
const popup = await openPopup(`${PAGE}/`)
await popup.click('lend')
check('Lend this tab in the popup lends it', await until(async () => (await popup.text('status')) === 'Lent read-only'), { status: await popup.text('status'), detail: await popup.text('detail') })
await popup.close()
await showTab(SETUP)
check('every step is green', await until(async () => Object.values(await steps(setup)).every((s) => s === 'ok')), await steps(setup))
check('the lent step names the tab', /Lent read-only: Bridge test page/.test(await detail(setup, 'lent')), await detail(setup, 'lent'))
await shot('3-all-green')

// Reload on chrome://extensions: the lend ends, the key and custom reflector stay, and it reconnects with a new ephemeral session.
await reloadExtension()
check('after Reload Amp sees the extension again without re-entering a key', await until(async () => (await api('/status', null)).extension_connected === true))
check('after Reload nothing is lent', (await api('/status', null)).tab === null)
setup = cdp((await openTarget(SETUP)).webSocketDebuggerUrl)
await showTab(SETUP)
check('the setup page shows connected with Amp and nothing lent', await until(async () => { const s = await steps(setup); return s.relay === 'ok' && s.amp === 'ok' && s.lent === '' }), await steps(setup))
await shot('4-after-reload')

// Rotating the key revokes the previous client immediately and resets step 2 until the new key is used.
await clickElement(setup, `document.getElementById('rotateKey')`)
check('Rotate key resets step 2', await until(async () => (await steps(setup)).amp === '' && (await steps(setup)).relay === 'ok'))
let oldRejected = false
try {
  await oldClient.request('', '/status')
} catch (e: any) {
  oldRejected = /rejected|unauthorized|not connected/i.test(e.message)
}
// Either the old gate channel has no listener (disconnected) or decryption rejected the old key.
const oldStatus = oldRejected ? { extension_connected: false } : await oldClient.request('', '/status')
check('the rotated-out key can no longer reach this browser', oldRejected || oldStatus.extension_connected === false, oldStatus)
check('the new key reaches the browser and turns step 2 green again', (await api('/status', null)).extension_connected === true && (await until(async () => (await steps(setup)).amp === 'ok')))
done()
