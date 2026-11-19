const $ = (id) => document.getElementById(id);

function render(s) {
  $("error").textContent = (s.ok === false ? s.error : s.bridgeError) || "";
  $("pair").classList.toggle("hidden", s.paired && s.connected);
  $("controls").classList.toggle("hidden", !s.connected);
  $("reconnect").classList.toggle("hidden", !s.paired || s.connected);
  $("continue").classList.toggle("hidden", !s.waiting);
  $("stop").disabled = !s.lend;
  $("permissions").classList.toggle("hidden", !s.lend);
  if (s.lend) {
    $("allowActions").checked = s.lend.allowActions;
    $("anyOrigin").checked = s.lend.anyOrigin;
    $("origin").textContent = s.lend.origin;
  }
  $("lease").classList.toggle("hidden", !s.lease);
  if (s.lease) {
    $("leaseThread").textContent = s.lease.thread;
    $("leaseThread").href = `https://ampcode.com/threads/${s.lease.thread}`;
  }
  $("status").textContent = !s.connected
    ? (s.paired ? "Paired, waiting for the bridge…" : "Not paired.")
    : s.waiting ? `Amp is waiting for you: ${s.waiting}`
    : s.tab ? `Lent${s.lend.allowActions ? "" : " read-only"}: ${s.tab.title || s.tab.url}`
    : "Connected. No tab lent.";
}

const ask = (message) => chrome.runtime.sendMessage(message).then(render);

$("connect").onclick = () => ask({action: "pair", code: $("code").value}).then(() => setTimeout(() => ask({action: "state"}), 800));
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
