# Amp Browser Bridge

An Amp plugin (`plugin/`), a Chrome extension (`extension/`), and a stateless blind ciphertext
reflector (`relay/`) that let Amp threads across orbs and runners use one tab the user lends. Run
`bun install`, then `bun run check` before submitting changes.

- `relay/server.ts` is the blind reflector. Locally it listens only on `127.0.0.1:19989`; keep it
  stateless and blind to plaintext and user identity.
- Never retry a browser action automatically. A lost answer is reported as unknown.
- No tokens, setup keys or secrets in logs, source, tool results or screenshots.
- Keep `README.md` current when setup, tools or security behaviour change.

## Testing end to end

Test every change to `extension/`, `plugin/` or `relay/` with `bun run e2e` before you hand it
back. In an orb or CI it starts Xvfb, a headed Chrome for Testing with the real extension, and a
fresh local reflector for each `test/e2e/*.e2e.ts`.

- `bun run e2e popup` runs one script; `E2E_SHOTS=.amp/in/artifacts/e2e bun run e2e` saves
  whole-screen screenshots (tab strip, popup, setup page). Look at them for UI changes.
- Drive the extension as a person does, with the helpers in `test/e2e/lib.ts`: `openPopup()` for
  the toolbar popup, `reloadExtension()` for Reload in `chrome://extensions`, `showTab()`,
  `trustedClick()`, `message()` for popup actions with no button to click. `background.js` is a
  module, so its functions can't be called from a test.
- Add a check to the script that covers the behaviour, or a new script, rather than a one-off.
  Mark a check for a known bug with `known()`, never by loosening it.
- Never set the user's real `BROWSER_BRIDGE_*` personal secrets or deploy `relay/` to production
  from a test or without explicit approval.
