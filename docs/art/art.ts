// Draws the README banner, the how-it-works diagram and the tweet card as SVG, in the
// extension's colours. Needs the Inter and JetBrains Mono fonts installed.
// bun docs/art/art.ts /tmp/art && bash docs/art/render.sh /tmp/art, then copy the PNGs to docs/.
import {mkdirSync, writeFileSync} from "node:fs";

type T = Record<string, string> & {dark: any};
const light = {
  dark: false, bg: "#f8fafc", card: "#ffffff", ink: "#0f172a", muted: "#64748b", faint: "#94a3b8",
  line: "#e2e8f0", line2: "#cbd5e1", chrome: "#e9eef4", skel: "#e2e8f0", zone: "#f1f5f9",
  green: "#16a34a", greenInk: "#ffffff", orange: "#ea580c", orangeSoft: "#ffedd5", blue: "#1d4ed8",
  navy: "#111827", navyLine: "#111827", shadow: "#0f172a22",
};
const dark = {
  dark: true, bg: "#0b1120", card: "#111827", ink: "#f1f5f9", muted: "#94a3b8", faint: "#64748b",
  line: "#1f2937", line2: "#334155", chrome: "#1e293b", skel: "#1f2937", zone: "#0f172a",
  green: "#22c55e", greenInk: "#052e16", orange: "#f97316", orangeSoft: "#431407", blue: "#60a5fa",
  navy: "#020617", navyLine: "#475569", shadow: "#00000088",
};

const SANS = `font-family="Inter, sans-serif"`;
const MONO = `font-family="JetBrains Mono, monospace"`;
let uid = 0;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const text = (x: number, y: number, s: string, a: string) => `<text x="${x}" y="${y}" ${a}>${esc(s)}</text>`;

// The extension's icon (extension/icons/icon.svg).
function icon(x: number, y: number, size: number, t: T) {
  return `<g transform="translate(${x} ${y}) scale(${size / 128})">
  <rect width="128" height="128" rx="28" fill="#111827" ${t.dark ? `stroke="#334155" stroke-width="4"` : ""}/>
  <rect x="18" y="22" width="92" height="84" rx="12" fill="none" stroke="#f9fafb" stroke-width="9"/>
  <path d="M18 44 V34 Q18 22 30 22 H98 Q110 22 110 34 V44 Z" fill="#f9fafb"/>
  <path d="M30 64 H98 M42 102 V88 A22 22 0 0 1 86 88 V102" fill="none" stroke="#f97316" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</g>`;
}

const shadowDef = (t: T) => `<filter id="sh" x="-20%" y="-20%" width="140%" height="150%">
  <feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="${t.shadow.slice(0, 7)}" flood-opacity="${t.dark ? 0.55 : 0.13}"/></filter>`;

// The card the extension shows on the page during a handoff (background.js).
function handoffCard(x: number, y: number, w: number, t: T, s = 1) {
  return `<g transform="translate(${x} ${y}) scale(${s})" filter="url(#sh)">
  <rect width="${w}" height="84" rx="10" fill="#111827" stroke="${t.dark ? "#475569" : "#111827"}"/>
  <rect x="0" y="0" width="5" height="84" rx="2.5" fill="${t.orange}"/>
  ${text(18, 26, "Amp needs you", `${SANS} font-size="13.5" font-weight="700" fill="#f9fafb"`)}
  ${text(18, 45, "Sign in, then click Continue.", `${SANS} font-size="12.5" fill="#cbd5e1"`)}
  <rect x="18" y="55" width="76" height="22" rx="6" fill="#22c55e"/>
  ${text(56, 70, "Continue", `${SANS} font-size="12" font-weight="600" fill="#052e16" text-anchor="middle"`)}
</g>`;
}

// Chrome with the lent tab in the green Amp group, and the extension's badge.
function browser(x: number, y: number, w: number, h: number, t: T, o: {badge?: "WAIT" | "ON" | "RUN"; handoff?: boolean; url?: string; tab?: string} = {}) {
  const id = `clip${uid++}`;
  const badge = o.badge ?? "WAIT";
  const badgeFill = badge === "WAIT" ? t.orange : badge === "RUN" ? "#1d4ed8" : "#111827";
  const px = x + 22, pw = w - 44;
  const login = o.handoff !== false;
  return `<g>
  <clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/></clipPath>
  <g clip-path="url(#${id})" filter="url(#sh)">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${t.card}"/>
    <rect x="${x}" y="${y}" width="${w}" height="40" fill="${t.chrome}"/>
    <circle cx="${x + 18}" cy="${y + 20}" r="5" fill="#ef4444"/><circle cx="${x + 34}" cy="${y + 20}" r="5" fill="#f59e0b"/><circle cx="${x + 50}" cy="${y + 20}" r="5" fill="#22c55e"/>
    <rect x="${x + 68}" y="${y + 11}" width="40" height="19" rx="9.5" fill="${t.green}"/>
    ${text(x + 88, y + 25, "Amp", `${SANS} font-size="11.5" font-weight="700" fill="${t.greenInk}" text-anchor="middle"`)}
    <path d="M${x + 114} ${y + 40} V${y + 15} Q${x + 114} ${y + 8} ${x + 121} ${y + 8} H${x + 255} Q${x + 262} ${y + 8} ${x + 262} ${y + 15} V${y + 40} Z" fill="${t.card}"/>
    <line x1="${x + 68}" y1="${y + 38.5}" x2="${x + 262}" y2="${y + 38.5}" stroke="${t.green}" stroke-width="3"/>
    <rect x="${x + 126}" y="${y + 17}" width="12" height="12" rx="3" fill="${t.ink}"/>
    ${text(x + 145, y + 27.5, o.tab ?? "Acme Billing", `${SANS} font-size="12" font-weight="500" fill="${t.ink}"`)}
    ${w >= 308 ? text(x + 274, y + 27.5, "Inbox", `${SANS} font-size="12" fill="${t.muted}"`) : ""}
    <rect x="${x}" y="${y + 40}" width="${w}" height="38" fill="${t.card}"/>
    <line x1="${x}" y1="${y + 78}" x2="${x + w}" y2="${y + 78}" stroke="${t.line}"/>
    <rect x="${x + 14}" y="${y + 48}" width="${w - 70}" height="23" rx="11.5" fill="${t.chrome}"/>
    ${text(x + 28, y + 64, o.url ?? "billing.acme.com/login", `${MONO} font-size="11.5" fill="${t.muted}"`)}
    ${icon(x + w - 44, y + 49, 21, t)}
    <rect x="${x + w - 36}" y="${y + 60}" width="${badge.length * 7 + 8}" height="14" rx="3" fill="${badgeFill}"/>
    ${text(x + w - 32, y + 71, badge, `${SANS} font-size="9.5" font-weight="700" fill="#fff"`)}
    <rect x="${px}" y="${y + 96}" width="${pw * 0.45}" height="12" rx="3" fill="${t.skel}"/>
    <rect x="${px}" y="${y + 118}" width="${pw * 0.8}" height="7" rx="3" fill="${t.skel}"/>
    <rect x="${px}" y="${y + 132}" width="${pw * 0.62}" height="7" rx="3" fill="${t.skel}"/>
    ${login ? `
    <rect x="${px}" y="${y + 156}" width="${pw * 0.5}" height="24" rx="5" fill="${t.card}" stroke="${t.line2}"/>
    ${text(px + 10, y + 172, "Email", `${SANS} font-size="11" fill="${t.faint}"`)}
    <rect x="${px}" y="${y + 188}" width="${pw * 0.5}" height="24" rx="5" fill="${t.card}" stroke="${t.line2}"/>
    ${text(px + 10, y + 204, "Password", `${SANS} font-size="11" fill="${t.faint}"`)}
    <rect x="${px}" y="${y + 220}" width="64" height="22" rx="5" fill="${t.skel}"/>
    ` : `
    <rect x="${px}" y="${y + 156}" width="${pw * 0.72}" height="7" rx="3" fill="${t.skel}"/>
    <rect x="${px}" y="${y + 170}" width="${pw * 0.55}" height="7" rx="3" fill="${t.skel}"/>`}
  </g>
  <rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="${t.line2}"/>
</g>`;
}

// An Amp thread running in an orb, calling the browser tools.
function thread(x: number, y: number, w: number, t: T, s = 1) {
  const row = (yy: number, mark: string, name: string, note: string, c: string) => `
    ${text(16, yy, mark, `${MONO} font-size="12" fill="${c}"`)}
    ${text(32, yy, name, `${MONO} font-size="12" fill="${t.ink}"`)}
    ${note ? text(w - 14, yy, note, `${SANS} font-size="11.5" font-weight="600" fill="${c}" text-anchor="end"`) : ""}`;
  return `<g transform="translate(${x} ${y}) scale(${s})" filter="url(#sh)">
  <rect x="0.5" y="0.5" width="${w - 1}" height="171" rx="12" fill="${t.card}" stroke="${t.line2}"/>
  ${cloud(16, 15, 0.62, t.muted)}
  ${text(48, 27, "Amp thread", `${SANS} font-size="13" font-weight="700" fill="${t.ink}"`)}
  ${text(w - 14, 27, "in an orb", `${SANS} font-size="11.5" fill="${t.muted}" text-anchor="end"`)}
  <line x1="0" y1="42" x2="${w}" y2="42" stroke="${t.line}"/>
  <rect x="14" y="54" width="${w - 28}" height="30" rx="8" fill="${t.zone}"/>
  ${text(26, 73.5, "Export last month's invoices", `${SANS} font-size="12.5" fill="${t.ink}"`)}
  ${row(108, "✓", "browser_snapshot", "", t.green)}
  ${row(130, "✓", "browser_click e12", "", t.green)}
  ${row(152, "●", "browser_handoff", "waiting for you", t.orange)}
</g>`;
}

function cloud(x: number, y: number, s: number, c: string) {
  return `<path transform="translate(${x} ${y}) scale(${s})" d="M10 26 H32 A8 8 0 0 0 31 10 A11 11 0 0 0 10 12 A7 7 0 0 0 10 26 Z" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round"/>`;
}

function lock(x: number, y: number, c: string) {
  return `<g transform="translate(${x} ${y})"><rect x="0" y="6" width="12" height="10" rx="2" fill="${c}"/><path d="M3 6 V4 A3 3 0 0 1 9 4 V6" fill="none" stroke="${c}" stroke-width="2"/></g>`;
}

function pill(x: number, y: number, label: string, t: T, opts: {mono?: boolean; icon?: string; w?: number} = {}) {
  const w = opts.w ?? label.length * (opts.mono ? 7.3 : 7) + (opts.icon ? 40 : 26);
  return `<g>
  <rect x="${x - w / 2}" y="${y - 14}" width="${w}" height="28" rx="14" fill="${t.card}" stroke="${t.line2}"/>
  ${opts.icon ?? ""}
  ${text(x + (opts.icon ? 9 : 0), y + 4.5, label, `${opts.mono ? MONO : SANS} font-size="12" font-weight="${opts.mono ? 400 : 600}" fill="${t.ink}" text-anchor="middle"`)}
</g>`;
}

function svg(w: number, h: number, t: T, body: string, frame = true) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>${shadowDef(t)}
<pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="${t.dark ? "#1e293b" : "#e2e8f0"}"/></pattern></defs>
${frame ? `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="18" fill="${t.bg}" stroke="${t.line2}" stroke-width="1.5"/>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="18" fill="url(#dots)"/>` : ""}
${body}
</svg>`;
}

// ---------- Banner: 1000x320 ----------
function banner(t: T) {
  const W = 1000, H = 320;
  return svg(W, H, t, `
  ${icon(56, 84, 52, t)}
  ${text(56, 190, "Amp Browser Bridge", `${SANS} font-size="40" font-weight="800" letter-spacing="-1" fill="${t.ink}"`)}
  ${text(56, 228, "Lend one Chrome tab to your Amp threads.", `${SANS} font-size="19" fill="${t.muted}"`)}
  ${browser(612, 33, 340, 254, t)}
  ${handoffCard(740, 179, 196, t)}
  `);
}

// ---------- How it works: 1000x480 ----------
function how(t: T) {
  const W = 1000, H = 500;
  const arrow = (d: string, c: string, dash = "") => `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.2" ${dash ? `stroke-dasharray="${dash}"` : ""} marker-end="url(#ah-${c.slice(1)})"/>`;
  const marker = (c: string) => `<marker id="ah-${c.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${c}"/></marker>`;
  const step = (x: number, y: number, n: string, title: string, lines: string[], c = t.ink) => `
    <circle cx="${x + 11}" cy="${y - 5}" r="11" fill="${c === t.ink ? (t.dark ? "#334155" : "#111827") : c}"/>
    ${text(x + 11, y - 0.5, n, `${SANS} font-size="12" font-weight="700" fill="#fff" text-anchor="middle"`)}
    ${text(x + 30, y, title, `${SANS} font-size="14" font-weight="700" fill="${t.ink}"`)}
    ${lines.map((l, i) => text(x + 30, y + 21 + i * 19, l, `${SANS} font-size="13" fill="${t.muted}"`)).join("")}`;
  return svg(W, H, t, `
  <defs>${marker(t.ink)}${marker(t.orange)}${marker(t.muted)}</defs>
  ${text(40, 44, "HOW IT WORKS", `${MONO} font-size="12" letter-spacing="2" fill="${t.muted}"`)}
  <!-- cloud zone -->
  <rect x="30" y="64" width="286" height="282" rx="16" fill="${t.zone}" stroke="${t.line2}" stroke-dasharray="5 5"/>
  ${cloud(46, 76, 0.62, t.muted)}
  ${text(80, 89, "In the cloud", `${SANS} font-size="13" font-weight="600" fill="${t.muted}"`)}
  ${thread(48, 112, 250, t)}
  <!-- portal -->
  <g>
    <rect x="356" y="168" width="136" height="64" rx="12" fill="${t.card}" stroke="${t.line2}" filter="url(#sh)"/>
    ${lock(372, 180, t.ink)}
    ${text(392, 196, "Amp portal", `${SANS} font-size="13.5" font-weight="700" fill="${t.ink}"`)}
    ${text(372, 218, "Amp sign-in", `${SANS} font-size="12" fill="${t.muted}"`)}
  </g>
  ${arrow("M 298 200 H 352", t.ink)}
  ${text(325, 190, "https", `${MONO} font-size="11" fill="${t.muted}" text-anchor="middle"`)}
  <!-- mac zone -->
  <rect x="532" y="64" width="438" height="282" rx="16" fill="${t.zone}" stroke="${t.line2}" stroke-dasharray="5 5"/>
  <path transform="translate(548 76)" d="M2 3 H20 V15 H2 Z M-1 17 H23" fill="none" stroke="${t.muted}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${text(578, 89, "On your Mac", `${SANS} font-size="13" font-weight="600" fill="${t.muted}"`)}
  ${arrow("M 492 200 H 548", t.ink)}
  <g>
    <rect x="552" y="160" width="128" height="80" rx="12" fill="${t.card}" stroke="${t.line2}" filter="url(#sh)"/>
    ${text(566, 184, "Bridge", `${SANS} font-size="13.5" font-weight="700" fill="${t.ink}"`)}
    ${text(566, 204, "Amp plugin", `${SANS} font-size="12" fill="${t.muted}"`)}
    ${text(566, 226, "127.0.0.1:19989", `${MONO} font-size="11" fill="${t.ink}"`)}
  </g>
  ${arrow("M 680 200 H 702", t.ink)}
  ${browser(706, 106, 252, 226, t, {url: "billing.acme.com", tab: "Acme Billing", handoff: false})}
  ${handoffCard(748, 238, 196, t, 0.92)}
  ${text(691, 190, "ws", `${MONO} font-size="11" fill="${t.muted}" text-anchor="middle"`)}
  <!-- steps -->
  <line x1="30" y1="372" x2="970" y2="372" stroke="${t.line2}"/>
  ${step(30, 404, "1", "A thread calls a tool", ["browser_snapshot, browser_click…", "from an orb or your Mac"])}
  ${step(270, 404, "2", "Two checks let it in", ["your Amp sign-in at the portal,", "a signed request at the bridge"])}
  ${step(510, 404, "3", "The extension acts", ["on a tab you lent or Amp opened;", "clicks and typing need your OK"])}
  ${step(750, 404, "4", "Logins come back to you", ["the agent can't see the tab", "while it waits for you"], t.orange)}
  `);
}

// The path a tool call takes, as a row of pills.
function flow(cx: number, y: number, t: T) {
  const items = [
    {label: "thread in an orb", w: 178, icon: (x: number) => cloud(x + 14, y - 10, 0.55, t.muted)},
    {label: "Amp portal", w: 130, icon: (x: number) => lock(x + 18, y - 9, t.ink)},
    {label: "bridge on 127.0.0.1", w: 166, icon: (x: number) => ""},
    {label: "your Chrome tab", w: 168, icon: (x: number) => `<rect x="${x + 16}" y="${y - 7}" width="20" height="14" rx="7" fill="${t.green}"/>`},
  ];
  const gap = 24, total = items.reduce((a, i) => a + i.w, 0) + gap * (items.length - 1);
  let x = cx - total / 2, out = "";
  items.forEach((it, i) => {
    const hasIcon = it.icon(0) !== "";
    out += `<rect x="${x}" y="${y - 20}" width="${it.w}" height="40" rx="20" fill="${t.card}" stroke="${t.line2}"/>
    ${it.icon(x)}
    ${text(hasIcon ? x + 44 : x + it.w / 2, y + 5.5, it.label, `${SANS} font-size="14" font-weight="600" fill="${t.ink}" ${hasIcon ? "" : `text-anchor="middle"`}`)}`;
    if (i < items.length - 1) out += `<path d="M ${x + it.w + 5} ${y} H ${x + it.w + gap - 5}" stroke="${t.muted}" stroke-width="2" marker-end="url(#ahf)"/>`;
    x += it.w + gap;
  });
  return `<defs><marker id="ahf" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="${t.muted}"/></marker></defs>` + out;
}

// ---------- Tweet card: 800x450 (rendered at 2x = 1600x900) ----------
function tweet(t: T) {
  const W = 800, H = 450;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>${shadowDef(t)}
<pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="${t.dark ? "#1e293b" : "#e2e8f0"}"/></pattern>
<radialGradient id="glow" cx="78%" cy="62%" r="55%"><stop offset="0" stop-color="${t.green}" stop-opacity="0.16"/><stop offset="1" stop-color="${t.green}" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="${t.bg}"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
${icon(48, 46, 52, t)}
${text(112, 82, "Amp Browser Bridge", `${SANS} font-size="28" font-weight="800" letter-spacing="-0.5" fill="${t.ink}"`)}
${text(48, 150, "Lend one Chrome tab", `${SANS} font-size="36" font-weight="800" letter-spacing="-1" fill="${t.ink}"`)}
${text(48, 193, "to your Amp threads.", `${SANS} font-size="36" font-weight="800" letter-spacing="-1" fill="${t.ink}"`)}
${text(48, 238, "Even ones running in the cloud.", `${SANS} font-size="20" fill="${t.muted}"`)}
${text(48, 267, "It asks before it clicks, and", `${SANS} font-size="20" fill="${t.muted}"`)}
${text(48, 296, "hands logins back to you.", `${SANS} font-size="20" fill="${t.muted}"`)}
${browser(482, 48, 300, 262, t)}
${thread(412, 180, 240, t, 0.74)}
${handoffCard(588, 246, 192, t)}
${flow(400, 380, t)}
</svg>`;
}

const out = process.argv[2] ?? ".";
mkdirSync(out, {recursive: true});
for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  writeFileSync(`${out}/banner-${name}.svg`, banner(t as T));
  writeFileSync(`${out}/how-${name}.svg`, how(t as T));
}
writeFileSync(`${out}/tweet-card.svg`, tweet(dark as T));
