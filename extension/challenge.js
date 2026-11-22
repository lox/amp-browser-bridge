// Recognises bot challenges and block pages, after OpenCode Browse's detection
// (https://github.com/anomalyco/browse, cli/src/execute/challenge-detection.ts). Three kinds:
// - "non-interactive": an interstitial the browser clears by itself (Cloudflare's "Just a moment...",
//   Akamai's and AWS WAF's silent checks, a DataDome device check). Worth waiting a few seconds for.
// - "interactive": only a person should answer it (a Turnstile, reCAPTCHA or hCaptcha checkbox,
//   PerimeterX "Press & Hold", a DataDome or AWS WAF captcha). The agent hands it to the user.
// - "block": the site refused the visit (Cloudflare "Sorry, you have been blocked", Akamai or Imperva
//   "Access Denied"). Retrying makes it worse.
// Generic phrases ("access denied", "verify you are human") count only on short pages, so an article
// that mentions them is not a challenge. A miss costs the agent a turn; a false positive costs a wait
// or a needless handoff, so stay conservative.

/** Element markers the probe looks for. Keep in sync with classifyChallenge. */
export const PROBE_SELECTORS = [
  // Cloudflare
  "#challenge-form", "#challenge-running", "#challenge-stage", "#cf-challenge-running", ".cf-turnstile", "#cf-error-details",
  // Akamai Bot Manager
  "#sec-if-cpt-container", "#sec-cpt-if", "#sec-text-if",
  // DataDome
  "#ddv1-captcha-container",
  // PerimeterX / HUMAN
  "#px-captcha", "#px-captcha-wrapper", "[id^='px-captcha']",
  // Imperva / Incapsula
  "#main-iframe[src*='_Incapsula_Resource']",
  // AWS WAF
  "awswaf-captcha", "#challenge-container",
  // reCAPTCHA / hCaptcha
  ".g-recaptcha", ".h-captcha",
];

/**
 * Runs in the page's isolated world (chrome.scripting.executeScript), where the page's scripts can't
 * see it. Reads only what classifyChallenge needs, and bounds every field.
 */
export function probePage(selectors) {
  const text = document.body?.innerText ?? "";
  const matched = [];
  const visible = [];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) continue;
    matched.push(selector);
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) visible.push(selector);
  }
  return {
    url: location.href,
    title: document.title.slice(0, 300),
    text: text.slice(0, 3000),
    textLength: text.length,
    frameUrls: Array.from(document.querySelectorAll("iframe[src]"), (frame) => frame.src).slice(0, 50),
    scriptSrcs: Array.from(document.scripts, (script) => script.src).filter(Boolean).slice(0, 50),
    selectors: matched,
    visibleSelectors: visible,
  };
}

const shortPage = (probe) => probe.textLength < 1500;
const clip = (value) => value.slice(0, 160);
// Challenge URLs carry session values (DataDome's cid, Cloudflare's ray); a signal names only where.
const bare = (url) => url.replace(/[?#].*$/, "");

/** {vendor, kind, signal} for a probed challenge or block page, or null for an ordinary page. */
export function classifyChallenge(probe) {
  const title = probe.title.trim().toLowerCase();
  const text = probe.text.toLowerCase();
  const has = (selector) => probe.selectors.includes(selector);
  const visible = (selector) => probe.visibleSelectors.includes(selector);
  const frame = (pattern) => probe.frameUrls.find((url) => pattern.test(url));
  const script = (pattern) => probe.scriptSrcs.find((src) => pattern.test(src));
  let host = "";
  try {
    host = new URL(probe.url).hostname;
  } catch {}

  // Cloudflare, including a site's own block page with a Cloudflare Ray ID (Indeed's, say).
  if (/sorry, you have been blocked/.test(text) && (has("#cf-error-details") || /cloudflare/.test(text))) {
    return {vendor: "cloudflare", kind: "block", signal: "text: Sorry, you have been blocked"};
  }
  if (shortPage(probe) && /you have been blocked/.test(text) && /\bray id\b/.test(text)) {
    return {vendor: "cloudflare", kind: "block", signal: "text: You have been blocked (Ray ID)"};
  }
  const interstitial = /^just a moment\b|^attention required! \| cloudflare|^checking your browser|^un instant|^einen moment/.test(title)
    || has("#challenge-form") || has("#challenge-running") || has("#cf-challenge-running") || has("#challenge-stage");
  const turnstile = frame(/^https:\/\/challenges\.cloudflare\.com\/.*(turnstile|challenge-platform)/);
  if (interstitial || (turnstile && shortPage(probe))) {
    // The managed challenge shows Turnstile's checkbox only when it wants a click; until then it clears itself.
    const widget = visible(".cf-turnstile") || /verify you are human by completing|click to verify|confirm you are human/.test(text);
    return {vendor: "cloudflare", kind: widget ? "interactive" : "non-interactive", signal: clip(interstitial ? `title: ${probe.title.trim()}` : `iframe ${bare(turnstile)}`)};
  }

  // PerimeterX / HUMAN
  if (has("#px-captcha") || has("#px-captcha-wrapper") || has("[id^='px-captcha']") || /press (?:&|and) hold/.test(text)) {
    return {vendor: "perimeterx", kind: "interactive", signal: has("#px-captcha") ? "element #px-captcha" : "text: Press & Hold"};
  }

  // DataDome
  const dataDome = frame(/captcha-delivery\.com/);
  if (dataDome || has("#ddv1-captcha-container")) {
    const silent = dataDome !== undefined && /\/interstitial\//.test(dataDome);
    return {vendor: "datadome", kind: silent ? "non-interactive" : "interactive", signal: clip(dataDome ? `iframe ${bare(dataDome)}` : "element #ddv1-captcha-container")};
  }

  // Akamai Bot Manager
  if (has("#sec-if-cpt-container") || has("#sec-cpt-if") || has("#sec-text-if")) {
    const interactive = visible("#sec-cpt-if") && /verify|press|slide|captcha/.test(text);
    return {vendor: "akamai", kind: interactive ? "interactive" : "non-interactive", signal: "element #sec-if-cpt-container"};
  }
  if (title === "access denied" && /you don't have permission to access/.test(text) && /reference #?\d/.test(text)) {
    return {vendor: "akamai", kind: "block", signal: "title: Access Denied (Akamai reference)"};
  }
  // A site's own Akamai block page still shows the reference: 18.666c3817.1795295759.607c6d26.
  if (shortPage(probe) && /reference (?:error|id|#)?:? ?\d{1,3}\.[0-9a-f]{6,10}\.\d{10}\.[0-9a-f]{4,10}/.test(text)) {
    return {vendor: "akamai", kind: "block", signal: "text: Akamai reference"};
  }

  // Imperva / Incapsula
  const incapsula = frame(/_Incapsula_Resource/) ?? script(/_Incapsula_Resource/);
  if (incapsula || has("#main-iframe[src*='_Incapsula_Resource']")) {
    const captcha = /captcha|verify you are human|i am human/.test(text) || frame(/hcaptcha|recaptcha/) !== undefined;
    if (/request unsuccessful|incapsula incident id/.test(text) && !captcha) return {vendor: "imperva", kind: "block", signal: "text: Request unsuccessful (Incapsula)"};
    return {vendor: "imperva", kind: captcha ? "interactive" : "non-interactive", signal: clip(`resource ${bare(incapsula ?? "_Incapsula_Resource")}`)};
  }
  if (/incapsula incident id/.test(text) && shortPage(probe)) return {vendor: "imperva", kind: "block", signal: "text: Incapsula incident ID"};

  // AWS WAF
  if (/^error: the request could not be satisfied/.test(title) && /request blocked/.test(text)) {
    return {vendor: "aws-waf", kind: "block", signal: "text: Request blocked (CloudFront)"};
  }
  if (has("awswaf-captcha")) return {vendor: "aws-waf", kind: "interactive", signal: "element awswaf-captcha"};
  const aws = script(/\.awswaf\.com\//);
  if (aws && shortPage(probe) && (has("#challenge-container") || probe.textLength < 300)) {
    return {vendor: "aws-waf", kind: "non-interactive", signal: clip(`script ${bare(aws)}`)};
  }

  if (!shortPage(probe)) return null;

  // Captcha walls: a short page that is mostly a reCAPTCHA or hCaptcha widget and says why. A form
  // with a captcha in it (a login, a demo) says none of these things, even when it names the captcha.
  const recaptcha = frame(/^https:\/\/www\.(?:google|recaptcha)\.(?:com|net)\/recaptcha\/(?:api2|enterprise)\/anchor/);
  const hcaptcha = frame(/^https:\/\/(?:newassets\.|assets\.)?hcaptcha\.com\/captcha\//);
  const wall = /verify you are (?:a )?human|are you a robot|not a robot|unusual traffic|security check|complete the captcha/.test(text)
    || /security check|verify/.test(title);
  if (hcaptcha && wall) return {vendor: "hcaptcha", kind: "interactive", signal: clip(`iframe ${bare(hcaptcha)}`)};
  if (recaptcha && wall) return {vendor: "recaptcha", kind: "interactive", signal: clip(`iframe ${bare(recaptcha)}`)};
  // Google's own "unusual traffic" page.
  if (/^www\.google\./.test(host) && /\/sorry\//.test(probe.url)) return {vendor: "recaptcha", kind: "interactive", signal: "url: google.com/sorry"};

  // Generic block and verification pages.
  if (/^(?:access denied|403 forbidden|forbidden|blocked|request blocked|you have been blocked)$/.test(title)
    || /^(?:access to this page has been denied|access denied)\b/.test(text.trim())) {
    return {vendor: "generic", kind: "block", signal: clip(`title: ${probe.title.trim() || text.trim().slice(0, 60)}`)};
  }
  const phrase = /verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|are you a robot\?|pardon our interruption|please verify you are a human|bot (?:check|detection)/.exec(`${title}\n${text}`);
  if (phrase) return {vendor: "generic", kind: "interactive", signal: clip(`text: ${phrase[0]}`)};
  return null;
}
