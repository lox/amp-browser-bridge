import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import manifest from "../extension/manifest.json";
import { EXTENSION_ID } from "../plugin/extension-id";

test("EXTENSION_ID matches the manifest key", () => {
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
  const id = [...digest.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  expect(EXTENSION_ID).toBe(id);
});
