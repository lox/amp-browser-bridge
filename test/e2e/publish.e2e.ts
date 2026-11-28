// Runs the real plugin in its host role with a fake `amp` on PATH: the bridge republishes its
// portal on start and on a timer, and publishing warns when no runner serves its directory. The
// plugin reads HOME when it loads, so this script runs itself again with its own HOME and port.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, done, until } from './lib'

const PORTAL = 'https://port-19979--fake.onamp.dev'
const THREAD = 'T-00000000-0000-0000-0000-0000000000a1'

if (!process.env.PUBLISH_E2E_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'abb-publish-'))
  const bin = join(home, 'bin')
  mkdirSync(join(home, '.amp-browser-bridge'), { recursive: true })
  mkdirSync(bin)
  // Answers like the real CLI: `orb portal` prints the URL, `runner list --json` prints $HOME/runners.json,
  // and every thread runs on the runner "mac". `orb portal` fails while $HOME/fail exists, and takes
  // a second for the thread named in $HOME/slow. `threads export` reports the thread named in
// $HOME/archived as archived.
  writeFileSync(join(bin, 'amp'), `#!/bin/sh
echo "$PWD $*" >> "$HOME/amp.log"
case "$1 $2" in
  "orb portal")
    [ -f "$HOME/fail" ] && exit 1
    [ "$5" = "$(cat "$HOME/slow" 2>/dev/null)" ] && sleep 1
    echo "Portal: ${PORTAL}/" ;;
  "runner list") cat "$HOME/runners.json" ;;
  "threads export") [ "$3" = "$(cat "$HOME/archived" 2>/dev/null)" ] && a=true || a=false; echo '{"archived":'$a',"env":{"initial":{"runnerID":"mac"}}}' ;;
  "secrets set") cat > /dev/null ;;
esac
`)
  chmodSync(join(bin, 'amp'), 0o755)
  writeFileSync(join(home, '.amp-browser-bridge/published.json'), JSON.stringify({ url: PORTAL, thread: THREAD, at: new Date().toISOString() }))
  const child = Bun.spawn(['bun', import.meta.path], {
    env: { ...process.env, HOME: home, PUBLISH_E2E_HOME: home, PATH: `${bin}:${process.env.PATH}`, AMP_BROWSER_BRIDGE_ROLE: 'host', BROWSER_BRIDGE_PORT: '19979', BROWSER_BRIDGE_REPUBLISH_MS: '700' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await child.exited
  rmSync(home, { recursive: true, force: true })
  process.exit(code)
}

const home = process.env.PUBLISH_E2E_HOME
const dir = join(home, '.amp-browser-bridge')
const runner = (runnerId: string, served: string[]) => ({ runnerId, workingDirectory: served[0], serveCwd: true, directories: served.slice(1).map((path) => ({ path })) })
const runners = (served: string[], ...others: ReturnType<typeof runner>[]) => writeFileSync(join(home, 'runners.json'), JSON.stringify({ runners: [runner('mac', served), ...others] }))
const calls = () => readFileSync(join(home, 'amp.log'), 'utf8').trim().split('\n')
const portals = (thread = THREAD) => calls().filter((c) => c === `${dir} orb portal 19979 --thread ${thread} --title Browser bridge --description Amp browser bridge; requires its token`)
const publishedThread = () => JSON.parse(readFileSync(join(dir, 'published.json'), 'utf8')).thread
runners(['/elsewhere'])

const logs: string[] = []
const tools = new Map<string, any>()
const disposers: (() => unknown)[] = []
const plugin = (await import('../../plugin/index')).default
await plugin({ registerTool: (t: any) => tools.set(t.name, t), logger: { log: (m: string) => logs.push(m) }, onDispose: (f: () => unknown) => disposers.push(f) } as any)

check('republishes on start, from the bridge directory, through the published thread', await until(async () => portals().length >= 1, 50), calls())
check('republishes again on its timer', await until(async () => portals().length >= 4, 60), portals().length)
check('republishing the same URL leaves the secrets alone', !calls().some((c) => c.includes('secrets set')), calls())
check('republishing warns when no runner serves the bridge directory', logs.some((m) => m.includes(`amp runner dirs add --runner-id mac '${dir}'`)), logs)

const dialogs: any[] = []
const B2 = 'T-00000000-0000-0000-0000-0000000000b2'
const publish = async (thread = B2) => JSON.parse(await tools.get('browser_bridge_publish').execute({}, { thread: { id: thread }, ui: { confirm: async (o: any) => (dialogs.push(o), true) } }))
const unserved = await publish()
check('publish returns the portal URL and the unserved warning', unserved.portal_url === PORTAL && unserved.warning?.includes(`amp runner dirs add --runner-id mac '${dir}'`), unserved)
// A timer republish racing this write may set them again, so check that both were set, not how often.
check('publishing on request updates both secrets', ['BROWSER_BRIDGE_TOKEN', 'BROWSER_BRIDGE_URL'].every((name) => calls().some((c) => c.includes('secrets set') && c.includes(name))), calls())
const wording = [tools.get('browser_bridge_publish').description, dialogs[0]?.message, unserved.note].join('\n')
check('publishing says to keep the thread unarchived', dialogs[0]?.requireHuman === true && /unarchived/.test(tools.get('browser_bridge_publish').description) && /unarchived/.test(unserved.note), wording)
runners(['/elsewhere', home])
check('no warning when a runner serves a directory that contains it', (await publish()).warning === undefined)
runners([dir])
check('no warning when a runner serves the bridge directory itself', (await publish()).warning === undefined)
writeFileSync(join(home, 'runners.json'), JSON.stringify({ runners: [] }))
check('no warning when no runner reports its directories', (await publish()).warning === undefined)
runners([`${dir}-other`])
check('a sibling directory with the same prefix does not count as served', (await publish()).warning !== undefined)
runners(['/elsewhere'], runner('other', [home]))
check('another runner serving it does not hide the warning for the thread\'s own runner', (await publish()).warning?.includes('runner mac'))

// A timer republish still running when the user publishes from another thread must not win.
writeFileSync(join(home, 'slow'), B2)
const slowBefore = portals(B2).length
check('a timer republish through the last thread starts', await until(async () => portals(B2).length > slowBefore, 30))
const B3 = 'T-00000000-0000-0000-0000-0000000000b3'
await publish(B3)
await Bun.sleep(1500)
check('an explicit publish during a timer republish keeps its thread', publishedThread() === B3, publishedThread())
rmSync(join(home, 'slow'))

// While the runner is down, timer republishes fail: the setup page must say so, and the timer must
// recover through the same thread once the runner is back.
writeFileSync(join(home, 'fail'), '')
check('failing timer republishes clear published.json, so the setup page asks to publish', await until(async () => !existsSync(join(dir, 'published.json')), 60))
rmSync(join(home, 'fail'))
check('the timer then republishes through the same thread and records it again', await until(async () => publishedThread() === B3, 60))

// Amp refuses orbs' sign-in to an archived thread's portal, so publishing through one is refused,
// and the timer clears the setup page's state instead of republishing through it.
const archived = 'T-00000000-0000-0000-0000-0000000000b4'
writeFileSync(join(home, 'archived'), archived)
const before = portals(archived).length
const refused = await publish(archived).catch((e: Error) => e.message)
check('publishing through an archived thread is refused before the portal is registered', /is archived/.test(String(refused)) && portals(archived).length === before && publishedThread() === B3, refused)
writeFileSync(join(home, 'archived'), B3)
check('the timer stops republishing through a thread once it is archived', await until(async () => !existsSync(join(dir, 'published.json')), 60) && logs.some((m) => m.includes(`${B3} is archived`)))
rmSync(join(home, 'archived'))
check('and republishes through it again once it is unarchived', await until(async () => existsSync(join(dir, 'published.json')) && publishedThread() === B3, 60))

await Promise.all(disposers.map((f) => f()))
done()
