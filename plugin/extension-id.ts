// The extension's IDs. The bridge remembers which of these last reached it, and pairing opens the
// setup page under that ID (see setupPageID in host.ts).

/** The unpacked build's fixed ID, derived from the `key` in extension/manifest.json. test/extension-id.test.ts fails if the two drift apart. */
export const UNPACKED_ID = "goknnphohomgekkahpdiphdfladfnmoc";

/** The Chrome Web Store listing's ID, assigned on the first upload. */
export const STORE_ID = "hgigeejknnccieodeahgkjbnjibenpib";

/** Every build the plugin opens setup pages in, most preferred first. */
export const EXTENSION_IDS = [STORE_ID, UNPACKED_ID].filter(Boolean);
