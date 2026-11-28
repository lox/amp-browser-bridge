// Calls one bridge tool as an Amp thread would, encrypted with BROWSER_BRIDGE_KEY, to try the
// extension without Amp (the Chrome Web Store's reviewers do).
//
//   BROWSER_BRIDGE_KEY=abb1_... bun scripts/call.ts snapshot
//   BROWSER_BRIDGE_KEY=abb1_... bun scripts/call.ts click '{"ref":"e1"}'
import { createClient } from '../plugin/crypto'

const [tool, args = '{}'] = process.argv.slice(2)
if (!tool) throw new Error('Usage: BROWSER_BRIDGE_KEY=abb1_... bun scripts/call.ts <tool> [json args]')
const rawKey = (process.env.BROWSER_BRIDGE_KEY ?? '').trim()
if (!rawKey) throw new Error('Set BROWSER_BRIDGE_KEY from Chrome (Setup and status → Copy setup key).')
const client = createClient(rawKey)
const thread = 'T-00000000-0000-0000-0000-000000000000'
const res = tool === 'status' ? await client.request(thread, '/status') : await client.call(thread, tool, JSON.parse(args))
console.log(JSON.stringify(res, null, 2))
