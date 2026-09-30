# evidence-locker 🗄️

Turn a folder of evidence into **one self-contained HTML file** — zero network
requests, no build server, no database. A `TIMELINE.md`, a `CORRECTIONS.md`,
and an `evidence/` folder go in; a single browsable, searchable page comes out.

Built for anyone assembling a private case file: journalists, lawyers,
researchers, or anyone who wants their chronology **evidence-grade** — every
dated claim backed by an exhibit, every correction tracked instead of silently
edited.

## Quickstart

```sh
git clone https://github.com/toxicwind/evidence-locker
cd evidence-locker
bun src/build.ts example --out /tmp/demo.html --title "Harbor Street incident"
open /tmp/demo.html   # or: adb push /tmp/demo.html /sdcard/Download/
```

The `example/` directory is a fully synthetic case (the fictional Harbor
Street incident) — cloning and building produces a complete locker with zero
of your own data.

## The two halves

**Reads: static snapshot** (`src/build.ts`). Bakes timeline + evidence +
corrections into one HTML file with inline CSS and a few lines of vanilla JS
(tabs, filter, evidence browser). With JS disabled the page still reads fully —
every section renders. Regenerate on every commit:

```sh
# .git/hooks/post-commit
bun /path/to/evidence-locker/src/build.ts /path/to/my-locker --out /path/to/my-locker/locker.html
```

**Writes: live server** (`src/server.ts`). Token-gated Bun server for the
corrections board — the write path. Reads stay static; the server only needs
to exist where corrections get submitted.

```sh
LOCKER_TOKEN=$(openssl rand -hex 32) bun src/server.ts /path/to/my-locker --port 25137
# open http://localhost:25137/?token=<token>
```

## Corpus format

See [docs/FORMAT.md](docs/FORMAT.md). The short version:

- `TIMELINE.md` — `## YYYY-MM-DD — Title` events, plus an `## Undated` section.
- `CORRECTIONS.md` — intake table (`C-001`, claim, correction, source, status).
- `evidence/` — `001-*.md` renders inline; photos/PDFs list as downloads.

## Layout

```
src/        parse.ts   — TIMELINE/CORRECTIONS/evidence parsing + Markdown→HTML (shared)
            build.ts   — static snapshot generator (reads live, emits one HTML file)
            server.ts  — token-gated live server (corrections write path)
template/   style.css  — the locker theme
            client.js  — tabs / filter / evidence browser (progressive enhancement)
example/    TIMELINE.md, CORRECTIONS.md, evidence/ — synthetic demo case
docs/       FORMAT.md  — corpus format spec
```

## License

MIT — see [LICENSE](LICENSE).
