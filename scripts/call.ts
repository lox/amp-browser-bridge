// Calls one bridge tool as an Amp thread would, signed with the bridge's token, to try the
// extension without Amp (the Chrome Web Store's reviewers do).
//
//   bun scripts/call.ts snapshot
//   bun scripts/call.ts click '{"ref":"e1"}'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PORT, signRequest, tokenFile } from '../plugin/host'

const [tool, args = '{}'] = process.argv.slice(2)
if (!tool) throw new Error('Usage: bun scripts/call.ts <tool> [json args]')
const token = readFileSync(tokenFile(join(homedir(), '.amp-browser-bridge')), 'utf8').trim()
const thread = 'T-00000000-0000-0000-0000-000000000000'
const path = '/call'
const body = JSON.stringify({ tool, args: JSON.parse(args) })
const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}${path}`, {
  method: 'POST',
  headers: { 'x-bridge-auth': signRequest(token, { method: 'POST', path, thread, body }).header, 'x-amp-thread': thread, 'content-type': 'application/json' },
  body,
})
console.log(await res.text())
