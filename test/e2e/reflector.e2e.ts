// Multi-runner and orb workflow through the blind reflector:
// 1. Missing BROWSER_BRIDGE_KEY fails with actionable instructions naming `manage_amp` and `--amp-env`,
//    with zero `~/.amp-browser-bridge` dotfiles written to disk.
// 2. Multiple runner/orb processes sharing `BROWSER_BRIDGE_KEY` work without `amp` on PATH, without
//    port-binding races, and coordinate via Chrome's 10-minute tab lease.
// 3. Restarting Chrome's service worker mid-handoff rotates its ephemeral P-256 ECDH key (HTTP 409
//    banner refresh on polls) while keeping the handoff alive until the user clicks Continue.
// 4. Rotating the setup key in Chrome revokes the old key, clears site allowances so approvals do
//    not carry across browser identities, and keeps a displaced browser displaced across worker restarts.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import '../../extension/crypto.js'
import { BRIDGE, PAGE, cdp, check, dir, done, evaluate, message, pageTarget, pair, readSetupKey, restartWorker, showTab, trustedClick, until, wakeWorker } from './lib'

const A = 'T-00000000-0000-0000-0000-0000000000a1'
const B = 'T-00000000-0000-0000-0000-0000000000b2'

let { send: sw } = await wakeWorker()
await pair()
await until(async () => (await message({ action: 'state' })).connected === true)
const initialKey = await readSetupKey()

const tabId = await evaluate(sw, `chrome.tabs.query({url: '${PAGE}/*'}).then(t => t[0].id)`)
await showTab(`${PAGE}/`)
await message({ action: 'lend', tabId })
await message({ action: 'permissions', allowActions: true, anyOrigin: false })

// Strip `amp` from PATH to match a locked-down runner service like wandi-gateway.
const noAmpPath = (process.env.PATH ?? '')
  .split(':')
  .filter((p) => p && !existsSync(join(p, 'amp')))
  .join(':')
const savedPath = process.env.PATH
process.env.PATH = noAmpPath
delete process.env.BROWSER_BRIDGE_KEY

const plugin = (await import('../../plugin/index')).default
const tools = new Map<string, any>()
await plugin({ registerTool: (t: any) => tools.set(t.name, t), logger: { log() {} }, onDispose() {}, attachments: { upload: async () => ({ url: 'https://ampcode.com/fake.jpg' }) } } as any)

let approvals = 0
const makeCtx = (thread: string, allowForThread = false) => ({
  thread: { id: thread },
  signal: new AbortController().signal,
  logger: { log() {} },
  ui: {
    select: async (opts: any) => {
      approvals++
      return allowForThread ? opts.options.find((o: string) => o.startsWith('Allow on ')) : 'Allow once'
    },
  },
})
const run = async (name: string, input: any, c: any) => {
  try {
    return { ok: await tools.get(name).execute(input, c) }
  } catch (e: any) {
    return { err: e.message as string }
  }
}

// Missing BROWSER_BRIDGE_KEY explains `manage_amp` and `--amp-env`, and creates no `~/.amp-browser-bridge` directory.
const missing = await run('browser_status', {}, makeCtx(A))
check('missing BROWSER_BRIDGE_KEY points to Copy setup key, manage_amp, and runner env', /Copy setup key/.test(missing.err ?? '') && /manage_amp/.test(missing.err ?? ''), missing)
check('no ~/.amp-browser-bridge directory is created', !existsSync(dir))

// Setting BROWSER_BRIDGE_KEY works immediately without `amp` on PATH.
process.env.BROWSER_BRIDGE_KEY = initialKey
const firstStatus = await run('browser_status', {}, makeCtx(A))
check('BROWSER_BRIDGE_KEY works on a runner without amp on PATH', JSON.parse(firstStatus.ok ?? '{}').extension_connected === true, firstStatus)

// A second runner process with BROWSER_BRIDGE_KEY connects with zero port-binding races.
{
  const script = `
    const p = (await import(${JSON.stringify(join(import.meta.dir, '../../plugin/index'))})).default;
    const tools = new Map();
    await p({ registerTool: (t) => tools.set(t.name, t), logger: { log() {} }, onDispose() {} });
    const s = await tools.get('browser_status').execute({}, { thread: { id: '${B}' }, signal: new AbortController().signal, ui: {}, logger: { log() {} } });
    console.log(s);
  `
  const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env }, stdout: 'pipe', stderr: 'inherit' })
  const out = JSON.parse((await new Response(child.stdout).text()).trim())
  check('second runner process connects concurrently without binding a port', out.extension_connected === true && out.tab?.url === `${PAGE}/`, out)
}

// Handoff survives an MV3 service worker restart (which rotates Chrome's ephemeral ECDH key -> HTTP 409 refresh on polls).
const snap = (await run('browser_snapshot', {}, makeCtx(A))).ok as string
check('Runner A takes the tab lease and reads the page', snap?.includes('Bridge test page'), snap)
const btnRef = snap.split('\n').find((l) => /button "Press me"/.test(l))?.match(/\[(e\d+)\]/)?.[1]
await run('browser_click', { ref: btnRef }, makeCtx(A, true))
check('site allowance recorded for initial browser key', approvals === 1)
await run('browser_click', { ref: btnRef }, makeCtx(A, true))
check('repeat click under same browser key skips prompt', approvals === 1)

const blocked = await run('browser_snapshot', {}, makeCtx(B))
check('Runner B is blocked by Chrome’s tab lease', /in use by thread/.test(blocked.err ?? ''), blocked)

const handoffPromise = run('browser_handoff', { message: 'Approve after worker restart' }, makeCtx(A))
const page = cdp((await pageTarget()).webSocketDebuggerUrl)
let rect: any
await until(async () => (rect = JSON.parse(await evaluate(page, `JSON.stringify(document.getElementById('__amp_handoff')?.getBoundingClientRect() ?? null)`))))
;({ send: sw } = await restartWorker())
await until(async () => (await message({ action: 'state' })).connected === true)
await Bun.sleep(600)
await showTab(`${PAGE}/`)
await trustedClick(page, rect.left + 30, rect.bottom - 26)
const handoffDone = await handoffPromise
check('handoff completes across service worker restart and ephemeral ECDH key rotation', JSON.parse(handoffDone.ok ?? '{}').continued === true, handoffDone)

// Displacing Chrome with a second connection on the same gate stays displaced across worker restart until explicit Reconnect.
{
  const BC = (globalThis as any).BridgeCrypto
  const parsed = BC.parseKey(initialKey)
  const root = await BC.deriveRoot(parsed.secret)
  const fakeSession = await BC.createSession(root)
  const ws2 = new WebSocket(BRIDGE.replace('http', 'ws') + '/ext', { headers: { origin: 'chrome-extension://goknnphohomgekkahpdiphdfladfnmoc' } } as any)
  await new Promise<void>((res) => {
    ws2.onmessage = (e) => JSON.parse(String(e.data)).type === 'registered' && res()
    ws2.onopen = () => ws2.send(JSON.stringify({ type: 'register', gate: fakeSession.gate, banner: fakeSession.banner }))
  })
  check('Chrome marks itself displaced on 4001', await until(async () => /Another browser/.test((await message({ action: 'state' })).bridgeError)))
  ;({ send: sw } = await restartWorker())
  await Bun.sleep(400)
  const afterRestart = await message({ action: 'state' })
  check('displaced browser stays disconnected across worker restart instead of stealing back', afterRestart.connected === false && /Another browser/.test(afterRestart.bridgeError), afterRestart)
  ws2.close()
  await message({ action: 'reconnect' })
  check('explicit Reconnect clears displaced state and reconnects', await until(async () => (await message({ action: 'state' })).connected === true))
}

// Rotate key in Chrome: old key stops working, and updating BROWSER_BRIDGE_KEY requires fresh site approval.
await message({ action: 'rotateKey' })
await until(async () => (await message({ action: 'state' })).connected === true)
const rotatedKey = await readSetupKey()
check('rotated key differs from the initial key', rotatedKey !== initialKey)
const afterRotate = await run('browser_snapshot', {}, makeCtx(A))
check('old key can no longer read Chrome after rotation', /disconnected|not connected|rejected/i.test(afterRotate.err ?? ''), afterRotate)

process.env.BROWSER_BRIDGE_KEY = rotatedKey
const snap2 = (await run('browser_snapshot', {}, makeCtx(A))).ok as string
check('updated BROWSER_BRIDGE_KEY reads the page again', snap2?.includes('Bridge test page'))
const btnRef2 = snap2.split('\n').find((l) => /button "Press me"/.test(l))?.match(/\[(e\d+)\]/)?.[1]
await run('browser_click', { ref: btnRef2 }, makeCtx(A))
check('changing BROWSER_BRIDGE_KEY asks for human approval again', approvals === 2, approvals)

process.env.PATH = savedPath
await message({ action: 'stop' })
done()
