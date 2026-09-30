// evidence-locker — shared parsing module (single source of truth for the timeline/
// corrections/evidence parsers). Imported by web/server.ts (live UI) and
// web/build-static.ts (static snapshot generator). Keep semantics identical
// in both consumers: any TIMELINE.md format fix lands here once.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

export interface StorePaths {
  root: string;
  webroot: string;
  timeline: string;
  corrections: string;
  evidenceDir: string;
}
export function storePaths(root: string): StorePaths {
  return {
    root,
    webroot: join(root, "web"),
    timeline: join(root, "TIMELINE.md"),
    corrections: join(root, "CORRECTIONS.md"),
    evidenceDir: join(root, "evidence"),
  };
}

// ---------- tiny markdown ----------
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function mdInline(s: string): string {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*([^\*\n]+)\*/g, "<em>$1</em>");
  return h;
}
export function mdBlock(src: string): string {
  const lines = src.split("\n");
  let out = "", inList = false, inQuote = false, inPre = false;
  const flush = () => {
    if (inList) { out += "</ul>"; inList = false; }
    if (inQuote) { out += "</blockquote>"; inQuote = false; }
    if (inPre) { out += "</pre>"; inPre = false; }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (t.startsWith("```")) { if (inPre) { out += "</pre>"; inPre = false; } else { flush(); out += '<pre class="raw">'; inPre = true; } continue; }
    if (inPre) { out += esc(line) + "\n"; continue; }
    if (!t) { flush(); continue; }
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(#{1,4})\s+(.*)/))) { flush(); out += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`; continue; }
    if (t.startsWith("&gt; ") || t.startsWith("> ")) { if (!inQuote) { flush(); out += "<blockquote>"; inQuote = true; } out += mdInline(t.replace(/^(&gt;|>)\s?/, "")) + "<br>"; continue; }
    if ((m = t.match(/^[-*]\s+(.*)/))) { if (!inList) { flush(); out += "<ul>"; inList = true; } out += `<li>${mdInline(m[1])}</li>`; continue; }
    if ((m = t.match(/^\d+\.\s+(.*)/))) { if (!inList) { flush(); out += "<ul>"; inList = true; } out += `<li>${mdInline(m[1])}</li>`; continue; }
    flush(); out += `<p>${mdInline(t)}</p>`;
  }
  flush();
  return out;
}

// ---------- timeline parsing ----------
export interface EvFile { name: string; exists: boolean }
export interface TlEvent {
  id: string; era: string; label: "evidence" | "allegation" | "note";
  dateRaw: string; dateStart: string | null; dateEnd: string | null;
  title: string; body: string; citations: string[];
  sourceType: "email" | "sms" | "allegation" | "other";
  files: EvFile[];
}
export interface Era { title: string; events: TlEvent[] }

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};
export function parseDateToken(tok: string): string | null {
  tok = tok.trim();
  let m: RegExpMatchArray | null;
  if ((m = tok.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = tok.match(/^(\d{4})-(\d{2})/))) return `${m[1]}-${m[2]}-01`;
  if ((m = tok.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)))
    return `${m[2]}-${MONTHS[m[1].toLowerCase()]!}-01`;
  if ((m = tok.match(/^(\d{4})/))) return `${m[1]}-01-01`;
  return null;
}
const DATE_ATOM = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|January|February|March|April|May|June|July|August|September|October|November|December)\s*(?:\d{4})?`;

export function parseTimeline(p: StorePaths): { eras: Era[]; events: TlEvent[] } {
  const text = readFileSync(p.timeline, "utf8");
  const lines = text.split("\n");
  let era = "Unfiled";
  const eraMap = new Map<string, TlEvent[]>();
  let cur: string[] | null = null;
  let n = 0;
  const emit = (section: string, rawLines: string[]) => {
    const raw = rawLines.join("\n").replace(/^\s*-\s*/, "").trim();
    let label: TlEvent["label"] = "note";
    let rest = raw;
    const lm = raw.match(/^\*\*\[(evidence|allegation)\]\*\*\s*([\s\S]*)$/);
    if (lm) { label = lm[1] as TlEvent["label"]; rest = lm[2].trim(); }
    // leading date: DATE [→ DATE] [(note)] — date
    let dateRaw = "", dateStart: string | null = null, dateEnd: string | null = null, body = rest;
    const dm = rest.match(
      new RegExp(`^(${DATE_ATOM}(?:\\s*(?:\u2192|->|\u2013|-)\\s*${DATE_ATOM})?(?:\\s*\\([^)]*\\))?)\\s*[\u2014\u2013-]\\s*([\\s\\S]*)$`)
    );
    if (dm) {
      dateRaw = dm[1].trim(); body = dm[2].trim();
      // split range on arrows / spaced dashes only — never inside an ISO date
      const parts = dateRaw.split(/\s*(?:\u2192|\u2013)\s*|\s+->\s+|\s+-\s+/);
      dateStart = parseDateToken(parts[0]!.replace(/\s*\([^)]*\)\s*$/, ""));
      if (parts[1]) dateEnd = parseDateToken(parts[1]);
    } else {
      // fallback: leading date without a following dash (e.g. allegation entries)
      const fm = rest.match(new RegExp(`^(${DATE_ATOM})(?![\\w-])([\\s\\S]*)$`));
      if (fm) {
        dateRaw = fm[1]!.trim();
        body = fm[2]!.trim().replace(/^["\u201c]/, "");
        dateStart = parseDateToken(dateRaw);
      }
    }
    // title = first bold span
    let title = "";
    const tm = body.match(/\*\*([^*]{2,120}?)\*\*/);
    if (tm) { title = tm[1]!.trim(); body = body.replace(tm[0], "").trim(); }
    const citations = [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const files: EvFile[] = [...body.matchAll(/evidence\/([\w\-.]+)/g)].map((m) => ({
      name: m[1]!, exists: existsSync(join(p.evidenceDir, m[1]!)),
    }));
    let sourceType: TlEvent["sourceType"] = "other";
    if (label === "allegation" || /Drive docs/i.test(body)) sourceType = "allegation";
    else if (/SMS|content:\/\/mms/i.test(body)) sourceType = "sms";
    else if (/Gmail/i.test(body)) sourceType = "email";
    const ev: TlEvent = {
      id: `e${++n}`, era: section, label, dateRaw, dateStart, dateEnd,
      title, body, citations, sourceType, files,
    };
    if (!eraMap.has(section)) eraMap.set(section, []);
    eraMap.get(section)!.push(ev);
  };
  const flush = () => { if (cur) { emit(era, cur); cur = null; } };
  for (const line of lines) {
    const hm = line.match(/^##\s+(.*)/);
    if (hm) { flush(); era = hm[1]!.trim(); continue; }
    if (/^-\s/.test(line)) { flush(); cur = [line]; continue; }
    if (cur && /^\s+\S/.test(line)) { cur.push(line); continue; }
    if (cur && !line.trim()) { cur.push(line); continue; }
    flush();
  }
  flush();
  const eras: Era[] = [...eraMap.entries()].map(([title, events]) => ({ title, events }));
  const events = [...eraMap.values()].flat().sort((a, b) => {
    if (!a.dateStart && !b.dateStart) return 0;
    if (!a.dateStart) return 1;
    if (!b.dateStart) return -1;
    return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0;
  });
  return { eras, events };
}

// ---------- corrections (CORRECTIONS.md is the source of truth) ----------
export interface Correction {
  id: string; dateLogged: string; claim: string; correction: string; source: string; status: string;
}
export function parseCorrections(p: StorePaths): { pre: string[]; rows: Correction[]; post: string[] } {
  const lines = readFileSync(p.corrections, "utf8").split("\n");
  const sepIdx = lines.findIndex((l) => /^\|[\s:-]+\|/.test(l));
  const pre = lines.slice(0, sepIdx + 1);
  const rows: Correction[] = [];
  let i = sepIdx + 1;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith("|")) break;
    const cells = l.split("|").slice(1, -1).map((c) => c.trim().replace(/<br>/g, "\n"));
    while (cells.length < 6) cells.push("");
    rows.push({ id: cells[0]!, dateLogged: cells[1]!, claim: cells[2]!, correction: cells[3]!, source: cells[4]!, status: cells[5]! || "pending" });
  }
  return { pre, rows, post: lines.slice(i) };
}
export function todayDenver(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function nextCorrId(rows: Correction[]): string {
  let max = 0;
  for (const r of rows) { const m = r.id.match(/C-(\d+)/); if (m) max = Math.max(max, parseInt(m[1]!, 10)); }
  return `C-${String(max + 1).padStart(3, "0")}`;
}

// ---------- evidence ----------
export interface EvidenceMeta { name: string; size: number; mtime: string; kind: string }
export function listEvidence(p: StorePaths): EvidenceMeta[] {
  return readdirSync(p.evidenceDir)
    .filter((f) => !f.startsWith("."))
    .map((f) => {
      const st = statSync(join(p.evidenceDir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString(), kind: f.endsWith(".md") ? "md" : "txt" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function renderEvidence(p: StorePaths, name: string): { html: string; kind: string } | null {
  const safe = basename(name);
  const fp = join(p.evidenceDir, safe);
  if (!existsSync(fp) || statSync(fp).isDirectory()) return null;
  const raw = readFileSync(fp, "utf8");
  if (safe.endsWith(".md")) return { html: mdBlock(raw), kind: "md" };
  return { html: `<pre class="raw">${esc(raw)}</pre>`, kind: "txt" };
}
