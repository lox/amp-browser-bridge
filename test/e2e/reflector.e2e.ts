// Multi-runner and orb workflow through the blind reflector:
// 1. A locked-down runner without --amp-env and without `amp` on PATH (like wandi-gateway) prompts
//    once in-thread via `ui.confirm` (`secret: true`), writes `~/.amp-browser-bridge/key` (0600),
//    and uses Chrome immediately in the same turn without restarting.
// 2. A second runner sharing the same HOME (like two Mac runners) picks up `~/.amp-browser-bridge/key`
//    with zero port-binding races and coordinates via Chrome's 10-minute tab lease.
// 3. Restarting Chrome's service worker mid-handoff rotates its ephemeral P-256 ECDH key (HTTP 409
//    banner refresh) while keeping the handoff alive until the user clicks Continue.
// 4. Rotating the setup key in Chrome revokes old runners until `browser_bridge_connect` saves the new
//    key locally and (when `amp` is on PATH) into personal secret `BROWSER_BRIDGE_KEY`.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAGE, cdp, check, dir, done, evaluate, message, pageTarget, pair, readSetupKey, restartWorker, showTab, trustedClick, until, wakeWorker } from './lib'

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

let confirmPrompts = 0
const makeCtx = (thread: string, provideKey?: string, orbs = 'true') => ({
  thread: { id: thread },
  signal: new AbortController().signal,
  logger: { log() {} },
  ui: {
    select: async () => 'Allow once',
    confirm: async (opts: any) => {
      confirmPrompts++
      if (!provideKey) return undefined
      const keyField = opts.fields?.find((f: any) => f.name === 'key')
      check('key prompt uses a secret field and requires a human', keyField?.secret === true && opts.requireHuman === true, opts)
      return { key: provideKey, orbs }
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

// Cancelled prompt fails with clear setup instructions.
const missing = await run('browser_status', {}, makeCtx(A))
check('missing key with cancelled prompt explains how to copy the setup key', /Copy setup key/.test(missing.err ?? '') && confirmPrompts === 1, missing)

// Entering the key once saves `~/.amp-browser-bridge/key` (0600) and succeeds immediately without `amp` on PATH.
const firstStatus = await run('browser_status', {}, makeCtx(A, initialKey, 'true'))
check('pasting key on a runner without amp on PATH works immediately in the same call', JSON.parse(firstStatus.ok ?? '{}').extension_connected === true, firstStatus)
const keyPath = join(dir, 'key')
check('saved key file has 0600 permissions', existsSync(keyPath) && (statSync(keyPath).mode & 0o777) === 0o600, existsSync(keyPath) && (statSync(keyPath).mode & 0o777).toString(8))

// A separate runner process sharing HOME (like two Mac runners) uses `~/.amp-browser-bridge/key` with zero prompts or port fights.
{
  const script = `
    const p = (await import(${JSON.stringify(join(import.meta.dir, '../../plugin/index'))})).default;
    const tools = new Map();
    await p({ registerTool: (t) => tools.set(t.name, t), logger: { log() {} }, onDispose() {} });
    const s = await tools.get('browser_status').execute({}, { thread: { id: '${B}' }, signal: new AbortController().signal, ui: {}, logger: { log() {} } });
    console.log(s);
  `
  const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, HOME: process.env.E2E_HOME }, stdout: 'pipe', stderr: 'inherit' })
  const out = JSON.parse((await new Response(child.stdout).text()).trim())
  check('second runner sharing HOME connects without prompting or binding a port', out.extension_connected === true && out.tab?.url === `${PAGE}/`, out)
}

// Handoff survives an MV3 service worker restart (which rotates Chrome's ephemeral ECDH key -> HTTP 409 refresh).
const snap = (await run('browser_snapshot', {}, makeCtx(A))).ok as string
check('Runner A takes the tab lease and reads the page', snap?.includes('Bridge test page'), snap)
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

// Rotate key in Chrome: existing runner key fails, and `browser_bridge_connect` updates both local file and personal secret (tested with a fake `amp` binary!).
await message({ action: 'rotateKey' })
await until(async () => (await message({ action: 'state' })).connected === true)
const rotatedKey = await readSetupKey()
check('rotated key differs from the initial key', rotatedKey !== initialKey)
const afterRotate = await run('browser_snapshot', {}, makeCtx(A))
check('old key can no longer read Chrome after rotation', /not connected|rejected/i.test(afterRotate.err ?? ''), afterRotate)

const fakeBin = mkdtempSync(join(tmpdir(), 'abb-fake-amp-'))
const capturedSecret = join(fakeBin, 'secret.txt')
writeFileSync(
  join(fakeBin, 'amp'),
  `#!/bin/sh\nif [ "$1 $2 $3 $4 $5" = "secrets set --user --secret BROWSER_BRIDGE_KEY" ]; then cat > "${capturedSecret}"; exit 0; fi\nexit 1\n`,
)
chmodSync(join(fakeBin, 'amp'), 0o755)
process.env.PATH = `${fakeBin}:${noAmpPath}`

const reconnected = await run('browser_bridge_connect', {}, makeCtx(A, rotatedKey, 'true'))
const recData = JSON.parse(reconnected.ok ?? '{}')
check('browser_bridge_connect connects with the rotated key and saves for future orbs', recData.extension_connected === true && recData.saved_for_orbs === true, recData)
check('fake amp CLI received the exact rotated key for BROWSER_BRIDGE_KEY', readFileSync(capturedSecret, 'utf8') === rotatedKey)
check('local key file updated to rotated key', readFileSync(keyPath, 'utf8').trim() === rotatedKey)
check('browser_snapshot works again after browser_bridge_connect', ((await run('browser_snapshot', {}, makeCtx(A))).ok ?? '').includes('Bridge test page'))

process.env.PATH = savedPath
rmSync(fakeBin, { recursive: true, force: true })
await message({ action: 'stop' })
done()
