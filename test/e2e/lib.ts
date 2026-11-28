// Shared helpers for the end-to-end scripts. test/e2e/run.ts starts the local blind reflector, the
// test page and a headed Chrome with the extension for each script, and sets E2E_HOME to a fresh HOME.
import { createClient, type BridgeClient } from '../../plugin/crypto'

export const EXT = 'goknnphohomgekkahpdiphdfladfnmoc'
export const PAGE = 'http://127.0.0.1:8765'
export const BRIDGE = 'http://127.0.0.1:19989'
const CDP = 'http://127.0.0.1:9333'
export const dir = `${process.env.E2E_HOME}/.amp-browser-bridge`

let cachedKey = ''
let cachedClient: BridgeClient | undefined

export const readSetupKey = async (): Promise<string> => (await message({ action: 'setupKey' })).setupKey

async function client() {
  const key = await readSetupKey()
  if (!cachedClient || cachedKey !== key) {
    cachedClient = createClient(key)
    cachedKey = key
  }
  return cachedClient
}

// Sends an end-to-end encrypted request through the local reflector, as the plugin does.
export async function api(path: string, thread: string | null, init: RequestInit = {}) {
  const c = await client()
  const method = init.method ?? 'GET'
  const body = typeof init.body === 'string' ? init.body : ''
  return c.request(thread ?? '', path, { method, body })
}
export const call = (thread: string, tool: string, args: object = {}) => api('/call', thread, { method: 'POST', body: JSON.stringify({ tool, args }) })

let failed = 0
export function check(name: string, ok: unknown, extra: unknown = '') {
  if (!ok) failed++
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(extra)?.slice(0, 600))
}
// A check that fails today because of a known bug: it reports KNOWN instead of failing, and fails
// once the bug is fixed, so the check can become a plain check() then.
export function known(name: string, ok: unknown, bug: string) {
  if (ok) failed++
  console.log(ok ? 'FAIL (now passes; make it a check)' : 'KNOWN', name, '-', bug)
}
export const done = () => process.exit(failed ? 1 : 0)

export const refOf = (s: any, pattern: RegExp): string | undefined => (s?.outline ?? s ?? '').split('\n').find((l: string) => pattern.test(l))?.match(/\[(e\d+)\]/)?.[1]

export type Send = (method: string, params?: object) => Promise<any>
export function cdp(url: string): Send {
  const ws = new WebSocket(url)
  let n = 0
  const waits = new Map<number, (m: any) => void>()
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    waits.get(m.id)?.(m)
    waits.delete(m.id)
  }
  const opened = new Promise((r) => (ws.onopen = r))
  return async (method, params = {}) => {
    await opened
    const id = ++n
    ws.send(JSON.stringify({ id, method, params }))
    const m: any = await new Promise((r) => waits.set(id, r))
    if (m.error) throw new Error(JSON.stringify(m.error))
    return m.result
  }
}

export const targets = async (): Promise<any[]> => (await fetch(`${CDP}/json/list`)).json()
export const openTarget = async (url: string): Promise<any> => (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
export const browser = async () => cdp((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl)
export const pageTarget = async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith(PAGE))
export const workerTarget = async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT))

// An extension page opened as a tab, which can send the extension the same messages its popup sends.
// Its #driver suffix tells it apart from the real popup and the setup page.
const DRIVER = `chrome-extension://${EXT}/popup.html#driver`
let extPage: Send | undefined
async function extensionPage() {
  if (!extPage) {
    const page = (await targets()).find((t) => t.type === 'page' && t.url === DRIVER) ?? (await openTarget(DRIVER))
    const conn = cdp(page.webSocketDebuggerUrl)
    await until(async () => (await evaluate(conn, 'typeof chrome?.runtime?.sendMessage')) === 'function')
    extPage = conn
  }
  return extPage
}

// Sends a popup message, such as {action: 'lend', tabId}, and returns the extension's state after it.
// Messaging also starts a stopped service worker. A "continue" sent this way is ignored, because it
// comes from a tab other than the handoff's; use the real popup's Continue button instead.
export const message = async (m: object) => evaluate(await extensionPage(), `chrome.runtime.sendMessage(${JSON.stringify(m)})`)
/** Points the extension at the local e2e reflector (`BRIDGE`). */
export const pair = async () => message({ action: 'setRelay', relay: BRIDGE })

// background.js is a module, so its functions aren't reachable here: evaluate only chrome.* and self.
export async function wakeWorker(): Promise<{ send: Send; target: any }> {
  for (let i = 0; i < 60; i++) {
    await message({ action: 'state' }).catch(() => {})
    const target = await workerTarget()
    if (target) return { send: cdp(target.webSocketDebuggerUrl), target }
    await Bun.sleep(300)
  }
  throw new Error('extension worker not found')
}

// Closing the worker's target is how Chrome stops an idle worker.
export async function restartWorker() {
  const target = await workerTarget()
  await (await browser())('Target.closeTarget', { targetId: target.id }).catch(() => {})
  await Bun.sleep(500)
  return wakeWorker()
}

export const evaluate = async (send: Send, expression: string) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value

export async function until(f: () => Promise<unknown>, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await f().catch(() => false)) return true
    await Bun.sleep(100)
  }
  return false
}

// A trusted click, the only kind the handoff card's Continue button accepts.
export async function trustedClick(page: Send, x: number, y: number) {
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (const type of ['mousePressed', 'mouseReleased']) await page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}

// A trusted click in the middle of the element `selector` returns, a JS expression evaluated in the page.
export async function clickElement(page: Send, selector: string) {
  const r = await evaluate(page, `(() => { const e = ${selector}; if (!e) return null; e.scrollIntoView({block: 'center'}); const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? {x: b.x + b.width / 2, y: b.y + b.height / 2} : null })()`)
  if (!r) throw new Error(`nothing to click: ${selector}`)
  await trustedClick(page, r.x, r.y)
}

// Makes the tab showing `url` the active one, as clicking it in the tab strip does. Through
// DevTools, because Chrome switches straight back after chrome.tabs.update() while DevTools last
// activated another tab. (The extension can't read most tabs' URLs, so tabs are found by URL here.)
export async function showTab(url: string) {
  const target = (await targets()).find((t) => t.type === 'page' && t.url === url)
  if (!target) throw new Error(`no tab shows ${url}`)
  await (await browser())('Target.activateTarget', { targetId: target.id })
  // Chrome drops input to a page that isn't visible yet.
  const page = cdp(target.webSocketDebuggerUrl)
  if (!(await until(async () => (await evaluate(page, 'document.visibilityState')) === 'visible'))) throw new Error(`${url} did not come to the front`)
}

// The real toolbar popup, opened as clicking the extension's icon does, on the tab showing `url`.
export async function openPopup(url: string) {
  // Waking the worker may open the driver tab in front, so show the page after.
  const { send } = await wakeWorker()
  await showTab(url)
  const err = await evaluate(send, `chrome.action.openPopup().then(() => '', e => String(e))`)
  if (err) throw new Error(`openPopup: ${err}`)
  let popup: any
  await until(async () => (popup = (await targets()).find((t) => t.type === 'page' && t.url === `chrome-extension://${EXT}/popup.html`)))
  if (!popup) throw new Error('the popup did not open')
  const page = cdp(popup.webSocketDebuggerUrl)
  // popup.js renders once it has the extension's state, and Chrome drops input until the popup shows.
  const ready = await until(async () => (await evaluate(page, `document.visibilityState === 'visible' && document.getElementById('status').textContent !== 'Loading…'`)) === true)
  if (!ready) throw new Error('the popup did not show')
  return {
    page,
    click: (id: string) => clickElement(page, `document.getElementById(${JSON.stringify(id)})`),
    clickText: (text: string) => clickElement(page, `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)} && b.offsetParent)`),
    text: (id: string) => evaluate(page, `document.getElementById(${JSON.stringify(id)}).textContent`),
    visible: (id: string) => evaluate(page, `!!document.getElementById(${JSON.stringify(id)}).offsetParent`),
    checked: (id: string) => evaluate(page, `document.getElementById(${JSON.stringify(id)}).checked`),
    close: () => evaluate(page, 'window.close()').catch(() => {}),
  }
}

// Clicks Reload on the extension's card in chrome://extensions, as you do after changing extension/.
// Chrome closes the extension's own pages and starts a fresh worker with empty session storage.
export async function reloadExtension() {
  const old = await workerTarget()
  const tab = await openTarget('chrome://extensions/')
  const page = cdp(tab.webSocketDebuggerUrl)
  await page('Page.bringToFront')
  const card = `document.querySelector('extensions-manager')?.shadowRoot.querySelector('extensions-item-list')?.shadowRoot.querySelector('extensions-item#${EXT}')`
  if (!(await until(async () => evaluate(page, `!!${card}?.shadowRoot.querySelector('#dev-reload-button')`)))) throw new Error('no Reload button on the extension card; is Developer mode on?')
  await clickElement(page, `${card}.shadowRoot.querySelector('#dev-reload-button')`)
  extPage = undefined
  cachedClient = undefined
  await until(async () => (await workerTarget())?.id !== old?.id || !(await targets()).some((t) => t.id === old?.id))
  try {
    return await wakeWorker()
  } catch {
    if ((await evaluate(page, `${card}.shadowRoot.querySelector('#enableToggle')?.checked`)) === false) throw new Error('Chrome turned the extension off on Reload; is Developer mode on?')
    throw new Error('the extension did not come back after Reload')
  } finally {
    await (await browser())('Target.closeTarget', { targetId: tab.id }).catch(() => {})
  }
}

// Saves a picture of the whole screen, tab strip and popup included, when E2E_SHOTS names a directory.
export async function shot(name: string) {
  const out = process.env.E2E_SHOTS
  if (!out) return
  const file = `${out}/${name}.png`
  const command = process.platform === 'darwin' ? ['screencapture', '-x', file]
    : process.env.DISPLAY && Bun.which('import') ? ['import', '-display', process.env.DISPLAY, '-window', 'root', file]
    : null
  if (!command) throw new Error('E2E_SHOTS needs ImageMagick (import) and a display')
  await Bun.sleep(400) // Chrome fades the popup in.
  if ((await Bun.spawn(command).exited) !== 0) throw new Error(`${command[0]} could not save ${file}`)
}
