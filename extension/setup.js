// The setup and status checklist. Polls the service worker's state and lets you copy or rotate
// this browser's setup key (without ever rendering the secret on screen) or point at a custom reflector.
const $ = (id) => document.getElementById(id);
const escape = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A template whose interpolated values are escaped; the literal parts are trusted markup. */
const html = (strings, ...values) => strings.reduce((out, s, i) => out + escape(values[i - 1]) + s);

let editingRelay = false;
let copyTimer = null;

function step(id, status, detail) {
  $(id).className = `step ${status}`;
  $(id).querySelector(".detail").innerHTML = detail;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(area);
  try {
    area.select();
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}

function render(s) {
  if (s.ok === false) {
    $("relayError").textContent = s.error || "Invalid reflector URL.";
    $("relayError").classList.remove("hidden");
  }

  if (s.connected) {
    step("relay", "ok", html`Connected end-to-end encrypted through <code>${s.relay}</code>.`);
  } else if (s.bridgeError) {
    step("relay", "fail", html`<p class="error">${s.bridgeError}</p>`);
  } else {
    step("relay", "wait", html`Connecting to <code>${s.relay}</code>…`);
  }
  $("reconnect").classList.toggle("hidden", !!s.connected);
  $("relayForm").classList.toggle("hidden", !editingRelay);
  $("resetRelay").classList.toggle("hidden", s.relay === s.defaultRelay);
  if (!editingRelay) $("relayInput").value = s.relay || "";

  if (s.everUsed) {
    step("amp", "ok", "Amp has connected with this browser's setup key. Copy the same key to connect another runner, or rotate it to revoke old machines.");
  } else {
    step("amp", "", `Click <b>Copy setup key</b>, then ask any Amp thread (in an orb or on a runner) to use your browser and paste the key when prompted.`);
  }
  $("copyKey").classList.toggle("primary", !s.everUsed);

  const TODO_LEND = `Open the page you want help with, click the Amp Browser Bridge icon in Chrome's toolbar
    (pin it from the puzzle-piece menu), and choose <b>Lend this tab</b>. Then ask Amp about it.`;
  if (s.waiting) step("lent", "wait", html`Amp is waiting for you on the lent tab: ${s.waiting}`);
  else if (s.tab) {
    step("lent", "ok", html`Lent ${s.tab.allow_actions ? "with clicks and typing allowed" : "read-only"}: ${s.tab.title || s.tab.url}`);
  } else step("lent", "", TODO_LEND);
}

const ask = (message) => chrome.runtime.sendMessage(message).then(render);

$("toggleRelay").onclick = (event) => {
  event.preventDefault();
  editingRelay = !editingRelay;
  $("relayError").classList.add("hidden");
  $("relayForm").classList.toggle("hidden", !editingRelay);
  if (editingRelay) $("relayInput").focus();
};

function saveRelay(value) {
  $("relayError").classList.add("hidden");
  chrome.runtime.sendMessage({action: "setRelay", relay: value}).then((s) => {
    if (s.ok !== false) editingRelay = false;
    render(s);
  });
}

$("saveRelay").onclick = () => saveRelay($("relayInput").value);
$("relayInput").onkeydown = (event) => event.key === "Enter" && saveRelay($("relayInput").value);
$("resetRelay").onclick = () => saveRelay("");
$("reconnect").onclick = () => ask({action: "reconnect"});

$("copyKey").onclick = async () => {
  const s = await chrome.runtime.sendMessage({action: "setupKey"});
  if (s.setupKey) {
    await copyText(s.setupKey);
    clearTimeout(copyTimer);
    $("copyNote").textContent = "Copied to clipboard.";
    copyTimer = setTimeout(() => ($("copyNote").textContent = ""), 2000);
  }
  render(s);
};

$("rotateKey").onclick = async () => {
  const s = await chrome.runtime.sendMessage({action: "rotateKey"});
  clearTimeout(copyTimer);
  $("copyNote").textContent = "Key rotated. Copy the new setup key to Amp.";
  copyTimer = setTimeout(() => ($("copyNote").textContent = ""), 3000);
  render(s);
};

ask({action: "state"});
setInterval(() => ask({action: "state"}), 1500);
