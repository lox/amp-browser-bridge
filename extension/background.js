// Lends one tab to Amp through the bridge on this computer (plugin/host.ts), which listens only on
// loopback. Everything that must survive a service worker restart lives in chrome.storage.session:
// the lent tab and its permissions, the latest snapshot's refs, a waiting handoff and the lease.
const BRIDGE = "ws://127.0.0.1:19989/ext";
const SNAPSHOT_LIMIT = 120_000;
const MUTATING = new Set(["click", "type", "navigate"]);
const EDITABLE = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

let socket = null;
let ready = false;
let heartbeat = null;
let reconnectTimer = null;
let lastError = "";
let running = 0;
// A pairing code is kept until the bridge accepts or rejects it, so a bridge that is still starting
// doesn't lose it. pairError says why the last code failed.
let pendingCode = "";
let pairError = "";
// What the bridge last said about being published to orbs: undefined until it says (older bridges
// never do), null for not published, or {url, thread, at}.
let published;

const session = {
  get: async (key) => (await chrome.storage.session.get(key))[key] ?? null,
  set: (key, value) => chrome.storage.session.set({[key]: value}),
  remove: (key) => chrome.storage.session.remove(key),
};

/** {tabId, origin, allowActions, anyOrigin} */
const getLend = () => session.get("lend");

async function tabInfo() {
  const lend = await getLend();
  if (!lend) return null;
  const tab = await chrome.tabs.get(lend.tabId).catch(() => null);
  return tab ? {title: tab.title || "", url: tab.url || "", origin: lend.origin, allow_actions: lend.allowActions, any_origin: lend.anyOrigin} : null;
}

async function badge() {
  const [lend, handoff] = await Promise.all([getLend(), session.get("handoff")]);
  if (!lend) return;
  // Per tab: the badge shows only while you look at the lent tab, so ON never marks the wrong one.
  const tabId = lend.tabId;
  await chrome.action.setBadgeText({tabId, text: handoff ? "WAIT" : running ? "RUN" : "ON"});
  // The icon's orange asks for you, the setup page's blue is busy, the icon's navy is lent and idle.
  await chrome.action.setBadgeBackgroundColor({tabId, color: handoff ? "#ea580c" : running ? "#1d4ed8" : "#111827"});
  await chrome.action.setBadgeTextColor({tabId, color: "#ffffff"});
}

function send(message) {
  // Before the bridge accepts hello, any other message would get this browser rejected.
  if (!ready || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function connect(code) {
  clearTimeout(reconnectTimer);
  const {key} = await chrome.storage.local.get("key");
  if (code) {
    pendingCode = code;
    pairError = "";
  }
  code = pendingCode || undefined;
  if (!key && !code) return;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  ready = false;
  published = undefined;
  const ws = new WebSocket(BRIDGE);
  socket = ws;
  ws.onopen = async () => ws.send(JSON.stringify({type: "hello", key, code, tab: await tabInfo(), handoff: (await session.get("handoff"))?.id}));
  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "paired") await chrome.storage.local.set({key: message.key});
    if (message.type === "published") published = message.published ?? null;
    if (message.type === "ready") {
      ready = true;
      lastError = "";
      pendingCode = "";
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send({type: "ping"}), 20_000);
      // A Continue click made while the bridge was unreachable is delivered now.
      if ((await session.get("handoff"))?.continued) await continueHandoff();
    }
    if (message.type === "lease") await session.set("lease", message.lease);
    if (message.type === "command") run(message);
    if (message.type === "handoff") await startHandoff(message.id, message.message);
    if (message.type === "cancel_handoff") await clearHandoff(message.id);
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    ready = false;
    clearInterval(heartbeat);
    if (event.code === 1008) {
      pairError = code
        ? "The bridge rejected this pairing code. Codes work once, for 10 minutes, and five wrong tries void them."
        : "The bridge no longer knows this browser. Pair it again.";
      pendingCode = "";
      lastError = "The bridge rejected this browser. Pair it again.";
      chrome.storage.local.remove("key");
      return;
    }
    if (event.code === 4001) {
      lastError = "Another browser connected to the bridge. Click Reconnect to take over.";
      return;
    }
    lastError = "The bridge isn't reachable on 127.0.0.1:19989; retrying.";
    reconnectTimer = setTimeout(() => connect(), 3000);
  };
}

async function run(message) {
  running++;
  await badge();
  // Set once input may have reached the page: a failure after that leaves the outcome unknown.
  const effects = {sent: false};
  try {
    const lend = await getLend();
    if (!lend) throw new Error("No tab is lent. Ask the user to open the page and click Lend this tab in the extension.");
    const result = await execute(lend, message.tool, message.args || {}, effects);
    send({type: "result", id: message.id, result});
  } catch (error) {
    send({type: "result", id: message.id, error: String(error?.message || error).slice(0, 1000), unknown: effects.sent});
  } finally {
    running--;
    await badge();
  }
}

async function execute(lend, tool, args, effects) {
  const target = {tabId: lend.tabId};
  if (MUTATING.has(tool) && !lend.allowActions) {
    throw new Error("This tab is lent read-only. Ask the user to turn on Allow clicks, typing and navigation in the extension popup.");
  }
  // During a handoff the tab belongs to the user: no reading (they may be typing a 2FA code) and
  // no input, which could also land on the card's Continue button as a trusted click.
  if (await session.get("handoff")) throw new Error("The user has the tab for a handoff. Wait for browser_handoff to return, or call it again if it failed; browser_status shows whether the user continued.");
  const tab = await chrome.tabs.get(lend.tabId);
  if (!lend.anyOrigin && originOf(tab.url) !== lend.origin) {
    throw new Error(`The tab has left ${lend.origin}, the site it was lent on. Ask the user to go back or to allow other sites.`);
  }
  switch (tool) {
    case "snapshot": return snapshot(target, tab);
    case "describe": return describe(target, tab, args.ref);
    case "screenshot": return screenshot(target);
    case "scroll": return scroll(target, Number(args.delta_y), effects);
    case "click": return click(target, args.ref, effects);
    case "type": return type(target, args.ref, String(args.text ?? ""), args.submit === true, effects);
    case "navigate": return navigate(target, lend, args.url, effects);
    default: throw new Error(`Unknown tool: ${tool}`);
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

const cdp = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);

/** The current document's ID, refusing if the tab has left the lent site. */
async function documentID(target) {
  const {frameTree} = await cdp(target, "Page.getFrameTree");
  const lend = await getLend();
  if (lend && !lend.anyOrigin && originOf(frameTree.frame.url) !== lend.origin) {
    throw new Error(`The tab has left ${lend.origin}, the site it was lent on. Ask the user to go back or to allow other sites.`);
  }
  return frameTree.frame.loaderId;
}

const SKIP = new Set(["none", "generic", "InlineTextBox", "LineBreak"]);
const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "tab", "option", "slider", "spinbutton", "listbox", "menuitemcheckbox", "menuitemradio", "treeitem"]);

async function snapshot(target, tab) {
  const doc = await documentID(target);
  const {nodes} = await cdp(target, "Accessibility.getFullAXTree");
  const byID = new Map(nodes.map((n) => [n.nodeId, n]));
  const refs = {};
  let count = 0;
  const lines = [];
  let size = 0;
  let truncated = false;
  const walk = (node, depth) => {
    if (truncated) return;
    const role = node.role?.value || "";
    const name = (node.name?.value || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const shown = !node.ignored && !SKIP.has(role) && !(role === "StaticText" && !name);
    if (shown) {
      let line = "  ".repeat(depth);
      if (node.backendDOMNodeId && (INTERACTIVE.has(role) || node.focusable)) {
        const ref = `e${++count}`;
        refs[ref] = {backendNodeId: node.backendDOMNodeId, role, name: node.name?.value || ""};
        line += `[${ref}] `;
      }
      line += role === "StaticText" ? JSON.stringify(name) : `${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
      // Snapshots leave out what's typed in fields; the agent sees the field, not its contents.
      for (const p of node.properties || []) {
        if (["checked", "disabled", "expanded", "selected"].includes(p.name) && p.value?.value) line += ` (${p.name})`;
      }
      size += line.length + 1;
      if (size > SNAPSHOT_LIMIT) {
        truncated = true;
        return;
      }
      lines.push(line);
    }
    // Don't descend into fields: their text children are what the user typed.
    if (EDITABLE.has(role) || node.properties?.some((p) => p.name === "editable" && p.value?.value)) return;
    for (const id of node.childIds || []) {
      const child = byID.get(id);
      if (child) walk(child, shown ? depth + 1 : depth);
    }
  };
  const root = nodes.find((n) => !n.parentId);
  if (root) walk(root, 0);
  // The origin was checked before the read; a navigation during it would mix in another page.
  if (await documentID(target) !== doc) throw new Error("The page navigated while it was read. Take a new snapshot.");
  await session.set("refs", {doc, refs});
  return {title: tab.title, url: tab.url, truncated, outline: lines.join("\n")};
}

// Refs come from the latest snapshot. Refuse to act once the page has navigated or the element no
// longer matches, so an action approved for one element never lands on another.
async function resolveRef(target, ref) {
  const saved = await session.get("refs");
  const entry = saved?.refs[ref];
  if (!entry) throw new Error(`Unknown ref ${ref}. Take a new snapshot.`);
  if (await documentID(target) !== saved.doc) throw new Error("The page changed since the snapshot. Take a new snapshot.");
  const {nodes} = await cdp(target, "Accessibility.getPartialAXTree", {backendNodeId: entry.backendNodeId, fetchRelatives: false});
  const node = nodes?.find((n) => n.backendDOMNodeId === entry.backendNodeId);
  if (!node || node.role?.value !== entry.role || (node.name?.value || "") !== entry.name) {
    throw new Error(`${ref} changed since the snapshot. Take a new snapshot.`);
  }
  return entry;
}

/** Runs `fn` on a node in an isolated world, where the page's own overrides (of focus, contains, ...) don't apply. */
async function isolated(target, backendNodeId, fn, otherBackendNodeId) {
  const {frameTree} = await cdp(target, "Page.getFrameTree");
  const {executionContextId} = await cdp(target, "Page.createIsolatedWorld", {frameId: frameTree.frame.id, worldName: "amp-browser-bridge"});
  const {object} = await cdp(target, "DOM.resolveNode", {backendNodeId, executionContextId});
  const args = [];
  if (otherBackendNodeId) args.push({objectId: (await cdp(target, "DOM.resolveNode", {backendNodeId: otherBackendNodeId, executionContextId})).object.objectId});
  const {result} = await cdp(target, "Runtime.callFunctionOn", {objectId: object.objectId, functionDeclaration: fn.toString(), arguments: args, returnByValue: true});
  return result.value;
}

async function describe(target, tab, ref) {
  const entry = await resolveRef(target, ref);
  return {ref, role: entry.role, name: entry.name, url: tab.url};
}

async function click(target, ref, effects) {
  const {backendNodeId} = await resolveRef(target, ref);
  await cdp(target, "DOM.scrollIntoViewIfNeeded", {backendNodeId});
  const {model} = await cdp(target, "DOM.getBoxModel", {backendNodeId});
  const q = model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  // A click lands on whatever is on top at that point. Refuse unless that is the element itself
  // (or something inside it), so an overlay never receives a click approved for something else.
  const hit = await cdp(target, "DOM.getNodeForLocation", {x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false});
  const inside = await isolated(target, backendNodeId, function (h) {
    for (let n = h; n; n = n.parentNode || n.host) if (n === this) return true;
    // Custom checkboxes and switches hide the input under its label; the browser forwards that click.
    return h.closest?.("label")?.control === this;
  }, hit.backendNodeId);
  if (!inside) throw new Error(`Something else covers ${ref} (a dialog or banner?). Take a new snapshot.`);
  effects.sent = true;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp(target, "Input.dispatchMouseEvent", {type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1});
  }
  return {clicked: ref};
}

async function type(target, ref, text, submit, effects) {
  const {backendNodeId} = await resolveRef(target, ref);
  await cdp(target, "DOM.scrollIntoViewIfNeeded", {backendNodeId});
  // Focus and select in an isolated world, without bringing the tab to the front, and check that
  // the field really has focus: the page can't redirect it there, but its own handlers could.
  const focused = await isolated(target, backendNodeId, function () {
    this.focus();
    if (typeof this.select === "function") this.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(this);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active === this;
  });
  if (!focused) throw new Error(`${ref} did not take focus. Take a new snapshot.`);
  effects.sent = true;
  await cdp(target, "Input.insertText", {text});
  // The page could still move focus between the check and the insert; then the outcome is unknown.
  const stillFocused = await isolated(target, backendNodeId, function () {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active === this;
  });
  if (!stillFocused) throw new Error(`Focus moved away from ${ref} while typing; check where the text went.`);
  if (submit) {
    await cdp(target, "Input.dispatchKeyEvent", {type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r"});
    await cdp(target, "Input.dispatchKeyEvent", {type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13});
  }
  return {typed: ref, submitted: submit};
}

async function navigate(target, lend, raw, effects) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs.");
  if (!lend.anyOrigin && url.origin !== lend.origin) throw new Error(`This tab is limited to ${lend.origin}. Ask the user to allow other sites in the extension popup.`);
  effects.sent = true;
  const result = await cdp(target, "Page.navigate", {url: url.toString()});
  if (result.errorText) throw new Error(result.errorText);
  return {url: url.toString()};
}

async function scroll(target, dy, effects) {
  if (!Number.isFinite(dy) || Math.abs(dy) > 10_000) throw new Error("delta_y must be between -10000 and 10000.");
  effects.sent = true;
  await cdp(target, "Runtime.evaluate", {expression: `window.scrollBy(0, ${dy})`});
  return {scrolled: dy};
}

async function screenshot(target) {
  const doc = await documentID(target);
  const {data} = await cdp(target, "Page.captureScreenshot", {format: "jpeg", quality: 70});
  if (await documentID(target) !== doc) throw new Error("The page navigated during the screenshot. Try again.");
  return {mime_type: "image/jpeg", data};
}

// ---- Handoff ----
// The card lives in the extension's isolated world inside a closed shadow root, and only a trusted
// click counts, so the page can neither read the card nor fake the user's answer.

function showCard(message) {
  document.getElementById("__amp_handoff")?.remove();
  const host = document.createElement("div");
  host.id = "__amp_handoff";
  // A closed shadow root still reaches the accessibility tree; keep the card out of snapshots.
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
  const root = host.attachShadow({mode: "closed"});
  root.innerHTML = `<div style="font:14px system-ui;background:#111827;color:#f9fafb;padding:14px 16px;border-radius:10px;box-shadow:0 8px 24px #0006;max-width:320px">
    <div style="font-weight:600;margin-bottom:6px">Amp needs you</div><div class="m" style="margin-bottom:10px"></div>
    <button style="font:inherit;background:#22c55e;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">Continue</button></div>`;
  root.querySelector(".m").textContent = message;
  root.querySelector("button").addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    chrome.runtime.sendMessage({action: "continue"});
    host.remove();
  });
  document.documentElement.append(host);
}

async function injectCard() {
  const [lend, handoff] = await Promise.all([getLend(), session.get("handoff")]);
  if (!lend || !handoff || handoff.continued) return;
  await chrome.scripting.executeScript({target: {tabId: lend.tabId}, world: "ISOLATED", func: showCard, args: [handoff.message]}).catch(() => {});
}

async function removeCard() {
  const lend = await getLend();
  if (!lend) return;
  await chrome.scripting.executeScript({target: {tabId: lend.tabId}, world: "ISOLATED", func: () => document.getElementById("__amp_handoff")?.remove()}).catch(() => {});
}

async function startHandoff(id, message) {
  if (!await getLend()) {
    send({type: "result", id, error: "No tab is lent, so there is nowhere to show the handoff."});
    return;
  }
  await session.set("handoff", {id, message});
  await injectCard();
  await badge();
}

async function clearHandoff(id) {
  const handoff = await session.get("handoff");
  if (!handoff || (id && handoff.id !== id)) return;
  await session.remove("handoff");
  await removeCard();
  await badge();
}

async function continueHandoff() {
  const handoff = await session.get("handoff");
  if (!handoff) return;
  await removeCard();
  // Keep the answer until the bridge has it; it's sent again once the connection is back.
  if (!send({type: "result", id: handoff.id, result: {continued: true, tab: await tabInfo()}})) {
    await session.set("handoff", {...handoff, continued: true});
    return;
  }
  await clearHandoff(handoff.id);
}

// ---- Lending ----

async function lend(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || "")) throw new Error("Chrome only lets extensions control normal web pages, not browser pages or the Web Store.");
  const previous = await getLend();
  if (previous && previous.tabId !== tabId) await stop();
  try {
    await chrome.debugger.attach({tabId}, "1.3");
  } catch (error) {
    if (!String(error.message).includes("Another debugger is already attached")) throw error;
  }
  await cdp({tabId}, "Page.enable");
  await cdp({tabId}, "Accessibility.enable");
  // Lent read-only and limited to the current site until the user widens it.
  // Chrome deletes a group when its last tab leaves, so remember enough to recreate it.
  const previousGroup = tab.groupId >= 0 ? await chrome.tabGroups.get(tab.groupId).catch(() => null) : null;
  await session.set("lend", {
    tabId, origin: originOf(tab.url), allowActions: false, anyOrigin: false,
    previousGroup: previousGroup && {id: previousGroup.id, title: previousGroup.title, color: previousGroup.color, windowId: previousGroup.windowId},
  });
  await groupTab(tabId);
  await session.remove("refs");
  send({type: "tab", tab: await tabInfo()});
  await badge();
}

async function setPermissions(changes) {
  const current = await getLend();
  if (!current) return;
  await session.set("lend", {...current, ...changes});
  send({type: "tab", tab: await tabInfo()});
}

// The lent tab sits in a green "Amp" tab group, so it's easy to spot from any tab in the window.
const GROUP_TITLE = "Amp";

async function groupTab(tabId) {
  try {
    const groupId = await chrome.tabs.group({tabIds: [tabId]});
    await chrome.tabGroups.update(groupId, {title: GROUP_TITLE, color: "green", collapsed: false});
    await session.set("lend", {...(await getLend()), groupId});
  } catch {
    // Grouping is a hint, never a reason to refuse a lend (some Chromium browsers lack tab groups).
  }
}

/** Puts the tab back where lending found it, unless the user moved it to another group since. */
async function ungroupTab(lend) {
  if (lend.groupId == null) return;
  const tab = await chrome.tabs.get(lend.tabId).catch(() => null);
  if (!tab || tab.groupId !== lend.groupId) return;
  const before = lend.previousGroup;
  try {
    if (!before) return await chrome.tabs.ungroup(lend.tabId);
    const existing = await chrome.tabGroups.get(before.id).catch(() => null);
    if (existing && existing.windowId === tab.windowId) return void await chrome.tabs.group({tabIds: [lend.tabId], groupId: existing.id});
    const groupId = await chrome.tabs.group({tabIds: [lend.tabId]});
    await chrome.tabGroups.update(groupId, {title: before.title, color: before.color});
  } catch {
    // Best effort: the tab may have closed or moved meanwhile.
  }
}

async function stop() {
  const current = await getLend();
  const handoff = await session.get("handoff");
  if (handoff) send({type: "result", id: handoff.id, error: "The user stopped lending the tab."});
  await removeCard();
  await chrome.storage.session.remove(["lend", "refs", "handoff"]);
  if (current) {
    await chrome.action.setBadgeText({tabId: current.tabId, text: ""}).catch(() => {});
    await ungroupTab(current);
    await chrome.debugger.detach({tabId: current.tabId}).catch(() => {});
  }
  send({type: "tab", tab: null});
  await badge();
}

chrome.debugger.onDetach.addListener(async ({tabId}) => {
  if (tabId === (await getLend())?.tabId) await stop();
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getLend())?.tabId) await stop();
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (tabId !== (await getLend())?.tabId) return;
  if (change.status === "complete") await injectCard();
  if (change.url || change.title) send({type: "tab", tab: await tabInfo()});
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.action === "continue") {
      // From the card on the lent tab, or the popup's Continue button.
      if (!sender.tab || sender.tab.id === (await getLend())?.tabId) await continueHandoff();
      return;
    }
    // Everything else comes only from the extension's own pages (the popup and setup.html), never
    // from the card's isolated world on the lent tab.
    if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
    if (message.action === "pair") return connect(String(message.code || "").trim());
    if (message.action === "reconnect") return connect();
    if (message.action === "lend") return lend(message.tabId);
    if (message.action === "stop") return stop();
    if (message.action === "permissions") return setPermissions({allowActions: !!message.allowActions, anyOrigin: !!message.anyOrigin});
    if (message.action === "release") {
      send({type: "release"});
      await session.remove("lease");
    }
  })().then(
    async () => reply({ok: true, ...(await state())}),
    async (error) => reply({ok: false, error: String(error.message || error), ...(await state())}),
  );
  return true;
});

async function state() {
  const {key} = await chrome.storage.local.get("key");
  const [lendState, handoff, lease] = await Promise.all([getLend(), session.get("handoff"), session.get("lease")]);
  return {
    paired: !!key, connected: ready, bridge: ready ? "connected" : await probe(), bridgeError: lastError,
    pairing: !!pendingCode, pairError, published,
    lend: lendState, tab: await tabInfo(), waiting: handoff?.message ?? null, lease,
  };
}

/** Whether something answers on the bridge's port when the extension isn't connected to it. */
async function probe() {
  try {
    const res = await fetch(BRIDGE.replace("ws:", "http:").replace("/ext", "/status"), {signal: AbortSignal.timeout(1500)});
    // The bridge answers 401 "unauthorized" without its token.
    return res.status === 401 && (await res.text()) === "unauthorized" ? "found" : "other";
  } catch {
    return "missing";
  }
}

chrome.runtime.onInstalled.addListener(({reason}) => {
  if (reason === "install") chrome.tabs.create({url: chrome.runtime.getURL("setup.html")});
});

/**
 * A reload or update of the extension ends the lend without running stop(), which would leave the
 * tab in the Amp group. With nothing lent, ungroup every tab still in a green "Amp" group.
 */
async function clearStaleGroups() {
  if (await getLend()) return;
  const groups = await chrome.tabGroups.query({title: GROUP_TITLE, color: "green"}).catch(() => []);
  for (const group of groups) {
    const tabs = await chrome.tabs.query({groupId: group.id});
    if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id)).catch(() => {});
  }
}

connect();
clearStaleGroups();
// Earlier versions set the badge for every tab; clear that before showing the per-tab one.
chrome.action.setBadgeText({text: ""}).then(badge);
