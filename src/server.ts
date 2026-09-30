// evidence-locker — live server (the WRITE side).
// Token-gated single-file Bun server: chronological timeline, evidence browser,
// corrections board (the corrections API is the write path; reads are served
// statically by `bun src/build.ts` output).
//
// Usage: bun src/server.ts [root] [--host 127.0.0.1] [--port 25137] [--title "..."]
// Token: LOCKER_TOKEN env, or <root>/.token file.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  storePaths, parseTimeline, parseCorrections, listEvidence, renderEvidence,
  todayDenver, nextCorrId, type Correction,
} from "./parse.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string" }, port: { type: "string" }, title: { type: "string" },
  },
  allowPositionals: true,
});
const ROOT = resolve(positionals[0] ?? process.env.LOCKER_ROOT ?? ".");
const HOST = values.host ?? process.env.LOCKER_HOST ?? "127.0.0.1";
const PORT = parseInt(values.port ?? process.env.LOCKER_PORT ?? "", 10) || 25137;
const TITLE = values.title ?? process.env.LOCKER_TITLE ?? "Evidence locker";
const WEBROOT = join(ROOT, "web");
const TOKEN_PATH = join(ROOT, ".token");
const CORRECTIONS_PATH = join(ROOT, "CORRECTIONS.md");
const TOKEN = process.env.LOCKER_TOKEN
  ?? (existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, "utf8").trim() : "");
if (!TOKEN) { console.error("[evidence-locker] set LOCKER_TOKEN or <root>/.token"); process.exit(1); }
const P = storePaths(ROOT);
// ---------- auth ----------
function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// returns "query" (authed via ?token=, needs cookie set), "cookie", or null
function checkAuth(req: Request, url: URL): "query" | "cookie" | null {
  if (url.searchParams.get("token") === TOKEN) return "query";
  const c = parseCookies(req.headers.get("cookie") || "");
  if (c.bt === TOKEN) return "cookie";
  return null;
}
const SET_COOKIE = `bt=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;

// ---------- corrections (CORRECTIONS.md is the source of truth) ----------

let corrWrite = Promise.resolve();
function writeCorrections(pre: string[], rows: Correction[], post: string[]): Promise<void> {
  corrWrite = corrWrite.then(() => {
    const cell = (s: string) => s.replace(/\|/g, "\u2502").replace(/\r?\n/g, "<br>");
    const out = [...pre];
    for (const r of rows)
      out.push(`| ${r.id} | ${r.dateLogged} | ${cell(r.claim)} | ${cell(r.correction)} | ${cell(r.source)} | ${r.status} |`);
    out.push(...post);
    writeFileSync(CORRECTIONS_PATH, out.join("\n"));
  });
  return corrWrite;
}



// ---------- responses ----------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function log(method: string, path: string, status: number) {
  // never log query strings (token lives there) or bodies
  console.log(`[evidence-locker] ${method} ${path} ${status}`);
}
const DENIED = () => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE} — private</title>
   <style>body{font-family:Georgia,serif;background:#f7f4ec;color:#1d1a14;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
   .c{text-align:center;max-width:420px;padding:2rem}.k{font-size:2.5rem}</style></head>
   <body><div class="c"><div class="k">\u{1F512}</div><h1>Private locker</h1>
   <p>This evidence locker is private. Open it with your magic link (<code>?token=\u2026</code>).</p></div></body></html>`,
  { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
);

// ---------- page ----------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<style>
:root{
  --paper:#f7f4ec; --card:#fffdf8; --ink:#1d1a14; --muted:#6f675a;
  --line:#e3dccb; --accent:#1f4e5f; --accent-soft:#e4eef1;
  --ev:#2f6b3a; --ev-soft:#e3efe4; --al:#b45309; --al-soft:#fbeed7;
  --serif:Georgia,'Times New Roman',serif; --sans:-apple-system,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55}
header.top{position:sticky;top:0;z-index:20;background:rgba(247,244,236,.96);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
.top-inner{max-width:1080px;margin:0 auto;padding:.7rem 1.2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.brand{font-family:var(--serif);font-size:1.5rem;font-weight:700;letter-spacing:.02em}
.brand small{display:block;font-family:var(--sans);font-weight:400;font-size:.72rem;color:var(--muted);letter-spacing:.14em;text-transform:uppercase}
nav.tabs{display:flex;gap:.25rem;margin-left:auto}
nav.tabs button{border:1px solid transparent;background:none;padding:.5rem .95rem;border-radius:8px;font:inherit;cursor:pointer;color:var(--muted)}
nav.tabs button.active{background:var(--ink);color:var(--paper);font-weight:600}
.privacy{font-size:.7rem;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:.2rem .7rem;white-space:nowrap}
main{max-width:1080px;margin:0 auto;padding:1.4rem 1.2rem 4rem}
.view{display:none}.view.active{display:block}
/* filters */
.filters{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.9rem 1rem;margin-bottom:1.2rem;display:flex;gap:.7rem;flex-wrap:wrap;align-items:center}
.filters input[type=search],.filters input[type=date],.filters select{font:inherit;padding:.45rem .7rem;border:1px solid var(--line);border-radius:8px;background:#fff}
.filters input[type=search]{flex:1;min-width:200px}
.pills{display:flex;gap:.35rem}
.pill{border:1px solid var(--line);background:#fff;border-radius:20px;padding:.35rem .8rem;font-size:.82rem;cursor:pointer;color:var(--muted)}
.pill.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.count{font-size:.82rem;color:var(--muted);margin-left:auto}
/* timeline */
.era{margin:0 0 2.2rem}
.era>h2{font-family:var(--serif);font-size:1.35rem;margin:0 0 .9rem;padding-bottom:.45rem;border-bottom:2px solid var(--ink)}
.event{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--accent);border-radius:10px;padding:1rem 1.2rem;margin-bottom:.9rem;box-shadow:0 1px 2px rgba(29,26,20,.05)}
.event.allegation{border-left-color:var(--al);background:linear-gradient(0deg,var(--al-soft),var(--al-soft)) ,var(--card);background-blend-mode:multiply}
.event.note{border-left-style:dashed;opacity:.92}
.event-head{display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap;margin-bottom:.35rem}
.date{font-family:var(--serif);font-weight:700;font-size:1.02rem}
.badge{font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-radius:5px;padding:.18rem .55rem;white-space:nowrap}
.badge.evidence{background:var(--ev-soft);color:var(--ev);border:1px solid var(--ev)}
.badge.allegation{background:var(--al-soft);color:var(--al);border:1px dashed var(--al)}
.badge.note{background:#eee;color:var(--muted);border:1px solid var(--line)}
.badge.src{background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent)}
.event h3{font-family:var(--serif);margin:.1rem 0 .4rem;font-size:1.12rem}
.event .body{color:#33302a}
.event .body p{margin:.4em 0}.event .body ul{margin:.4em 0;padding-left:1.3em}
.event code{font-family:var(--mono);font-size:.82em;background:#f0ebdd;border-radius:4px;padding:.1em .35em}
.cites{margin-top:.6rem;font-size:.8rem;color:var(--muted)}
.cites code{margin-right:.35rem}
.files{margin-top:.5rem;display:flex;gap:.4rem;flex-wrap:wrap}
.file-chip{font-size:.8rem;border:1px solid var(--accent);color:var(--accent);background:#fff;border-radius:7px;padding:.25rem .65rem;cursor:pointer}
.file-chip.missing{border-style:dashed;color:var(--muted);border-color:var(--muted);cursor:default}
.allegation-note{margin-top:.6rem;font-size:.78rem;color:var(--al);font-style:italic}
/* evidence */
.ev-layout{display:grid;grid-template-columns:280px 1fr;gap:1rem}
@media(max-width:800px){.ev-layout{grid-template-columns:1fr}}
.ev-list{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.6rem;align-self:start}
.ev-item{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;font:inherit;padding:.55rem .7rem;border-radius:8px;cursor:pointer}
.ev-item:hover{background:var(--accent-soft)}
.ev-item.active{background:var(--ink);color:var(--paper)}
.ev-item .meta{display:block;font-size:.72rem;color:var(--muted)}
.ev-item.active .meta{color:#c9c2b2}
.ev-view{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.2rem 1.4rem;min-height:300px}
.ev-view h1,.ev-view h2,.ev-view h3{font-family:var(--serif)}
.ev-view pre.raw{font-family:var(--mono);font-size:.82rem;background:#f4f0e4;border:1px solid var(--line);border-radius:8px;padding:1rem;overflow-x:auto;white-space:pre-wrap}
.ev-view blockquote{border-left:3px solid var(--line);margin:.6em 0;padding:.2em 0 .2em 1em;color:#4a4438;font-style:italic}
/* corrections */
.corr-intro{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.2rem;margin-bottom:1rem}
table.corr{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:.88rem}
table.corr th{background:var(--ink);color:var(--paper);text-align:left;padding:.6rem .7rem;font-weight:600}
table.corr td{padding:.6rem .7rem;border-top:1px solid var(--line);vertical-align:top}
.status{font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:5px;padding:.2rem .6rem}
.status.pending{background:#f0ebdd;color:#7a6a3a;border:1px solid #c9bd9a}
.status.accepted{background:var(--ev-soft);color:var(--ev);border:1px solid var(--ev)}
.status.rejected{background:#f7e2e2;color:#8f2d2d;border:1px solid #8f2d2d}
select.status-sel{font:inherit;font-size:.8rem;padding:.25rem .5rem;border-radius:6px;border:1px solid var(--line)}
.add-form{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.2rem;margin-top:1.2rem}
.add-form h3{font-family:var(--serif);margin-top:0}
.add-form label{display:block;font-size:.82rem;color:var(--muted);margin:.7rem 0 .25rem}
.add-form input,.add-form textarea{width:100%;font:inherit;padding:.5rem .7rem;border:1px solid var(--line);border-radius:8px;background:#fff}
.add-form textarea{min-height:70px;resize:vertical}
.btn{font:inherit;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:.55rem 1.3rem;cursor:pointer;font-weight:600;margin-top:.9rem}
.btn:hover{filter:brightness(1.1)}
.empty{color:var(--muted);font-style:italic;padding:2rem;text-align:center}
footer{max-width:1080px;margin:0 auto;padding:0 1.2rem 2rem;color:var(--muted);font-size:.75rem}
</style>
</head>
<body>
<header class="top"><div class="top-inner">
  <div class="brand">${TITLE}</div>
  <nav class="tabs">
    <button data-view="timeline" class="active">Timeline</button>
    <button data-view="evidence">Evidence</button>
    <button data-view="corrections">Corrections</button>
  </nav>
  <span class="privacy">\u{1F512} private \u00b7 local only \u00b7 tailnet</span>
</div></header>
<main>
  <section id="view-timeline" class="view active">
    <div class="filters">
      <input type="search" id="q" placeholder="Search everything \u2014 names, places, phrases\u2026">
      <div class="pills" id="typepills">
        <button class="pill on" data-t="all">All</button>
        <button class="pill" data-t="email">Email</button>
        <button class="pill" data-t="sms">SMS</button>
        <button class="pill" data-t="allegation">Allegations</button>
      </div>
      <input type="date" id="dfrom" title="From date">
      <input type="date" id="dto" title="To date">
      <span class="count" id="count"></span>
    </div>
    <div id="timeline"></div>
  </section>
  <section id="view-evidence" class="view">
    <div class="ev-layout">
      <div class="ev-list" id="evlist"></div>
      <div class="ev-view" id="evview"><div class="empty">Select a file to read it here.</div></div>
    </div>
  </section>
  <section id="view-corrections" class="view">
    <div class="corr-intro">
      <strong>Correction log.</strong> Corrections land here first \u2014 corrections land here first, then get applied to the timeline.
      A correction that contradicts [evidence] stays on record alongside it: the owner's word wins the narrative, the evidence keeps its citation.
      Rows are never deleted.
    </div>
    <div id="corrtable"></div>
    <div class="add-form">
      <h3>Log a correction</h3>
      <label>Claim as written (timeline)</label><input id="nc-claim" placeholder="What the timeline currently says">
      <label>Correction (verbatim)</label><textarea id="nc-corr" placeholder="The corrected account, verbatim"></textarea>
      <label>Source / evidence</label><input id="nc-src" placeholder="email / SMS / doc reference">
      <button class="btn" id="nc-add">Add correction row</button>
    </div>
  </section>
</main>
<footer>${TITLE} \u00b7 built with evidence-locker</footer>
`;
const CLIENT = `
const S = { events: [], eras: [], files: [], corrs: [], f: { q: "", type: "all", from: "", to: "" }, evSel: null };
const MONTHS_S = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(iso) {
  if (!iso) return "";
  const m = iso.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  if (!m) return iso;
  const d = new Date(+m[1], +m[2]-1, +m[3]);
  return MONTHS_S[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
}
function fmtRange(ev) {
  if (!ev.dateStart) return ev.dateRaw || "Undated";
  if (ev.dateEnd && ev.dateEnd !== ev.dateStart) {
    const a = ev.dateStart, b = ev.dateEnd;
    if (a.slice(0,7) === b.slice(0,7)) return fmtDate(a) + " \\u2192 " + fmtDate(b).replace(/^\\w+ /, "");
    return fmtDate(a) + " \\u2192 " + fmtDate(b);
  }
  return fmtDate(ev.dateStart) + (ev.dateRaw.match(/\\(.*\\)/) ? " " + ev.dateRaw.match(/\\(.*\\)/)[0] : "");
}
function renderBody(ev) {
  // body is plain markdown-ish from TIMELINE.md
  const t = ev.body.replace(/\\n{3,}/g, "\\n\\n");
  return t.split(/\\n\\n+/).map(function(p){
    p = p.trim();
    if (/^>/.test(p)) return "<blockquote>" + escHtml(p.replace(/^>\\s?/gm,"")) + "</blockquote>";
    return "<p>" + inline(p) + "</p>";
  }).join("");
}
function escHtml(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function inline(s){
  let h = escHtml(s);
  h = h.replace(/\\u0060([^\\u0060]+)\\u0060/g, "<code>$1</code>");
  h = h.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  h = h.replace(/\\*([^\\*\\n]+)\\*/g, "<em>$1</em>");
  h = h.replace(/\\n/g, "<br>");
  return h;
}
function typeLabel(t){ return t === "email" ? "email" : t === "sms" ? "sms" : t === "allegation" ? "allegation" : "record"; }
function matches(ev) {
  const f = S.f;
  if (f.type !== "all") {
    if (f.type === "allegation") { if (ev.label !== "allegation") return false; }
    else if (ev.sourceType !== f.type) return false;
  }
  if (f.from && (!ev.dateStart || ev.dateStart < f.from)) return false;
  if (f.to && (!ev.dateStart || ev.dateStart > f.to)) return false;
  if (f.q) {
    const hay = (ev.title + " " + ev.body + " " + ev.era + " " + ev.citations.join(" ")).toLowerCase();
    if (!f.q.toLowerCase().split(/\\s+/).every(function(w){ return hay.indexOf(w) >= 0; })) return false;
  }
  return true;
}
function renderTimeline() {
  const box = document.getElementById("timeline");
  const evs = S.events.filter(matches);
  document.getElementById("count").textContent = evs.length + " of " + S.events.length + " events";
  if (!evs.length) { box.innerHTML = '<div class="empty">No events match these filters.</div>'; return; }
  const byEra = {};
  evs.forEach(function(e){ (byEra[e.era] = byEra[e.era] || []).push(e); });
  box.innerHTML = S.eras.filter(function(er){ return byEra[er.title]; }).map(function(er){
    const cards = byEra[er.title].map(function(ev){
      const cls = ev.label === "allegation" ? "event allegation" : ev.label === "note" ? "event note" : "event";
      const files = ev.files.map(function(fl){
        return fl.exists
          ? '<button class="file-chip" data-file="' + escHtml(fl.name) + '">\\u{1F4C4} ' + escHtml(fl.name) + "</button>"
          : '<span class="file-chip missing" title="referenced in timeline but not yet captured">' + escHtml(fl.name) + " (pending)</span>";
      }).join("");
      const cites = ev.citations.length ? '<div class="cites">Cited: ' + ev.citations.map(function(c){ return "<code>" + escHtml(c.length > 42 ? c.slice(0,42) + "\\u2026" : c) + "</code>"; }).join("") + "</div>" : "";
      const alNote = ev.label === "allegation" ? '<div class="allegation-note">\\u26a0\\ufe0f Allegation \\u2014 claimed in Drive docs, not confirmed by email/SMS. Not presented as fact.</div>' : "";
      return '<article class="' + cls + '"><div class="event-head">' +
        '<span class="date">' + escHtml(fmtRange(ev)) + "</span>" +
        '<span class="badge ' + ev.label + '">' + ev.label + "</span>" +
        '<span class="badge src">' + typeLabel(ev.sourceType) + "</span></div>" +
        (ev.title ? "<h3>" + escHtml(ev.title) + "</h3>" : "") +
        '<div class="body">' + renderBody(ev) + "</div>" + cites +
        (files ? '<div class="files">' + files + "</div>" : "") + alNote + "</article>";
    }).join("");
    return '<div class="era"><h2>' + escHtml(er.title) + "</h2>" + cards + "</div>";
  }).join("");
  box.querySelectorAll(".file-chip[data-file]").forEach(function(b){
    b.addEventListener("click", function(){ openEvidence(b.getAttribute("data-file")); });
  });
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { document.body.innerHTML = "<p style='padding:3rem;font-family:Georgia'>Session expired \\u2014 reopen your magic link.</p>"; throw new Error("unauthorized"); }
  return r.json();
}
function openEvidence(name) {
  document.querySelectorAll("nav.tabs button").forEach(function(b){ b.classList.toggle("active", b.dataset.view === "evidence"); });
  document.querySelectorAll(".view").forEach(function(v){ v.classList.toggle("active", v.id === "view-evidence"); });
  S.evSel = name;
  document.querySelectorAll(".ev-item").forEach(function(b){ b.classList.toggle("active", b.dataset.file === name); });
  const v = document.getElementById("evview");
  v.innerHTML = '<div class="empty">Loading\\u2026</div>';
  api("/api/evidence/" + encodeURIComponent(name)).then(function(d){
    v.innerHTML = "<h2 style='margin-top:0'>" + escHtml(d.name) + "</h2>" + d.html;
  });
}
function renderEvidenceList() {
  const l = document.getElementById("evlist");
  l.innerHTML = S.files.map(function(f){
    return '<button class="ev-item" data-file="' + escHtml(f.name) + '">' + escHtml(f.name) +
      '<span class="meta">' + (f.size/1024).toFixed(1) + " KB \\u00b7 " + f.kind + "</span></button>";
  }).join("");
  l.querySelectorAll(".ev-item").forEach(function(b){
    b.addEventListener("click", function(){ openEvidence(b.dataset.file); });
  });
}
function renderCorrections() {
  const box = document.getElementById("corrtable");
  const rows = S.corrs.map(function(r){
    const st = (r.status || "pending").toLowerCase();
    return "<tr><td><strong>" + escHtml(r.id) + "</strong></td><td>" + escHtml(r.dateLogged) + "</td>" +
      "<td>" + escHtml(r.claim || "\\u2014") + "</td><td>" + escHtml(r.correction || "\\u2014") + "</td>" +
      "<td>" + escHtml(r.source || "\\u2014") + "</td>" +
      '<td><span class="status ' + st + '">' + escHtml(r.status || "pending") + "</span><br>" +
      '<select class="status-sel" data-id="' + escHtml(r.id) + '">' +
      ["pending","accepted","rejected"].map(function(o){ return '<option value="' + o + '"' + (o === st ? " selected" : "") + ">" + o + "</option>"; }).join("") +
      "</select></td></tr>";
  }).join("");
  box.innerHTML = '<table class="corr"><thead><tr><th>#</th><th>Logged</th><th>Claim as written</th><th>Correction</th><th>Source</th><th>Status</th></tr></thead><tbody>' + rows + "</tbody></table>";
  box.querySelectorAll(".status-sel").forEach(function(sel){
    sel.addEventListener("change", function(){
      api("/api/corrections/" + encodeURIComponent(sel.dataset.id), {
        method: "PATCH", headers: {"content-type":"application/json"},
        body: JSON.stringify({ status: sel.value })
      }).then(function(d){ S.corrs = d.rows; renderCorrections(); });
    });
  });
}
async function boot() {
  const t = await api("/api/timeline");
  S.eras = t.eras; S.events = t.events;
  S.files = await api("/api/evidence");
  const c = await api("/api/corrections");
  S.corrs = c.rows;
  renderTimeline(); renderEvidenceList(); renderCorrections();
  document.querySelectorAll("nav.tabs button").forEach(function(b){
    b.addEventListener("click", function(){
      document.querySelectorAll("nav.tabs button").forEach(function(x){ x.classList.toggle("active", x === b); });
      document.querySelectorAll(".view").forEach(function(v){ v.classList.toggle("active", v.id === "view-" + b.dataset.view); });
    });
  });
  document.getElementById("q").addEventListener("input", function(e){ S.f.q = e.target.value; renderTimeline(); });
  document.getElementById("dfrom").addEventListener("change", function(e){ S.f.from = e.target.value; renderTimeline(); });
  document.getElementById("dto").addEventListener("change", function(e){ S.f.to = e.target.value; renderTimeline(); });
  document.querySelectorAll("#typepills .pill").forEach(function(p){
    p.addEventListener("click", function(){
      document.querySelectorAll("#typepills .pill").forEach(function(x){ x.classList.remove("on"); });
      p.classList.add("on"); S.f.type = p.dataset.t; renderTimeline();
    });
  });
  document.getElementById("nc-add").addEventListener("click", async function(){
    const claim = document.getElementById("nc-claim").value.trim();
    const correction = document.getElementById("nc-corr").value.trim();
    const source = document.getElementById("nc-src").value.trim();
    if (!correction) { alert("The correction text is required \\u2014 keep the wording verbatim."); return; }
    const d = await api("/api/corrections", { method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({ claim: claim, correction: correction, source: source }) });
    S.corrs = d.rows;
    document.getElementById("nc-claim").value = ""; document.getElementById("nc-corr").value = ""; document.getElementById("nc-src").value = "";
    renderCorrections();
  });
}
boot();
`;

// ---------- router ----------
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const auth = checkAuth(req, url);
  if (!auth) { log(req.method, path, 401); return DENIED(); }
  if (auth === "query") {
    const clean = new URL(url); clean.searchParams.delete("token");
    const r = new Response(null, { status: 302, headers: { location: clean.pathname + clean.search, "set-cookie": SET_COOKIE } });
    log(req.method, path, 302); return r;
  }
  const cookieHdr = auth === "cookie" ? { "set-cookie": SET_COOKIE } : {};
  try {
    if (path === "/" || path === "/index.html") {
      log(req.method, path, 200);
      return new Response(PAGE + "<script>" + CLIENT + "</script></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...cookieHdr } });
    }
    if (path === "/api/timeline" && req.method === "GET") { log(req.method, path, 200); return json(parseTimeline(P)); }
    if (path === "/api/evidence" && req.method === "GET") { log(req.method, path, 200); return json(listEvidence(P)); }
    const evm = path.match(/^\/api\/evidence\/(.+)$/);
    if (evm && req.method === "GET") {
      const r = renderEvidence(P, decodeURIComponent(evm[1]!));
      log(req.method, "/api/evidence/:name", r ? 200 : 404);
      return r ? json({ name: basename(decodeURIComponent(evm[1]!)), ...r }) : json({ error: "not found" }, 404);
    }
    if (path === "/api/corrections" && req.method === "GET") { log(req.method, path, 200); return json(parseCorrections(P)); }
    if (path === "/api/corrections" && req.method === "POST") {
      const b = await req.json().catch(() => ({})) as { claim?: string; correction?: string; source?: string };
      if (!b.correction || !String(b.correction).trim()) { log(req.method, path, 400); return json({ error: "correction text required" }, 400); }
      const { pre, rows, post } = parseCorrections(P);
      rows.push({ id: nextCorrId(rows), dateLogged: todayDenver(), claim: String(b.claim || ""), correction: String(b.correction), source: String(b.source || ""), status: "pending" });
      await writeCorrections(pre, rows, post);
      log(req.method, path, 201); return json({ rows }, 201);
    }
    const cm = path.match(/^\/api\/corrections\/([A-Za-z0-9-]+)$/);
    if (cm && req.method === "PATCH") {
      const b = await req.json().catch(() => ({})) as Partial<Correction>;
      const { pre, rows, post } = parseCorrections(P);
      const row = rows.find((r) => r.id === cm[1]);
      if (!row) { log(req.method, path, 404); return json({ error: "not found" }, 404); }
      if (b.status && ["pending", "accepted", "rejected"].includes(b.status)) row.status = b.status;
      if (typeof b.claim === "string") row.claim = b.claim;
      if (typeof b.correction === "string") row.correction = b.correction;
      if (typeof b.source === "string") row.source = b.source;
      await writeCorrections(pre, rows, post);
      log(req.method, path, 200); return json({ rows });
    }
    log(req.method, path, 404);
    return json({ error: "not found" }, 404);
  } catch (e) {
    log(req.method, path, 500);
    return json({ error: "internal error" }, 500);
  }
}

Bun.serve({ hostname: HOST, port: PORT, fetch: handle });
console.log(`[evidence-locker] ${TITLE} listening on http://${HOST}:${PORT} (token-gated)`);
