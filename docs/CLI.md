# `book2md` — command-line client

Everything the web UI does, from the terminal. `book2md` is a thin HTTP client over
the running API (`packages/api/scripts/book2md.ts`) — the **server stays the single
source of truth**: uploads queue real conversion jobs on the GPU lanes, and lint /
strip / approve / export hit the same handlers the SPA uses. No second copy of the
business logic, no direct DB access, nothing to drift.

## Prerequisites

The API server must be running — either the full stack (`docker compose up -d`, API on
`:3000`) or local dev (`bun run dev`, API on **`:4000`**). Point the CLI at whichever
with `API_URL`.

## Running it

```bash
bun run book2md <command> [args]          # from the repo root
bun packages/api/scripts/book2md.ts ...   # or invoke directly
(cd packages/api && bun run cli ...)      # or the package script

# dev server runs on :4000, so:
API_URL=http://localhost:4000 bun run book2md list
```

A **book ref** in any command is a numeric id, an exact slug, or a unique title
fragment (e.g. `70`, `american-government-4e`, or `"u s history"`).

## Getting help

`book2md help` (or `book2md` with no arguments, or `--help`) prints a full reference —
a "how it works" summary, every command and flag, and worked examples. It's generated
from the CLI itself, so it's always in sync with the installed version; the sections
below mirror it.

```bash
bun run book2md help
```

## Commands

### Convert & watch

```bash
book2md convert ch1.pdf --title "Algebra" --tags math,algebra
book2md convert *.pdf --no-wait          # queue a batch, don't block
```

Uploads each PDF, queues conversion, and follows progress to completion with a live
bar (Ctrl-C is safe — the server keeps converting). Flags: `--title`, `--author`,
`--tags a,b,c`, `--force-ocr`, `--no-wait`, `--quiet`. `--title` applies only to a
single-file convert; for batches the title is derived from each filename.

```bash
book2md reconvert 70                      # re-run conversion on an existing book (no re-upload)
book2md reconvert --failed --no-wait      # re-queue every failed book in one shot
book2md reconvert --status uploaded       # re-queue everything still in a given status
```

`reconvert` re-triggers conversion on books that already exist (it hits the same
`POST /api/books/:id/convert` as the UI's re-convert button — it does **not** upload a
file). Select books by ref(s), or in bulk with `--failed` / `--status S`. Same
`--force-ocr` / `--no-wait` / `--quiet` flags as `convert`.

### Inspect

```bash
book2md list                              # all books: status, page count, review stats
book2md list --status converted --tag openstax --q physics --json
book2md status <ref> [--wait]             # book detail + latest job (--wait follows it)
book2md pages  <ref> [--flagged]          # per-page status + lint flags (most-flagged first)
book2md jobs   [--book <ref>]             # recent conversion jobs
book2md delete <ref...>                   # soft-delete books (by ref)
book2md delete --tag spanish              # …or in bulk by tag / --status S
```

`delete` is a **soft delete** — it sets `deletedAt`, so the book disappears from the
library but is recoverable, and the on-disk data under `data/books/<slug>/` is left in
place. Select by ref(s), `--tag NAME`, or `--status S`; it prints the list before
deleting.

### QA & export

```bash
book2md lint    <ref>                     # re-run the deterministic linter over the book
book2md strip   <ref> --line "CHAPTER 3"  # delete an exact line from every page (kill a header/footer)
book2md approve <ref>                     # bulk-approve all pending pages
book2md export  <ref> --out ./out/ --images   # write <slug>.md (+ images/) for KB ingestion
```

`export` defaults to `<slug>.md` in the current directory; pass `--out DIR/` for a
folder or `--out path/to/file.md` for an exact path. `--images` parses image
references out of the exported Markdown and downloads them into a sibling `images/`.

`--json` is available on `list`, `status`, `pages`, and `jobs` for scripting.

## Recipes

```bash
# Convert one PDF with metadata and watch it finish
book2md convert calculus-vol1.pdf --title "Calculus Vol 1" --tags math,calculus

# Queue a whole folder without blocking, then check on it later
book2md convert ./pdfs/*.pdf --no-wait
book2md list --status converting
book2md status 70 --wait

# Find pages needing attention, kill a book-wide running header, re-lint
book2md pages american-government-4e --flagged
book2md strip american-government-4e --line "CHAPTER 3"
book2md lint american-government-4e

# Approve everything, then export for the knowledge base
book2md approve 70
book2md export 70 --out ./export/ --images

# Talk to the dev server (API on :4000) and emit JSON for scripts
API_URL=http://localhost:4000 book2md list --status converted --json
```

## How it maps to the API

| Command | Endpoint(s) |
|---------|-------------|
| `convert` | `POST /api/books` (multipart) → poll `GET /api/jobs/:id` |
| `reconvert` | `POST /api/books/:id/convert` (re-trigger; no upload) |
| `delete` | `DELETE /api/books/:id` (soft delete) |
| `list` | `GET /api/books` |
| `status` | `GET /api/books/:id` (+ `GET /api/jobs/:id` with `--wait`) |
| `pages` | `GET /api/books/:id/pages?sort=flags` |
| `jobs` | `GET /api/jobs` |
| `lint` | `POST /api/books/:id/lint` |
| `strip` | `POST /api/books/:id/strip` |
| `approve` | `POST /api/books/:id/approve-all` |
| `export` | `GET /api/books/:id/export` (+ `/images/:name`) |

To add a CLI command, add a handler that calls an existing endpoint — don't reach into
the DB or duplicate route logic. (Bulk importing local PDFs is a separate one-off
script: `packages/api/scripts/import-openstax.ts`.)
