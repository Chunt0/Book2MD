# Book2MD — Design Specification

Status: **design** (pre-build). Authoritative spec for the build. Sections 1–6 are
the template's required brief; 7+ are the detailed design. Items marked
**`VERIFY-IN-M0`** depend on marker's real output and are confirmed by the M0 spike
before code leans on them.

> Build per `CLAUDE.md`: copy the reference feature's shape (envelope responses,
> `t`-validated inputs, query-key factories, the CRUD page archetype). Don't invent
> new patterns where an existing one fits.

## Contents

1. One-liner
2. Auth mode
3. Entities (brief)
4. Pages / views (brief)
5. Non-defaults / special needs
6. Out of scope
7. Goals, non-goals, principles
8. System architecture & topology
9. On-disk storage layout
10. Data model (full schema)
11. State machines
12. API surface (full)
13. marker integration contract
14. No LLM (decided)
15. Conversion pipeline & job model
16. QA subsystem (lint, rules, review UX)
17. Edit-protection & re-conversion semantics
18. Frontend design
19. GPU / VRAM management
20. Configuration (env)
21. Error handling, logging, observability
22. Security & privacy
23. Testing strategy
24. Milestones & acceptance criteria
25. Risks, open questions, decisions log
26. Glossary

---

## 1. One-liner

A fully-local web app that converts PDF textbooks to clean Markdown using `marker`
(GPU), with a fast page-level QA workflow, feeding a downstream
knowledge base. **No data leaves the machine** — the source material is copyrighted.

## 2. Auth mode

- **Mode A (none).** Localhost only. `lib/auth.ts` `derive` returns `{ user: { id: 'me' } }`
  unconditionally; `AUTH_TOKEN`/`VITE_AUTH_TOKEN` become optional (no longer fail-fast
  in `lib/env.ts`). Swappable to the shipped Mode B in minutes if ever reached over the LAN.

## 3. Entities (brief — full schema in §10)

- **Book** — an uploaded PDF + its conversion lifecycle and metadata. Soft-deletable.
- **Tag** + **BookTag** — many-to-many free-form tags (flat organization, no hierarchy).
- **Page** — one converted page: working Markdown, conversion-baseline Markdown,
  review status, lint flags, and marker layout (block polygons) for alignment.
- **Job** — a long-running unit of work (`convert | lint | qa_llm`) with status/progress.
- **Rule** (M4) — a book-scoped find/replace/cleanup rule for systematic artifacts.

## 4. Pages / views (brief — full UX in §16, §18)

- **Library** (home) — searchable, tag-filterable table of books with status + review progress.
- **Upload** — dialog: drop a PDF, set title/tags + conversion options, start a convert job.
- **Book detail** — conversion status/progress, settings, export/download, deliberate re-convert.
- **Review workspace** — the QA centerpiece: PDF page beside Markdown, per-page status,
  lint flags, inline editing, one-click fixes, keyboard-driven.

## 5. Non-defaults / special needs

- **PDF upload** — multipart, streamed to disk (textbooks are large; default cap 200 MB).
- **marker — a GPU Docker service** (`infra/marker/Dockerfile`, stock `marker_server` on
  `:8001`, `network_mode: host`) added to `docker-compose.yml`. Reads/writes the shared
  `./data` volume. **Deterministic — no LLM.** The Bun API proxies it; the SPA never calls it directly.
- **Long-running conversion** — a `jobs` table + an in-process sequential worker; the SPA
  polls job status. (The documented "jobs table + tick loop" escape hatch.)
- **Path translation** — the API writes PDFs under the host `./data` tree but passes marker
  the *container* path (`/data/...`); a small helper maps host↔container paths.
- **Frontend libs not in the template** — `pdfjs-dist` (render PDF pages), `katex` +
  `remark-math`/`rehype-katex` (math), `react-markdown` + `remark-gfm` (render),
  `@uiw/react-codemirror` + `@codemirror/lang-markdown` (edit).
- **GPU** — reserved for the `marker` container only; the Bun container needs none.

## 6. Out of scope

- Multi-user / RBAC / login (Mode A only). No `users` table.
- Any cloud API for conversion or LLM — **everything local, hard requirement** (copyright).
- Full per-run version history (single current text + edit-protection instead, §17).
- Subject/course hierarchy (flat list + tags instead).
- Active VRAM load/unload orchestration (both models stay resident, §19).
- Parallel/batch conversion (one book at a time, worker concurrency = 1).
- A second datastore, external job-queue service, or error tracker.
- OCR language packs beyond what marker/Surya ship by default (revisit if needed).

---

## M0 outcomes (DECIDED) — read before §7+

The M0 spike ran marker in Docker (GPU) against a real 565-page born-digital math
textbook. Findings that **revise** the conversion design in §13/§15/§16/§19:

- **GPU/Docker works.** torch 2.8 / cu12.8 on the host 580 / CUDA-13 driver; marker
  idle ≈ 3.9 GB VRAM. (Base image must ship torch ≥ 2.7 or torch/torchvision desync.)
- **Marker runs the STOCK `marker_server`, no LLM.** (M0 briefly added a custom
  `server.py` to enable per-request `use_llm`/`ollama_*`, but once we committed to
  no-LLM that was removed — the stock server's deterministic params are all we use.)
- **LLM-in-the-loop is DROPPED as the default.** marker's `--use_llm` calls a
  multimodal LLM **per equation/table block, with a retry loop, inside one blocking
  request**: a single dense page took *minutes*; a whole book = *hours*. Non-viable
  for a multi-hundred-book corpus (measured, not estimated).
- **marker's BASE (no-LLM) math is already excellent.** On dense math pages it emits
  clean, KaTeX-ready LaTeX in `<math display="block|inline">` tags with no LLM — e.g.
  `r(a_t,q_t,d_t)=\mu a_t-\frac12\beta a_t^2+\gamma a_t d_t-\eta p(a_t-q_t)_+ +\kappa q_t\mathbb{1}_{a_t=0}`
  — sums, fractions, Greek, `\mathbb{1}`, bold vectors, equation numbers intact.
- **Timing (no-LLM):** ~2.8 s/page prose, ~7.4 s/page dense-math → **~30–45 min/book**.
- **marker labels structure usefully:** `PageHeader`/`PageFooter`/`Footnote`/`Equation`
  block types come out of the base pipeline (helps lint strip headers/footers).

### Revised conversion + LaTeX-correctness strategy (supersedes §13's "use_llm" default)

1. **Convert with NO LLM** using `output_format=markdown` + `paginate_output=true` —
   marker's native Markdown already has `$$…$$`/`$…$` math; split on the `{N}----`
   page separator. (Per-block layout/polygons via a `json` pass are deferred to M4.)
2. **Validate every equation with KaTeX** (server-side, instant): parses → trust;
   throws → flag `bad_equation`. Catches all *malformed* LaTeX, zero GPU.
3. **Fix only flagged equations**, by hand in the review editor (rare — base output is clean).
   A future *deterministic* option: re-OCR the equation's **bbox crop** with a fast math-OCR
   (`texify`/`pix2tex`). No LLM.
4. **Human confirms semantics** in the QA workspace (PDF crop beside rendered KaTeX,
   flagged-first) — the real correctness guarantee (KaTeX can't catch valid-but-wrong).

Marker is a **pure deterministic converter** and **Book2MD has no LLM at all** — the M5 Gemma
QA assistant was considered and **cut** (base output + lint + human review suffice). Per-book
cost is ~30–45 min and only marker touches the GPU.

## 7. Goals, non-goals, principles

**Primary goal.** Turn a large library of PDF textbooks into trustworthy Markdown with
the *least human effort per book*, where "trustworthy" means a human has confirmed each
page is free of extraction artifacts.

**Success criteria.**
- A book goes upload → converted → fully QA'd → exported with the reviewer touching only
  the pages that actually need fixing.
- Exported Markdown is clean: no running headers/footers, page numbers, broken
  hyphenation; tables and equations render correctly (KaTeX-valid LaTeX).
- The whole corpus (potentially hundreds of books) stays browsable and resumable.

**Non-goals.** Perfect automated conversion (the human is in the loop by design); a
general document-management system; serving the KB itself (Book2MD only produces its input).

**Design principles.**
1. **Flag automatically, fix systematically, hand-edit only the residual.** The review UI
   exists to make *approval* fast, not to be a manual transcription tool.
2. **The Bun process is the only surface.** marker/Ollama are internal dependencies; their
   failures map to envelope errors (`BadGatewayError` / `ServiceUnavailableError`).
3. **Stable internal contracts.** A `marker adapter` normalizes whatever marker returns
   into our `Page` shape, so marker version/format choices stay behind one seam.
4. **Copy the template's shape.** Envelope, typed errors, `t`-validation, key factories,
   one place to register routes/pages.

## 8. System architecture & topology

```
                                   ┌─────────────────────────────────────────────┐
  browser (SPA) ───────────────►   │  Bun process (Elysia)  — the only public port │
   pdf.js / katex / codemirror     │   • serves built SPA + /api/*                  │
                                   │   • SQLite (Drizzle, WAL)                      │
                                   │   • in-process job worker (concurrency 1)      │
                                   │   • proxies marker (deterministic, no LLM)     │
                                   └───────┬───────────────────────────────────────┘
                              POST /marker │ (filepath, output_format, paginate, force_ocr)
                            (shared ./data)│
                                   ┌───────▼────────┐
                                   │ marker (Docker)│
                                   │ GPU :8001      │
                                   │ marker_server  │
                                   │ no LLM         │
                                   └───────┬────────┘
                                           │ reads/writes
                                   ┌───────▼────────┐
                                   │  ./data (host) │  PDFs in, images/output out
                                   └────────────────┘
```

- **Dev:** `bun run dev` (API `:4000`, Vite `:3000` proxying `/api`); `docker compose up -d marker`
  (GPU service on `:8001`); Ollama already running natively. The native API reaches marker at
  `http://localhost:8001` and Ollama at `http://localhost:11434`.
- **Prod (single box):** the Bun app may be containerized later; for now native is fine
  (Mode A, localhost). The marker container uses `network_mode: host`, so it binds `:8001`
  on the host and reaches native Ollama at `localhost:11434` with no host-gateway plumbing.
- **Shared data:** marker mounts `./data → /data`. The API writes to the host path and sends
  marker the container path. See §9 + the `toMarkerPath()` helper.

## 9. On-disk storage layout

Disk is the source of truth for *binaries* (PDF, images) and the *export artifact*. The DB
holds the editable per-page Markdown + review metadata (the working copy). Export reassembles
DB pages into `book.md`.

```
data/
  app.db                          # SQLite (template default)
  books/
    <slug>/                       # slug derived from title, unique, filesystem-safe
      source.pdf                  # the uploaded original
      marker/                     # raw marker outputs, kept for debugging/re-derive
        output.json               # marker JSON tree (pages→blocks→polygon/html)  VERIFY-IN-M0
        output.md                 # marker markdown (if we request it)            VERIFY-IN-M0
        meta.json                 # marker metadata/run info
      images/                     # extracted figures/tables, referenced by Markdown
        _page_3_figure_1.png ...  # exact names from marker                       VERIFY-IN-M0
      book.md                     # assembled export (regenerated on export/approve)
```

- `<slug>`: `slugify(title)` with a numeric suffix on collision; also the unique
  `books.slug`. Folder is created on upload.
- Container view: `/data/books/<slug>/source.pdf`. Host view: `${DATA_DIR}/books/<slug>/source.pdf`.
  `toMarkerPath(hostPath)` swaps the `DATA_DIR` prefix for `MARKER_DATA_DIR` (`/data`).
- The downstream KB reads `data/books/<slug>/book.md` + `images/` directly; the UI also
  offers a download (single `.md`, or a `.zip` of `.md`+images).

## 10. Data model (full schema)

SQLite via Drizzle, following the reference feature's conventions: `integer` autoincrement
PKs, `text` timestamps defaulting to `(current_timestamp)`, soft-delete via `deletedAt`,
JSON stored as `text` (parsed/serialized at the edge). Enums are `text` + a TS union +
runtime validation (no native enum in SQLite). `bun run db:generate` after edits.

### 10.1 `books`

| column | type | notes |
|---|---|---|
| `id` | integer PK auto | |
| `title` | text, **required** | display title |
| `author` | text, null | optional |
| `slug` | text, **required, unique** | folder name; `UNIQUE` |
| `originalFilename` | text, **required** | uploaded filename |
| `status` | text, **required**, default `'uploaded'` | conversion lifecycle (§11.1) |
| `pageCount` | integer, null | set after conversion |
| `sizeBytes` | integer, null | PDF size |
| `conversionSettings` | text(JSON), null | last run: `{ useLlm, model, outputFormat, forceOcr, markerVersion }` |
| `errorMessage` | text, null | last failure summary |
| `approvedAt` | text, null | set when the book is marked approved |
| `createdAt` | text, required, default now | |
| `convertedAt` | text, null | last successful conversion |
| `deletedAt` | text, null | soft delete |

Indexes: `unique(slug)`, `index(status)`, `index(deletedAt)`. Paths are **derived** from
`slug` (not stored) to avoid drift. Review progress is **derived** from `pages` (not stored).

### 10.2 `tags` and `book_tags`

`tags`: `id` PK · `name` text **required, unique (NOCASE)** · `createdAt`.

`book_tags` (join): `bookId` → `books.id` **required** · `tagId` → `tags.id` **required** ·
composite `PRIMARY KEY (bookId, tagId)` · `index(tagId)`. Deleting a tag removes its joins;
deleting a book removes its joins (soft-delete keeps the book row but the Library hides it).

### 10.3 `pages`

| column | type | notes |
|---|---|---|
| `id` | integer PK auto | |
| `bookId` | integer → books.id, **required** | |
| `pageNumber` | integer, **required** | 1-based, matches marker page index |
| `markdown` | text, **required** | working text (edited/cleaned) |
| `originalMarkdown` | text, **required** | conversion baseline (for diff + protection) |
| `status` | text, **required**, default `'pending'` | review status (§11.2) |
| `editedAt` | text, null | set on first manual edit; the **edit-protection flag** |
| `flagsJson` | text(JSON), default `'[]'` | lint findings (§16.1) |
| `layoutJson` | text(JSON), null | marker per-page blocks: `[{id,type,polygon,bbox}]` VERIFY-IN-M0 |
| `pageWidth` | integer, null | source page dims (px/pt) for bbox scaling VERIFY-IN-M0 |
| `pageHeight` | integer, null | |
| `createdAt` | text, required, default now | |
| `updatedAt` | text, required, default now | bumped on edit/status change |

Indexes: `unique(bookId, pageNumber)`, `index(bookId, status)`. Re-conversion replaces pages
by `(bookId, pageNumber)` (upsert), honoring §17.

### 10.4 `jobs`

| column | type | notes |
|---|---|---|
| `id` | integer PK auto | |
| `bookId` | integer → books.id, null | null for non-book jobs |
| `type` | text, **required** | `convert | lint | qa_llm` |
| `status` | text, **required**, default `'queued'` | `queued | running | succeeded | failed | canceled` |
| `stage` | text, null | human label: `calling marker`, `splitting pages`, … |
| `progress` | real, default `0` | 0..1; may stay 0 during the indeterminate marker call |
| `paramsJson` | text(JSON) | run inputs |
| `resultJson` | text(JSON), null | summary `{ pageCount, durationMs, … }` |
| `error` | text, null | failure detail |
| `attempts` | integer, default `0` | |
| `createdAt` / `startedAt` / `finishedAt` | text | timestamps |

Indexes: `index(status)`, `index(bookId)`. On boot, any `running` job is reconciled
(→ `failed` with a note, since the in-process worker didn't survive) so nothing is stuck.

### 10.5 `rules` (M4)

`id` PK · `bookId` → books.id · `type` text (`strip_lines | replace | dehyphenate | trim_blank`)
· `pattern` text (regex/source) · `replacement` text null · `enabled` integer(bool) default 1 ·
`createdAt`. Applied on demand (preview → commit), §16.2.

## 11. State machines

### 11.1 Book conversion lifecycle (`books.status`)

```
uploaded ──enqueue convert──► queued ──worker picks──► converting ──ok──► converted
   ▲                                                         │
   └──────────────────────(re-upload, rare)                 └──error──► failed
converted ──re-convert──► queued ──► converting ──► converted
failed ──retry──► queued
```
`approvedAt` is an orthogonal flag set by "mark book approved" (allowed when all pages are
`approved`); it does not change `status`. The Library shows a combined badge: `status`
(+ "approved" pill) + review progress %.

### 11.2 Page review status (`pages.status`)

```
pending ──approve──► approved
pending ──flag─────► needs_fix ──edit/clean & resolve──► fixed ──approve──► approved
approved/fixed ──re-flag──► needs_fix
(any) ──reset to original──► pending (clears editedAt)
```
Editing markdown sets `editedAt` but does **not** auto-change status (the reviewer decides).
"Approve all remaining" bulk-sets `pending → approved`.

### 11.3 Job status

`queued → running → (succeeded | failed | canceled)`. `canceled` is best-effort: marker calls
in flight can't be force-killed, so cancel marks the job and the result is discarded on return.

## 12. API surface (full)

Conventions: prefix `/api`. Every success returns `ok(data, meta?)`; every error throws an
`AppError` subclass → envelope. All inputs validated with Elysia `t`. Pagination via
`lib/pagination.ts`. Resource routes register one `.use(...)` line in `routes/index.ts`.

### 12.1 Books — `routes/books.ts`

| method + path | body / query | returns |
|---|---|---|
| `GET /api/books` | query: `q?`, `tagId?`, `status?`, `approved?`, `limit`, `offset`, `sort?` | list of books + `tags[]` + derived `review` `{ total, approved, flagged, needsFix }`; `meta` page info |
| `POST /api/books` | **multipart**: `file` (pdf, ≤ `MAX_UPLOAD_MB`), `title?`, `author?`, `tags?` (csv), `useLlm?`, `model?`, `forceOcr?` | `{ book, job }` — creates Book(`uploaded`), writes `source.pdf`, enqueues a `convert` job |
| `GET /api/books/:id` | — | book + tags + derived review + latest job |
| `PATCH /api/books/:id` | `{ title?, author?, tagIds? }` | updated book |
| `DELETE /api/books/:id` | — | soft-delete (`deletedAt`); files retained |
| `POST /api/books/:id/convert` | `{ useLlm?, model?, forceOcr?, overwriteEdited? (default false) }` | `{ job }`; 409 if a convert job already running |
| `POST /api/books/:id/lint` | — | `{ job }` (or sync `{ flaggedCount }`); recomputes `pages.flagsJson` |
| `POST /api/books/:id/approve` | — | book with `approvedAt`; 400 if any page not `approved` (unless `?force=true`) |
| `GET /api/books/:id/export` | query: `images=linked|inline`, `format=md|zip` | assembles `book.md` to disk + streams download |
| `GET /api/books/:id/pdf` | (Range supported) | streams `source.pdf` for pdf.js |
| `GET /api/books/:id/images/:name` | — | streams an extracted image (referenced by Markdown) |

Validation highlights: `file` must be `application/pdf` (sniff magic bytes `%PDF`), size capped;
`status` ∈ lifecycle enum; `model` ∈ an allowlist fetched from Ollama (§14); `slug` generated
server-side.

### 12.2 Pages — `routes/pages.ts`

| method + path | body / query | returns |
|---|---|---|
| `GET /api/books/:id/pages` | query: `status?`, `flagged?`, `sort=number|flags`, `limit?`, `offset?` | lightweight page list: `{ id, pageNumber, status, edited, flagCount, flagTypes[] }` (no full markdown) |
| `GET /api/pages/:id` | — | full page: `markdown, originalMarkdown, status, edited, flags[], layout, pageWidth/Height, neighbors {prevId, nextId}` |
| `PATCH /api/pages/:id` | `{ markdown?, status? }` | updated page; sets `editedAt` if `markdown` changed |
| `POST /api/pages/:id/reset` | — | `markdown := originalMarkdown`, clears `editedAt`, `status := pending` |
| `POST /api/pages/:id/apply-suggestion` | `{ index }` | applies a flag's `suggestion` (e.g. dehyphenate) to `markdown`, returns updated page |

### 12.3 Tags — `routes/tags.ts`

`GET /api/tags` (with book counts) · `POST /api/tags` `{ name }` · `DELETE /api/tags/:id`.
Assignment is via `PATCH /api/books/:id { tagIds }`.

### 12.4 Rules — `routes/rules.ts` (M4)

`GET /api/books/:id/rules` · `POST /api/books/:id/rules` `{ type, pattern, replacement?, enabled? }`
· `PATCH /api/rules/:id` · `DELETE /api/rules/:id` · `POST /api/books/:id/rules/apply`
`{ commit: boolean }` → preview (per-page diff counts) or commit (updates pages, sets `editedAt`).

### 12.5 Jobs — `routes/jobs.ts`

`GET /api/jobs?bookId=&status=&type=` · `GET /api/jobs/:id` (SPA polls this) ·
`POST /api/jobs/:id/cancel`. Optional `GET /api/jobs/:id/stream` (SSE) deferred; polling
(`refetchInterval` while active) is the v1 mechanism.

### 12.6 System — `routes/system.ts`

`GET /api/health` (template default, public). `GET /api/system/status` → `{ marker: {reachable, version?}, ollama: {reachable, models[]}, gpu?: {…} }` — pings marker `/health`/`/docs`
and Ollama `/api/tags`; powers an in-UI "services up?" indicator. GPU stats optional (would
need shelling to `nvidia-smi`; deferred).

## 13. marker integration contract

`lib/marker.ts` (the **adapter** seam). Confirmed from current marker docs; field-level
shapes are `VERIFY-IN-M0`.

**Request** — `POST {MARKER_URL}/marker`, JSON (stock marker_server, deterministic):
```jsonc
{
  "filepath": "/data/books/<slug>/source.pdf",   // container path (toMarkerPath)
  "output_format": "markdown",                    // native $$…$$ / $…$ math
  "paginate_output": true,                         // inserts a "{N}----" page separator
  "force_ocr": false                               // true for scanned books
  // page_range as needed. NO use_llm — conversion is deterministic.
}
```

**Response** — `{ format, output, images: { name: base64 }, metadata, success }`. With
`paginate_output`, `output` is the whole book's Markdown, each page preceded by a
`{<markerIndex>}` + 48-dash separator line.

**Adapter responsibilities (`callMarker` / `parsePaginatedMarkdown` in lib/marker.ts):**
1. POST the request; map non-2xx/unreachable → `BadGatewayError`, timeout → `ServiceUnavailableError`.
2. Write base64 `images` to `data/books/<slug>/images/`; persist raw `output` to `marker/output.md`.
3. Split `output` on the `{N}----` separator → `pages[]` `{ pageNumber (1-based), markdown }`.
   Math is already `$$…$$`/`$…$`; no HTML→MD step needed.

**Per-block layout/polygons (M4):** a *second* `output_format=json` pass (deterministic,
no LLM) yields pages → blocks with `polygon`/`bbox`/`html` for the review-alignment overlay,
stored in `pages.layoutJson`. Deferred until M4 needs it.

**Errors:** non-2xx / unreachable → `BadGatewayError`; timeout (`CONVERT_TIMEOUT_MS`) →
`ServiceUnavailableError`; surfaced on the job as `failed` with `error`.

## 14. No LLM (decided)

**Book2MD has no LLM / Ollama dependency.** Conversion is deterministic (marker); QA is the lint
catalog (§16) + human review + one-click fixes. A Gemma "clean this page" assistant was considered
(M5) and **cut** — marker's base output is clean enough that an LLM earns nothing. Nothing but
marker touches the GPU.

## 15. Conversion pipeline & job model

**Worker.** An in-process module (`lib/jobs.ts`) with a sequential queue (concurrency **1** —
matches "one book at a time" + single GPU). On enqueue it processes immediately if idle; else
the job waits. On boot, `running` jobs are reconciled to `failed` (the worker didn't survive a
restart). No external queue service.

**Convert job steps** (each updates `jobs.stage`/`progress`, `books.status`):
1. `queued` → worker sets job `running`, book `converting`.
2. `stage: calling marker` — POST `/marker` with settings; `progress` indeterminate (marker is
   a single blocking call — no per-page stream by default; UI shows elapsed time). `VERIFY-IN-M0`:
   check whether marker exposes finer progress; if not, optionally chunk by `page_range` to gain
   progress + resumability (future).
3. `stage: post-processing` — adapter normalizes result, writes images, derives per-page Markdown.
4. `stage: splitting pages` — upsert `pages` by `(bookId, pageNumber)` honoring edit-protection (§17).
5. `stage: linting` — run the lint pass (§16.1) to populate `flagsJson`.
6. Set book `converted` + `pageCount` + `convertedAt` + `conversionSettings`; job `succeeded`
   with `result {pageCount, durationMs}`.
- **Failure** at any step: job `failed` (`error`), book `failed` (`errorMessage`). Retdownloadable
  via `POST /convert` again.

**Progress reality.** Honest stage-based progress (queued → calling marker → post-processing →
splitting → linting → done), not a per-page bar, because `marker_server` returns once at the end.

## 16. QA subsystem

### 16.1 Lint checks (catalog)

Pure functions in `lib/lint/` (unit-tested, no GPU). Run post-conversion and on demand; write
`page.flagsJson` as `[{ type, severity, message, snippet?, line?, suggestion? }]`. Severity
`warn` (likely artifact) or `info` (FYI). Each suggestion carries an `action` for one-click apply.

| type | detection | severity | suggestion |
|---|---|---|---|
| `running_header` / `running_footer` | first/last text block per page, normalized (strip digits), recurs on > `LINT_HEADER_FREQ` of pages (default 25%, ≥3 pages) | warn | create a book-wide `strip_lines` rule |
| `page_number` | isolated short line `^\s*\d{1,4}\s*$` or `^(Page\s+)?\d+$` near top/bottom | warn | remove line |
| `hyphenation` | line ends `[a-z]-` and next line starts `[a-z]` | info | dehyphenate (join) |
| `broken_table` | Markdown table where header col count ≠ body row col counts, or pipe counts vary | warn | (manual / "clean with Gemma") |
| `bad_equation` | each `$…$` / `$$…$$` span fails server-side KaTeX parse (`throwOnError`) | warn | show offending TeX for manual fix |
| `extraction_gap` (born-digital) | marker page char-count < `LINT_GAP_RATIO` (default 0.6) × PDF text-layer char-count for that page | warn | flag for manual review |
| `encoding_artifact` | contains `�`, mojibake ligatures, control chars | info | normalize |
| `empty_page` | page Markdown < `LINT_MIN_CHARS` (default 20) | info | confirm intentionally blank |
| `repeated_block` | consecutive identical paragraphs (OCR doubling) | info | dedupe |

PDF text-layer extraction (for `extraction_gap`) uses a server-side PDF text extractor
(`pdfjs-dist` / `unpdf` in Bun). KaTeX validation uses the `katex` npm package server-side.

### 16.2 Book-wide rules (M4)

Turn a systematic artifact into a one-time fix. Types: `strip_lines(regex)`, `replace(regex→repl)`,
`dehyphenate`, `trim_blank`. **Preview** shows per-page change counts + a sample diff; **commit**
applies to all pages (sets `editedAt`, re-runs lint). Rules persist per book and can be re-applied.
Rules are explicit user actions → they apply even to edited pages (with preview).

### 16.3 No LLM assist (cut)

A Gemma "clean this page" assistant was considered (M5) and **cut** — marker's base output is
clean enough that lint + one-click fixes + inline human edit cover QA. No Ollama dependency.

### 16.4 Review workspace UX (the centerpiece)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Book title          [▒▒▒▒▒░░░░] 142/320 reviewed · 9 flagged    [Approve book]  │
├───────────────┬───────────────────────────────────┬───────────────────────────┤
│ Pages         │  PDF page (pdf.js canvas)          │  Markdown                 │
│ ▢ 48  ✓       │  ┌───────────────────────────────┐ │  [ Rendered | Source ]    │
│ ▢ 49  ⚑2      │  │                               │ │  ## Heading               │
│▶▢ 50  ●edited │  │   rendered page, zoom/fit,     │ │  body text … $E=mc^2$     │
│ ▢ 51  ✓       │  │   bbox overlay (toggle)        │ │  | a | b |                │
│ …             │  │                               │ │  |---|---|                │
│ [flagged ⚑]   │  └───────────────────────────────┘ │  (CodeMirror when editing)│
│               │                                     │                           │
│               │  Flags: ⚑ running_footer [strip]    │  [Approve][Needs fix]     │
│               │         ⚑ bad_equation  [clean ✨]   │  [Clean ✨][Reset]        │
└───────────────┴───────────────────────────────────┴───────────────────────────┘
```

- **Left:** page navigator with status dot (pending/approved/needs_fix/fixed), flag badge,
  `edited` marker; toggle "flagged first".
- **Center:** pdf.js renders the current page from the streamed PDF; bbox overlay drawn from
  `layoutJson` polygons; clicking a Markdown block highlights its polygon (block↔md mapping
  from adapter order; page-level v1, block-level if M0 mapping is clean).
- **Right:** Rendered (react-markdown + GFM + KaTeX + image resolution) / Source (CodeMirror)
  toggle; action bar; flag list with one-click suggestions.
- **Keyboard:** `j/k` prev/next page · `a` approve · `f` needs-fix · `e` edit ·
  `r` toggle rendered/source · `[`/`]` prev/next flagged.

## 17. Edit-protection & re-conversion semantics

- A page is **edited** when a `PATCH` changes `markdown` to differ from current (sets `editedAt`).
  `POST /pages/:id/reset` clears it.
- `POST /books/:id/convert` defaults `overwriteEdited: false`. Re-conversion produces a fresh
  page set and, per page number:
  - **Not edited:** `markdown` and `originalMarkdown` ← new conversion (re-baselined).
  - **Edited, `overwriteEdited: false`:** keep the user's `markdown` + `editedAt`; update
    `originalMarkdown` to the new baseline and **flag `diverged`** (UI offers a diff: keep mine /
    take new).
  - **Edited, `overwriteEdited: true`:** overwrite everything, clear `editedAt`.
- **Page-count change caveat:** preservation aligns by `pageNumber`. If new settings change
  pagination, alignment may be wrong; the convert dialog **warns** when the new `pageCount`
  differs from the old, and recommends `overwriteEdited` or accepting misalignment. Documented
  limitation (full content-based realignment is out of scope).

## 18. Frontend design

- **Pages** (`pages/`, default-export, registered in `routes.manifest.ts`): `LibraryPage`,
  `BookDetailPage`, `ReviewPage`. Dialogs: `UploadDialog`, `ReConvertDialog`, `ConfirmDialog`.
- **Hooks** (`hooks/`, TanStack Query + key factories): `use-books`, `use-book`, `use-pages`,
  `use-page`, `use-tags`, `use-jobs` (with `refetchInterval` while a job is active),
  `use-system-status`.
- **Data access:** all via `lib/api.ts` (Eden Treaty `api.books…`) + `unwrap(...)`. Query keys
  from factories only.
- **New deps:** `pdfjs-dist`, `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex`,
  `katex`, `@uiw/react-codemirror`, `@codemirror/lang-markdown`, a diff component
  (`react-diff-viewer-continued` or a small custom one over a diff lib).
- **Components reused from the template:** `PageHeader`, `DataTable` (Library), `FormDialog`
  (Upload/re-convert), `ConfirmDialog`, `Badge` (status/flags), `Tabs` (rendered/source),
  `Tooltip`, `Skeleton`, `toast`. The Review workspace is a new bespoke layout (not a CRUD
  archetype) composed from primitives.
- **Markdown image resolution:** rewrite relative image src → `/api/books/:id/images/:name`.

## 19. GPU / VRAM management

- RTX A6000, **48 GB**. Budget: marker Surya models ≈ 3–5 GB + `gemma4:26b` ≈ 18 GB ≈ **~23 GB**,
  leaving ~25 GB headroom. `gemma4:31b` (~20 GB) also fits. Both Gemmas at once (~38 GB) is
  possible but unnecessary.
- **Both stay resident.** No app-driven load/unload. Worker concurrency 1 ⇒ one marker run at a
  time ⇒ one burst of LLM calls at a time. Ollama `keep_alive` long so Gemma stays warm.
- **Rule:** QA model defaults to the conversion model to avoid loading a *second* LLM. Picking a
  different QA model is allowed but warns about extra VRAM.
- `VERIFY-IN-M0`: measure real peak VRAM during an LLM-assisted conversion; confirm no OOM with
  marker + gemma4:26b co-resident.

## 20. Configuration (env)

Only `lib/env.ts` reads `process.env` (fail-fast). New vars:

| var | default | purpose |
|---|---|---|
| `DATABASE_PATH` | `../../data/app.db` | template default |
| `NODE_ENV` | `development` | template |
| `MARKER_URL` | `http://localhost:8001` | marker_server base (deterministic, no LLM) |
| `DATA_DIR` | `<repo>/data` (host) | root for books/ (host view) |
| `MARKER_DATA_DIR` | `/data` | data root as the marker container sees it (path translation) |
| `MAX_UPLOAD_MB` | `200` | upload cap |
| `CONVERT_TIMEOUT_MS` | `1800000` (30m) | marker call timeout |
| `OLLAMA_BASE_URL` / `OLLAMA_QA_MODEL` | — | **M5 only** — direct QA-assist client, not wired yet |
| `LINT_HEADER_FREQ` | `0.25` | header/footer recurrence threshold |
| `LINT_GAP_RATIO` | `0.6` | extraction-gap threshold |
| `LINT_MIN_CHARS` | `20` | empty-page threshold |

`AUTH_TOKEN`/`VITE_AUTH_TOKEN` become **optional** under Mode A (kept for an easy Mode B switch).
Build-time SPA: `VITE_API_URL` (empty=same-origin), `VITE_APP_NAME` (`Book2MD`).

## 21. Error handling, logging, observability

- **Envelope + typed errors** as the template: `BadRequestError` (bad input, non-PDF, unknown
  model), `NotFoundError` (book/page), `ConflictError`/409 (convert already running),
  `BadGatewayError` (marker/Ollama bad response), `ServiceUnavailableError` (unreachable/timeout).
- **Correlation IDs** (`X-Request-ID`) thread through logs + error bodies (template default).
- **Job logging:** each stage transition logged with `jobId`, `bookId`, durations; marker +
  Ollama call latencies logged. Failures store a concise `error` on the job + book and the full
  detail in logs (`pino`).
- **System status** endpoint (§12.6) for an at-a-glance "services up" UI badge.

## 22. Security & privacy

- **Local only, by hard requirement** (copyrighted source). No outbound calls for conversion or
  inference — marker → native Ollama, both on-box. No telemetry/error tracker.
- Mode A: bound to localhost. If ever exposed on the LAN, follow the template's pre-expose
  checklist and switch to Mode B (shared token) first.
- Upload safety: validate PDF magic bytes + size; store under a server-generated slug (never use
  client filename as a path); never execute uploaded content.
- `ENABLE_SWAGGER=false` outside local dev.

## 23. Testing strategy

- **API (`bun:test`):** per route, happy-path + validation failure + envelope shape. Mode A means
  no 401 test; instead assert input validation (non-PDF rejected, unknown model rejected) and
  error mapping (marker down → `ServiceUnavailableError` envelope, mocked).
- **marker adapter:** unit test against a **recorded M0 fixture** (real marker JSON) → asserts
  page split, image extraction, markdown derivation, layout parsing.
- **Lint functions:** pure unit tests with crafted inputs per check (header detection,
  dehyphenation, KaTeX-invalid equations, ragged tables, extraction gap).
- **Frontend (Vitest):** `DataTable`/Library filtering; ReviewPage status transitions + keyboard
  handlers; Markdown rendering (math/table) smoke test; diff accept/reject.
- **Definition of done:** `bun run check` green; `bun run check:reference` clean after eject.

## 24. Milestones & acceptance criteria

Each milestone is independently useful; M0 front-loads the unknowns.

- **M0 — Infra spike (validation only, no app code).**
  - Build the `marker` Docker image; `docker compose up -d marker`; confirm GPU visible in-container.
  - Convert a **real textbook PDF** with `use_llm` → gemma4:26b; record outputs to a fixture.
  - **Resolve:** exact marker response shape; the markdown/layout strategy (A/B/C, §13); whether
    gemma4 vision works via OllamaService; peak VRAM with both resident; image output mechanics.
  - **Done when:** a documented fixture + a written decision on §13 strategy + measured VRAM, and
    a `curl`-level conversion works end to end.
- **M1 — The spine.** `books` + `jobs` tables + worker; upload → convert → marker adapter → split
  into `pages` → store images/outputs on disk; Library lists books with live job status. **Eject
  the reference feature here.** Done: upload a PDF in the UI, watch it convert, see pages in the DB.
- **M2 — Browse & read.** Book detail; rendered Markdown (KaTeX/tables/images); export (`book.md`
  + download); tags + search/filter on Library. Done: convert, read rendered output, export a clean
  `.md` a KB could ingest.
- **M3 — Review workspace v1.** pdf.js side-by-side; per-page status; rendered/source toggle;
  inline edit with protection; review progress. Done: review a book page-by-page, edit + approve,
  progress persists and resumes.
- **M4 — Make QA fast.** Lint catalog (§16.1) + flagged-first ordering; book-wide rules (§16.2);
  bulk approve; keyboard shortcuts; bbox overlay/alignment (if M0 boxes are usable). Done: a book's
  systematic artifacts cleared with a handful of rule applies + flagged-page review.
- **M5 — Gemma QA assistant — CUT.** Decided unnecessary: marker's base output + lint + human
  review cover QA without an LLM, keeping Book2MD fully LLM-free.
- **M6 — Polish & hardening.** Re-convert flow honoring protection (§17); job failure/cancel UX;
  `/api/system/status` UI; backups; docs aligned (`WIRED.md`, `ARCHITECTURE.md` escape-hatch note,
  this spec). Done: `bun run check` green, docs match reality, a restore tested.

## 25. Risks, open questions, decisions log

**Risks — RESOLVED in M0 (see "M0 outcomes" near the top).**
- R1 ✅ — marker JSON gives per-block `polygon`+`bbox`+`html`+`section_hierarchy`; pages are
  top-level children with page-indexed ids. Side-by-side alignment is real.
- R2 ✅ — no-LLM base output already yields clean, KaTeX-ready LaTeX in `<math>` tags (derive
  Markdown from json html). Equation correctness = KaTeX-validate + targeted fix + human review,
  not bulk LLM.
- R3 ✅ — gemma4 *does* run through marker's Ollama service (via our custom server), but
  LLM-in-the-loop is too slow to use by default (minutes/page, hours/book) — **dropped**.
- R4 ✅ — marker idle ≈ 3.9 GB; no-LLM conversion is light. Big LLMs load only for opt-in QA
  assist, never bulk conversion.

**Open questions (non-blocking, defaults chosen).**
- Per-page conversion progress — deferred; stage-based progress for v1 (could chunk by page_range).
- Block↔Markdown mapping granularity for click-to-highlight — page-level v1, block-level if clean.
- Batch LLM cleanup auto-apply policy — opt-in, off by default (M5).

**Decisions log (from kickoff Q&A).**
- Auth: **Mode A**. · Organization: **flat list + tags**. · Edits: **protect edits, re-convert is
  deliberate**. · Output: **disk folder tree + in-app download**. · PDFs: **assume mixed, OCR-capable**
  (textbooks, math-heavy, LaTeX matters; figures shown but not gated). · Scale: **one book at a time**
  (but a large corpus → browse/QA must scale). · GPU: **marker + one Gemma resident together**.
  · Services: **marker dockerized (GPU) via compose; Ollama native on host**.
  · **Conversion: NO-LLM by default** (M0 finding — LLM-in-loop = hours/book; base math is clean).
  LaTeX correctness via KaTeX-validate → targeted fix (`texify`/`gemma4:e4b` on flagged crops) →
  human QA. Big Gemma (`26b`/`31b`) reserved for opt-in on-demand QA assist, not conversion.

## 26. Glossary

- **marker / marker_server** — the PDF→Markdown engine (Surya models) and its FastAPI server.
- **LLM-assist** — marker calling a multimodal LLM per block to improve tables/equations/layout.
- **Layout / polygon** — per-block bounding geometry from marker, used for PDF↔Markdown alignment.
- **Lint** — cheap heuristic checks that flag likely extraction artifacts for review.
- **Edit-protection** — re-conversion never silently overwrites a page the user hand-edited.
- **Adapter** — the seam (`lib/marker.ts`) normalizing marker output into our `Page` shape.

---

When done building: `bun run check` green, `bun run eject:reference` run, docs updated to match.
