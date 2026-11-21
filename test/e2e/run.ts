// Runs each test/e2e/*.e2e.ts against the real extension in headless Chrome and a real bridge
// (plugin/host.ts), each on a fresh bridge home and Chrome profile. Needs CHROME_BIN: Chrome for
// Testing or Chromium (branded Chrome ignores --load-extension). Usage: bun run e2e [name ...]
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const chrome = process.env.CHROME_BIN
if (!chrome) throw new Error('Set CHROME_BIN to a Chrome for Testing or Chromium binary')

const only = process.argv.slice(2)
const scripts = [...new Bun.Glob('*.e2e.ts').scanSync(import.meta.dir)].sort().filter((f) => !only.length || only.some((o) => f.includes(o)))
if (!scripts.length) throw new Error(`No test/e2e script matches ${only.join(', ')}`)

const pageDir = join(import.meta.dir, 'page')
const page = Bun.serve({
  hostname: '127.0.0.1',
  port: 8765,
  fetch: (req) => {
    const path = new URL(req.url).pathname
    const file = Bun.file(join(pageDir, path === '/' ? 'index.html' : path))
    return file.exists().then((ok) => (ok ? new Response(file) : new Response('not found', { status: 404 })))
  },
})

async function waitFor(what: string, f: () => Promise<boolean> | boolean, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (await Promise.resolve().then(f).catch(() => false)) return
  throw new Error(`timed out waiting for ${what}`)
}

let failed = 0
for (const script of scripts) {
  const home = mkdtempSync(join(tmpdir(), 'abb-home-'))
  const profile = mkdtempSync(join(tmpdir(), 'abb-chrome-'))
  const host = Bun.spawn(['bun', 'plugin/host.ts'], { cwd: root, env: { ...process.env, HOME: home }, stdout: 'ignore', stderr: 'inherit' })
  let browser: ReturnType<typeof Bun.spawn> | undefined
  console.log(`--- ${script}`)
  try {
    // Chrome must start after the bridge has written its token and pairing code.
    await waitFor('the bridge', () => existsSync(join(home, '.amp-browser-bridge/pairing-code')))
    const ext = join(root, 'extension')
    browser = Bun.spawn([chrome, '--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-port=9333', `--user-data-dir=${profile}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      '--enable-unsafe-extension-debugging', `http://127.0.0.1:${page.port}/`], { stdout: 'ignore', stderr: 'ignore' })
    await waitFor('Chrome', async () => (await fetch('http://127.0.0.1:9333/json/version')).ok)
    const run = Bun.spawn(['bun', join(import.meta.dir, script)], { cwd: root, env: { ...process.env, E2E_HOME: home }, stdout: 'inherit', stderr: 'inherit' })
    const timer = setTimeout(() => run.kill(), 180_000)
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
    host.kill()
    await Promise.all([browser?.exited, host.exited])
    rmSync(home, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
}
page.stop()
console.log(failed ? `${failed} of ${scripts.length} scripts failed` : `all ${scripts.length} scripts passed`)
process.exit(failed ? 1 : 0)
