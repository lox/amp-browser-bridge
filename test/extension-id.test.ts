import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import manifest from "../extension/manifest.json";
import { STORE_ID, UNPACKED_ID } from "../plugin/extension-id";

test("UNPACKED_ID matches the manifest key", () => {
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
  const id = [...digest.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  expect(UNPACKED_ID).toBe(id);
});

test("STORE_ID is empty or a Chrome extension ID", () => {
  expect(STORE_ID).toMatch(/^([a-p]{32})?$/);
});
