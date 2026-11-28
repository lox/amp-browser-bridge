# Privacy policy: Amp Browser Bridge

_Last updated 28 November 2026._

Amp Browser Bridge is a Chrome extension that lets [Amp](https://ampcode.com) threads you run use
a browser tab that you choose to lend, and tabs they open for you. This policy covers the extension
and its stateless ciphertext reflector. It is open source: <https://github.com/lox/amp-browser-bridge>.

## What the extension reads

Nothing until an Amp thread holding your browser's setup key asks, and then only in tabs Amp works
in: the tab you lent with **Lend this tab**, and tabs a thread opens itself, which open in the
background in a green **Amp** tab group. From each:

- **Page structure.** An accessibility outline of the page: roles, names and visible text. It
  leaves out what you typed into fields.
- **Screenshots.** A JPEG of the visible part of the page, as it appears on screen.
- **Tab details.** The tab's title and address.

If you allow actions, it also clicks, types, scrolls and navigates in those tabs when a thread asks
and you approve. That can include entering a password or one-time code you gave the thread: the
value passes through the extension into the page, isn't stored, and is hidden in the approval
prompt and in what the thread gets back. It never reads your other tabs, your history, cookies or
saved passwords. It stops when you stop lending, close the tab, or click **Cancel** on Chrome's
debugging bar.

## Where that data goes

Commands from your Amp thread and responses from the extension are encrypted end to end (`AES-256-GCM`
with ephemeral `P-256` ECDH keys derived alongside your local setup key) before leaving either side.
They pass through a stateless WebSocket reflector (`https://amp-browser-bridge.fly.dev` by default,
or a reflector URL you configure yourself in **Setup and status**).

Because encryption keys never leave your browser and your Amp environment, the reflector cannot
decrypt requests, page outlines, screenshots, or addresses, and stores nothing on disk. Like any
network relay, the reflector sees the IP addresses and connection timing of your browser and your
Amp thread while they communicate.

Once decrypted by the Amp plugin in your thread, Amp handles the tool result like anything else in
your thread, including sending it to the model provider that runs the thread. See
[Amp's privacy policy](https://ampcode.com/privacy).

The extension has no analytics, advertising or tracking, and does not sell or share data with anyone.

## What the extension stores

On your computer, in Chrome's extension storage:

- A 256-bit setup secret (plus an optional custom reflector URL) in local storage. Rotating the key
  replaces it, and removing the extension deletes it.
- Which tabs Amp works in and what they allow, plus any step waiting for you. This lives in session
  storage, which Chrome clears when it quits.

## Your choices

Lend a tab only to sites you are happy for your Amp threads to see. You can stop lending or rotate
your setup key at any time from the extension, self-host the reflector from `relay/`, and remove
the extension from `chrome://extensions`.

## Contact

Questions: open an issue at <https://github.com/lox/amp-browser-bridge/issues>.
