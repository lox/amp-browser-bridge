# Amp Browser Bridge

An Amp plugin (`plugin/`) and a Chrome extension (`extension/`) that let Amp threads use one tab the
user lends. Run `bun install`, then `bun run check` before submitting changes.

- `plugin/host.ts` is the bridge. It listens only on 127.0.0.1; keep it that way.
- Never retry a browser action automatically. A lost answer is reported as unknown.
- No tokens, keys or pairing codes in logs, source, tool results or screenshots.
- Keep `README.md` current when setup, tools or security behaviour change.

## Testing end to end

Test every change to `extension/` or `plugin/` with `bun run e2e` before you hand it back; it is the
same loop lox runs by hand on his Mac. In an orb it needs nothing else: it starts Xvfb, a headed
Chrome for Testing with the real extension, and a fresh bridge for each `test/e2e/*.e2e.ts`.
`portal.e2e.ts` goes through this thread's portal with the real client plugin, as orbs do.

- `bun run e2e popup` runs one script; `E2E_SHOTS=.amp/in/artifacts/e2e bun run e2e` saves
  whole-screen screenshots (tab strip, popup, setup page). Look at them for UI changes.
- Drive the extension as a person does, with the helpers in `test/e2e/lib.ts`: `openPopup()` for
  the toolbar popup, `reloadExtension()` for Reload in `chrome://extensions`, `showTab()`,
  `trustedClick()`, `message()` for popup actions with no button to click. `background.js` is a
  module, so its functions can't be called from a test.
- Add a check to the script that covers the behaviour, or a new script, rather than a one-off.
  Mark a check for a known bug with `known()`, never by loosening it.
- Never run `browser_bridge_publish` or set the `BROWSER_BRIDGE_*` secrets from a test or orb: they
  point at the user's own Mac.
