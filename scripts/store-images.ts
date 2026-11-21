// Renders the Chrome Web Store images into docs/store/: four 1280x800 screenshots and the 440x280
// small promo tile. Everything shown is real extension UI, driven through a real bridge, on
// fictional pages at https://app.example.com that this script serves itself. No real accounts,
// threads or portals appear.
//
//   CHROME=/path/to/chrome bun scripts/store-images.ts
//
// CHROME must be Chromium or Chrome for Testing: branded Chrome ignores --load-extension. The
// bridge port (19989) must be free, so quit Amp first. Pages use the system UI font; the committed
// images were rendered with Inter.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UNPACKED_ID } from '../plugin/extension-id'
import { DEFAULT_PORT, startBridge, writePublished } from '../plugin/host'

const CHROME = process.env.CHROME
if (!CHROME) throw new Error('Set CHROME to a Chromium or Chrome for Testing binary.')
const root = join(import.meta.dir, '..')
const out = join(root, 'docs', 'store')
const THREAD = 'T-019a3f6e-2b7c-7d41-9c58-4e1f0a6b3d27' // fictional
const DEMO = 'https://app.example.com'

// ---- The bridge, with a fictional published portal ----

const dir = mkdtempSync(join(tmpdir(), 'abb-store-'))
writePublished(dir, { url: 'https://port-19989--k7q2m.onamp.dev', thread: THREAD, at: new Date().toISOString() })
const bridge = startBridge({ dir, port: DEFAULT_PORT })
const call = (tool: string, args: object = {}) =>
  fetch(`http://127.0.0.1:${DEFAULT_PORT}/call`, {
    method: 'POST',
    headers: { 'x-bridge-token': bridge.token, 'x-amp-thread': THREAD, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  }).then((r) => r.json())

// ---- Chrome, driven over the DevTools protocol ----

const profile = mkdtempSync(join(tmpdir(), 'abb-chrome-'))
const ext = join(root, 'extension')
const chrome = Bun.spawn([CHROME, '--headless=new', '--no-sandbox', `--user-data-dir=${profile}`, `--load-extension=${ext}`,
  `--disable-extensions-except=${ext}`, '--remote-debugging-port=0', '--hide-scrollbars', '--force-color-profile=srgb',
  '--lang=en-US', '--no-first-run', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })

async function until<T>(what: string, check: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    const v = await Promise.resolve().then(check).catch(() => undefined)
    if (v) return v as NonNullable<T>
  }
  throw new Error(`timed out waiting for ${what}`)
}

const port = await until('DevToolsActivePort', () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const ws = new WebSocket(webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let nextID = 0
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const listeners: ((m: any) => void)[] = []
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id)!
    waiting.delete(m.id)
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result)
  } else for (const l of listeners) l(m)
}
function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = ++nextID
  ws.send(JSON.stringify({ id, method, params, sessionId }))
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}

/** Attaches to a page target; `size` sets its viewport in CSS pixels. */
async function page(targetId: string, width: number, height: number, scale = 1) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const s = (method: string, params: object = {}) => send(method, params, sessionId)
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
  const evaluate = async (expression: string) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const shot = async (clip?: { width: number; height: number }) =>
    `data:image/png;base64,${(await s('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { x: 0, y: 0, ...clip, scale: 1 } } : {}) })).data}`
  return { sessionId, s, evaluate, shot }
}

const targets = async () => (await send('Target.getTargets')).targetInfos as { targetId: string; type: string; url: string }[]
const setupTarget = await until('the setup page Chrome opens on install', async () =>
  (await targets()).find((t) => t.url === `chrome-extension://${UNPACKED_ID}/setup.html`))
const setup = await page(setupTarget.targetId, 1160, 572)
const state = () => setup.evaluate('chrome.runtime.sendMessage({action: "state"})')
const ask = (message: object) => setup.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`)

// The setup page's probe has told the bridge which build is installed, before any pairing.
await until('the bridge to record the extension ID', () => readFileSync(join(dir, 'extension-id'), 'utf8').trim() === UNPACKED_ID)
await ask({ action: 'pair', code: readFileSync(join(dir, 'pairing-code'), 'utf8').trim() })
await until('the extension to connect', async () => (await state()).connected)

// ---- The fictional site ----

const DEMO_PAGES: Record<string, string> = { '/issues': demoIssues(), '/login': demoLogin() }
const { targetId: demoID } = await send('Target.createTarget', { url: 'about:blank' })
const demo = await page(demoID, 1160, 572)
await demo.s('Fetch.enable', { patterns: [{ urlPattern: `${DEMO}/*` }] })
listeners.push((m) => {
  if (m.method !== 'Fetch.requestPaused' || m.sessionId !== demo.sessionId) return
  const html = DEMO_PAGES[new URL(m.params.request.url).pathname]
  demo.s('Fetch.fulfillRequest', {
    requestId: m.params.requestId, responseCode: html ? 200 : 404,
    responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
    body: Buffer.from(html ?? 'not found').toString('base64'),
  })
})
async function visit(path: string) {
  await demo.s('Page.navigate', { url: DEMO + path })
  await until(`${path} to load`, async () => (await demo.evaluate('document.readyState')) === 'complete' && (await demo.evaluate('location.pathname')) === path)
}
await visit('/issues')
const tabId = await setup.evaluate(`chrome.tabs.query({url: "${DEMO}/*"}).then(([t]) => t.id)`)
await ask({ action: 'lend', tabId })
await ask({ action: 'permissions', allowActions: true, anyOrigin: false })
// A thread reads the page, so the popup shows which thread holds the tab.
const read = await call('snapshot')
if (!read.result?.outline?.includes('Checkout fails')) throw new Error(`unexpected snapshot: ${JSON.stringify(read).slice(0, 300)}`)
await until('the lease to reach the extension', async () => (await state()).lease)

const { targetId: popupID } = await send('Target.createTarget', { url: `chrome-extension://${UNPACKED_ID}/popup.html` })
const popup = await page(popupID, 320, 600, 2)
async function popupShot(expect: string) {
  await popup.s('Page.reload')
  await until(`the popup to say ${expect}`, async () => (await popup.evaluate('document.getElementById("status").textContent')) === expect)
  await Bun.sleep(200)
  return popup.shot({ width: 320, height: Math.ceil(await popup.evaluate('document.body.getBoundingClientRect().height')) })
}

mkdirSync(out, { recursive: true })
const frames: [string, string][] = []
frames.push(['screenshot-1-lend.png', frame({
  title: 'Lend one tab to your Amp threads',
  sub: 'They read it and take screenshots. Clicks and typing wait for your OK.',
  url: 'app.example.com/issues', tab: 'Open issues · Acme', badge: 'ON', page: await demo.shot(), popup: await popupShot('Lent'),
})])

// A handoff: the thread needs a person to sign in.
await visit('/login')
const handoff = await call('handoff', { message: 'Sign in to Acme with your password and 2FA code, then click Continue.' })
if (!handoff.result?.handoff_id) throw new Error(`handoff failed: ${JSON.stringify(handoff)}`)
await until('the handoff card', () => demo.evaluate('!!document.getElementById("__amp_handoff")'))
await Bun.sleep(300)
frames.push(['screenshot-2-handoff.png', frame({
  title: 'Logins and 2FA stay with you',
  sub: 'Amp hands the tab back, sees nothing while you type, and waits for Continue.',
  url: 'app.example.com/login', tab: 'Sign in · Acme', badge: 'WAIT', page: await demo.shot(), popup: await popupShot('Amp is waiting for you'),
})])
await fetch(`http://127.0.0.1:${DEFAULT_PORT}/handoff/${handoff.result.handoff_id}/cancel`, {
  method: 'POST', headers: { 'x-bridge-token': bridge.token, 'x-amp-thread': THREAD },
})
await visit('/issues')

// The setup checklist, all green, then with the bridge gone.
await send('Target.activateTarget', { targetId: setupTarget.targetId })
const setupShot = async (check: string) => {
  await until(`setup page: ${check}`, () => setup.evaluate(check), 10_000)
  await Bun.sleep(300)
  return setup.shot()
}
frames.push(['screenshot-3-setup.png', frame({
  title: 'Set up in minutes, no terminal',
  sub: 'A live checklist follows each step and pairs with your Mac by itself.',
  url: 'chrome-extension://…/setup.html', tab: 'Set up Amp Browser Bridge',
  page: await setupShot('document.querySelectorAll(".step.ok").length === 4'),
})])
bridge.stop()
frames.push(['screenshot-4-troubleshoot.png', frame({
  title: 'Every failing step says how to fix it',
  sub: 'The extension only talks to the bridge on your own computer, at 127.0.0.1.',
  url: 'chrome-extension://…/setup.html', tab: 'Set up Amp Browser Bridge',
  page: await setupShot('document.getElementById("bridge").classList.contains("fail")'),
})])
frames.push(['promo-small-440x280.png', promoTile()])

// ---- Compose each image in Chrome at its exact size ----

const { targetId: composeID } = await send('Target.createTarget', { url: 'about:blank' })
for (const [name, html] of frames) {
  const [w, h] = name.startsWith('promo') ? [440, 280] : [1280, 800]
  const c = await page(composeID, w, h)
  const file = join(profile, 'compose.html')
  writeFileSync(file, html)
  await c.s('Page.navigate', { url: `file://${file}` })
  await until('the composed image', () => c.evaluate('document.readyState === "complete" && [...document.images].every((i) => i.complete)'))
  await Bun.sleep(200)
  const png = await c.shot({ width: w, height: h })
  writeFileSync(join(out, name), Buffer.from(png.split(',')[1], 'base64'))
  console.log(`docs/store/${name}`)
  await send('Target.detachFromTarget', { sessionId: c.sessionId })
}

ws.close()
chrome.kill()
await chrome.exited
rmSync(profile, { recursive: true, force: true })
rmSync(dir, { recursive: true, force: true })

// ---- Templates ----

function frame(f: { title: string; sub: string; url: string; tab: string; page: string; popup?: string; badge?: string }) {
  const icon = `data:image/png;base64,${readFileSync(join(ext, 'icons', 'icon-32.png')).toString('base64')}`
  const badgeColor = f.badge === 'WAIT' ? '#ea580c' : '#111827'
  return `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 800px; overflow: hidden; font-family: Inter, system-ui, sans-serif;
    background: radial-gradient(1200px 500px at 15% -10%, #1e293b, #0b1120 70%); color: #f8fafc; }
  .caption { position: absolute; left: 60px; top: 38px; right: 60px; }
  h1 { margin: 0; font-size: 38px; font-weight: 700; letter-spacing: -0.02em; }
  h1::before { content: ""; display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #f97316; margin: 0 16px 6px 0; }
  p { margin: 8px 0 0 28px; font-size: 21px; color: #cbd5e1; }
  .window { position: absolute; left: 60px; top: 150px; width: 1160px; height: 680px; border-radius: 12px 12px 0 0;
    overflow: hidden; background: #fff; box-shadow: 0 20px 60px #0009; }
  .tabs { height: 40px; background: #dee1e6; display: flex; align-items: flex-end; padding: 0 10px; gap: 8px; color: #202124; font-size: 13px; }
  .group { align-self: center; background: #188038; color: #fff; font-weight: 600; font-size: 12px; padding: 3px 10px; border-radius: 6px; }
  .tab { background: #fff; border-radius: 9px 9px 0 0; height: 34px; padding: 0 16px; display: flex; align-items: center; gap: 8px;
    width: 240px; border-top: 3px solid #188038; }
  .tab::before { content: ""; width: 14px; height: 14px; border-radius: 3px; background: #cbd5e1; }
  .bar { height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid #e2e8f0; }
  .nav { color: #5f6368; font-size: 18px; letter-spacing: 10px; }
  .omni { flex: 1; height: 28px; border-radius: 14px; background: #f1f3f4; color: #202124; font-size: 13.5px; display: flex; align-items: center; padding: 0 14px; }
  .ext { position: relative; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: #e8eaed; }
  .ext img { width: 16px; height: 16px; }
  .badge { position: absolute; right: -9px; bottom: -3px; font: 700 9px Inter, sans-serif; color: #fff; background: ${badgeColor}; padding: 1px 3px; border-radius: 3px; }
  .page { display: block; width: 1160px; height: 572px; }
  .popup { position: absolute; right: 74px; top: 226px; width: 352px; border-radius: 10px; box-shadow: 0 12px 40px #0006, 0 0 0 1px #0002; }
</style>
<div class="caption"><h1>${f.title}</h1><p>${f.sub}</p></div>
<div class="window">
  <div class="tabs">${f.badge ? '<span class="group">Amp</span>' : ''}<div class="tab" style="${f.badge ? '' : 'border-top-color: transparent'}">${f.tab}</div></div>
  <div class="bar"><span class="nav">←→⟳</span><div class="omni">${f.url}</div>
    <div class="ext"><img src="${icon}">${f.badge ? `<span class="badge">${f.badge}</span>` : ''}</div></div>
  <img class="page" src="${f.page}">
</div>
${f.popup ? `<img class="popup" src="${f.popup}">` : ''}`
}

function promoTile() {
  const icon = `data:image/svg+xml;base64,${readFileSync(join(ext, 'icons', 'icon.svg')).toString('base64')}`
  return `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; width: 440px; height: 280px; overflow: hidden; font-family: Inter, system-ui, sans-serif; color: #f8fafc;
    background: radial-gradient(420px 260px at 20% 0%, #1e293b, #0b1120 75%); display: flex; flex-direction: column; justify-content: center; padding: 0 36px; box-sizing: border-box; }
  img { width: 88px; height: 88px; border-radius: 20px; box-shadow: 0 0 0 1px #ffffff22, 0 10px 30px #0008; }
  h1 { margin: 22px 0 0; font-size: 32px; font-weight: 700; letter-spacing: -0.02em; }
  p { margin: 6px 0 0; font-size: 17px; color: #cbd5e1; }
  b { color: #f97316; font-weight: 600; }
</style><img src="${icon}"><h1>Amp Browser Bridge</h1><p>Lend a tab to your <b>Amp</b> threads</p>`
}

function demoIssues() {
  const rows = [
    ['#482', 'Checkout fails when the cart has a gift card', 'Bug', 'Priya N.', '2h'],
    ['#479', 'Export to CSV drops the last column', 'Bug', 'Sam O.', '5h'],
    ['#477', 'Add dark mode to the billing page', 'Feature', 'Mei L.', '1d'],
    ['#471', 'Search ignores accents in customer names', 'Bug', 'Diego R.', '2d'],
    ['#468', 'Invite emails land in spam for some domains', 'Bug', 'Ana K.', '3d'],
    ['#463', 'Show seat usage on the plan page', 'Feature', 'Tom B.', '4d'],
    ['#459', 'Slow load on the reports dashboard', 'Performance', 'Priya N.', '6d'],
  ]
  return `<!doctype html><meta charset="utf-8"><title>Open issues · Acme</title><style>
  body { margin: 0; font: 14px Inter, system-ui, sans-serif; color: #0f172a; background: #f8fafc; }
  nav { display: flex; align-items: center; gap: 24px; padding: 0 32px; height: 56px; background: #fff; border-bottom: 1px solid #e2e8f0; }
  nav b { font-size: 18px; color: #4f46e5; } nav span { color: #64748b; } nav .on { color: #0f172a; font-weight: 600; }
  main { padding: 28px 32px; } h1 { font-size: 22px; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #f1f5f9; } th { color: #64748b; font-weight: 500; font-size: 13px; background: #f8fafc; }
  td:first-child { color: #64748b; width: 60px; } .tag { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: #fee2e2; color: #991b1b; }
  .Feature { background: #dbeafe; color: #1e40af; } .Performance { background: #fef3c7; color: #92400e; }
</style><nav><b>Acme</b><span class="on">Issues</span><span>Customers</span><span>Reports</span><span>Settings</span></nav>
<main><h1>Open issues</h1><table><tr><th>ID</th><th>Title</th><th>Type</th><th>Reporter</th><th>Opened</th></tr>
${rows.map(([id, title, type, who, age]) => `<tr><td>${id}</td><td><a href="#">${title}</a></td><td><span class="tag ${type}">${type}</span></td><td>${who}</td><td>${age} ago</td></tr>`).join('')}
</table></main>`
}

function demoLogin() {
  return `<!doctype html><meta charset="utf-8"><title>Sign in · Acme</title><style>
  body { margin: 0; font: 14px Inter, system-ui, sans-serif; color: #0f172a; background: #eef2ff; display: grid; place-items: center; height: 100vh; }
  form { width: 360px; background: #fff; border-radius: 14px; padding: 32px; box-shadow: 0 10px 30px #4f46e522; }
  b { font-size: 20px; color: #4f46e5; } h1 { font-size: 20px; margin: 14px 0 20px; }
  label { display: block; font-size: 13px; color: #475569; margin: 14px 0 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; }
  button { width: 100%; margin-top: 22px; padding: 11px; border: 0; border-radius: 8px; background: #4f46e5; color: #fff; font: 600 14px Inter, sans-serif; }
</style><form><b>Acme</b><h1>Sign in to your workspace</h1>
<label>Email</label><input placeholder="you@company.com"><label>Password</label><input type="password" placeholder="••••••••">
<button type="button">Sign in</button></form>`
}
