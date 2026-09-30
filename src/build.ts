#!/usr/bin/env bun
// evidence-locker — static snapshot generator.
// Reads TIMELINE.md + CORRECTIONS.md + evidence/ live at generation time and emits
// ONE self-contained HTML file: inline CSS, zero network fetches, tiny
// progressive-enhancement JS (tabs / search / evidence filter). With JS disabled
// every section renders with `active`, so the file reads fully as a document.
//
// Usage:
//   bun src/build.ts [root] [--out path] [--title "..."] [--live-url https://...]
//   root defaults to "."; out defaults to <root>/locker.html
//
// Regenerate on every commit (see README) so the read path never goes stale.
import { parseArgs } from "node:util";
import { join, resolve, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  storePaths, parseTimeline, parseCorrections, listEvidence, renderEvidence,
  mdBlock, esc, type EvidenceMeta,
} from "./parse.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string" },
    title: { type: "string" },
    "live-url": { type: "string" },
  },
  allowPositionals: true,
});

const ROOT = resolve(positionals[0] ?? ".");
const OUT = values.out ? resolve(values.out) : join(ROOT, "locker.html");
const TITLE = values.title ?? "Evidence locker";
const LIVE_URL = values["live-url"] ?? "";
const TPL = join(dirname(new URL(import.meta.url).pathname), "..", "template");
const P = storePaths(ROOT);

const css = readFileSync(join(TPL, "style.css"), "utf8");
const clientJs = readFileSync(join(TPL, "client.js"), "utf8");

const { events } = parseTimeline(P);
const { rows } = parseCorrections(P);
const files: EvidenceMeta[] = listEvidence(P);

// ---- timeline ----
let tl = "";
for (const e of events) {
  const dateBadge = e.dateStart ?? e.dateRaw ?? "Undated";
  const labelCls = e.label === "evidence" ? "" : ` ${e.label}`;
  const cites = e.citations.length
    ? `<div class="cites">Sources: ${e.citations.map((c) => esc(c)).join(" · ")}</div>`
    : "";
  tl += `<div class="event${labelCls}"><div class="ev-date">${esc(dateBadge)}</div><div class="ev-body"><div class="ev-title">${esc(e.title)}</div>${mdBlock(e.body)}${cites}</div></div>`;
}

// ---- evidence index + full sections ----
let evIndex = "", evSections = "";
for (const f of files) {
  const r = renderEvidence(P, f.name);
  if (!r) continue;
  const s = "ev-" + f.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const label = f.name.replace(/\.md$/i, "").replace(/^(\d+)[-_ ]?/, "#$1 ");
  const kindTag = r.kind === "md" ? "" : ` <span class="kind">${esc(r.kind)} · ${(f.size / 1024).toFixed(0)}K</span>`;
  evIndex += `<a class="ev-item" data-target="${s}"><span class="ev-name">${esc(label)}</span>${kindTag}</a>`;
  evSections += `<section class="ev-view" id="${s}" style="margin-bottom:1rem"><h2 class="ev-h">${esc(label)}${kindTag}</h2>${r.html}</section>`;
}

// ---- corrections table ----
let corrRows = "";
for (const c of rows) {
  corrRows += `<tr><td><strong>${esc(c.id)}</strong></td><td>${esc(c.dateLogged)}</td><td>${esc(c.claim)}</td><td>${esc(c.correction)}</td><td>${esc(c.source)}</td><td><span class="status ${esc(c.status)}">${esc(c.status)}</span></td></tr>`;
}

// ---- generated stamp ----
let sha = "uncommitted";
try {
  const r = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"]);
  if (r.exitCode === 0) sha = new TextDecoder().decode(r.stdout).trim();
} catch { /* not a git checkout */ }
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

const liveLink = LIVE_URL
  ? `<p class="live-link">Live locker (for submitting corrections) → <a href="${esc(LIVE_URL)}">${esc(LIVE_URL)}</a></p>`
  : "";

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(TITLE)}</title><style>${css}</style></head>
<body><div class="wrap">
<header class="masthead"><div class="k">🗄️</div><div><h1>${esc(TITLE)}</h1>
<p class="sub">Static snapshot — generated ${stamp} UTC · source <code>${esc(sha)}</code> · corrections table is read-only here</p>${liveLink}</div></header>
<div class="tabs"><button class="tab active" data-view="timeline">Timeline (${events.length})</button><button class="tab" data-view="evidence">Evidence (${files.length})</button><button class="tab" data-view="corrections">Corrections (${rows.length})</button></div>
<input id="q" class="search" type="search" placeholder="Filter…">
<section id="view-timeline" class="view active">${tl || "<p>Empty.</p>"}</section>
<section id="view-evidence" class="view"><div class="ev-index">${evIndex}</div>${evSections}</section>
<section id="view-corrections" class="view"><p><strong>Correction log.</strong> Corrections land here first, then get applied to the timeline.</p>
<table class="corr"><thead><tr><th>ID</th><th>Date</th><th>Claim as written</th><th>Correction</th><th>Source</th><th>Status</th></tr></thead><tbody>${corrRows}</tbody></table></section>
<footer class="foot">Built with <a href="https://github.com/toxicwind/evidence-locker">evidence-locker</a> — one self-contained HTML file, zero network requests.</footer>
</div><script>${clientJs}</script></body></html>`;

writeFileSync(OUT, html);
console.log(`[evidence-locker] ${OUT} — ${events.length} events, ${files.length} evidence files, ${rows.length} corrections, ${html.length} bytes`);
