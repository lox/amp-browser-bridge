// The first-run checklist. It polls the service worker's state and says, for each step, what is
// done or exactly what to do next. Opened as setup.html#code=<code>, it pairs by itself.
const $ = (id) => document.getElementById(id);
const escape = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A template whose interpolated values are escaped; the literal parts are trusted markup. */
const html = (strings, ...values) => strings.reduce((out, s, i) => out + escape(values[i - 1]) + s);

const ASK_PAIR = `Ask Amp in a thread on your Mac for a new pairing code: it opens this page and pairs by
  itself. Or run <code>cat ~/.amp-browser-bridge/pairing-code</code> and enter the code here.`;
const ASK_PUBLISH = `In an Amp thread on your Mac, ask <em>“publish the browser bridge”</em> and confirm.
  Orbs that were already running need <code>amp orb restart-processes</code>.`;

function step(id, status, detail) {
  $(id).className = `step ${status}`;
  $(id).querySelector(".detail").innerHTML = detail;
}

function render(s) {
  const up = s.bridge === "connected" || s.bridge === "found";
  if (up) step("bridge", "ok", "The bridge is running.");
  else if (s.bridge === "other") {
    step("bridge", "fail", `Something other than the bridge answers on port 19989. Quit it, then restart the Amp app.`);
  } else {
    step("bridge", "fail", `Nothing answers on 127.0.0.1:19989. Open the Amp app on your Mac with <b>Run threads on
      this Mac</b> turned on (App Settings → Runner), and install the plugin if you haven't
      (<a href="https://github.com/lox/amp-browser-bridge#set-up" target="_blank">set up</a>). The bridge starts with Amp.`);
  }

  let pairForm = false;
  let reconnect = false;
  if (s.connected) step("paired", "ok", "This browser is paired and connected.");
  else if (s.pairing) step("paired", "wait", up ? "Pairing…" : "Got a pairing code. It is used as soon as the bridge answers.");
  else if (!up) step("paired", s.paired ? "wait" : "", s.paired ? "Paired. Reconnects when the bridge is back." : "Waiting for the bridge.");
  else if (s.paired) {
    reconnect = true;
    step("paired", "wait", s.bridgeError ? html`${s.bridgeError}` : "Paired. Connecting…");
  } else {
    pairForm = true;
    step("paired", "fail", (s.pairError ? html`<p class="error">${s.pairError}</p>` : "Not paired yet. ") + ASK_PAIR);
  }
  $("pairForm").classList.toggle("hidden", !pairForm);
  $("reconnectRow").classList.toggle("hidden", !reconnect);

  // The bridge reports this after it accepts the browser; an older bridge never does.
  if (!s.connected) step("published", "", "Checked once this browser is connected.");
  else if (s.published === undefined) step("published", "unknown", `This bridge doesn't report it. If orbs can't reach your browser: ${ASK_PUBLISH}`);
  else if (!s.published) step("published", "fail", `Not published, so only threads on this Mac can use the tab. ${ASK_PUBLISH}`);
  else {
    const {url, thread} = s.published;
    step("published", "ok", "Orbs reach this browser" +
      (url ? html` through <code>${url}</code>` : "") +
      (thread ? html`, published from <a href="https://ampcode.com/threads/${thread}" target="_blank">this thread</a>.` : "."));
  }

  const TODO_LEND = `Open the page you want help with, click the Amp Browser Bridge icon in Chrome's toolbar
    (pin it from the puzzle-piece menu), and choose <b>Lend this tab</b>. Then ask Amp about it.`;
  if (s.waiting) step("lent", "wait", html`Amp is waiting for you on the lent tab: ${s.waiting}`);
  else if (s.tab) {
    step("lent", "ok", html`Lent ${s.tab.allow_actions ? "with clicks and typing allowed" : "read-only"}: ${s.tab.title || s.tab.url}`);
  } else step("lent", "", TODO_LEND);
}

const ask = (message) => chrome.runtime.sendMessage(message).then(render);

function pair(code) {
  if (code.trim()) ask({action: "pair", code});
}

/** Pairs with a code passed in the URL, then drops it from the address bar and history. */
function pairFromHash() {
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  if (!code) return;
  history.replaceState(null, "", location.pathname);
  pair(code);
}

$("connect").onclick = () => pair($("code").value);
$("code").onkeydown = (event) => event.key === "Enter" && pair($("code").value);
$("reconnect").onclick = () => ask({action: "reconnect"});
addEventListener("hashchange", pairFromHash);

pairFromHash();
ask({action: "state"});
setInterval(() => ask({action: "state"}), 1500);
