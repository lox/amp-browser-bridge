<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.png">
    <img src="docs/banner-light.png" alt="Amp Browser Bridge: lend one Chrome tab to your Amp threads. The lent tab, in Chrome's green Amp tab group, shows the extension's WAIT badge and a card asking you to sign in, then click Continue.">
  </picture>
</p>

Works with [Amp](https://ampcode.com) threads in orbs and on any runner (macOS or Linux), using your existing browser logins — no local daemon, runner portal, or macOS Amp app required.

Amp asks before clicking or typing, and hands the tab back to you for logins, 2FA, and payments.

Heavily inspired by [OpenCode Browse](https://opencode.ai/product/browse).

## Why it's safe

- Amp can only see the tab you lend (or background tabs it opens, if you turn that on). It can't read your other tabs, cookies, or history.
- Lent tabs start read-only and locked to their current site until you allow actions or other sites in the popup.
- During a handoff, Amp can't see or touch the tab until you click **Continue**.
- Traffic between Amp and Chrome is **end-to-end encrypted with forward secrecy**. The stateless reflector (`relay/`) sees only ciphertext and a pseudonymous routing hash — never URLs, snapshots, screenshots, passwords, or your Amp user ID.
- Click **Stop lending** or close the tab at any time to disconnect it.

Approval prompts happen in the plugin, so code running on an executor that holds `BROWSER_BRIDGE_KEY` can call Chrome directly within the extension's tab and permission boundaries. See [Security](#security) for details.

## Set up

You'll need Chrome 116+ on any desktop OS.

1. **Install the plugin.** In any Amp thread, ask:

   ```prompt
   Install the plugin/ directory from https://github.com/lox/amp-browser-bridge into my personal plugins as browser-bridge, then push it.
   ```

   New threads in orbs and on all of your runners pick it up from your personal plugins repo.

2. **Load the extension.** Chrome Web Store review is still pending, so load it unpacked for now. Download and unzip `amp-browser-bridge-<version>.zip` from the [latest release](https://github.com/lox/amp-browser-bridge/releases/latest). Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, select the unzipped folder, and pin the extension to Chrome's toolbar.

   Installing opens the setup checklist (or click **Setup and status** in the popup).

3. **Connect Amp.** On the setup page in Chrome, click **Copy setup key** (`abb1_…`). Then in any Amp thread — in an orb or on a runner — ask *"use my browser"* and paste the key into Amp's private secret prompt:
   - **Orbs** get it from your personal `BROWSER_BRIDGE_KEY` secret (set on a runner via the prompt checkbox, in Amp Settings, or by asking an orb thread to save `BROWSER_BRIDGE_KEY` with `manage_amp`).
   - **Runners** (including locked-down Linux runners without `--amp-env`, and multiple runners on the same Mac) store the key in `~/.amp-browser-bridge/key` (`0600`) on first prompt and work immediately without restarting the runner or exposing your other personal secrets.

## Usage

Open a page, click the extension icon, and click **Lend this tab**. The tab joins a green **Amp** tab group and starts read-only on that site.

Popup controls:

- **Allow clicks, typing and navigation** - lets Amp click, type, and navigate. Amp asks before each action, with an option to allow that site for the thread.
- **Allow other sites** - lets Amp navigate to other sites. If this is off and you navigate away yourself, Amp is blocked until you go back.
- **Release to other threads** - frees the tab from the current thread (one thread holds it at a time, with a 10-minute idle timeout) without ending the lend. **Stop lending** disconnects the tab.

If a modal or banner covers the element Amp tries to use, the action fails instead of clicking whatever is on top.

### Background tabs

Turn on **Let Amp open its own tabs** in the popup to let threads open background tabs without you lending one. Amp asks before opening a site, then puts the tab in a collapsed **Amp** group; the popup lists open tabs with **Show** and **Close**.

- Only the thread that opened a tab can use it. Actions work on any site (still with approval prompts), and idle tabs close after 10 minutes.
- Chrome freezes hidden background tabs, so each command wakes the tab first so the page still reacts.
- Dragging a tab out of the group, lending it, editing the group, or cancelling Chrome's debugger bar turns it into a normal tab.

**Known issue:** Chrome silently drops clicks and `submit` Enter keys on background tabs that have never been visible, even though the tool reports success. Click the tab (or **Show** in the popup) once to work around it.

### Bot checks

When navigating or taking a snapshot, the extension checks for bot challenges (Cloudflare, CAPTCHAs, PerimeterX, DataDome) and block pages. On navigation it waits up to 12 seconds for automatic checks to clear. If a challenge needs a human, it tells Amp to hand the tab over instead of trying to solve it; on a block page, it tells Amp to stop. Detection is adapted from [anomalyco/browse](https://github.com/anomalyco/browse).

## Troubleshooting

Check **Setup and status** in the popup first. Each failing check explains how to fix it.

- **`browser_status` says Chrome isn't connected:** open Chrome (the extension reconnects on its own within seconds) and check that **Connected to reflector** is green on **Setup and status**.
- **Chrome rejected the request / rotated key:** if you clicked **Rotate key** in Chrome (or reinstalled the extension), click **Copy setup key** and run `browser_bridge_connect` in Amp (plus `amp orb restart-processes` in already-running orbs after updating `BROWSER_BRIDGE_KEY`).
- **Two Chrome browsers sharing one key:** connecting a second browser closes the first with *"Connected in another browser"*. Click **Reconnect** in the browser you want active, or **Rotate key** to give it its own key.

## Tools

| Tool | Description |
| --- | --- |
| `browser_status` | Connection status, lent tab, active thread, background tabs, and handoff state |
| `browser_open_tab`, `browser_close_tab` | Open or close a background tab for the current thread |
| `browser_snapshot` | Accessibility tree with element refs (`e12`) |
| `browser_screenshot` | Viewport screenshot (JPEG) |
| `browser_wait_for` | Wait up to 20s for text, a URL, or an element by role and name |
| `browser_scroll` | Scroll the page |
| `browser_click`, `browser_type`, `browser_navigate` | Click, type, or navigate (URLs that trigger a download return `download`) |
| `browser_fill` | Fill a field, hiding password and one-time-code values in prompts and results |
| `browser_press` | Press a key (`Enter`, `Escape`, `Tab`, etc.) on an element or the focused target |
| `browser_select` | Select a `<select>` option by value or label |
| `browser_handoff` | Hand the tab back to you and wait up to 30m for **Continue** (re-attaches if an earlier call disconnected) |
| `browser_bridge_connect` | Enter or rotate `BROWSER_BRIDGE_KEY` in a private prompt (`~/.amp-browser-bridge/key` + optional personal secret) |

Page tools take an optional `tab` ID from `browser_open_tab`, defaulting to the lent tab. Tools that change the page ask for approval first.

`browser_status` is in every thread's tool list from the start, so telling a thread "I lent you a tab" or "use my browser" is enough; the other tools load through Amp's tool search when needed. Set `AMP_BROWSER_BRIDGE_ROLE=off` to disable the plugin on a machine.

Chrome blocks extensions on Chrome Web Store pages, so tools refuse them and navigating a lent tab there ends the lend.

## Security

Treat page content as untrusted: because Amp reads pages in your signed-in browser, prompt injection in a page or email can try to steer the agent.

- **Blind reflector & forward secrecy:** Chrome generates a 256-bit root secret `K` (`abb1_<secret>`) and derives three independent subkeys via `HKDF-SHA256`: `gate` (routing capability), `auth` (banner authentication), and `psk`. On every WebSocket connection Chrome generates a fresh non-extractable P-256 ECDH keypair in RAM and signs its public key (`banner`) with `auth`. Each client request generates its own single-use P-256 ECDH keypair, mixes `ECDH + psk` via HKDF to derive directional `AES-256-GCM` keys (`c2b` and `b2c`), and binds ciphertexts to the connection and request IDs in AAD, with a 5-minute clock window and single-use replay tracking.
- **What the reflector sees:** Only `SHA-256(gate)` in RAM, opaque ciphertexts, endpoint IP addresses, and packet sizes/timing. Compromising the reflector cannot read or forge browser commands or responses, and leaking `K` later cannot decrypt previously recorded sessions.
- **Extension enforcement:** The extension enforces tab scope, read-only mode, single-site lock, thread leases, and handoffs. Approval prompts live in `plugin/index.ts`, so processes on an orb or runner that can read `BROWSER_BRIDGE_KEY` or `~/.amp-browser-bridge/key` can bypass prompts: keep lent tabs read-only unless you trust the executor, and leave **Let Amp open its own tabs** off unless you want threads able to open and drive any site.
- **Field & action safety:** Snapshots omit form values, screenshots capture visible pixels, and `browser_fill` hides password/OTP values in prompts and output (though the agent chose the value). Element refs (`e12`) reset on navigation and check role and name; if focus moves while typing or a connection drops mid-action, the tool returns `unknown` without retrying. Pages can't click **Continue** on their own handoff card, though they can cover it (use **Continue** in the popup instead). Single-site lock only restricts navigation, not requests made by the page itself.

## Self-hosting the reflector (`relay/`)

By default the extension connects to `https://amp-browser-bridge.fly.dev`. You can deploy your own stateless reflector on [Fly.io](https://fly.io) in one minute (~$3/month for a single 512 MB machine):

```sh
fly launch --config relay/fly.toml --no-deploy
fly deploy relay --config relay/fly.toml --ha=false
```

Keep a single machine (`--ha=false` / `fly scale count 1`), as active WebSockets are held in memory on that instance. Then open **Setup and status** in Chrome, click **Change reflector**, enter your `https://<app>.fly.dev` URL, click **Save**, and click **Copy setup key** — the copied `abb1_<secret>@https://<app>.fly.dev` string carries your reflector URL automatically.

## Develop

```sh
bun install
bun run check   # typecheck, extension syntax check, unit tests
bun run e2e     # e2e suite in headed Chrome against a local reflector
```

`bun run e2e` runs `test/e2e/*.e2e.ts` against a fresh local reflector (`relay/server.ts` on `127.0.0.1:19989`) and headed Chrome for Testing (via Xvfb on headless Linux) using ports `8765`, `9333`, and `19989`. Branded Chrome ignores `--load-extension`; set `CHROME_BIN` to override agent-browser's Chrome for Testing binary. Pass a script name to run one test (e.g. `bun run e2e popup`), or set `E2E_SHOTS=<dir>` to save screenshots. Checks marked `KNOWN` track known bugs without failing the run. Buildkite runs both suites via [`.buildkite/pipeline.yml`](.buildkite/pipeline.yml).

`test/fixtures/challenges/` stores scrubbed probes from real bot challenges, block pages, and normal pages for `test/challenge.test.ts`. After editing `extension/`, click **Reload** in `chrome://extensions`.

## Release

```sh
bun run release            # dist/amp-browser-bridge-<version>.zip (with manifest key)
bun run release --no-key   # without manifest key, for Chrome Web Store uploads
```

Bump the version in `extension/manifest.json` before releasing. `bun run release` builds a reproducible zip of `extension/`.

Unpacked builds keep a fixed extension ID (`goknnphohomgekkahpdiphdfladfnmoc`, `UNPACKED_ID` in `plugin/extension-id.ts`) via the `key` in `extension/manifest.json`. Chrome Web Store uploads strip that key with `--no-key` and use `STORE_ID`.

See [`docs/chrome-web-store.md`](docs/chrome-web-store.md) for the Web Store listing and upload checklist, [`docs/privacy.md`](docs/privacy.md) for the privacy policy, and `scripts/store-images.ts` to render `docs/store/` assets.

## License

[MIT](LICENSE)
