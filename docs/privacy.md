# Privacy policy: Amp Browser Bridge

_Draft, not yet published. Last updated 21 November 2026._

Amp Browser Bridge is a Chrome extension that lets [Amp](https://ampcode.com) threads you run use
one browser tab that you choose to lend. This policy covers the extension and the bridge it talks
to. It is open source: <https://github.com/lox/amp-browser-bridge>.

## What the extension reads

Nothing until you click **Lend this tab**. After that, only the lent tab, and only when an Amp
thread asks for it:

- **Page structure.** An accessibility outline of the page: roles, names and visible text. It
  leaves out what you typed into fields.
- **Screenshots.** A JPEG of the visible part of the page, as it appears on screen.
- **Tab details.** The lent tab's title and address.

If you allow actions for that tab, it also clicks, types, scrolls and navigates in it when a thread
asks and you approve. It never reads other tabs, your history, cookies or passwords, and it stops
when you stop lending, close the tab, or click **Cancel** on Chrome's debugging bar.

## Where that data goes

The extension sends it only to the bridge on your own computer, at `127.0.0.1:19989`. The bridge
passes it to the Amp thread that asked for it. If you published the bridge to your orbs, that
thread may run in Amp's cloud, and the data reaches it through an Amp portal that only you can
open.

From there, Amp handles it like anything else in your thread, including sending it to the model
provider that runs the thread. See [Amp's privacy policy](https://ampcode.com/privacy).

The developer of this extension runs no server and receives none of this data. The extension has
no analytics, advertising or tracking, and does not sell or share data with anyone.

## What the extension stores

On your computer, in Chrome's extension storage:

- A pairing key, so the bridge recognises this browser. Removing the extension deletes it.
- Which tab is lent and what it allows, plus any step waiting for you. This lives in session
  storage, which Chrome clears when it quits.

## Your choices

Lend a tab only to sites you are happy for your Amp threads to see. You can stop lending at any
time from the extension's popup, and remove the extension from `chrome://extensions`.

## Contact

Questions: open an issue at <https://github.com/lox/amp-browser-bridge/issues>.
