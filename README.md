# Amp Browser Bridge

Let your [Amp](https://ampcode.com) threads use your real Chrome, with your logins, even when the
thread runs in an orb in the cloud. You lend one tab; the agent reads it, takes screenshots, and,
when you allow it, clicks and types. When a step needs a person (a login, 2FA, a payment), the
agent hands the tab back to you and waits until you click **Continue**.

```text
orb thread ── browser_* tools ──https──▶ runner portal ──▶ Amp plugin on your Mac
                                                             │ bridge on 127.0.0.1:19989
                                          Chrome extension ◀─┘ (loopback WebSocket)
```

Nothing listens on your network. Chrome only talks to `127.0.0.1`, and orbs reach your Mac through
an Amp [runner portal](https://ampcode.com/docs/cli/runners), which only you can open.

It is an alternative to the Chrome integration in
[amp-mcp-gateway](https://github.com/lox/amp-mcp-gateway), which routes the browser through a
self-hosted gateway with durable approvals and an audit log. This project needs no server: just a
plugin, an extension, and the Amp app on your Mac.

## Requirements

- The [Amp app for macOS](https://ampcode.com/docs/apps/mac) with **Run threads on this Mac** and
  **Allow Portals** turned on (App Settings → Runner).
- Chrome 116 or newer (or another Chromium browser that loads unpacked extensions).

## Set up

1. **Install the plugin** in your User Plugins repository, so it loads on your Mac and in every
   orb. Clone it (`amp plugins repositories` prints the command), copy this repository's
   `plugin/` directory into it as `browser-bridge/`, then commit and push:

   ```sh
   cp -R plugin ~/path/to/user-plugins/browser-bridge
   ```

   On your Mac the plugin runs the bridge; everywhere else it only adds the tools. Start a new thread
   (or reload plugins) to pick it up.

2. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, choose **Load
   unpacked**, and pick this repository's `extension/` folder.

3. **Pair it.** Run `cat ~/.amp-browser-bridge/pairing-code` and enter the code in the extension's
   popup. A code works once, for 10 minutes. If it expires, ask Amp in a thread on your Mac for a
   new pairing code (the `browser_bridge_pair` tool writes a fresh one to the same file).

4. **Publish the bridge to your orbs.** In an Amp thread on your Mac, ask *"publish the browser
   bridge"*. After you confirm, the `browser_bridge_publish` tool:
   - serves the bridge through that thread's portal, and
   - stores `BROWSER_BRIDGE_URL` and `BROWSER_BRIDGE_TOKEN` as your personal Amp secrets, which every
     new orb receives.

   Keep that thread unarchived: the portal belongs to it. If you archive it, publish again from
   another thread on the Mac. Orbs that were already running need `amp orb restart-processes`.

## Use it

Open the page you want help with, click the extension, and choose **Lend this tab**. Then ask Amp
something like *"read my lent tab and summarise the open issues"*.

- **Read-only by default.** A new lend allows `browser_snapshot`, `browser_screenshot` and
  `browser_scroll`. Turn on **Allow clicks, typing and navigation** in the popup to go further.
- **One site.** The tab stays on the site you lent it on. Turn on **Allow other sites** to let the
  agent navigate elsewhere. If you browse away yourself, the agent stops until you come back.
- **Amp asks before acting.** Before each click, typing or navigation, the tool asks you in Amp,
  naming the element and page. **Allow on *site* for this thread** stops the questions for that
  thread on that site; navigating to another site asks again.
- **Clicks land where they should.** If a dialog, banner or overlay covers the element, the click
  is refused instead of hitting whatever is on top.
- **Handoffs.** `browser_handoff` shows a card on the page with what to do. Only a real click on
  **Continue** (on the card or in the popup) finishes it. While it waits, the agent can neither read
  the tab nor send it input, so it doesn't see what you type.
- **One thread at a time.** The first thread to use the tab holds it until it has been idle for 10
  minutes. The popup shows which thread holds it and lets you **Release** it.
- **Badge.** `ON` while a tab is lent, `RUN` while a command runs, `WAIT` when Amp needs you.
- **Stop lending** at any time, or close the tab. Chrome's "started debugging" bar's **Cancel**
  also stops it.

| Tool | What it does |
| --- | --- |
| `browser_status` | Connection, lent tab, who holds it, and what to do next |
| `browser_snapshot` | Accessibility outline with refs (`e12`) for click and type |
| `browser_screenshot` | JPEG of the viewport |
| `browser_scroll` | Scroll by a number of pixels |
| `browser_click`, `browser_type`, `browser_navigate` | Act on the page, after your approval |
| `browser_handoff` | Hand the tab to you and wait for **Continue** (up to 30 minutes) |
| `browser_bridge_publish` | On the Mac only: expose the bridge to your orbs |
| `browser_bridge_pair` | On the Mac only: write a new pairing code to `~/.amp-browser-bridge/pairing-code` |

## Security

The agent works in a browser you are signed in to, so treat what it reads as untrusted: a page or
an email can try to steer it.

- **Who can drive the tab.** HTTP calls need `BROWSER_BRIDGE_TOKEN` (stored in
  `~/.amp-browser-bridge/token`, mode 600). The extension proves itself with a key it received for a
  one-time pairing code; five wrong codes void the code. Through the portal, Amp also requires your
  sign-in.
- **What enforces what.** The extension enforces the hard limits: only the tab you lent, read-only
  until you allow actions, on its own site until you allow others, nothing during a handoff. The
  approval dialogs in Amp are a convenience on top: they guard the agent's tools, but code running
  in your orb can read `BROWSER_BRIDGE_TOKEN` and call the bridge directly. So keep tabs read-only
  unless you are watching, and use the
  [amp-mcp-gateway](https://github.com/lox/amp-mcp-gateway) integration if you need approvals that
  can't be skipped. Likewise, the one-thread lease keeps threads from interleaving; it is not a
  security boundary.
- **Refs.** They expire when the page changes, and an element is checked against the snapshot's
  role and name before each action. A click is refused when something else covers the element, and
  if the page moves focus while text is typed, the result is reported as unknown.
- **What it sees.** Snapshots leave out what's typed in fields. Screenshots show the page as it is.
- **The card.** A page can't press **Continue** for you, but it can hide the card; use the popup's
  **Continue** button then.
- **Limits.** The site limit covers navigation, not requests the page makes itself. If an answer
  is lost in the middle of an action (the extension disconnects, or the portal times out), the
  result is reported as unknown and never retried, so check the page.

## How it works

`plugin/index.ts` decides its role by platform: on macOS it runs the bridge (`plugin/host.ts`);
elsewhere it reads `BROWSER_BRIDGE_URL` and `BROWSER_BRIDGE_TOKEN`, signs in to the portal with
`amp portal login-url`, and forwards each tool call. Every Amp process on the Mac loads the plugin;
the first one to bind port 19989 runs the bridge and the others take over if it exits. Set
`AMP_BROWSER_BRIDGE_ROLE` to `host`, `client` or `off` to override, and `BROWSER_BRIDGE_PORT` to
change the port (the extension expects 19989).

The extension (`extension/`) attaches Chrome's debugger to the lent tab only. Its state lives in
session storage, so a service worker restart keeps the lend, the snapshot refs and a waiting
handoff. You can also run the bridge without Amp: `bun plugin/host.ts`.

## Develop

```sh
bun install
bun run check   # type check, syntax check the extension, run the bridge tests
```

After changing `extension/`, click **Reload** on its card in `chrome://extensions`.
