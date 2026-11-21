// The extension's half of the handshake with the bridge (plugin/host.ts has the bridge's half; keep
// the formats in step). It sets globalThis.BridgePairing and exports nothing, so it loads either as
// a module (background.js imports it) or as a classic script; test/host.test.ts imports it too.
//
// A one-time pairing code is exchanged, over a fresh ECDH key agreement, for a random key of this
// browser's own, so neither the code nor the key ever crosses the connection. On every connection
// both sides prove they hold the key with an HMAC over fresh nonces from each side, and the
// extension obeys nothing until the bridge has proved it.
(() => {
  const CONTEXT = "amp-browser-bridge-pairing-v2";
  const encoder = new TextEncoder();

  const base64url = (bytes) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromBase64url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

  async function hmac(key, message) {
    const imported = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", imported, typeof message === "string" ? encoder.encode(message) : message));
  }

  /** The link the proofs are bound to, so a program on another port can't pass them through. */
  const endpoint = (port) => `127.0.0.1:${port}/ext`;

  /** Compares two strings without returning early on the first difference. */
  function same(expected, actual) {
    if (typeof actual !== "string" || actual.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
    return difference === 0;
  }

  const nonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

  /** What `role` ("bridge" or "extension") sends to prove it holds `key` on this connection. */
  async function keyProof(key, role, port, extensionNonce, bridgeNonce) {
    return base64url(await hmac(key, `${CONTEXT}|key|${role}|${endpoint(port)}|${extensionNonce}|${bridgeNonce}`));
  }

  /** Codes are shown as XXXXX-XXXXX; case, spaces and dashes don't matter. */
  const normalizeCode = (code) => String(code).toUpperCase().replace(/[\s-]/g, "");

  /**
   * Starts a code exchange: the public key to send in hello, and how to derive the session key from
   * the bridge's challenge. The code is stretched with PBKDF2 so a program posing as the bridge,
   * which sees one proof, can't try every code before it expires.
   */
  async function codeExchange(code) {
    const pair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"]);
    const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const password = await crypto.subtle.importKey("raw", encoder.encode(normalizeCode(code)), "PBKDF2", false, ["deriveBits"]);
    const material = new Uint8Array(await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(`${CONTEXT}|code`), iterations: 100_000}, password, 256));
    return {
      publicKey,
      /** The session key, or null when the bridge's key isn't a P-256 public key. */
      async session(port, extensionNonce, bridgeNonce, bridgeKey) {
        let secret;
        try {
          const peer = await crypto.subtle.importKey("raw", fromBase64url(bridgeKey), {name: "ECDH", namedCurve: "P-256"}, false, []);
          secret = new Uint8Array(await crypto.subtle.deriveBits({name: "ECDH", public: peer}, pair.privateKey, 256));
        } catch {
          return null;
        }
        const text = encoder.encode(`${CONTEXT}|session|${endpoint(port)}|${extensionNonce}|${bridgeNonce}|${publicKey}|${bridgeKey}|`);
        const message = new Uint8Array(text.length + secret.length);
        message.set(text);
        message.set(secret, text.length);
        return hmac(material, message);
      },
    };
  }

  /** What `role` sends to prove it derived the same session key, and so knows the code. */
  const codeProof = async (session, role) => base64url(await hmac(session, `${CONTEXT}|code|${role}`));

  /** The browser key the bridge masked under the session key, or null. */
  async function unwrapKey(session, wrapped) {
    if (typeof wrapped !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(wrapped)) return null;
    const mask = await hmac(session, `${CONTEXT}|wrap`);
    return base64url(fromBase64url(wrapped).map((byte, i) => byte ^ mask[i]));
  }

  globalThis.BridgePairing = {nonce, same, keyProof, codeExchange, codeProof, unwrapKey};
})();
