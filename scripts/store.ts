// Chrome Web Store releases from the command line, through the Chrome Web Store API v2 and a
// service account (docs/chrome-web-store.md#automating-releases sets one up).
//
//   bun run store status            # review state and versions of the published and submitted revisions
//   bun run store upload [zip]      # upload dist/amp-browser-bridge-<version>-no-key.zip as the draft
//   bun run store publish           # submit the draft for review; staged, so it waits for you after approval
//   bun run store publish           # again, once approved: publish the staged revision
//   bun run store publish --auto    # submit, and publish as soon as it is approved
//
// Needs CWS_SERVICE_ACCOUNT (the service account's JSON key) and CWS_PUBLISHER_ID. The item is
// STORE_ID from plugin/extension-id.ts.
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STORE_ID } from "../plugin/extension-id";

const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const root = join(import.meta.dir, "..");

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** An access token for the service account, from a JWT it signs (RFC 7523). */
async function accessToken(keyJSON: string, now = Date.now()) {
  let key: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    key = JSON.parse(keyJSON);
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT must be the service account's JSON key.");
  }
  if (!key.client_email || !key.private_key) throw new Error("CWS_SERVICE_ACCOUNT has no client_email or private_key; use the service account's JSON key.");
  const aud = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 }))}`;
  const jwt = `${unsigned}.${b64url(createSign("RSA-SHA256").update(unsigned).sign(key.private_key))}`;
  const res = await fetch(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google refused the service account's token request (HTTP ${res.status}): ${body.error_description ?? body.error ?? "no reason given"}`);
  return body.access_token as string;
}

/** Calls one method on the item, such as ":fetchStatus", and returns its JSON or throws Google's error. */
async function api(token: string, publisher: string, method: string, init: RequestInit = {}, upload = false) {
  const res = await fetch(`${API}${upload ? "/upload" : ""}/v2/publishers/${publisher}/items/${STORE_ID}${method}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = body.error?.details ? `\n${JSON.stringify(body.error.details, null, 2)}` : "";
    const hint = res.status === 403 || res.status === 404 ? " Check CWS_PUBLISHER_ID, and that the service account is added under Account in the developer dashboard." : "";
    throw new Error(`${method} failed (HTTP ${res.status}): ${String(body.error?.message ?? "no reason given").replace(/\.$/, "")}.${hint}${details}`);
  }
  return body;
}

/** The parts of fetchStatus a person reads: each revision's state and versions. */
function summarize(status: any) {
  const revision = (r: any) => r && { state: r.state, versions: (r.distributionChannels ?? []).map((c: any) => `${c.crxVersion}${c.deployPercentage != null && c.deployPercentage !== 100 ? ` (${c.deployPercentage}%)` : ""}`) };
  return {
    item: status.itemId ?? STORE_ID,
    published: revision(status.publishedItemRevisionStatus) ?? null,
    submitted: revision(status.submittedItemRevisionStatus) ?? null,
    ...(status.lastAsyncUploadState ? { last_upload: status.lastAsyncUploadState } : {}),
    ...(status.takenDown ? { taken_down: true } : {}),
    ...(status.warned ? { warned: true } : {}),
  };
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (!["status", "upload", "publish"].includes(command ?? "")) throw new Error("Usage: bun run store status | upload [zip] | publish [--auto]");
  const keyJSON = process.env.CWS_SERVICE_ACCOUNT?.trim();
  const publisher = process.env.CWS_PUBLISHER_ID?.trim();
  if (!keyJSON || !publisher) throw new Error("Set CWS_SERVICE_ACCOUNT (the service account's JSON key) and CWS_PUBLISHER_ID; see docs/chrome-web-store.md#automating-releases.");
  if (!STORE_ID) throw new Error("STORE_ID in plugin/extension-id.ts is empty.");
  const token = await accessToken(keyJSON);
  const status = () => api(token, publisher, ":fetchStatus");

  if (command === "status") return console.log(JSON.stringify(summarize(await status()), null, 2));

  if (command === "upload") {
    const version = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8")).version;
    const zip = rest[0] ?? join(root, "dist", `amp-browser-bridge-${version}-no-key.zip`);
    if (!existsSync(zip)) throw new Error(`${zip} doesn't exist. Build it with \`bun run release --no-key\`.`);
    let state = (await api(token, publisher, ":upload", { method: "POST", body: readFileSync(zip) }, true)).uploadState;
    for (let i = 0; state === "IN_PROGRESS" && i < 60; i++) {
      await Bun.sleep(3000);
      state = (await status()).lastAsyncUploadState ?? state;
    }
    if (state !== "SUCCEEDED") throw new Error(`The upload of ${zip} ended ${state}. Check the Package tab in the developer dashboard.`);
    return console.log(`Uploaded ${zip} as the draft. Submit it with \`bun run store publish\`.`);
  }

  // Staged by default, as the release checklist does it: an approved revision waits for you. Per
  // Google's docs, publish on a staged revision releases it without another review.
  const auto = rest.includes("--auto");
  const result = await api(token, publisher, ":publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publishType: auto ? "DEFAULT_PUBLISH" : "STAGED_PUBLISH", blockOnWarnings: true }),
  });
  console.log(JSON.stringify({ state: result.state, ...(result.warningInfo ? { warnings: result.warningInfo } : {}) }, null, 2));
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
