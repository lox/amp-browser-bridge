// Amp's own tabs where Chrome won't let the extension in: Web Store URLs, a redirect into the Web
// Store and downloads. A failed open_tab must not leave a tab behind that the agent can't see.
import { PAGE, api, call, check, done, evaluate, message, pair, until, wakeWorker } from './lib'

const A = 'T-00000000-0000-0000-0000-00000000000a'
const { send: sw } = await wakeWorker()
const ev = (e: string) => evaluate(sw, e)
await pair()
check('extension pairs and connects', await until(async () => (await api('/status', null)).extension_connected))
await message({ action: 'agentTabs', enabled: true })
const count = (): Promise<number> => ev('chrome.tabs.query({}).then(t => t.length)')
const agentTabs = async () => (await api('/status', A)).agent_tabs.tabs as { tab: number }[]

for (const url of ['https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/devconsole']) {
  const before = await count()
  const r = await call(A, 'open_tab', { url })
  check(`open_tab ${url}: refused as a permanent Chrome rule, known outcome`, /never lets extensions control Chrome Web Store/.test(r.error ?? '') && !r.unknown, r)
  check(`open_tab ${url}: no tab opened`, (await count()) === before && (await agentTabs()).length === 0)
}

// A redirect into the Web Store fails only after the tab opened; the extension closes it.
{
  const before = await count()
  const r = await call(A, 'open_tab', { url: `${PAGE}/to-store` })
  check('open_tab redirected into the Web Store: Web Store message, known outcome', /never lets extensions control Chrome Web Store.*Amp closed the tab/.test(r.error ?? '') && !r.unknown, r)
  check('open_tab redirected into the Web Store: tab closed', (await until(async () => (await count()) === before, 30)) && (await agentTabs()).length === 0, { before, now: await count() })
}

// A download closes the tab Chrome opened for it; the error says so and nothing is left behind.
{
  const before = await count()
  const r = await call(A, 'open_tab', { url: `${PAGE}/download` })
  check('open_tab on a download: says the tab closed, known outcome', /closed as it opened/.test(r.error ?? '') && !r.unknown, r)
  check('open_tab on a download: no tab left', (await count()) === before && (await agentTabs()).length === 0)
}

const opened = await call(A, 'open_tab', { url: `${PAGE}/other.html` })
const tab = opened.result?.tab
check('open_tab on a normal page returns its tab', Number.isInteger(tab), opened)
{
  const r = await call(A, 'navigate', { url: 'https://chromewebstore.google.com/', tab })
  check('navigate to the Web Store: permanent-rule message, known outcome', /never lets extensions control Chrome Web Store/.test(r.error ?? '') && !r.unknown, r)
}
{
  const r = await call(A, 'navigate', { url: `${PAGE}/download`, tab })
  check('navigate to a download reports the download, not a failure', r.result?.download === `${PAGE}/download` && r.result.url === `${PAGE}/other.html`, r)
}
check('the open tab is still there', (await agentTabs()).some((t) => t.tab === tab))
{
  const r = await call(A, 'navigate', { url: `${PAGE}/to-store`, tab })
  check('navigate redirected into the Web Store: says where the tab is, known outcome', /tab is on the Chrome Web Store\. Chrome never lets extensions/.test(r.error ?? '') && !r.unknown, r)
  const s = await call(A, 'snapshot', { tab })
  check('snapshot on a Web Store tab: permanent-rule message', /never lets extensions control Chrome Web Store/.test(s.error ?? '') && !s.unknown, s)
  const c = await call(A, 'close_tab', { tab })
  check('close_tab still closes a tab on the Web Store', c.result?.closed === tab && (await agentTabs()).length === 0, c)
}
done()
