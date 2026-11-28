# Chrome Web Store listing

Everything the listing needs is in this file or in [`store/`](store/). The upload itself waits on
lox: work down [the checklist](#upload-checklist), pasting the text from the later sections.

Sentences marked † describe the background tabs a thread opens itself. Keep them only if the
version you upload includes that feature; otherwise leave them out.

## Upload checklist

1. **Publish the privacy policy.** On GitHub, open the repository's **Settings → Pages**. Under
   **Build and deployment**, set **Source** to **Deploy from a branch**, pick branch **main** and
   folder **/docs**, and click **Save**. After a minute or two,
   <https://lox.github.io/amp-browser-bridge/privacy.html> shows [`privacy.md`](privacy.md). If you
   would rather not turn on Pages, use
   <https://github.com/lox/amp-browser-bridge/blob/main/docs/privacy.md> instead; the store accepts
   any public URL.
2. **Sign in** to the [developer dashboard](https://chrome.google.com/webstore/devconsole) with the
   Google account that should own the listing. A new account pays a one-time US$5 fee, verifies its
   contact email on the **Account** page, and answers the trader question there (a free,
   open-source tool from an individual is normally *non-trader*). Publishing stays blocked until the
   email is verified.
3. **Build the package** from an up-to-date `main`. Every upload needs a version the store hasn't
   seen, and the zip should match a tagged release, so if no release has been cut since this
   change, bump `version` in `extension/manifest.json` and release first. Then:

   ```sh
   bun install && bun run check && bun run release --no-key
   ```

   Upload `dist/amp-browser-bridge-<version>-no-key.zip`. Store uploads always drop the manifest
   `key`: the store keeps its own key, and an upload whose `key` doesn't match it is refused.
4. **Add new item** in the dashboard and upload the zip. The store assigns the item its ID now, a
   32-letter string shown under the item's name and in the dashboard's address bar. Send it to Amp
   and ask for a pull request that sets `STORE_ID` in `plugin/extension-id.ts`; merge it and update
   the plugin before step 9. Until the bridge knows that ID it refuses the store build, so the
   store's reviewer couldn't pair it.
5. **Store listing** tab: paste [the listing text](#store-listing), set the category and language,
   and upload the images from [`docs/store/`](store/): `icon-128.png` as the store icon, the four
   `screenshot-*.png` in their numbered order, and `promo-small-440x280.png` as the small promo
   tile. Leave the marquee tile and video empty. Fill in the homepage and support URLs.
6. **Privacy** tab: paste the [single purpose, permission justifications and data
   answers](#privacy-tab), and the privacy policy URL from step 1.
7. **Distribution** tab: free, **Unlisted** (only people with the link from the README can install
   it; switch to Public once it has had real use), all regions.
8. **Test instructions** tab: paste [the reviewer instructions](#test-instructions).
9. **Submit for review.** In the submit dialog, untick **Publish automatically after review**, so
   the item waits for you to press **Publish**. Expect a longer review than usual: `debugger` with
   all-sites host access gets a manual look, and the reviewer may write with questions. The
   justifications below are the answers.

### After approval

10. **Publish**, then ask Amp to point the README's install step at the listing, as described in
    [Moving to the store's ID](#moving-to-the-stores-id). Merge it once the listing is live.
11. Tell people on the unpacked build how to move, using the steps in the same section.

## Automating releases

`scripts/store.ts` uploads, submits and checks a version through the
[Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api), so a thread can do
steps 3, 4 and 9 for a new version and say where review stands. The API can't create the item or
edit the listing; those stay in the dashboard.

**Set up once:**

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project,
   enable the **Chrome Web Store API**, and create a service account with no roles. Create a JSON
   key for it.
2. In the [developer dashboard](https://chrome.google.com/webstore/devconsole), open **Account**
   and add the service account's email. A publisher can have only one.
3. Store the JSON key as the personal Amp secret `CWS_SERVICE_ACCOUNT`, and the publisher ID (the
   long ID after `/devconsole/` in the dashboard's address bar) as the environment variable
   `CWS_PUBLISHER_ID`. Running orbs need `amp orb restart-processes` to see them.

**Release a version** after it is tagged, from an up-to-date `main`:

```sh
bun run release --no-key
bun run store upload     # dist/amp-browser-bridge-<version>-no-key.zip becomes the draft
bun run store publish    # submit for review, staged: it waits for you once approved
bun run store status     # review state and version of the published and submitted revisions
bun run store publish    # once status says STAGED: publish it
```

`bun run store publish --auto` publishes as soon as the review passes instead.



The store assigns its own ID. The private key behind today's unpacked ID,
`goknnphohomgekkahpdiphdfladfnmoc`, was not kept, so the listing can't reuse it. Two things depend
on the ID:

- **Pairing.** `browser_bridge_pair` opens `chrome-extension://<id>/setup.html#code=…`. An ID that
  isn't installed only shows Chrome's "blocked" page.
- **The README's install step**, which loads the folder unpacked and names its ID.

**Proposal: keep both IDs working, with no forced move.** The unpacked build keeps its own key and
ID; the store build has the store's. Store uploads never carry a `key`, so nobody needs to fetch the
store's public key. The plugin knows both IDs and opens the setup page in whichever build last
talked to the bridge:

- The extension's `/status` probe, which runs whenever an unpaired or disconnected extension has
  its popup or setup page open (including the setup page Chrome opens on install), now sends
  `x-extension-id: <its ID>`. A paired extension's `/ext` connection carries its ID in `Origin`.
- The bridge writes the last known ID it saw to `~/.amp-browser-bridge/extension-id`, and
  `setupPageID()` in `plugin/host.ts` reads it. IDs outside `EXTENSION_IDS` are ignored, so a
  local program forging the header can't send pairing codes to another extension.
- With nothing recorded, the plugin opens the store build, once `STORE_ID` is set.

That is all in this change except `STORE_ID`, which is empty until the store assigns it. So people
on the unpacked build keep working through and after the switch, with or without updating.

**The switch-over PR** (after approval) sets `STORE_ID` in `plugin/extension-id.ts` (a test checks
its shape) and replaces README step 2 with:

```markdown
2. **Install the extension** from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/<STORE_ID>) and pin it from Chrome's
   puzzle-piece menu.
```

and moves the unpacked instructions (download, **Developer mode**, **Load unpacked**, its ID) to
**Develop**, with a note that a store install and an unpacked one in the same Chrome each need
pairing, and the last one paired is the one the bridge uses.

**Moving an existing unpacked install to the store build:**

1. Update the plugin first (it must know `STORE_ID`), so pairing opens the store build's page.
2. Install from the store. Chrome opens its setup page, which tells the bridge the store build is
   there.
3. Ask Amp to *"pair the browser extension"*. The store build pairs and takes over the bridge from
   the unpacked one, whose key stops working.
4. Remove the unpacked build in `chrome://extensions`.

Skipping step 1 still works: copy the code from `~/.amp-browser-bridge/pairing-code` into the store
build's setup page (popup → **Setup and status**).

## Store listing

- **Name** and **summary** come from the package: *Amp Browser Bridge* and *Lend a Chrome tab to your Amp threads, or let them open their own. They read pages and, with your approval, click and type.*
  (123 of 132 characters; edit `description` in `extension/manifest.json` to change it, and
  `bun run release` refuses a longer one.)
- **Category:** Developer Tools
- **Language:** English
- **Homepage URL:** https://github.com/lox/amp-browser-bridge
- **Support URL:** https://github.com/lox/amp-browser-bridge/issues
- **Description:**

```text copy Copy Description
Amp Browser Bridge lets your Amp threads use a tab of your real Chrome, with your logins, even when the thread runs in the cloud.

You choose the tab. A thread can read it and take screenshots. It can click, type and navigate only after you turn that on for the tab, and Amp asks before each action. When a step needs you, such as a login, 2FA or a payment, the thread hands the tab back, sees nothing while you type, and waits until you click Continue.

† A thread can also open pages itself. They open in background tabs, in a green "Amp" tab group, so they never take over the tab you're using.

The extension only talks to a bridge on your own computer (127.0.0.1). It never reads your other tabs, history, cookies or passwords, and you can stop lending at any time.

Needs the Amp app for macOS and the Amp Browser Bridge plugin. Setup takes a few minutes:
https://github.com/lox/amp-browser-bridge#set-up

Open source: https://github.com/lox/amp-browser-bridge
```

### Images

All rendered by `CHROME=<Chromium binary> bun scripts/store-images.ts` from the real extension and
bridge in headless Chrome, on fictional pages at `app.example.com`; no real accounts, threads or
portals appear. Rerun it after UI changes.

| File | Size | Use |
| --- | --- | --- |
| [`store/icon-128.png`](store/icon-128.png) | 128×128 | Store icon (96×96 artwork, transparent padding) |
| [`store/screenshot-1-lend.png`](store/screenshot-1-lend.png) | 1280×800 | Popup over a lent tab, actions allowed, held by a thread |
| [`store/screenshot-2-handoff.png`](store/screenshot-2-handoff.png) | 1280×800 | Handoff card on a login page, popup waiting |
| [`store/screenshot-3-setup.png`](store/screenshot-3-setup.png) | 1280×800 | Setup checklist, all four steps done |
| [`store/screenshot-4-troubleshoot.png`](store/screenshot-4-troubleshoot.png) | 1280×800 | Setup checklist with the bridge missing and how to fix it |
| [`store/promo-small-440x280.png`](store/promo-small-440x280.png) | 440×280 | Small promo tile |

## Privacy tab

**Single purpose:**

```text copy Copy Single Purpose
Let the user's own Amp threads read and, with the user's permission, operate the browser tab the user lends them, through a bridge running on the user's computer.
```

† With background tabs, append: *…the browser tab the user lends them, and tabs the threads open
themselves in an "Amp" tab group, through…*

**Permission justifications:**

- **debugger**

  ```text copy Copy debugger
  The extension attaches Chrome's debugger only to tabs Amp works in: the tab the user lends from the popup, and tabs an Amp thread opens itself in the background (†). It detaches when the user stops lending, closes the tab, or clicks Cancel on Chrome's debugging bar. It uses the DevTools protocol to read the page's accessibility tree (Accessibility.getFullAXTree), take screenshots (Page.captureScreenshot), and check what is under a point before a click (DOM.getNodeForLocation, DOM.getBoxModel). Only after the user allows actions does it dispatch clicks and keystrokes (Input.dispatchMouseEvent, Input.dispatchKeyEvent, Input.insertText) and navigate (Page.navigate), and the Amp app asks the user before each one. Trusted input events and the full accessibility tree are not available through other extension APIs.
  ```

- **tabs**

  ```text copy Copy tabs
  Reads the title and URL of the tabs Amp works in, to keep each on the site the user allowed and to tell the thread which page it is on, and notices when they navigate or close. Opens tabs in the background when an Amp thread asks for a page (†). Opens the extension's setup page, and finds it among open tabs to focus it instead of opening a second copy.
  ```

- **tabGroups**

  ```text copy Copy tabGroups
  Puts the lent tab, and tabs an Amp thread opens (†), in a green "Amp" tab group, so the user can see from anywhere in the window which tabs Amp is using. When lending stops it puts the tab back in its earlier group.
  ```

- **scripting**

  ```text copy Copy scripting
  Shows and removes the handoff card ("Amp needs you: … Continue") on the tab Amp is working in, in an isolated world and a closed shadow root, and accepts only a trusted click, so the page can neither read the card nor press Continue itself. After a navigation or snapshot it also reads the page's title, the start of its text and the addresses of its frames and scripts, in an isolated world, to tell the thread when the page is a bot check or block page it should hand to the user instead of retrying.
  ```

- **storage**

  ```text copy Copy storage
  Keeps the pairing key that identifies this browser to the user's own bridge in local storage, and the tabs Amp works in, their permissions and any waiting handoff in session storage, so a service worker restart doesn't drop them. Nothing is synced or sent elsewhere.
  ```

- **alarms** (†)

  ```text copy Copy alarms
  Runs a check once a minute that closes tabs an Amp thread opened itself once no command has used them for 10 minutes, so they don't pile up in the user's window. It never closes a tab the user lent, one with a command running, or one waiting for the user. An alarm is needed because Chrome stops the extension's service worker when idle, which would cancel an ordinary timer.
  ```

- **Host permissions** (`http://*/*`, `https://*/*`)

  ```text copy Copy Host Permissions
  The user can lend a tab on any site, and scripting needs host access to show the handoff card on that site. Access to http://127.0.0.1 lets the extension check whether the bridge on the user's own computer is running. The extension acts only on tabs the user lent or an Amp thread opened (†), never on other tabs.
  ```

**Remote code:** No. All code ships in the package; the extension exchanges data only with the
bridge on the user's computer.

**Data usage:** tick **Website content** (page text, accessibility tree and screenshots of the tabs
Amp works in), **Web history** (the titles and addresses of those tabs, which the thread sees) and
**Authentication information** (with `browser_fill`, a password or one-time code the user gave the
thread passes through the extension into the page; it isn't kept, and the tool's result hides it).
Leave the rest unticked: the extension keeps no history and never reads saved passwords or
cookies. Certify all three statements: not sold, not used for unrelated purposes, not
used for creditworthiness or lending.

**Why not `activeTab`:** it would narrow host access, but the handoff card has to appear later,
without a fresh click from the user, and background tabs have no click at all. If a reviewer asks,
that is the reason.

## Test instructions

Reviewers have no Amp account, so they can run the bridge on its own:

```text copy Copy Test Instructions
The extension talks only to a bridge on 127.0.0.1:19989. To try it without Amp:

1. Install Bun (https://bun.sh), then: git clone https://github.com/lox/amp-browser-bridge && cd amp-browser-bridge && bun plugin/host.ts
2. Install the extension. Its setup page opens and shows the bridge as found. Enter the code from ~/.amp-browser-bridge/pairing-code and click Pair.
3. Open any web page, click the extension's toolbar icon, and click "Lend this tab".
4. Read the page as an Amp thread would (any thread ID of this shape works):
   bun scripts/call.ts snapshot
   Requests to the bridge are signed with the token in ~/.amp-browser-bridge/token; scripts/call.ts does that. Other tools: bun scripts/call.ts screenshot, and, after ticking "Allow clicks, typing and navigation" in the popup, bun scripts/call.ts click '{"ref":"e1"}' with a ref from the snapshot.
5. Hand the tab to the user: bun scripts/call.ts handoff '{"message":"Sign in, then click Continue"}'. A card appears on the page; Continue ends it.
```
