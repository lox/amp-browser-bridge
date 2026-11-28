// End-to-end encryption and forward-secret session keys for the browser extension (plugin/crypto.ts
// has the Amp plugin's half; keep the constants and formats in step). Sets globalThis.BridgeCrypto
// and exports nothing, so background.js imports it as a module and test/crypto.test.ts loads it too.
//
// From one 256-bit secret K (`abb1_<secret>`), HKDF derives three independent keys:
// - `gate`: sent to the reflector so it routes requests to this browser's WebSocket without ever
//   learning K or linking traffic to an Amp user.
// - `auth`: authenticates each WebSocket connection's fresh ephemeral P-256 public key (`banner`),
//   so the reflector cannot substitute its own ECDH key.
// - `psk`: mixed with each request's ephemeral P-256 ECDH shared secret to derive single-use
//   AES-256-GCM keys (`c2b` and `b2c`). Ephemeral private keys live only in memory and are never
//   stored, giving forward secrecy if K is ever exposed later.
(() => {
  const DEFAULT_RELAY = "https://amp-browser-bridge.fly.dev";
  const ROOT_SALT = "amp-browser-bridge-v3|root";
  const BANNER_CONTEXT = "amp-browser-bridge-v3|banner";
  const REQ_CONTEXT = "amp-browser-bridge-v3|req";
  const KEYS_INFO = "amp-browser-bridge-v3|keys";
  const REQUEST_WINDOW_MS = 5 * 60_000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const base64url = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromBase64url = (text) => {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };

  function concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }

  /** Constant-time string comparison. */
  function same(expected, actual) {
    if (typeof actual !== "string" || expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
    return diff === 0;
  }

  function normalizeRelay(raw) {
    let u;
    try {
      u = new URL(String(raw || "").trim());
    } catch {
      throw new Error("Reflector URL must be an http:// or https:// URL.");
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) {
      throw new Error("Reflector URL must be a plain http(s) origin without credentials, query or hash.");
    }
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
    return u.origin + path;
  }

  const wsURL = (relay) => normalizeRelay(relay).replace(/^http/, "ws") + "/ext";

  const generateSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

  function formatKey(secret, relay) {
    const norm = relay ? normalizeRelay(relay) : DEFAULT_RELAY;
    return norm === DEFAULT_RELAY ? `abb1_${secret}` : `abb1_${secret}@${norm}`;
  }

  function parseKey(raw, relayOverride) {
    const m = /^abb1_([A-Za-z0-9_-]{43})(?:@(\S+))?$/.exec(String(raw || "").trim());
    if (!m) throw new Error("Expected a setup key starting with abb1_ from the Chrome extension's Setup and status page.");
    const relay = normalizeRelay(relayOverride || m[2] || DEFAULT_RELAY);
    return {secret: m[1], relay};
  }

  async function hkdf(ikmBytes, saltText, infoText, byteLength) {
    const baseKey = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      {name: "HKDF", hash: "SHA-256", salt: encoder.encode(saltText), info: encoder.encode(infoText)},
      baseKey,
      byteLength * 8,
    );
    return new Uint8Array(bits);
  }

  async function hmacBase64url(rawKey, text) {
    const key = await crypto.subtle.importKey("raw", rawKey, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
    return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
  }

  async function deriveRoot(secret) {
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Invalid bridge secret.");
    const raw = fromBase64url(secret);
    const [gateBytes, auth, psk] = await Promise.all([
      hkdf(raw, ROOT_SALT, "gate", 32),
      hkdf(raw, ROOT_SALT, "auth", 32),
      hkdf(raw, ROOT_SALT, "psk", 32),
    ]);
    return {gate: base64url(gateBytes), auth, psk};
  }

  const bannerMac = (auth, connId, bPk) => hmacBase64url(auth, `${BANNER_CONTEXT}|${connId}|${bPk}`);

  async function derivePairKeys(dh, psk, connId, reqId, cPk, bPk) {
    const salt = `${REQ_CONTEXT}|${connId}|${reqId}|${cPk}|${bPk}`;
    const okm = await hkdf(concat(dh, psk), salt, KEYS_INFO, 88);
    const [reqKey, resKey] = await Promise.all([
      crypto.subtle.importKey("raw", okm.slice(0, 32), "AES-GCM", false, ["decrypt"]),
      crypto.subtle.importKey("raw", okm.slice(44, 76), "AES-GCM", false, ["encrypt"]),
    ]);
    return {reqKey, reqIv: okm.slice(32, 44), resKey, resIv: okm.slice(76, 88)};
  }

  /**
   * Creates one WebSocket connection's ephemeral P-256 session. Its private key is non-extractable
   * and lives only in memory for the life of this socket.
   */
  async function createSession(root) {
    const pair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"]);
    const bPk = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const connId = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const sig = await bannerMac(root.auth, connId, bPk);
    const seen = new Map();

    async function openRequest(envelope, now = Date.now()) {
      if (!envelope || typeof envelope !== "object") return null;
      const {req_id: reqId, c_pk: cPk, ct} = envelope;
      if (typeof reqId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(reqId)) return null;
      if (typeof cPk !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(cPk)) return null;
      if (typeof ct !== "string" || ct.length < 22) return null;

      let dh;
      try {
        const peer = await crypto.subtle.importKey("raw", fromBase64url(cPk), {name: "ECDH", namedCurve: "P-256"}, false, []);
        dh = new Uint8Array(await crypto.subtle.deriveBits({name: "ECDH", public: peer}, pair.privateKey, 256));
      } catch {
        return null;
      }

      const keys = await derivePairKeys(dh, root.psk, connId, reqId, cPk, bPk);
      let plain;
      try {
        const reqAad = encoder.encode(`c2b|${connId}|${reqId}`);
        const bytes = await crypto.subtle.decrypt({name: "AES-GCM", iv: keys.reqIv, additionalData: reqAad}, keys.reqKey, fromBase64url(ct));
        plain = JSON.parse(decoder.decode(bytes));
      } catch {
        return null;
      }

      if (!plain || typeof plain.at !== "number" || Math.abs(now - plain.at) > REQUEST_WINDOW_MS) return null;
      for (const [id, when] of seen) if (Math.abs(now - when) > REQUEST_WINDOW_MS) seen.delete(id);
      if (seen.has(reqId)) return null;
      seen.set(reqId, plain.at);

      return {
        request: {
          at: plain.at,
          thread: typeof plain.thread === "string" ? plain.thread : "",
          method: typeof plain.method === "string" ? plain.method : "GET",
          path: typeof plain.path === "string" ? plain.path : "/",
          body: typeof plain.body === "string" ? plain.body : "",
        },
        async sealResponse(status, body) {
          const resAad = encoder.encode(`b2c|${connId}|${reqId}`);
          const payload = encoder.encode(JSON.stringify({status, body}));
          const enc = await crypto.subtle.encrypt({name: "AES-GCM", iv: keys.resIv, additionalData: resAad}, keys.resKey, payload);
          return base64url(new Uint8Array(enc));
        },
      };
    }

    return {
      gate: root.gate,
      banner: {conn_id: connId, b_pk: bPk, sig},
      openRequest,
    };
  }

  globalThis.BridgeCrypto = {
    DEFAULT_RELAY,
    normalizeRelay,
    wsURL,
    generateSecret,
    formatKey,
    parseKey,
    deriveRoot,
    createSession,
  };
})();
