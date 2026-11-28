// Runs each test/e2e/*.e2e.ts against the real extension in a headed Chrome and a real blind
// reflector (relay/server.ts), each on a fresh home and Chrome profile with Developer mode on. On
// Linux without a display it starts Xvfb. CHROME_BIN must be Chrome for Testing or Chromium (branded
// Chrome ignores --load-extension); it defaults to agent-browser's newest Chrome for Testing.
// Usage: bun run e2e [name ...]. E2E_SHOTS=<dir> saves screenshots of the whole screen there.
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const forTesting = join(homedir(), '.agent-browser/browsers')
const chrome = process.env.CHROME_BIN ?? (existsSync(forTesting) ? readdirSync(forTesting).filter((d) => d.startsWith('chrome-')).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).map((d) => join(forTesting, d, 'chrome')).find(existsSync) : undefined)
if (!chrome) throw new Error('Set CHROME_BIN to a Chrome for Testing or Chromium binary')

const only = process.argv.slice(2)
const scripts = [...new Bun.Glob('*.e2e.ts').scanSync(import.meta.dir)].sort().filter((f) => !only.length || only.some((o) => f.includes(o)))
if (!scripts.length) throw new Error(`No test/e2e script matches ${only.join(', ')}`)

async function waitFor(what: string, f: () => Promise<boolean> | boolean, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (await Promise.resolve().then(f).catch(() => false)) return
  throw new Error(`timed out waiting for ${what}`)
}

// A headed Chrome, so the toolbar popup, chrome://extensions and Reload behave as on a desktop.
let xvfb: ReturnType<typeof Bun.spawn> | undefined
if (process.platform === 'linux' && !process.env.DISPLAY) {
  if (!Bun.which('Xvfb')) throw new Error('No display: install Xvfb (apt-get install xvfb) or set DISPLAY')
  const display = ':99'
  if (!existsSync('/tmp/.X11-unix/X99')) {
    xvfb = Bun.spawn(['Xvfb', display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdout: 'ignore', stderr: 'ignore' })
    await waitFor('Xvfb', () => existsSync('/tmp/.X11-unix/X99'))
  }
  process.env.DISPLAY = display
}

const pageDir = join(import.meta.dir, 'page')
const page = Bun.serve({
  hostname: '127.0.0.1',
  port: 8765,
  fetch: (req) => {
    const path = new URL(req.url).pathname
    if (path === '/to-store') return Response.redirect('https://chromewebstore.google.com/', 302)
    if (path === '/no-content') return new Response(null, { status: 204 })
    if (path === '/download') return new Response('a file', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="bridge-test.txt"' } })
    const file = Bun.file(join(pageDir, path === '/' ? 'index.html' : path))
    return file.exists().then((ok) => (ok ? new Response(file) : new Response('not found', { status: 404 })))
  },
})

let failed = 0
for (const script of scripts) {
  const home = mkdtempSync(join(tmpdir(), 'abb-home-'))
  const profile = mkdtempSync(join(tmpdir(), 'abb-chrome-'))
  const shots = process.env.E2E_SHOTS && join(resolve(process.env.E2E_SHOTS), basename(script, '.e2e.ts'))
  if (shots) mkdirSync(shots, { recursive: true })
  // Developer mode, as after "Load unpacked"; without it Reload turns a command-line extension off.
  mkdirSync(join(profile, 'Default'))
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }))
  const relay = Bun.spawn(['bun', 'relay/server.ts'], { cwd: root, env: { ...process.env, HOME: home }, stdout: 'ignore', stderr: 'inherit' })
  let browser: ReturnType<typeof Bun.spawn> | undefined
  console.log(`--- ${script}`)
  try {
    await waitFor('the reflector', async () => (await fetch('http://127.0.0.1:19989/healthz')).ok)
    const ext = join(root, 'extension')
    browser = Bun.spawn([chrome, '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-position=0,0', '--window-size=1440,900', '--remote-debugging-port=9333', `--user-data-dir=${profile}`,
      `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-extension-debugging', `http://127.0.0.1:${page.port}/`],
      { env: { ...process.env }, stdout: 'ignore', stderr: 'ignore' })
    await waitFor('Chrome', async () => (await fetch('http://127.0.0.1:9333/json/version')).ok)
    // Clean env: never pass real BROWSER_BRIDGE_* secrets into e2e scripts.
    const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, E2E_HOME: home, ...(shots ? { E2E_SHOTS: shots } : {}) }
    delete childEnv.BROWSER_BRIDGE_KEY
    delete childEnv.BROWSER_BRIDGE_RELAY
    delete childEnv.BROWSER_BRIDGE_URL
    delete childEnv.BROWSER_BRIDGE_TOKEN
    delete childEnv.AMP_BROWSER_BRIDGE_ROLE
    const run = Bun.spawn(['bun', join(import.meta.dir, script)], { cwd: root, env: childEnv, stdout: 'inherit', stderr: 'inherit' })
    const timer = setTimeout(() => run.kill(), 240_000)
    const code = await run.exited
    clearTimeout(timer)
    if (code !== 0) {
      failed++
      console.log(`FAIL ${script} exited ${code}`)
    }
  } catch (e) {
    failed++
    console.log(`FAIL ${script}: ${(e as Error).message}`)
  } finally {
    browser?.kill()
    relay.kill()
    await Promise.all([browser?.exited, relay.exited])
    rmSync(home, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
}
page.stop()
xvfb?.kill()
console.log(failed ? `${failed} of ${scripts.length} scripts failed` : `all ${scripts.length} scripts passed`)
process.exit(failed ? 1 : 0)
