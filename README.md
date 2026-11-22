# Amp Browser Bridge

**Lend one Chrome tab to your [Amp](https://ampcode.com) threads, even ones running in an orb in the
cloud, or let them open background tabs of their own.** The agent sees the page as you do, logins
included, and asks before it clicks or types.
When a step needs a person, like a login, a 2FA code or a payment, it hands the tab back to you
and waits.

<p align="center">
  <img src="docs/popup-lent.png" width="320" alt="The extension popup with a tab lent read-only">
  &nbsp;
  <img src="docs/popup-handoff.png" width="320" alt="The popup while Amp waits for you to sign in and click Continue">
</p>

Ask things like:

- *"Read my lent tab and summarise the open issues."*
- *"Fill in this form from the spec in the repo, but let me check it before submitting."*
- *"Reproduce the bug on this page and take a screenshot of the error."*

## Why it's safe

- **You choose the tab.** The agent works on the one tab you lent, through a fixed set of page
  actions, and on tabs it opened itself if you let it. It can't touch your other tabs or read your
  cookies or history.
- **Read-only until you say otherwise.** Clicking, typing and navigation stay off until you tick a
  box in the popup. Even then, Amp asks you before each action, or once per site if you say so.
- **It stays on one site.** The tab can't wander off the site you lent it on unless you allow it.
- **You take over for secrets.** During a handoff the agent can't see or touch the tab, so it never
  sees what you type. Only your real click on **Continue** gives it back.
- **Nothing is open to your network.** The bridge listens on `127.0.0.1` only. Orbs reach it
  through an Amp portal that needs your Amp sign-in and a signature made with a secret token.
- **No secrets on the wire.** The extension and the bridge prove to each other that they share a
  key before the extension does anything, so a program that takes the bridge's port can't drive
  your tab.
- **Stop anytime.** Click **Stop lending**, close the tab, or cancel Chrome's "started debugging"
  bar.

The details, including what this does *not* protect against, are under [Security](#security).

## Set up

You need the [Amp app for macOS](https://ampcode.com/docs/apps/mac) with **Run threads on this Mac**
and **Allow Portals** turned on (App Settings → Runner), and Chrome 116 or newer. Setup takes a few
minutes and no terminal.

1. **Install the plugin.** In any Amp thread, ask:

   ```prompt
   Install the plugin/ directory from https://github.com/lox/amp-browser-bridge into my personal plugins as browser-bridge, then push it.
   ```

   It lands in your User Plugins repository, so new threads on your Mac and in your orbs get it.

2. **Load the extension.** [Download this repository](https://github.com/lox/amp-browser-bridge/archive/refs/heads/main.zip)
   and unzip it. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**,
   and pick the `extension` folder. Pin the extension from Chrome's puzzle-piece menu. It always
   gets the ID `goknnphohomgekkahpdiphdfladfnmoc`, which is how Amp finds its setup page.

   Chrome opens a setup page that follows the remaining steps live and says what to do at any
   step that fails. Reopen it any time from the popup's **Setup and status** link.

3. **Pair it.** In an Amp thread on your Mac, ask *"pair the browser extension"*. Amp opens the
   setup page with a one-time code and the extension pairs by itself.

4. **Publish it to your orbs.** In an Amp thread on your Mac, ask *"publish the browser bridge"*
   and confirm. Keep that thread unarchived: the portal belongs to it. Skip this step if you only
   use threads on your Mac.

When all four steps are green, you're done:

<p align="center"><img src="docs/setup-done.png" width="620" alt="The setup page with all four steps checked"></p>

## Use it

Open the page you want help with, click the extension, and choose **Lend this tab**. Then ask Amp
about it.

- **Allow clicks, typing and navigation** lets the agent act on the page. Amp asks before each
  action; **Allow on *site* for this thread** stops the questions for that thread on that site.
- **Allow other sites** lets the agent navigate away from the site you lent the tab on. If you
  browse away yourself, the agent waits until you come back.
- **Continue** ends a handoff, on the card the agent shows on the page or in the popup.
- **Release to other threads** lets another thread use the tab. One thread holds it at a time,
  until it has been idle for 10 minutes. The tab stays lent and in the Amp group; use **Stop
  lending** to take it back.
- The lent tab moves into a green **Amp** tab group, and goes back to its earlier group when you
  stop lending. On that tab, the toolbar badge shows `ON`, `RUN` while a command runs, and `WAIT`
  when Amp needs you; other tabs show no badge.

### Amp's own tabs

Tick **Let Amp open its own tabs** in the popup, and a thread can open pages it needs without you
lending one: Amp asks before it opens a site, then the tab opens in the background of the window you
last used, inside a collapsed green **Amp** group.

- Only the thread that opened a tab can use it. Each thread can have several, while another thread
  holds the lent tab.
- Clicks, typing and navigation in them need no extra checkbox, and may go to any site, but Amp still
  asks before each action, or once per site per thread.
- They close after 10 minutes without a command, never while one runs or while Amp waits for you.
  The popup lists them with **Show** and **Close**; turning the setting off closes them all.
- A handoff in one of them opens its group, shows `WAIT` on the toolbar button of every tab, and the
  popup says which tab needs you.
- Lending one of Amp's tabs makes it yours: it gets the lent tab's limits. Cancel on Chrome's
  "started debugging" bar also takes them back, leaving them open.

If a dialog, banner or overlay covers what the agent wants to click, type into, press a key on or
select in, the action is refused rather than hitting whatever is on top.

## Troubleshooting

The setup page is the first place to look; each red step says how to fix it:

<p align="center"><img src="docs/setup-no-bridge.png" width="620" alt="The setup page with the first step red: nothing answers on 127.0.0.1:19989, and how to fix it"></p>

The common cases:

- **"Nothing answers on 127.0.0.1:19989".** Open the Amp app with **Run threads on this Mac**
  turned on, and check the plugin is installed. The bridge starts with Amp.
- **"Something other than the bridge answers on port 19989".** Quit the program holding the port,
  then restart the Amp app.
- **Pairing didn't happen.** If Chrome wasn't running, the setup page may say it was blocked;
  reload it. Or copy the code from `~/.amp-browser-bridge/pairing-code` into the setup page. Codes
  last 10 minutes.
- **"The extension was updated and now pairs in a safer way".** Browsers paired before the
  extension proved its key with a handshake need to pair once more. Update the plugin on your Mac
  too, then ask Amp to *"pair the browser extension"*.
- **"Something on 127.0.0.1:19989 could not prove it is your bridge".** Another program holds the
  bridge's port, and the extension won't talk to it. Quit that program, then restart the Amp app.
- **Orbs can't reach the tab.** Ask *"publish the browser bridge"* again from a thread on your Mac.
  Orbs that were already running need `amp orb restart-processes` to pick up a new address.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_status` | Connection, lent tab, who holds it, whether this thread's last handoff is still waiting or you clicked **Continue**, and what to do next |
| `browser_open_tab`, `browser_close_tab` | Open a background tab of the thread's own, after your approval, and close it |
| `browser_snapshot` | Accessibility outline with refs (`e12`) for the action tools |
| `browser_screenshot` | JPEG of the viewport |
| `browser_wait_for` | Wait (up to 20 seconds) for text, a URL or an element by role and name to appear |
| `browser_scroll` | Scroll by a number of pixels |
| `browser_click`, `browser_type`, `browser_navigate` | Act on the page, after your approval |
| `browser_fill` | Like `browser_type`, but hides the value of password and one-time-code fields in the approval prompt and the result |
| `browser_press` | Press a key such as Enter, Escape or Tab, on a ref or on whatever has focus, after your approval |
| `browser_select` | Choose an option of a `<select>` by value or label, after your approval |
| `browser_handoff` | Hand the tab to you and wait for **Continue** (up to 30 minutes). If a call is lost while the card is up, calling it again waits for the same card |
| `browser_bridge_pair` | On the Mac only: open the setup page with a new one-time pairing code |
| `browser_bridge_publish` | On the Mac only: expose the bridge to your orbs; it republishes itself on every start |

Page tools take an optional `tab` (from `browser_open_tab`); without it they use the lent tab.

## Security

The agent works in a browser you are signed in to, so treat what it reads as untrusted: a page or
an email can try to steer it.

- **Who can drive the tab.** HTTP calls are signed with `BROWSER_BRIDGE_TOKEN` (stored in
  `~/.amp-browser-bridge/token`, mode 600): each request carries an HMAC of its method, path,
  thread and body, a time within five minutes of the bridge's clock and a nonce the bridge accepts
  only once, and the bridge signs its answers the same way. The token itself is never sent, so a
  program that takes port 19989 while the bridge isn't running can't capture it, and the plugin
  rejects answers it didn't sign. Through the portal, Amp also requires your sign-in.
- **Pairing.** A pairing code works once, within 10 minutes, and five wrong codes void it. The
  browser exchanges it for a random key of its own over a fresh key agreement (ECDH, with the code
  stretched by PBKDF2), so neither the code nor the key crosses the connection. On every connection
  both sides prove they hold the key with an HMAC over fresh nonces from each side, the bridge
  first; the extension sends nothing about your tab and obeys nothing until the bridge has proved
  it. So a program that grabs the port first learns nothing it can use and can't drive your browser.
  The extension link accepts only this extension's ID, dialled as `127.0.0.1` or `localhost`, which
  turns away web pages, other extensions and DNS rebinding; the HTTP API refuses cross-site browser
  requests. Keys paired before this handshake had crossed the connection in plain text, so they are
  dropped and the browser pairs again.
- **What that does not cover.** Programs running as you can read `~/.amp-browser-bridge` and
  Chrome's storage, so they can do anything you can. While another program holds port 19989 it
  sees what threads ask the bridge (tool names and arguments such as text to type), though it can't
  act on them or answer as the bridge. Such a program can also make the extension forget its key
  by refusing it, so you pair again.
- **What enforces what.** The extension enforces the hard limits: only the tab you lent and, if you
  allowed them, tabs Amp opened, the lent tab read-only until you allow actions and on its own site
  until you allow others, nothing during a handoff. The
  approval prompts in Amp are a convenience on top: they guard the agent's tools, but code running
  in your orb can read `BROWSER_BRIDGE_TOKEN` and call the bridge directly. So keep tabs read-only
  unless you are watching. Likewise, the one-thread lease and each tab belonging to the thread that
  opened it keep threads from interleaving; they are not security boundaries.
- **Amp's own tabs are wider.** With **Let Amp open its own tabs** on, a token holder can open any
  site in your signed-in browser and click and type there, without the read-only and one-site limits
  of a lent tab; only the approval prompts stand in the way, and code in an orb can skip those. Keep
  it off unless you want that.
- **Refs.** They expire when the page changes, and an element is checked against the snapshot's
  role and name before each action. If the page moves focus while text is typed, the result is
  reported as unknown.
- **What it sees.** Snapshots and `browser_wait_for` leave out what's typed in fields. Screenshots
  show the page as it is. `browser_fill` hides what goes into password and one-time-code fields
  from the approval prompt and its result, but the agent chose the value, so it still knows it.
- **The card.** A page can't press **Continue** for you, but it can hide the card; use the popup's
  **Continue** button then.
- **Limits.** The site limit covers navigation, not requests the page makes itself. If an answer
  is lost in the middle of an action (the extension disconnects, or the portal times out), the
  result is reported as unknown and never retried, so check the page.

## How it works

```text
orb thread ── browser_* tools ──https──▶ Amp portal ──▶ Amp plugin on your Mac
                                                          │ bridge on 127.0.0.1:19989
                                       Chrome extension ◀─┘ (loopback WebSocket)
```

`plugin/index.ts` decides its role by platform: on macOS it runs the bridge (`plugin/host.ts`);
elsewhere it reads `BROWSER_BRIDGE_URL` and `BROWSER_BRIDGE_TOKEN`, signs in to the portal with
`amp portal login-url`, and forwards each tool call. Every Amp process on the Mac loads the plugin;
the first one to bind port 19989 runs the bridge and the others take over if it exits. Set
`AMP_BROWSER_BRIDGE_ROLE` to `host`, `client` or `off` to override, and `BROWSER_BRIDGE_PORT` to
change the port (the extension expects 19989).

Publishing serves the bridge through a [runner portal](https://ampcode.com/docs/cli/runners) owned
by the thread you asked in, and stores `BROWSER_BRIDGE_URL` and `BROWSER_BRIDGE_TOKEN` as personal
Amp secrets, which every new orb receives. After that, the bridge republishes itself every time it
starts, re-registering the portal through the same thread and updating `BROWSER_BRIDGE_URL` if the
address changed. The address depends on the directory the `amp` CLI runs in, so the plugin always
runs it from `~/.amp-browser-bridge`, and the URL stays the same across restarts and plugin updates.

The extension (`extension/`) attaches Chrome's debugger to the lent tab only. Its half of the
pairing handshake is `extension/pairing.js`; the bridge's half is in `plugin/host.ts`, and the
tests run the two against each other. Its state lives in
session storage, so a service worker restart keeps the lend, the snapshot refs and a waiting
handoff. The bridge tells the extension where it is published (`~/.amp-browser-bridge/published.json`:
portal URL, owning thread and time, never the token), so the setup page can show it. You can also
run the bridge without Amp: `bun plugin/host.ts`.

The setup page (`extension/setup.html`) finds the bridge by its `401` answer on
`http://127.0.0.1:19989/status`, and learns about publishing from a
`{type: "published", published: {url, thread, at} | null}` message the bridge sends after `ready`.
Opened as `setup.html#code=<code>`, it pairs with that code and drops it from the address bar.

The plugin can't be installed with `amp plugins import` or `amp plugins add` yet, because they
only take Amp-hosted plugin URLs, not GitHub ones.

## Develop

```sh
bun install
bun run check   # type check, syntax check the extension, run the bridge tests
```

After changing `extension/`, click **Reload** on its card in `chrome://extensions`.

## Release

```sh
bun run release            # dist/amp-browser-bridge-<version>.zip, keeps the fixed ID
bun run release --no-key   # without the manifest key, for a first Chrome Web Store upload
```

The version comes from `extension/manifest.json`; bump it before each release. The zip is the
`extension/` folder as is, and the same sources always give the same bytes. Unzip it and use
**Load unpacked** to try it.

The fixed ID comes from the `key` in `extension/manifest.json` and is exported as `EXTENSION_ID`
from `plugin/extension-id.ts`; a test fails if they disagree. The extension is not in the Chrome
Web Store. A store listing would get a store-assigned ID, so both would change together.
[`docs/chrome-web-store.md`](docs/chrome-web-store.md) drafts the listing, permission
justifications and screenshots, and [`docs/privacy.md`](docs/privacy.md) the privacy policy.

## License

[MIT](LICENSE)
