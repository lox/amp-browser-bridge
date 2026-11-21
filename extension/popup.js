const $ = (id) => document.getElementById(id);

function render(s) {
  // With no bridge at all the header already says so; other connection errors explain themselves.
  $("error").textContent = s.ok === false ? s.error : (s.bridge === "found" ? s.bridgeError : "") || "";
  $("setup").classList.toggle("hidden", s.connected);
  $("reconnect").classList.toggle("hidden", !s.paired || s.connected || s.bridge !== "found");
  $("controls").classList.toggle("hidden", !s.connected);
  $("continue").classList.toggle("hidden", !s.waiting);
  $("lend").classList.toggle("hidden", !!s.waiting);
  $("stop").disabled = !s.lend;
  $("permissions").classList.toggle("hidden", !s.lend);
  if (s.lend) {
    $("allowActions").checked = s.lend.allowActions;
    $("anyOrigin").checked = s.lend.anyOrigin;
    $("origin").textContent = s.lend.origin;
  }
  // Release goes through the bridge, so it only shows while connected.
  $("lease").classList.toggle("hidden", !s.connected || !s.lease);
  if (s.lease) {
    $("leaseThread").textContent = s.lease.thread;
    $("leaseThread").href = `https://ampcode.com/threads/${s.lease.thread}`;
  }
  const [state, status, detail] = !s.connected
    ? s.bridge === "missing" || s.bridge === "other" ? ["fail", "Bridge not found", "Open the Amp app on your Mac."]
    : s.paired && s.bridge === "found" && s.bridgeError ? ["fail", "Disconnected", "See below."]
    : s.paired ? ["wait", "Connecting to the bridge…", ""]
    : ["fail", "Not paired", "Finish setup to pair this browser."]
    : s.waiting ? ["wait", "Amp is waiting for you", s.waiting]
    : s.tab ? ["ok", s.lend.allowActions ? "Lent" : "Lent read-only", s.tab.title || s.tab.url]
    : ["", "Connected", "No tab lent."];
  $("head").className = state;
  $("status").textContent = status;
  $("detail").textContent = detail;
  $("detail").title = detail;
}

const ask = (message) => chrome.runtime.sendMessage(message).then(render);

/** Focuses the setup page if it is already open, rather than opening another. */
async function openSetup() {
  const url = chrome.runtime.getURL("setup.html");
  const [tab] = await chrome.tabs.query({url});
  if (tab) {
    await chrome.tabs.update(tab.id, {active: true});
    await chrome.windows.update(tab.windowId, {focused: true});
  } else await chrome.tabs.create({url});
  close();
}

$("openSetup").onclick = $("setupLink").onclick = (event) => {
  event.preventDefault();
  openSetup();
};
$("lend").onclick = async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  ask({action: "lend", tabId: tab.id});
};
$("reconnect").onclick = () => ask({action: "reconnect"}).then(() => setTimeout(() => ask({action: "state"}), 800));
$("stop").onclick = () => ask({action: "stop"});
$("continue").onclick = () => ask({action: "continue"});
$("release").onclick = () => ask({action: "release"});
$("allowActions").onchange = $("anyOrigin").onchange = () =>
  ask({action: "permissions", allowActions: $("allowActions").checked, anyOrigin: $("anyOrigin").checked});
ask({action: "state"});
