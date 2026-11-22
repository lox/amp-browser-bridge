// The path an orb takes: the bridge served through an Amp portal, and the real plugin in its client
// role reaching it with a portal sign-in (amp portal login-url) and signed requests. Needs an Amp
// orb. Inside the orb that owns a portal, its hostname resolves to a local shortcut that skips
// Amp's sign-in, so this script reruns itself in a mount namespace whose /etc/hosts lacks that
// entry: its requests then go out to Amp's portal proxy and back, as another orb's do.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EXT, PAGE, api, cdp, check, dir, done, evaluate, message, openTarget, pageTarget, pair, readToken, shot, showTab, trustedClick, until, wakeWorker } from './lib'
import { writePublished } from '../../plugin/host'

if (!process.env.AMP_ORB || !Bun.which('amp')) {
  console.log('SKIP portal: needs an Amp orb, to register a portal')
  process.exit(0)
}

// A portal's address depends on the directory amp runs in; a fixed one reuses the same portal every run.
const portalDir = `${tmpdir()}/abb-e2e-portal`
mkdirSync(portalDir, { recursive: true })
const portal = (await Bun.$`amp orb portal 19989 --title ${'Browser bridge (e2e)'} --description ${'bun run e2e portal; requires the bridge token'}`.cwd(portalDir).text()).trim().split('\n').at(-1)!.replace(/\/$/, '')
const host = new URL(portal).hostname
const hosts = readFileSync('/etc/hosts', 'utf8')
if (hosts.split('\n').some((l) => l.split(/\s+/).includes(host))) {
  if (process.env.E2E_OUTSIDE) throw new Error(`${host} still resolves locally`)
  const outside = `${dir}/hosts-outside`
  writeFileSync(outside, hosts.split('\n').filter((l) => !l.split(/\s+/).includes(host)).join('\n'))
  const uid = process.getuid!(), gid = process.getgid!()
  const proc = Bun.spawn(['sudo', '-E', 'unshare', '-m', 'sh', '-c', `mount --bind "$0" /etc/hosts && exec setpriv --reuid=${uid} --regid=${gid} --init-groups "$@"`, outside, process.execPath, import.meta.path],
    { env: { ...process.env, E2E_OUTSIDE: '1' }, stdout: 'inherit', stderr: 'inherit' })
  process.exit(await proc.exited)
}
console.log(`portal ${portal}, reached from outside the orb's shortcut`)

const unsigned = await fetch(`${portal}/status`, { redirect: 'manual' })
check('without a portal sign-in the request stops at Amp', unsigned.status === 302 && (unsigned.headers.get('location') ?? '').startsWith('https://ampcode.com/'), { status: unsigned.status, location: unsigned.headers.get('location') })

const { send: sw } = await wakeWorker()
await pair()
await until(async () => (await api('/status', null)).extension_connected)
const tabId = await evaluate(sw, `chrome.tabs.query({url: '${PAGE}/*'}).then(t => t[0].id)`)
// A person lends the tab they're looking at; Chrome drops input to a tab that was never shown.
await showTab(`${PAGE}/`)
await message({ action: 'lend', tabId })
await message({ action: 'permissions', allowActions: true, anyOrigin: false })

// The real plugin, as an orb loads it, with BROWSER_BRIDGE_URL and BROWSER_BRIDGE_TOKEN pointing here
// (never the user's own secrets of those names).
process.env.AMP_BROWSER_BRIDGE_ROLE = 'client'
process.env.BROWSER_BRIDGE_URL = portal
process.env.BROWSER_BRIDGE_TOKEN = await readToken()
const plugin = (await import('../../plugin/index')).default
const tools = new Map<string, any>()
await plugin({ registerTool: (t: any) => tools.set(t.name, t), logger: { log() {} }, onDispose() {}, attachments: { upload: async () => { throw new Error('offline') } } } as any)
const dialogs: any[] = []
const ctx = { thread: { id: 'T-00000000-0000-0000-0000-0000000000a9' }, signal: new AbortController().signal, ui: { select: async (o: any) => (dialogs.push(o), 'Allow once') }, logger: { log() {} } }
const run = async (name: string, input: any = {}) => { try { return { ok: await tools.get(name).execute(input, ctx) } } catch (e: any) { return { err: e.message as string } } }

const status = JSON.parse((await run('browser_status')).ok ?? '{}')
check('browser_status through the portal: connected, tab lent', status.extension_connected && status.tab?.url === `${PAGE}/`, status)
const snap = (await run('browser_snapshot')).ok as string
check('browser_snapshot through the portal', snap?.startsWith('Bridge test page'), snap)
const ref = snap.split('\n').find((l) => /button "Press me"/.test(l))?.match(/\[(e\d+)\]/)?.[1]
const clicked = await run('browser_click', { ref })
check('browser_click through the portal, after approval', clicked.ok && dialogs.length === 1 && /"Clicked!"/.test((await run('browser_snapshot')).ok), clicked)
const image = (await run('browser_screenshot')).ok as any
check('browser_screenshot through the portal', image?.[0]?.type === 'image' && image[0].data.length > 1000)

const handoff = run('browser_handoff', { message: 'Sign in, then click Continue' })
const page = cdp((await pageTarget()).webSocketDebuggerUrl)
let rect: any
await until(async () => (rect = JSON.parse(await evaluate(page, `JSON.stringify(document.getElementById('__amp_handoff')?.getBoundingClientRect() ?? null)`))))
await Bun.sleep(1500)
await showTab(`${PAGE}/`)
await trustedClick(page, rect.left + 30, rect.bottom - 26)
check('browser_handoff through the portal returns after Continue', JSON.parse((await handoff).ok ?? '{}').continued === true)

// What browser_bridge_publish records; the setup page then shows this portal.
writePublished(dir, { url: portal, thread: process.env.AMP_THREAD_ID ?? '', at: new Date().toISOString() })
const setup = cdp((await openTarget(`chrome-extension://${EXT}/setup.html`)).webSocketDebuggerUrl)
check('the setup page names the portal, every step green', await until(async () => evaluate(setup, `[...document.querySelectorAll('.step')].every(s => s.className === 'step ok') && document.querySelector('#published').textContent.includes(${JSON.stringify(portal)})`), 60))
await shot('setup-published')
await message({ action: 'stop' })
done()
