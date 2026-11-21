import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-ignore: the extension is plain JavaScript.
import { classifyChallenge } from '../extension/challenge.js'
import { challengeAdvice } from '../plugin/index'

// Each fixture is what the extension's probe read from a real page in headless Chrome on an orb
// (a datacenter IP, so many sites challenged it), with IP addresses and query values scrubbed.
const dir = join(import.meta.dir, 'fixtures', 'challenges')

/** What each page is, judged by looking at it: vendor and kind, or null for an ordinary page. */
const expected: Record<string, { vendor: string; kind: string } | null> = {
  // Cloudflare's managed challenge ("Performing security verification"), and Glassdoor's own version.
  'scrapingcourse.com-cloudflare-challenge': { vendor: 'cloudflare', kind: 'non-interactive' },
  'stockx.com': { vendor: 'cloudflare', kind: 'non-interactive' },
  'cloudflare.com-learning-bots-how-captchas-work': { vendor: 'cloudflare', kind: 'non-interactive' },
  'glassdoor.com': { vendor: 'cloudflare', kind: 'non-interactive' },
  'upwork.com': { vendor: 'cloudflare', kind: 'block' },
  // Indeed's own block page, titled "Blocked - Indeed.com", with a Cloudflare Ray ID.
  'indeed.com': { vendor: 'cloudflare', kind: 'block' },
  'zillow.com': { vendor: 'perimeterx', kind: 'interactive' },
  'fiverr.com': { vendor: 'perimeterx', kind: 'interactive' },
  'g2.com': { vendor: 'datadome', kind: 'non-interactive' },
  'leboncoin.fr': { vendor: 'datadome', kind: 'interactive' },
  // Google's "unusual traffic" page, served in place of search results.
  'google.com-search': { vendor: 'recaptcha', kind: 'interactive' },
  // Adidas's Akamai block page, with only a reference number to show for it.
  'adidas.com-us': { vendor: 'akamai', kind: 'block' },
  'similarweb.com': { vendor: 'aws-waf', kind: 'block' },

  // Ordinary pages, several about captchas or with one in a form.
  'example.com': null,
  'en.wikipedia.org-wiki-CAPTCHA': null,
  'developers.cloudflare.com-turnstile': null,
  'google.com-recaptcha-about': null,
  'hcaptcha.com': null,
  '2captcha.com-demo-recaptcha-v2': null,
  'google.com-recaptcha-api2-demo': null,
  'accounts.hcaptcha.com-demo': null,
  'github.com-login': null,
  'accounts.google.com': null,
  'login.microsoftonline.com': null,
  'news.ycombinator.com': null,
  'developer.mozilla.org-en-US-docs-Web-HTTP-Reference-Status-403': null,
  // Chrome's own error page for an HTTP 403: an error, not a bot check.
  'httpbin.org-status-403': null,
}

test('every fixture has an expectation', () => {
  expect(readdirSync(dir).map((f) => f.replace(/\.json$/, '')).sort()).toEqual(Object.keys(expected).sort())
})

for (const [name, want] of Object.entries(expected)) {
  test(name, () => {
    const { probe } = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))
    const got = classifyChallenge(probe)
    if (want) expect(got).toMatchObject(want)
    else expect(got).toBeNull()
  })
}

test('generic phrases count only on short pages', () => {
  const page = (title: string, text: string) => ({ url: 'https://shop.example/', title, text: text.slice(0, 3000), textLength: text.length, frameUrls: [], scriptSrcs: [], selectors: [], visibleSelectors: [] })
  expect(classifyChallenge(page('Access Denied', 'Access denied'))).toMatchObject({ vendor: 'generic', kind: 'block' })
  expect(classifyChallenge(page('Security', 'Please verify you are a human to continue.'))).toMatchObject({ vendor: 'generic', kind: 'interactive' })
  const article = `Access denied: how sites ask you to verify you are human. ${'More of the article. '.repeat(100)}`
  expect(classifyChallenge(page('Bot detection explained', article))).toBeNull()
})

test('signals leave out the session values in challenge URLs', () => {
  const probe = { url: 'https://shop.example/', title: '', text: '', textLength: 0, frameUrls: ['https://geo.captcha-delivery.com/captcha/?initialCid=secret&cid=secret'], scriptSrcs: [], selectors: [], visibleSelectors: [] }
  expect(classifyChallenge(probe).signal).toBe('iframe https://geo.captcha-delivery.com/captcha/')
})

test('the agent hands interactive checks to the user and stops at blocks', () => {
  const at = { vendor: 'cloudflare', signal: 'title: Just a moment...', url: 'https://shop.example/a?b=1', waited_ms: 12_000 }
  expect(challengeAdvice({ ...at, kind: 'non-interactive' })).toContain('call browser_handoff')
  expect(challengeAdvice({ ...at, kind: 'non-interactive' })).toContain('still there after 12 s')
  expect(challengeAdvice({ ...at, kind: 'interactive' })).toContain('on https://shop.example, then click Continue')
  const block = challengeAdvice({ ...at, kind: 'block' })
  expect(block).toContain('Stop and tell the user')
  expect(block).not.toContain('browser_handoff')
})
