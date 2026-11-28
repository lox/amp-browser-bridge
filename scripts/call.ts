// Calls one bridge tool as an Amp thread would, encrypted with your setup key, to try the
// extension without Amp (the Chrome Web Store's reviewers do).
//
//   BROWSER_BRIDGE_KEY=abb1_... bun scripts/call.ts snapshot
//   bun scripts/call.ts click '{"ref":"e1"}'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../plugin/crypto'

const [tool, args = '{}'] = process.argv.slice(2)
if (!tool) throw new Error('Usage: bun scripts/call.ts <tool> [json args]')
const keyFile = join(homedir(), '.amp-browser-bridge', 'key')
const rawKey = (process.env.BROWSER_BRIDGE_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '')).trim()
if (!rawKey) throw new Error('Set BROWSER_BRIDGE_KEY or save ~/.amp-browser-bridge/key from Chrome (Setup and status → Copy setup key).')
const client = createClient(rawKey, process.env.BROWSER_BRIDGE_RELAY)
const thread = 'T-00000000-0000-0000-0000-000000000000'
const res = tool === 'status' ? await client.request(thread, '/status') : await client.call(thread, tool, JSON.parse(args))
console.log(JSON.stringify(res, null, 2))
