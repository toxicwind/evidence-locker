# Evidence-locker corpus format

A locker is a directory with three things: `TIMELINE.md`, `CORRECTIONS.md`,
and `evidence/`. All three are plain Markdown; they are the source of truth.
The generator reads them live at build time — no database, no front matter.

## TIMELINE.md

`##` headings define **eras** (sections); events are `-` bullets inside an era,
sorted chronologically at render time.

```md
## Tenancy

- **[evidence]** 2024-03-12 — **Lease signed** at 44 Harbor Street. Mara Voss
  signs a 12-month lease; deposit $1,800. `listing-44`
- **[allegation]** 2024-10-01 — **Rent withheld.** Tenant places rent in escrow
  pending remediation. Filed as evidence/001-photos.md.
- A neighbor reportedly had the same leak in 2023 — unconfirmed.

## Open threads

- The building's 2019 inspection report (referenced, not yet located).
```

Event syntax, in order:

1. **Label** (optional): `**[evidence]**` or `**[allegation]**` at the start.
   Default is `note`. Labels get distinct styling; `allegation` also marks the
   event's source type.
2. **Date** (optional): `YYYY-MM-DD`, `YYYY-MM`, or `Month YYYY`, followed by
   `—`/`-` and the body — or directly followed by the body. Ranges work too:
   `2024-06-02 → 2024-06-20`. Undated bullets sort last.
3. **Title**: the first `**bold span**` in the body becomes the event title.
4. **Citations**: `` `backtick-quoted` `` strings are collected as source IDs
   and rendered under the event.
5. **File links**: `evidence/<name>` references are checked against `evidence/`
   and rendered with an exists/missing indicator.
6. Body supports `**bold**`, `*italic*`, `` `code` ``, `[text](url)` inline.

Continuation lines (indented) belong to the same event.

## CORRECTIONS.md

The intake log. Corrections land here first, then get applied to the
timeline. A Markdown table with exactly this header:

```md
| # | Date logged | Claim as written (TIMELINE) | Correction (verbatim) | Source / evidence | Status |
|---|-------------|-----------------------------|------------------------|-------------------|--------|
| C-001 | 2024-10-05 | Water damage reported 2024-06-02 | Text was sent June 3; photo was June 2. | Phone records | applied |
```

- `#` values look like `C-001`. The server auto-assigns the next ID.
- `Status` is free text; the UI styles `pending` / `applied` / common others.
- Lines before the table are kept verbatim (`pre`); lines after the table are
  kept verbatim (`post`). The live server's POST/PATCH endpoints rewrite only
  the table rows, preserving everything else byte-for-byte.

## evidence/

One file per exhibit. `.md` files render inline as HTML; anything else
(photos, PDFs, scans) appears in the index and is served as a download by
the live server. Name files with a numeric prefix (`001-*.md`) to control
order; the index strips the prefix and shows `#1`, `#2`, …
