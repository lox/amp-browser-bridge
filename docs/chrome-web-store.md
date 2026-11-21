# Chrome Web Store listing (draft)

_Nothing has been submitted. This is what a listing needs, ready to paste once lox decides to
publish._

## Package

- Build with `bun run release --no-key` and upload `dist/amp-browser-bridge-<version>-no-key.zip`.
  A new store item rejects a manifest that carries `key`.
- **The store assigns its own ID.** The private key behind today's
  `goknnphohomgekkahpdiphdfladfnmoc` was not kept, so the listing will get a different ID. After
  the first (draft) upload, open the item's **Package** tab, choose **View public key**, and in one
  commit put that key in `extension/manifest.json` and the new ID in `plugin/extension-id.ts`. The
  test in `test/extension-id.test.ts` checks the two match. Unpacked loads then share the store ID,
  and later uploads can keep the key (`bun run release`).
- Bump `version` in `extension/manifest.json` for every upload; the store refuses a repeat.

## Store listing tab

- **Name:** Amp Browser Bridge
- **Summary (132 characters max):** Lend one Chrome tab to your Amp threads. They read it, take
  screenshots and, with your approval, click and type.
- **Category:** Developer Tools
- **Language:** English
- **Description:**

  > Amp Browser Bridge lets your Amp threads use one tab of your real Chrome, with your logins,
  > even when the thread runs in the cloud.
  >
  > You choose the tab. A thread can read it and take screenshots. It can click, type and navigate
  > only after you turn that on for the tab, and Amp asks before each action. When a step needs
  > you, such as a login, 2FA or a payment, the thread hands the tab back and waits until you click
  > Continue.
  >
  > The extension only talks to a bridge on your own computer (127.0.0.1). It never touches other
  > tabs, and you can stop lending at any time.
  >
  > Needs the Amp app for macOS and the Amp Browser Bridge plugin. Setup:
  > https://github.com/lox/amp-browser-bridge#set-up

- **Icon:** `docs/store/icon-128.png` (128×128, artwork 96×96 with transparent padding, as the store
  asks).
- **Screenshots (1280×800 or 640×400, 1 to 5):** capture these on a Mac with a working setup, at
  1280×800:
  1. The setup page with all four steps green (`docs/setup-done.png` on the `readme` branch is this
     shot at another size).
  2. The popup open over a lent page, showing **Allow clicks, typing and navigation** and the
     thread that holds the tab.
  3. The Amp app asking to approve a click, next to the page it names.
  4. The handoff card on a login page, with **Continue**.
  5. The toolbar badges `ON`, `RUN` and `WAIT`.
- **Small promo tile (440×280):** optional; the icon on `#111827` with the name works.
- **Homepage / support URL:** https://github.com/lox/amp-browser-bridge

## Privacy tab

- **Single purpose:** Let the user's own Amp threads read and, with permission, operate one browser
  tab the user explicitly lends, through a bridge running on the user's computer.
- **Privacy policy URL:** publish [`docs/privacy.md`](privacy.md) somewhere stable (for example
  GitHub Pages or the repository's blob URL) and link it.
- **Remote code:** No. All code ships in the package; the extension only exchanges data with the
  local bridge.

### Permission justifications

- **debugger:** The extension attaches Chrome's debugger only to the tab the user lends, and
  detaches when they stop lending, close the tab or click Cancel on Chrome's debugging bar. It
  uses the DevTools protocol to read the page's accessibility tree
  (`Accessibility.getFullAXTree`), take screenshots (`Page.captureScreenshot`), check what is under
  a point before a click (`DOM.getNodeForLocation`, `DOM.getBoxModel`), and, only after the user
  allows actions for that tab, dispatch clicks and keystrokes (`Input.dispatchMouseEvent`,
  `Input.dispatchKeyEvent`, `Input.insertText`) and navigate (`Page.navigate`). Trusted input
  events and the full accessibility tree are not available through other extension APIs.
- **scripting:** Shows and removes the handoff card ("Amp needs you: … Continue") on the lent tab,
  in an isolated world, so the page cannot press Continue itself.
- **tabs:** Reads the lent tab's title and URL to keep it on the site the user lent it on, notices
  when the tab closes or navigates, and opens the extension's setup page.
- **storage:** Keeps the pairing key in local storage and the current lend and handoff in session
  storage, so a service worker restart doesn't drop them.
- **Host permissions (`http://*/*`, `https://*/*`):** The user can lend a tab on any site, and
  `scripting` needs host access to show the handoff card there. The extension acts only on the tab
  the user lent.

Reviewers look hard at `debugger` combined with all-sites host access. Expect a longer review and
possibly questions; the answers above, the open source, and the fact that nothing happens until a
tab is lent are the case for it. Replacing the host permissions with `activeTab` would narrow
them, but the handoff card has to appear later, without a fresh click, so it would need checking
first.

### Data usage disclosures

Tick **Website content** (page text, accessibility tree, screenshots, and the URL of the lent tab).
Leave the rest unticked: the extension doesn't keep a history of the pages it has seen.

Certify all three: not sold to third parties, not used for unrelated purposes, not used for
creditworthiness or lending.

## Distribution tab

- **Visibility:** Unlisted at first, so only people with the link from the README can install it;
  switch to Public once it has had real use.
- **Regions:** All.
