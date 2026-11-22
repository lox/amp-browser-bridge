// A sign-in handoff as it happens on a real site: the agent fills the username, hands the tab over,
// the person types the password and signs in, clicks Continue on the card, and the agent carries on
// without ever having seen the password.
import { PAGE, api, call, cdp, check, clickElement, done, evaluate, message, pageTarget, pair, refOf, shot, showTab, trustedClick, until, wakeWorker } from './lib'

const A = 'T-00000000-0000-0000-0000-0000000000f1'
const PASSWORD = 'correct horse battery staple'
const LOGIN = `${PAGE}/login.html`
const { send: sw } = await wakeWorker()
await pair()
await until(async () => (await api('/status', null)).extension_connected)
const tabId = await evaluate(sw, `chrome.tabs.query({url: '${PAGE}/*'}).then(t => t[0].id)`)
// A person lends the tab they're looking at; Chrome drops input to a tab that was never shown.
await showTab(`${PAGE}/`)
await message({ action: 'lend', tabId })
await message({ action: 'permissions', allowActions: true, anyOrigin: false })
const results: string[] = []
const agent = async (tool: string, args: object = {}) => {
  const r = await call(A, tool, args)
  results.push(JSON.stringify(r))
  return r
}

await agent('navigate', { url: LOGIN })
let snap = (await agent('snapshot')).result
await agent('fill', { ref: refOf(snap, /textbox "Username"/), value: 'lox' })
const h = (await agent('handoff', { message: 'Sign in, then click Continue' })).result
check('the agent hands the tab over', typeof h?.handoff_id === 'string', h)

// The person: types the password into the page and signs in, with real keystrokes and clicks.
await showTab(LOGIN)
const page = cdp((await pageTarget()).webSocketDebuggerUrl)
check('the card shows on the page', await until(async () => evaluate(page, `!!document.getElementById('__amp_handoff')`)))
await clickElement(page, `document.getElementById('password')`)
await page('Input.insertText', { text: PASSWORD })
check('the agent can read nothing meanwhile', /handoff/.test((await agent('snapshot')).error ?? ''))
await shot('1-typing-password')
await clickElement(page, `document.querySelector('button')`)
check('the person is signed in', await until(async () => (await evaluate(page, `document.getElementById('out').textContent`)) === 'Signed in as lox'))
check('still waiting until Continue', (await api(`/handoff/${h.handoff_id}?wait=300`, A)).result?.waiting === true)
const rect = JSON.parse(await evaluate(page, `JSON.stringify(document.getElementById('__amp_handoff').getBoundingClientRect())`))
await trustedClick(page, rect.left + 30, rect.bottom - 26)
check('Continue on the card gives the tab back', (await api(`/handoff/${h.handoff_id}?wait=3000`, A)).result?.continued === true)
check('the card is gone', await until(async () => !(await evaluate(page, `!!document.getElementById('__amp_handoff')`))))

snap = (await agent('snapshot')).result
check('the agent carries on, signed in', /Signed in as lox/.test(snap?.outline ?? ''), snap?.outline)
await agent('screenshot')
check('no result the agent got contains the password', !results.some((r) => r.includes(PASSWORD) || r.includes(Buffer.from(PASSWORD).toString('base64'))))
await message({ action: 'stop' })
done()
