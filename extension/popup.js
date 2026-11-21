const $ = (id) => document.getElementById(id);

function render(s) {
  // With no bridge at all the header already says so; other connection errors explain themselves.
  $("error").textContent = s.ok === false ? s.error : (s.bridge === "found" ? s.bridgeError : "") || "";
  $("setup").classList.toggle("hidden", s.connected);
  $("reconnect").classList.toggle("hidden", !s.paired || s.connected || s.bridge !== "found");
  $("controls").classList.toggle("hidden", !s.connected);
  $("continue").classList.toggle("hidden", !s.waiting);
  $("lend").classList.toggle("hidden", !!s.waiting && s.waitingTab === s.lend?.tabId);
  $("stop").disabled = !s.lend;
  $("permissions").classList.toggle("hidden", !s.lend);
  if (s.lend) {
    $("allowActions").checked = s.lend.allowActions;
    $("anyOrigin").checked = s.lend.anyOrigin;
    $("origin").textContent = s.lend.origin;
  }
  // Turning it off and closing tabs work without the bridge, so this shows whenever the browser is paired.
  $("agent").classList.toggle("hidden", !s.paired);
  $("allowAgentTabs").checked = !!s.agentTabs?.enabled;
  const tabs = s.agentTabs?.tabs ?? [];
  $("closeAgentTabs").classList.toggle("hidden", tabs.length < 2);
  $("agentTabs").replaceChildren(...tabs.map((t) => {
    const li = document.createElement("li");
    li.classList.toggle("wait", t.tab === s.waitingTab);
    const text = document.createElement("div");
    text.className = "title";
    text.textContent = t.tab === s.waitingTab ? `Amp needs you: ${t.title || t.url}` : t.title || t.url;
    text.title = t.url;
    const thread = document.createElement("a");
    thread.className = "thread muted";
    thread.textContent = `thread …${t.thread.slice(-6)}`;
    thread.href = `https://ampcode.com/threads/${t.thread}`;
    thread.target = "_blank";
    const info = document.createElement("div");
    info.append(text, thread);
    const show = document.createElement("button");
    show.textContent = "Show";
    show.onclick = () => ask({action: "showTab", tabId: t.tab}).then(() => close());
    const closeTab = document.createElement("button");
    closeTab.textContent = "Close";
    closeTab.onclick = () => ask({action: "closeAgentTab", tabId: t.tab});
    li.append(info, show, closeTab);
    return li;
  }));
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
    : s.waiting && s.waitingTab !== s.lend?.tabId ? ["wait", "Amp is waiting for you in one of its tabs", s.waiting]
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
$("allowAgentTabs").onchange = () => ask({action: "agentTabs", enabled: $("allowAgentTabs").checked});
$("closeAgentTabs").onclick = () => ask({action: "closeAgentTabs"});
$("release").onclick = () => ask({action: "release"});
$("allowActions").onchange = $("anyOrigin").onchange = () =>
  ask({action: "permissions", allowActions: $("allowActions").checked, anyOrigin: $("anyOrigin").checked});
ask({action: "state"});
