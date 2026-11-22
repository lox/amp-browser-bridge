// Shared helpers for the end-to-end scripts. test/e2e/run.ts starts the bridge, the test page and
// headless Chrome with the extension for each script, and sets E2E_HOME to the bridge's home.

import { signRequest, verifyResponse } from '../../plugin/host'

export const EXT = 'goknnphohomgekkahpdiphdfladfnmoc'
export const PAGE = 'http://127.0.0.1:8765'
export const BRIDGE = 'http://127.0.0.1:19989'
const CDP = 'http://127.0.0.1:9333'
const dir = `${process.env.E2E_HOME}/.amp-browser-bridge`

export const readToken = async () => (await Bun.file(`${dir}/token`).text()).trim()
export const readPairingCode = async () => (await Bun.file(`${dir}/pairing-code`).text()).trim()

// The bridge's HTTP API, signed like the plugin's requests; an answer without the bridge's signature fails the script.
export async function api(path: string, thread: string | null, init: RequestInit = {}) {
  const token = await readToken()
  const method = init.method ?? 'GET', body = typeof init.body === 'string' ? init.body : ''
  const auth = signRequest(token, { method, path, thread: thread ?? '', body })
  const res = await fetch(BRIDGE + path, { ...init, headers: { 'x-bridge-auth': auth.header, 'content-type': 'application/json', ...(thread ? { 'x-amp-thread': thread } : {}) } })
  const text = await res.text()
  if (!verifyResponse(token, auth.nonce, res.status, text, res.headers.get('x-bridge-proof'))) throw new Error(`unsigned answer from the bridge (HTTP ${res.status})`)
  return JSON.parse(text)
}
export const call = (thread: string, tool: string, args: object = {}) => api('/call', thread, { method: 'POST', body: JSON.stringify({ tool, args }) })

let failed = 0
export function check(name: string, ok: unknown, extra: unknown = '') {
  if (!ok) failed++
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(extra)?.slice(0, 600))
}
export const done = () => process.exit(failed ? 1 : 0)

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
export const openTarget = async (url: string): Promise<any> => (await fetch(`${CDP}/json/new?${url}`, { method: 'PUT' })).json()
export const browser = async () => cdp((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl)
export const pageTarget = async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith(PAGE))
export const workerTarget = async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT))

// An extension page, which can send the extension the same messages its popup sends.
let extPage: Send | undefined
async function extensionPage() {
  if (!extPage) {
    const page = (await targets()).find((t) => t.type === 'page' && t.url.includes(EXT)) ?? (await openTarget(`chrome-extension://${EXT}/popup.html`))
    extPage = cdp(page.webSocketDebuggerUrl)
  }
  return extPage
}

// Sends a popup message, such as {action: 'lend', tabId}, and returns the extension's state after it.
// Messaging also starts a stopped service worker.
export const message = async (m: object) => evaluate(await extensionPage(), `chrome.runtime.sendMessage(${JSON.stringify(m)})`)
export const pair = async () => message({ action: 'pair', code: await readPairingCode() })

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
    if (await f()) return true
    await Bun.sleep(100)
  }
  return false
}

// A trusted click, the only kind the handoff card's Continue button accepts.
export async function trustedClick(page: Send, x: number, y: number) {
  for (const type of ['mousePressed', 'mouseReleased']) await page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}
