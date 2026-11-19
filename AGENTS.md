# Amp Browser Bridge

An Amp plugin (`plugin/`) and a Chrome extension (`extension/`) that let Amp threads use one tab the
user lends. Run `bun install`, then `bun run check` before submitting changes.

- `plugin/host.ts` is the bridge. It listens only on 127.0.0.1; keep it that way.
- Never retry a browser action automatically. A lost answer is reported as unknown.
- No tokens, keys or pairing codes in logs, source, tool results or screenshots.
- Keep `README.md` current when setup, tools or security behaviour change.
