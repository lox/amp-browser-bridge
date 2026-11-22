// Lends one tab to Amp through the bridge on this computer (plugin/host.ts), which listens only on
// loopback, and, if the user allows it, lets Amp threads open background tabs of their own.
// Everything that must survive a service worker restart lives in chrome.storage.session: the lent
// tab and its permissions, each tab's latest snapshot refs, a waiting handoff and the lease. Amp's
// own tabs are recorded in chrome.storage.local, so they stay Amp's across a reload of the extension.
import {PROBE_SELECTORS, classifyChallenge, probePage} from "./challenge.js";

const BRIDGE = "ws://127.0.0.1:19989/ext";
const SNAPSHOT_LIMIT = 120_000;
const MUTATING = new Set(["click", "type", "fill", "press", "select", "navigate"]);
// A <select> is a combobox too, but it holds options, not typed text; text comboboxes are editable.
const EDITABLE = new Set(["textbox", "searchbox", "spinbutton"]);
const WAIT_LIMIT_MS = 20_000;
/** Amp's own tabs close after this long without a command. */
const AGENT_TAB_IDLE_MS = 10 * 60_000;
// A navigation waits this long for the page to load, then this long for a bot check that clears by
// itself, which keeps the whole command well inside the bridge's and the portal's timeouts.
const LOAD_WAIT_MS = 10_000;
const CHALLENGE_WAIT_MS = 12_000;

let socket = null;
let ready = false;
let heartbeat = null;
let reconnectTimer = null;
let lastError = "";
/** Commands running per tab, for the RUN badge and so an idle sweep never closes a busy tab. */
const running = new Map();
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

/** Amp's own tabs: {[tabId]: {thread, lastUsed, groupId}}. Only the thread that opened a tab may use it. */
const getAgentTabs = async () => (await chrome.storage.local.get("agentTabs")).agentTabs ?? {};
let agentTabsLock = Promise.resolve();
/** Read-modify-write of the record, one at a time, so concurrent commands don't lose each other's changes. */
function updateAgentTabs(change) {
  const next = agentTabsLock.then(async () => {
    const tabs = await getAgentTabs();
    const result = change(tabs);
    await chrome.storage.local.set({agentTabs: tabs});
    return result;
  });
  agentTabsLock = next.catch(() => {});
  return next;
}
const agentTabsAllowed = async () => !!(await chrome.storage.local.get("allowAgentTabs")).allowAgentTabs;

async function tabInfo() {
  const lend = await getLend();
  if (!lend) return null;
  const tab = await chrome.tabs.get(lend.tabId).catch(() => null);
  return tab ? {title: tab.title || "", url: tab.url || "", origin: lend.origin, allow_actions: lend.allowActions, any_origin: lend.anyOrigin} : null;
}

/**
 * The tab behind a record, if it is still Amp's: open and in the green Amp group it was put in.
 * A record can outlive its tab (tab IDs start over when Chrome restarts), and a tab you drag out of
 * the group is yours again, so anything else is forgotten, never used or closed.
 */
async function ownedTab(tabId, record) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const group = tab && record.groupId >= 0 && tab.groupId === record.groupId ? await chrome.tabGroups.get(tab.groupId).catch(() => null) : null;
  if (group?.title === GROUP_TITLE && group.color === "green") return tab;
  const stale = await updateAgentTabs((tabs) => tabs[tabId]?.groupId === record.groupId);
  if (stale) await forgetAgentTab(Number(tabId));
  return null;
}

async function agentTabsInfo() {
  const tabs = [];
  for (const [id, record] of Object.entries(await getAgentTabs())) {
    const tab = await ownedTab(id, record);
    if (tab) tabs.push({tab: tab.id, thread: record.thread, title: tab.title || "", url: tab.url || ""});
  }
  return {enabled: await agentTabsAllowed(), tabs};
}

async function sendAgentTabs() {
  send({type: "agent_tabs", ...(await agentTabsInfo())});
}

async function badge() {
  const [lend, handoff, agentTabs] = await Promise.all([getLend(), session.get("handoff"), getAgentTabs()]);
  // Per tab: the badge shows only while you look at a tab Amp uses, so ON never marks the wrong one.
  const ids = Object.keys(agentTabs).map(Number);
  if (lend) ids.push(lend.tabId);
  // A handoff in one of Amp's background tabs: you aren't looking at it, so every tab shows WAIT.
  const away = !!handoff && handoff.tabId !== lend?.tabId;
  for (const tabId of ids) {
    const waiting = handoff?.tabId === tabId || away;
    const busy = running.get(tabId) > 0;
    await chrome.action.setBadgeText({tabId, text: waiting ? "WAIT" : busy ? "RUN" : "ON"}).catch(() => {});
    // The icon's orange asks for you, the setup page's blue is busy, the icon's navy is in use and idle.
    await chrome.action.setBadgeBackgroundColor({tabId, color: waiting ? "#ea580c" : busy ? "#1d4ed8" : "#111827"}).catch(() => {});
    await chrome.action.setBadgeTextColor({tabId, color: "#ffffff"}).catch(() => {});
  }
  await chrome.action.setBadgeText({text: away ? "WAIT" : ""});
  if (away) await chrome.action.setBadgeBackgroundColor({color: "#ea580c"});
}

function send(message) {
  // Before the bridge accepts hello, any other message would get this browser rejected.
  if (!ready || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

// Defines globalThis.BridgePairing. Imports are hoisted, so this placement only keeps it next to
// its one user; pairing.js has no exports, so it also loads as a classic script (the tests do).
import "./pairing.js";

async function connect(code) {
  clearTimeout(reconnectTimer);
  // {version: 2, secret}: the browser key from the handshake in pairing.js. Never sent anywhere.
  const stored = (await chrome.storage.local.get("key")).key;
  if (typeof stored === "string") {
    // Earlier versions sent their key in plain text on every connection, to whatever held the port.
    await chrome.storage.local.remove("key");
    pairError = "The extension was updated and now pairs in a safer way, so this browser needs to pair once more.";
    chrome.tabs.create({url: chrome.runtime.getURL("setup.html")});
  }
  const key = stored?.version === 2 ? stored.secret : "";
  if (code) {
    pendingCode = code;
    pairError = "";
  }
  code = pendingCode || undefined;
  if (!key && !code) return;
  // A code takes precedence: the user asked to pair. The proofs are bound to the port dialled.
  // Awaited before the old socket is replaced, so overlapping calls never leave one open.
  const port = Number(new URL(BRIDGE).port);
  const nonce = BridgePairing.nonce();
  const exchange = code ? await BridgePairing.codeExchange(code) : null;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  ready = false;
  published = undefined;
  const ws = new WebSocket(BRIDGE);
  socket = ws;
  // Anything can listen on the port, so nothing it sends is obeyed until it has proved it holds this
  // browser's key or knows the code. `phase` is what may come next; "busy" while a step is checked.
  let phase = "challenge";
  let bridgeNonce = "";
  let sessionKey = null;
  let distrusted = "";
  const IMPOSTOR = "Something on 127.0.0.1:19989 could not prove it is your bridge, so this browser won't talk to it. Quit whatever holds the port, then restart Amp.";
  const refuse = (why) => {
    distrusted = why;
    ws.close();
  };
  const handshakeTimer = setTimeout(() => phase !== "ready" && refuse(IMPOSTOR), 10_000);
  const authenticate = async (browserKey) => {
    const proof = await BridgePairing.keyProof(browserKey, "extension", port, nonce, bridgeNonce);
    phase = "ready-wait";
    // The lent tab is told only to a bridge that has proved itself.
    ws.send(JSON.stringify({type: "auth", proof, tab: await tabInfo(), agent_tabs: await agentTabsInfo(), handoff: (await session.get("handoff"))?.id}));
  };
  const handshake = async (message) => {
    const step = phase;
    phase = "busy";
    if (step === "challenge" && message.type === "challenge" && typeof message.nonce === "string") {
      bridgeNonce = message.nonce;
      if (!exchange) {
        if (!BridgePairing.same(await BridgePairing.keyProof(key, "bridge", port, nonce, bridgeNonce), message.proof)) return refuse(IMPOSTOR);
        return authenticate(key);
      }
      sessionKey = await exchange.session(port, nonce, bridgeNonce, message.ecdh);
      if (!sessionKey) return refuse(IMPOSTOR);
      const proof = await BridgePairing.codeProof(sessionKey, "extension");
      phase = "paired";
      return ws.send(JSON.stringify({type: "pair", proof}));
    }
    if (step === "paired" && message.type === "paired") {
      if (!BridgePairing.same(await BridgePairing.codeProof(sessionKey, "bridge"), message.proof)) return refuse(IMPOSTOR);
      const secret = await BridgePairing.unwrapKey(sessionKey, message.wrapped);
      if (!secret) return refuse(IMPOSTOR);
      await chrome.storage.local.set({key: {version: 2, secret}});
      return authenticate(secret);
    }
    if (step === "ready-wait" && message.type === "ready") {
      phase = "ready";
      clearTimeout(handshakeTimer);
      ready = true;
      lastError = "";
      pendingCode = "";
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send({type: "ping"}), 20_000);
      // A Continue click made while the bridge was unreachable is delivered now.
      if ((await session.get("handoff"))?.continued) await continueHandoff();
      return;
    }
    refuse(IMPOSTOR);
  };
  ws.onopen = () => ws.send(JSON.stringify({type: "hello", nonce, ...(exchange ? {ecdh: exchange.publicKey} : {})}));
  ws.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return refuse(IMPOSTOR);
    }
    if (phase !== "ready") return handshake(message);
    if (message.type === "published") published = message.published ?? null;
    if (message.type === "lease") await session.set("lease", message.lease);
    if (message.type === "command") run(message);
    if (message.type === "handoff") await startHandoff(message.id, message.message, message.thread, message.tab);
    if (message.type === "cancel_handoff") await clearHandoff(message.id);
  };
  ws.onclose = (event) => {
    clearTimeout(handshakeTimer);
    if (socket !== ws) return;
    socket = null;
    ready = false;
    clearInterval(heartbeat);
    if (distrusted) {
      // The code may have reached an impostor; ask for a new one rather than trying it again.
      if (code) {
        pendingCode = "";
        pairError = distrusted;
      }
      lastError = distrusted;
      reconnectTimer = setTimeout(() => connect(), 10_000);
      return;
    }
    if (event.code === 1008) {
      pairError = code
        ? "The bridge rejected this pairing code. Codes work once, for 10 minutes, and five wrong tries void them."
        : "The bridge no longer knows this browser. Pair it again. If you just updated the extension, update the Amp plugin on your Mac too.";
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
  const args = message.args || {};
  // Set once input may have reached the page: a failure after that leaves the outcome unknown.
  const effects = {sent: false};
  let tabId = null;
  try {
    if (message.tool === "open_tab") {
      send({type: "result", id: message.id, result: await openTab(message.thread, args.url, effects)});
      return;
    }
    const policy = await policyFor(message.thread, args.tab, true);
    tabId = policy.tabId;
    // A reload of the extension detaches the debugger; attach again on first use.
    if (policy.agent) await attach(tabId);
    await badge();
    if (message.tool === "close_tab" && (await session.get("handoff"))?.tabId === tabId) throw new Error("The user has the tab for a handoff. Wait for browser_handoff to return.");
    const result = message.tool === "close_tab" && policy.agent
      ? await closeAgentTab(tabId)
      : await execute(policy, message.tool, args, effects);
    send({type: "result", id: message.id, result});
  } catch (error) {
    send({type: "result", id: message.id, error: String(error?.message || error).slice(0, 1000), unknown: effects.sent});
  } finally {
    if (tabId != null) {
      // A tab the user closed, or turned Amp's tabs off for, while this ran closes now.
      const close = await updateAgentTabs((tabs) => {
        running.set(tabId, running.get(tabId) - 1);
        if (tabs[tabId]) tabs[tabId].lastUsed = Date.now();
        return !!tabs[tabId]?.closing && !(running.get(tabId) > 0);
      });
      if (close) await closeAgentTab(tabId).catch(() => {});
      await badge();
    }
  }
}

/**
 * What a command may do to its tab: the lent tab (no `tab` argument) with the user's permissions,
 * or one of Amp's own tabs, which only the thread that opened it may use. The user widened those
 * by letting Amp open tabs at all; the plugin still asks before each action or once per site.
 */
async function policyFor(thread, tab, count = false) {
  if (tab == null) {
    const lend = await getLend();
    if (!lend) throw new Error("No tab is lent. Ask the user to open the page and click Lend this tab in the extension, or open a tab of your own with browser_open_tab.");
    if (count) running.set(lend.tabId, (running.get(lend.tabId) || 0) + 1);
    return lend;
  }
  const record = Number.isInteger(tab) ? (await getAgentTabs())[tab] : null;
  if (!record || !await agentTabsAllowed() || !await ownedTab(tab, record)) throw new Error(`Tab ${tab} is not one of Amp's open tabs. Open one with browser_open_tab.`);
  if (record.thread !== thread) throw new Error(`Tab ${tab} belongs to another thread. Open your own with browser_open_tab.`);
  const tabId = tab;
  // Under the same lock as closing, so a tab is never claimed for closing as a command starts on it.
  const usable = await updateAgentTabs((tabs) => {
    if (!tabs[tabId] || tabs[tabId].closing) return false;
    tabs[tabId].lastUsed = Date.now();
    if (count) running.set(tabId, (running.get(tabId) || 0) + 1);
    return true;
  });
  if (!usable) throw new Error(`Tab ${tab} is closing. Open another with browser_open_tab.`);
  return {tabId, allowActions: true, anyOrigin: true, agent: true};
}

async function execute(lend, tool, args, effects) {
  const target = {tabId: lend.tabId};
  if (MUTATING.has(tool) && !lend.allowActions) {
    throw new Error("This tab is lent read-only. Ask the user to turn on Allow clicks, typing and navigation in the extension popup.");
  }
  // During a handoff the tab belongs to the user: no reading (they may be typing a 2FA code) and
  // no input, which could also land on the card's Continue button as a trusted click.
  if ((await session.get("handoff"))?.tabId === lend.tabId) throw new Error("The user has the tab for a handoff. Wait for browser_handoff to return, or call it again if it failed; browser_status shows whether the user continued.");
  const tab = await chrome.tabs.get(lend.tabId);
  if (!lend.anyOrigin && originOf(tab.url) !== lend.origin) {
    throw new Error(`The tab has left ${lend.origin}, the site it was lent on. Ask the user to go back or to allow other sites.`);
  }
  switch (tool) {
    case "snapshot": return withChallenge(lend, await snapshot(target, lend, tab), 0);
    case "describe": return describe(target, lend, tab, args.ref);
    case "screenshot": return screenshot(target, lend);
    case "scroll": return scroll(target, Number(args.delta_y), effects);
    case "wait_for": return waitFor(target, lend, args);
    case "click": return click(target, lend, args.ref, effects);
    case "type": return type(target, lend, args.ref, String(args.text ?? ""), args.submit === true, effects);
    case "fill": return fill(target, lend, args.ref, String(args.value ?? ""), args.submit === true, args.secret === true, effects);
    case "press": return press(target, lend, args.ref, args.key, args.doc, args.url, args.focused, effects);
    case "select": return select(target, lend, args.ref, String(args.value ?? ""), effects);
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
async function documentID(target, lend) {
  const {frameTree} = await cdp(target, "Page.getFrameTree");
  if (!lend.anyOrigin && originOf(frameTree.frame.url) !== lend.origin) {
    throw new Error(`The tab has left ${lend.origin}, the site it was lent on. Ask the user to go back or to allow other sites.`);
  }
  return frameTree.frame.loaderId;
}

const SKIP = new Set(["none", "generic", "InlineTextBox", "LineBreak"]);
const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "tab", "option", "slider", "spinbutton", "listbox", "menuitemcheckbox", "menuitemradio", "treeitem"]);

/**
 * Calls visit(node, role, name, depth) for each accessibility node a snapshot shows, never inside
 * fields: their text is what the user typed. Stops when visit returns false.
 */
function walkTree(nodes, visit) {
  const byID = new Map(nodes.map((n) => [n.nodeId, n]));
  let stopped = false;
  const walk = (node, depth) => {
    if (stopped) return;
    const role = node.role?.value || "";
    const name = (node.name?.value || "").replace(/\s+/g, " ").trim();
    const shown = !node.ignored && !SKIP.has(role) && !(role === "StaticText" && !name);
    if (shown && visit(node, role, name, depth) === false) {
      stopped = true;
      return;
    }
    if (EDITABLE.has(role) || node.properties?.some((p) => p.name === "editable" && p.value?.value)) return;
    for (const id of node.childIds || []) {
      const child = byID.get(id);
      if (child) walk(child, shown ? depth + 1 : depth);
    }
  };
  const root = nodes.find((n) => !n.parentId);
  if (root) walk(root, 0);
}

async function snapshot(target, lend, tab) {
  const doc = await documentID(target, lend);
  const {nodes} = await cdp(target, "Accessibility.getFullAXTree");
  const refs = {};
  let count = 0;
  const lines = [];
  let size = 0;
  let truncated = false;
  walkTree(nodes, (node, role, name, depth) => {
    let line = "  ".repeat(depth);
    if (node.backendDOMNodeId && (INTERACTIVE.has(role) || node.focusable)) {
      const ref = `e${++count}`;
      refs[ref] = {backendNodeId: node.backendDOMNodeId, role, name: node.name?.value || ""};
      line += `[${ref}] `;
    }
    name = name.slice(0, 200);
    line += role === "StaticText" ? JSON.stringify(name) : `${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
    // Snapshots leave out what's typed in fields; the agent sees the field, not its contents.
    for (const p of node.properties || []) {
      if (["checked", "disabled", "expanded", "selected"].includes(p.name) && p.value?.value) line += ` (${p.name})`;
    }
    size += line.length + 1;
    if (size > SNAPSHOT_LIMIT) {
      truncated = true;
      return false;
    }
    lines.push(line);
  });
  // The origin was checked before the read; a navigation during it would mix in another page.
  if (await documentID(target, lend) !== doc) throw new Error("The page navigated while it was read. Take a new snapshot.");
  await session.set(`refs:${target.tabId}`, {doc, refs});
  return {title: tab.title, url: tab.url, truncated, outline: lines.join("\n")};
}

// Refs come from the latest snapshot. Refuse to act once the page has navigated or the element no
// longer matches, so an action approved for one element never lands on another.
async function resolveRef(target, lend, ref) {
  const saved = await session.get(`refs:${target.tabId}`);
  const entry = saved?.refs[ref];
  if (!entry) throw new Error(`Unknown ref ${ref}. Take a new snapshot.`);
  if (await documentID(target, lend) !== saved.doc) throw new Error("The page changed since the snapshot. Take a new snapshot.");
  const {nodes} = await cdp(target, "Accessibility.getPartialAXTree", {backendNodeId: entry.backendNodeId, fetchRelatives: false});
  const node = nodes?.find((n) => n.backendDOMNodeId === entry.backendNodeId);
  if (!node || node.role?.value !== entry.role || (node.name?.value || "") !== entry.name) {
    throw new Error(`${ref} changed since the snapshot. Take a new snapshot.`);
  }
  return entry;
}

/**
 * Runs `fn` on a node in an isolated world, where the page's own overrides (of focus, contains, ...)
 * don't apply. `arg` is passed to `fn`: another node as {node: backendNodeId}, or {value}.
 */
async function isolated(target, backendNodeId, fn, arg) {
  const {frameTree} = await cdp(target, "Page.getFrameTree");
  const {executionContextId} = await cdp(target, "Page.createIsolatedWorld", {frameId: frameTree.frame.id, worldName: "amp-browser-bridge"});
  const {object} = await cdp(target, "DOM.resolveNode", {backendNodeId, executionContextId});
  const args = [];
  if (arg?.node) args.push({objectId: (await cdp(target, "DOM.resolveNode", {backendNodeId: arg.node, executionContextId})).object.objectId});
  else if (arg) args.push({value: arg.value});
  const {result} = await cdp(target, "Runtime.callFunctionOn", {objectId: object.objectId, functionDeclaration: fn.toString(), arguments: args, returnByValue: true});
  return result.value;
}

/** Whether a node is a password or one-time-code field, whose value the fill tool hides. */
function isSecret() {
  const tokens = (this.getAttribute?.("autocomplete") || "").toLowerCase().split(/\s+/);
  return (this instanceof HTMLInputElement && this.type === "password") || ["one-time-code", "current-password", "new-password"].some((t) => tokens.includes(t));
}

async function describe(target, lend, tab, ref) {
  // Without a ref (a key pressed on whatever has focus) the page is all there is to describe; its
  // document ID lets press refuse a key approved for a page that has since navigated.
  if (!ref) {
    // URL and document ID from one read, so the site approved is the page the key goes to.
    const {frameTree} = await cdp(target, "Page.getFrameTree");
    if (!lend.anyOrigin && originOf(frameTree.frame.url) !== lend.origin) {
      throw new Error(`The tab has left ${lend.origin}, the site it was lent on. Ask the user to go back or to allow other sites.`);
    }
    return {url: frameTree.frame.url, doc: frameTree.frame.loaderId, focused: await focusedNode(target, frameTree)};
  }
  const entry = await resolveRef(target, lend, ref);
  return {ref, role: entry.role, name: entry.name, url: tab.url, secret: await isolated(target, entry.backendNodeId, isSecret)};
}

/**
 * Scrolls a node into view and returns its centre. Input lands on whatever is on top there, so
 * refuse unless that is the node itself (or something inside it): an overlay never receives an
 * action approved for something else, and nothing acts on an element the user can't see.
 */
async function uncovered(target, backendNodeId, ref) {
  await cdp(target, "DOM.scrollIntoViewIfNeeded", {backendNodeId});
  const {model} = await cdp(target, "DOM.getBoxModel", {backendNodeId});
  const q = model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  const hit = await cdp(target, "DOM.getNodeForLocation", {x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false});
  const inside = await isolated(target, backendNodeId, function (h) {
    for (let n = h; n; n = n.parentNode || n.host) if (n === this) return true;
    // Custom checkboxes and switches hide the input under its label; the browser forwards that click.
    return h.closest?.("label")?.control === this;
  }, {node: hit.backendNodeId});
  if (!inside) throw new Error(`Something else covers ${ref} (a dialog or banner?). Take a new snapshot.`);
  return {x, y};
}

/** The backend node ID of the element with focus (inside shadow roots too), read in an isolated world. */
async function focusedNode(target, frameTree) {
  const {executionContextId} = await cdp(target, "Page.createIsolatedWorld", {frameId: frameTree.frame.id, worldName: "amp-browser-bridge"});
  const {result} = await cdp(target, "Runtime.evaluate", {contextId: executionContextId, expression: "(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a; })()"});
  if (!result.objectId) return 0;
  return (await cdp(target, "DOM.describeNode", {objectId: result.objectId})).node.backendNodeId;
}

function hasFocus() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active === this;
}

async function click(target, lend, ref, effects) {
  const {backendNodeId} = await resolveRef(target, lend, ref);
  const {x, y} = await uncovered(target, backendNodeId, ref);
  effects.sent = true;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp(target, "Input.dispatchMouseEvent", {type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1});
  }
  return {clicked: ref};
}

/** Replaces a field's contents; browser_type and browser_fill differ only in what they report. */
async function replaceText(target, lend, ref, text, effects) {
  const {backendNodeId} = await resolveRef(target, lend, ref);
  await uncovered(target, backendNodeId, ref);
  // Focus and select in an isolated world, without bringing the tab to the front, and check that
  // the field really has focus: the page can't redirect it there, but its own handlers could.
  // focus() runs the page's own handlers, so from here a failure leaves the outcome unknown.
  effects.sent = true;
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
  await cdp(target, "Input.insertText", {text});
  // The page could still move focus between the check and the insert; then the outcome is unknown.
  if (!await isolated(target, backendNodeId, hasFocus)) throw new Error(`Focus moved away from ${ref} while typing; check where the text went.`);
  return backendNodeId;
}

async function type(target, lend, ref, text, submit, effects) {
  await replaceText(target, lend, ref, text, effects);
  if (submit) await sendKey(target, parseKey("Enter"));
  return {typed: ref, submitted: submit};
}

async function fill(target, lend, ref, value, submit, approvedSecret, effects) {
  // Checked before the value goes in too, so a page that turns a password field into a text field
  // as you type can't make the result show it.
  // approvedSecret: the approval prompt hid the value, so the result does too, even if the user
  // has since shown the password.
  const before = approvedSecret || await isolated(target, (await resolveRef(target, lend, ref)).backendNodeId, isSecret);
  const backendNodeId = await replaceText(target, lend, ref, value, effects);
  const secret = before || await isolated(target, backendNodeId, isSecret);
  // Enter last: a submit can navigate, and then the field is gone.
  if (submit) await sendKey(target, parseKey("Enter"));
  return {filled: ref, value: secret ? `(hidden: ${[...value].length} characters)` : value.slice(0, 80), submitted: submit};
}

const NAMED_KEYS = {
  Enter: [13, "\r"], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Space: [32, " "],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34],
};
const MODIFIERS = {Alt: 1, Control: 2, Meta: 4, Shift: 8};

/** "Enter", "Shift+Tab", "Control+a" or "x" as CDP key event fields. */
function parseKey(raw) {
  const parts = String(raw ?? "").split("+");
  let key = parts.pop();
  if (key === "" && parts.at(-1) === "") key = parts.pop() + "+";
  if (key === " ") key = "Space";
  let modifiers = 0;
  for (const m of parts) {
    if (!MODIFIERS[m]) throw new Error(`Unknown modifier ${m}. Use Shift, Control, Alt or Meta.`);
    modifiers |= MODIFIERS[m];
  }
  let event;
  if (NAMED_KEYS[key]) {
    const [code, text] = NAMED_KEYS[key];
    event = {key: key === "Space" ? " " : key, code: key, windowsVirtualKeyCode: code, text};
  } else if ([...key].length === 1 && key > " ") {
    const upper = key.toUpperCase();
    // One ASCII letter: ß upper-cases to "SS", which is two keys, not one.
    const letter = /^[A-Z]$/.test(upper);
    const digit = /^[0-9]$/.test(key);
    if (modifiers & MODIFIERS.Shift && !letter) throw new Error(`Shift+${key} depends on the keyboard layout. Pass the character it should type instead, such as ! for Shift+1.`);
    const code = letter ? `Key${upper}` : digit ? `Digit${key}` : "";
    const shown = modifiers & MODIFIERS.Shift ? upper : key;
    event = {key: shown, code, windowsVirtualKeyCode: letter || digit ? upper.charCodeAt(0) : 0, text: shown};
  } else {
    throw new Error(`Unknown key ${JSON.stringify(String(raw ?? ""))}. Use a name such as Enter, Escape, Tab, Backspace, ArrowDown or PageDown, or one character, optionally after Shift+, Control+, Alt+ or Meta+.`);
  }
  // Shortcuts send no text: Control+a selects, it doesn't type an "a".
  if (modifiers & (MODIFIERS.Alt | MODIFIERS.Control | MODIFIERS.Meta)) delete event.text;
  return {...event, modifiers};
}

async function sendKey(target, event) {
  await cdp(target, "Input.dispatchKeyEvent", {...event, type: event.text ? "keyDown" : "rawKeyDown"});
  const {text, ...up} = event;
  await cdp(target, "Input.dispatchKeyEvent", {...up, type: "keyUp"});
}

async function press(target, lend, ref, key, doc, url, focused, effects) {
  const event = parseKey(key);
  if (!ref && doc != null) {
    // Document and URL from one read: an in-page route change keeps the document but not the URL.
    // And the same element must still have focus: a dialog may have taken it while the user decided.
    const {frameTree} = await cdp(target, "Page.getFrameTree");
    if (frameTree.frame.loaderId !== doc || frameTree.frame.url !== url || await focusedNode(target, frameTree) !== focused) throw new Error("The page changed since this key press was approved, so no key was pressed. Take a new snapshot.");
  }
  if (ref) {
    const {backendNodeId} = await resolveRef(target, lend, ref);
    await uncovered(target, backendNodeId, ref);
    // focus() runs the page's own handlers, so from here a failure leaves the outcome unknown.
    effects.sent = true;
    if (!await isolated(target, backendNodeId, function () {
      this.focus();
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active === this;
    })) throw new Error(`${ref} did not take focus, so no key was pressed. Take a new snapshot.`);
  }
  effects.sent = true;
  await sendKey(target, event);
  return {pressed: key, ...(ref ? {ref} : {})};
}

async function select(target, lend, ref, value, effects) {
  const {backendNodeId} = await resolveRef(target, lend, ref);
  await uncovered(target, backendNodeId, ref);
  // Matched, checked and changed in one step in the page, so it can't disable the option in between.
  // Set as a person would pick it: the page hears input and change, and like a plain click only this
  // option stays selected, in a multi-select too.
  effects.sent = true;
  const found = await isolated(target, backendNodeId, function (wanted) {
    if (!(this instanceof HTMLSelectElement)) return {error: "is not a <select>. For a custom dropdown, click it, then click the option"};
    if (this.disabled) return {error: "is disabled"};
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const options = [...this.options];
    const option = options.find((o) => o.value === wanted) || options.find((o) => norm(o.label) === norm(wanted)) ||
      options.find((o) => norm(o.label).toLowerCase() === norm(wanted).toLowerCase());
    if (!option) return {error: `has no option ${JSON.stringify(wanted)}. Its options: ${options.slice(0, 50).map((o) => JSON.stringify(norm(o.label))).join(", ")}`};
    if (option.disabled || option.parentElement?.disabled) return {error: `has option ${JSON.stringify(norm(option.label))} disabled`};
    this.selectedIndex = option.index;
    this.dispatchEvent(new Event("input", {bubbles: true, composed: true}));
    this.dispatchEvent(new Event("change", {bubbles: true}));
    return {value: option.value, label: norm(option.label)};
  }, {value});
  if (found.error) {
    // Refused before anything changed.
    effects.sent = false;
    throw new Error(`${ref} ${found.error}.`);
  }
  return {selected: ref, value: found.value, label: found.label};
}

/** Waits until every given condition holds: text on the page, a URL substring, an element by role and name. */
async function waitFor(target, lend, args) {
  const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
  const text = args.text == null ? "" : norm(args.text);
  const url = args.url == null ? "" : String(args.url);
  const role = args.role == null ? "" : String(args.role);
  const name = args.name == null ? "" : norm(args.name);
  if (!text && !url && !role) throw new Error("wait_for needs text, url or role.");
  if (name && !role) throw new Error("name needs a role, such as button or heading.");
  const limit = Math.min(Math.max(Number(args.timeout_ms ?? 10_000) || 0, 0), WAIT_LIMIT_MS);
  const started = Date.now();
  const wanted = [text && `text ${JSON.stringify(args.text)}`, url && `a URL containing ${JSON.stringify(url)}`, role && `${role}${name ? ` ${JSON.stringify(args.name)}` : ""}`].filter(Boolean).join(" and ");
  for (;;) {
    // Refuses once the tab leaves the lent site, like every other read.
    const doc = await documentID(target, lend);
    const current = (await chrome.tabs.get(target.tabId)).url || "";
    let met = !url || current.includes(url);
    if (met && (text || role)) {
      // Read the page as a snapshot does, so a wait never finds what's typed in a field.
      const {nodes} = await cdp(target, "Accessibility.getFullAXTree").catch(() => ({nodes: []}));
      let seen = "";
      let found = !role;
      walkTree(nodes, (node, r, n) => {
        if (text) seen += ` ${n.toLowerCase()}`;
        if (!found && r === role && (!name || n.toLowerCase().includes(name))) found = true;
      });
      met = found && (!text || seen.replace(/\s+/g, " ").includes(text));
    }
    // Every condition must hold on one document: if the page moved during the read, read again.
    if (met && (await documentID(target, lend) !== doc || ((await chrome.tabs.get(target.tabId)).url || "") !== current)) met = false;
    const waited = Date.now() - started;
    if (met) return {matched: wanted, waited_ms: waited, url: current};
    if (waited >= limit) throw new Error(`Timed out after ${Math.round(limit / 1000)}s waiting for ${wanted}. The tab is at ${current}.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, limit - waited)));
  }
}

async function navigate(target, lend, raw, effects) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs.");
  if (!lend.anyOrigin && url.origin !== lend.origin) throw new Error(`This tab is limited to ${lend.origin}. Ask the user to allow other sites in the extension popup.`);
  effects.sent = true;
  const result = await cdp(target, "Page.navigate", {url: url.toString()});
  if (result.errorText) throw new Error(result.errorText);
  await waitForLoad(target.tabId);
  const tab = await chrome.tabs.get(target.tabId);
  return withChallenge(lend, {url: tab.url, title: tab.title}, CHALLENGE_WAIT_MS);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the tab has loaded, or LOAD_WAIT_MS has passed; a slow page is not an error. */
async function waitForLoad(tabId) {
  for (const started = Date.now(); Date.now() - started < LOAD_WAIT_MS; await sleep(250)) {
    if ((await chrome.tabs.get(tabId)).status === "complete") return;
  }
}

// ---- Bot challenges ----
// After a navigation, and with each snapshot, the page is checked for a bot challenge or block page
// (challenge.js), so the agent hands it to the user instead of retrying. Nothing here ever answers one.

/** Adds `challenge` to a result when the lent tab shows a bot check that waiting `waitMs` did not clear. */
async function withChallenge(lend, result, waitMs) {
  const challenge = await detectChallenge(lend, waitMs);
  return challenge ? {...result, challenge} : result;
}

/** Reads the page in an isolated world, invisible to its scripts. Null mid-navigation or off the lent site. */
async function probeChallenge(lend) {
  const [frame] = await chrome.scripting.executeScript({target: {tabId: lend.tabId}, world: "ISOLATED", func: probePage, args: [PROBE_SELECTORS]}).catch(() => []);
  const probe = frame?.result;
  if (!probe || (!lend.anyOrigin && originOf(probe.url) !== lend.origin)) return null;
  // Turnstile puts its iframe in a closed shadow root, out of querySelector's reach; the frame tree has it.
  const {frameTree} = await cdp({tabId: lend.tabId}, "Page.getFrameTree").catch(() => ({}));
  const frames = [];
  const collect = (node) => {
    for (const child of node?.childFrames || []) {
      frames.push(child.frame.url);
      collect(child);
    }
  };
  collect(frameTree);
  return {...probe, frameUrls: [...new Set([...probe.frameUrls, ...frames])].slice(0, 50)};
}

/**
 * {vendor, kind, signal, url, waited_ms} for a challenge on the lent tab, or null. A check the browser
 * clears by itself ("non-interactive") is polled for up to `waitMs` and is null once it has gone.
 */
async function detectChallenge(lend, waitMs) {
  const first = await probeChallenge(lend);
  let found = first && classifyChallenge(first);
  if (!found) return null;
  let url = first.url;
  const started = Date.now();
  while (found.kind === "non-interactive" && Date.now() - started < waitMs) {
    await sleep(1000);
    // A challenge often clears by navigating; a page that can't be read yet counts as still waiting.
    const probe = await probeChallenge(lend);
    if (!probe) continue;
    const next = classifyChallenge(probe);
    if (!next) return null;
    found = next;
    url = probe.url;
  }
  return {...found, url, waited_ms: Date.now() - started};
}

async function scroll(target, dy, effects) {
  if (!Number.isFinite(dy) || Math.abs(dy) > 10_000) throw new Error("delta_y must be between -10000 and 10000.");
  effects.sent = true;
  await cdp(target, "Runtime.evaluate", {expression: `window.scrollBy(0, ${dy})`});
  return {scrolled: dy};
}

async function screenshot(target, lend) {
  const doc = await documentID(target, lend);
  const {data} = await cdp(target, "Page.captureScreenshot", {format: "jpeg", quality: 70});
  if (await documentID(target, lend) !== doc) throw new Error("The page navigated during the screenshot. Try again.");
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
  const handoff = await session.get("handoff");
  if (!handoff || handoff.continued) return;
  await chrome.scripting.executeScript({target: {tabId: handoff.tabId}, world: "ISOLATED", func: showCard, args: [handoff.message]}).catch(() => {});
}

async function removeCard(tabId) {
  await chrome.scripting.executeScript({target: {tabId}, world: "ISOLATED", func: () => document.getElementById("__amp_handoff")?.remove()}).catch(() => {});
}

/** Shows the card on the lent tab, or on one of the thread's own tabs, and opens its group so the user finds it. */
async function startHandoff(id, message, thread, tab) {
  let tabId;
  try {
    tabId = (await policyFor(thread, tab)).tabId;
  } catch (error) {
    send({type: "result", id, error: `Nowhere to show the handoff: ${error.message}`});
    return;
  }
  await session.set("handoff", {id, message, tabId});
  const groupId = (await chrome.tabs.get(tabId).catch(() => null))?.groupId;
  if (groupId >= 0) await chrome.tabGroups.update(groupId, {collapsed: false}).catch(() => {});
  await injectCard();
  await badge();
}

async function clearHandoff(id) {
  const handoff = await session.get("handoff");
  if (!handoff || (id && handoff.id !== id)) return;
  await session.remove("handoff");
  await removeCard(handoff.tabId);
  await badge();
}

async function continueHandoff() {
  const handoff = await session.get("handoff");
  if (!handoff) return;
  // The user may have had the tab for longer than the idle limit; give the thread a fresh window.
  await updateAgentTabs((tabs) => {
    if (tabs[handoff.tabId]) tabs[handoff.tabId].lastUsed = Date.now();
  });
  await removeCard(handoff.tabId);
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
  const busy = "Amp is using this tab right now. Try again in a moment.";
  if ((await getAgentTabs())[tabId] && running.get(tabId) > 0) throw new Error(busy);
  const previous = await getLend();
  if (previous && previous.tabId !== tabId) await stop();
  // Lending one of Amp's own tabs makes it yours: it gets the lent tab's limits instead.
  // Not while a command runs in it: that command was allowed more than a lent tab is.
  const wasAgent = await updateAgentTabs((tabs) => {
    if (tabs[tabId] && running.get(tabId) > 0) throw new Error(busy);
    const had = !!tabs[tabId];
    delete tabs[tabId];
    return had;
  });
  await attach(tabId);
  // Lent read-only and limited to the current site until the user widens it.
  // Chrome deletes a group when its last tab leaves, so remember enough to recreate it, unless
  // that was Amp's own group: then Stop lending leaves the tab ungrouped, as yours.
  const previousGroup = tab.groupId >= 0 && !wasAgent ? await chrome.tabGroups.get(tab.groupId).catch(() => null) : null;
  await session.set("lend", {
    tabId, origin: originOf(tab.url), allowActions: false, anyOrigin: false,
    previousGroup: previousGroup && {id: previousGroup.id, title: previousGroup.title, color: previousGroup.color, windowId: previousGroup.windowId},
  });
  await groupTab(tabId);
  await session.remove(`refs:${tabId}`);
  send({type: "tab", tab: await tabInfo()});
  await sendAgentTabs();
  await badge();
}

/** Attaches the debugger to a tab unless it already is, and turns on what snapshots need. */
async function attach(tabId) {
  try {
    await chrome.debugger.attach({tabId}, "1.3");
  } catch (error) {
    if (!String(error.message).includes("Another debugger is already attached")) throw error;
  }
  await cdp({tabId}, "Page.enable");
  await cdp({tabId}, "Accessibility.enable");
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
    const lend = {...(await getLend()), groupId};
    await session.set("lend", lend);
    // Session storage dies with a reload; this local record lets startup undo exactly this group.
    await chrome.storage.local.set({ampGroup: {tabId, groupId, previousGroup: lend.previousGroup}});
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
  if (handoff && handoff.tabId === current?.tabId) {
    send({type: "result", id: handoff.id, error: "The user stopped lending the tab."});
    await removeCard(handoff.tabId);
    await session.remove("handoff");
  }
  await session.remove("lend");
  if (current) {
    await session.remove(`refs:${current.tabId}`);
    await chrome.action.setBadgeText({tabId: current.tabId, text: null}).catch(() => {});
    await ungroupTab(current);
    await chrome.storage.local.remove("ampGroup");
    await chrome.debugger.detach({tabId: current.tabId}).catch(() => {});
  }
  send({type: "tab", tab: null});
  await badge();
}

// ---- Amp's own tabs ----
// With "Let Amp open its own tabs" on, a thread can open background tabs in the window you last
// used, inside a collapsed green "Amp" group. Only that thread can use them, and they close after
// AGENT_TAB_IDLE_MS without a command.

async function openTab(thread, raw, effects) {
  if (!await agentTabsAllowed()) throw new Error("The user hasn't let Amp open its own tabs. Ask them to turn on \"Let Amp open its own tabs\" in the extension popup, or to lend a tab.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs.");
  const win = await chrome.windows.getLastFocused({windowTypes: ["normal"]});
  effects.sent = true;
  const tab = await chrome.tabs.create({windowId: win.id, url: url.toString(), active: false});
  // Join this window's group of Amp tabs if there is one; otherwise start one, collapsed.
  const records = await getAgentTabs();
  let groupId;
  for (const record of Object.values(records)) {
    const group = record.groupId >= 0 ? await chrome.tabGroups.get(record.groupId).catch(() => null) : null;
    // A group the user renamed or recoloured is theirs now; start a new one rather than join it.
    if (group?.windowId === win.id && group.title === GROUP_TITLE && group.color === "green") groupId = group.id;
  }
  try {
    if (groupId != null) await chrome.tabs.group({tabIds: [tab.id], groupId});
    else {
      groupId = await chrome.tabs.group({tabIds: [tab.id], createProperties: {windowId: win.id}});
      await chrome.tabGroups.update(groupId, {title: GROUP_TITLE, color: "green", collapsed: true});
    }
  } catch (error) {
    // The group is what marks the tab as Amp's; without it, don't keep the tab.
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error(`Could not put the new tab in an Amp tab group: ${error.message}`);
  }
  await updateAgentTabs((tabs) => void (tabs[tab.id] = {thread, lastUsed: Date.now(), groupId}));
  // The user may have turned the setting off while the tab opened.
  if (!await agentTabsAllowed()) {
    await closeAgentTab(tab.id);
    throw new Error("The user turned off \"Let Amp open its own tabs\" while the tab opened.");
  }
  await attach(tab.id);
  // Wait for the first load, so a snapshot right after sees the page.
  for (let i = 0; i < 100; i++) {
    const now = await chrome.tabs.get(tab.id).catch(() => null);
    if (!now || now.status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const now = await chrome.tabs.get(tab.id);
  await sendAgentTabs();
  await badge();
  return withChallenge({tabId: tab.id, anyOrigin: true}, {tab: tab.id, url: now.url || url.toString(), title: now.title || ""}, CHALLENGE_WAIT_MS);
}

/** Drops a tab from Amp's tabs without closing it. */
async function forgetAgentTab(tabId) {
  await updateAgentTabs((tabs) => void delete tabs[tabId]);
  await session.remove(`refs:${tabId}`);
  const handoff = await session.get("handoff");
  if (handoff?.tabId === tabId) {
    send({type: "result", id: handoff.id, error: "The tab was closed or taken back by the user."});
    await session.remove("handoff");
    await removeCard(tabId);
  }
  if (tabId !== (await getLend())?.tabId) await chrome.debugger.detach({tabId}).catch(() => {});
  // null, not "": a per-tab "" would hide the WAIT every tab shows during a background handoff.
  await chrome.action.setBadgeText({tabId, text: null}).catch(() => {});
  await sendAgentTabs();
  await badge();
}

async function closeAgentTab(tabId) {
  tabId = Number(tabId);
  const record = (await getAgentTabs())[tabId];
  if (!record || !await ownedTab(tabId, record)) throw new Error(`Tab ${tabId} is not one of Amp's tabs.`);
  // Removed straight after the ownership check, so a tab the user just dragged out isn't closed.
  await chrome.tabs.remove(tabId).catch(() => {});
  await forgetAgentTab(tabId);
  return {closed: tabId};
}

/** Closes one of Amp's tabs now, or, if a command is running on it, as soon as that command ends. */
async function closeWhenIdle(tabId) {
  tabId = Number(tabId);
  const now = await updateAgentTabs((tabs) => {
    if (!tabs[tabId]) return false;
    tabs[tabId].closing = true;
    return !(running.get(tabId) > 0);
  });
  if (now) await closeAgentTab(tabId);
}

async function closeAllAgentTabs() {
  for (const id of Object.keys(await getAgentTabs())) await closeWhenIdle(id).catch(() => {});
}

async function setAgentTabsAllowed(enabled) {
  await chrome.storage.local.set({allowAgentTabs: enabled});
  // Turning it off closes Amp's tabs, so nothing it opened keeps running in the background.
  if (!enabled) await closeAllAgentTabs();
  await sendAgentTabs();
}

/** The popup's Show button: the user asks to see one of Amp's tabs. */
async function showTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId >= 0) await chrome.tabGroups.update(tab.groupId, {collapsed: false}).catch(() => {});
  await chrome.tabs.update(tabId, {active: true});
  await chrome.windows.update(tab.windowId, {focused: true});
}

/** Closes Amp's tabs that no command touched for AGENT_TAB_IDLE_MS, never one in use or waiting for the user. */
async function closeIdleAgentTabs() {
  for (const id of Object.keys(await getAgentTabs())) {
    const tabId = Number(id);
    const handoff = await session.get("handoff");
    // Claimed under the record's lock: a command that starts after this sees the tab closing.
    const claimed = await updateAgentTabs((tabs) => {
      const record = tabs[tabId];
      if (!record || record.closing || running.get(tabId) > 0 || handoff?.tabId === tabId || Date.now() - record.lastUsed < AGENT_TAB_IDLE_MS) return false;
      record.closing = true;
      return true;
    });
    if (claimed) await closeAgentTab(tabId).catch(() => {});
  }
}

// Creating an alarm again restarts its timer, and the worker starts often; create it once.
chrome.alarms.get("close-idle-agent-tabs").then((alarm) => alarm || chrome.alarms.create("close-idle-agent-tabs", {periodInMinutes: 1}));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "close-idle-agent-tabs") closeIdleAgentTabs();
});
// Tab IDs start over when Chrome restarts, so a recorded ID could now be one of your tabs.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove("agentTabs"));

chrome.debugger.onDetach.addListener(async ({tabId}, reason) => {
  if (tabId === (await getLend())?.tabId) return stop();
  // Cancel on Chrome's "started debugging" bar takes Amp's tabs back too; they stay open as yours.
  if (reason === "canceled_by_user" && (await getAgentTabs())[tabId]) await forgetAgentTab(tabId);
});
// A renamed or recoloured Amp group is the user's, and so are its tabs.
chrome.tabGroups.onUpdated.addListener(async (group) => {
  for (const [id, record] of Object.entries(await getAgentTabs())) {
    if (record.groupId === group.id) await ownedTab(id, record);
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getLend())?.tabId) return stop();
  if ((await getAgentTabs())[tabId]) await forgetAgentTab(tabId);
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status === "complete" && tabId === (await session.get("handoff"))?.tabId) await injectCard();
  // Dragged out of the Amp group: the tab is the user's at once, even mid-command.
  if ("groupId" in change) {
    const record = (await getAgentTabs())[tabId];
    if (record) await ownedTab(tabId, record);
  }
  if (!change.url && !change.title) return;
  if (tabId === (await getLend())?.tabId) send({type: "tab", tab: await tabInfo()});
  else if ((await getAgentTabs())[tabId]) await sendAgentTabs();
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.action === "continue") {
      // From the card on the tab that shows it, or the popup's Continue button.
      if (!sender.tab || sender.tab.id === (await session.get("handoff"))?.tabId) await continueHandoff();
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
    if (message.action === "agentTabs") return setAgentTabsAllowed(!!message.enabled);
    if (message.action === "closeAgentTab") return closeWhenIdle(message.tabId);
    if (message.action === "closeAgentTabs") return closeAllAgentTabs();
    if (message.action === "showTab") return showTab(message.tabId);
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
    lend: lendState, tab: await tabInfo(), waiting: handoff?.message ?? null, waitingTab: handoff?.tabId ?? null, lease,
    agentTabs: await agentTabsInfo(),
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
 * tab in the Amp group. With nothing lent, put back only the tab and group this extension recorded,
 * and only while that group still looks like ours, so a group the user made is never touched.
 */
async function clearStaleGroups() {
  const {ampGroup} = await chrome.storage.local.get("ampGroup");
  if (!ampGroup || await getLend()) return;
  const group = await chrome.tabGroups.get(ampGroup.groupId).catch(() => null);
  if (group?.title === GROUP_TITLE && group.color === "green") await ungroupTab(ampGroup);
  // A lend that started meanwhile records its own group; keep that record.
  const {ampGroup: now} = await chrome.storage.local.get("ampGroup");
  if (now?.groupId === ampGroup.groupId) await chrome.storage.local.remove("ampGroup");
}

connect();
clearStaleGroups();
// Earlier versions set the badge for every tab; clear that before showing the per-tab one.
chrome.action.setBadgeText({text: ""}).then(badge);
