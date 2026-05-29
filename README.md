# Book2MD

A fully-local web app that converts **PDF textbooks → clean Markdown** with a fast,
page-by-page QA workflow — built to feed a downstream knowledge base. Nothing leaves
the machine (the source material is copyrighted), and conversion is **100% deterministic
— no LLM**.

Conversion uses [`marker`](https://github.com/datalab-to/marker) on the GPU. An early
experiment with LLM-assisted conversion (Ollama/Gemma) was measured to take *hours per
book* for no quality gain over marker's already-clean output, so it was dropped — see
[`NEW_PROJECT_SPEC.md`](./NEW_PROJECT_SPEC.md) §"M0 outcomes".

## What it does

1. **Upload** a PDF through the web UI.
2. **Convert** it to Markdown with `marker` (deterministic, GPU, ~30–45 min/book). Math
   comes out as KaTeX-ready `$…$`/`$$…$$`; figures are extracted, captioned, and kept.
3. **Browse & read** the rendered Markdown (math + tables + figures) per book.
4. **QA fast** in a side-by-side review workspace: the source PDF page beside the
   Markdown, an automatic **lint pass** (running headers/footers, page numbers, broken
   equations via KaTeX, ragged tables, hyphenation, …) that flags only the pages that
   need attention, **one-click fixes**, **book-wide strip**, **bulk approve**, inline
   editing with edit-protection, and keyboard-driven navigation.
5. **Export** `book.md` + an `images/` folder your KB can ingest directly.

## Architecture

One **Bun** process serves the Elysia API *and* the React SPA (same-origin, no CORS),
type-safe end-to-end via Eden Treaty, SQLite + Drizzle. Conversion runs in a separate
**GPU Docker service** (`marker_server`) that the API proxies; the SPA never calls it
directly. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and the full design in
[`NEW_PROJECT_SPEC.md`](./NEW_PROJECT_SPEC.md).

| Layer | Choice |
|-------|--------|
| Runtime / API | Bun + Elysia (+ Eden Treaty, zero codegen) |
| DB | SQLite (`bun:sqlite`) + Drizzle ORM |
| Frontend | React 19 + Vite + React Router v7 + TanStack Query v5 |
| UI | Tailwind v4 + Radix + CVA; `react-markdown` + KaTeX; `pdf.js`; CodeMirror |
| Conversion | `marker` (Surya models) in a CUDA Docker service — deterministic, no LLM |
| Auth | Mode A (none) — localhost only |

## Requirements

- An **NVIDIA GPU** + Docker with the **nvidia-container-toolkit** (marker runs on CUDA).
  Built and tested on an RTX A6000 (48 GB).
- [Bun](https://bun.sh) for the app.

## Quickstart

```bash
cp .env.example .env                 # Mode A — no token needed; defaults are fine
bun install

# 1) Start the marker GPU service (first run: builds the image + downloads Surya
#    model weights to a cache volume — a few GB, one time).
docker compose up -d --build marker

# 2) Set up the DB and run the app (API :4000 + Vite :3000, HMR).
bun run db:migrate
bun run dev
```

Open **http://localhost:3000**, upload a PDF, and watch it convert. Converted books
land under `data/books/<slug>/` (PDF, extracted images, `book.md`); all of `data/` is
git-ignored.

## Everyday commands

```bash
bun run check          # type-check + lint + test (the gate — keep it green)
bun run dev            # local dev with HMR
bun run db:generate    # after editing packages/api/src/db/schema.ts
bun run db:migrate     # apply migrations (also runs on API boot)
docker compose up -d --build marker   # (re)build/start the GPU conversion service
```

## Where things live

- `packages/api` — Bun + Elysia API (books / pages / jobs / tags, the conversion worker,
  the lint catalog `lib/lint.ts`, the marker adapter `lib/marker.ts`)
- `packages/frontend` — React SPA (Library, Book detail, Review workspace)
- `infra/marker` — the marker GPU service Dockerfile
- `NEW_PROJECT_SPEC.md` — the full design spec (data model, API, QA subsystem, milestones)
- `docs/ARCHITECTURE.md` / `docs/DESIGN_SYSTEM.md` — topology + UI system
- `CLAUDE.md` — conventions / how features are wired

## Status

The core loop is complete: **upload → convert → browse/read → review → export.**

| Milestone | |
|---|---|
| Spike, conversion spine, browse & read, review workspace, QA-fast lint | ✅ done |
| Gemma QA assistant | ❌ cut (no LLM — base output + lint + human review suffice) |
| Polish & hardening (deliberate re-convert, job-failure UX, backups) | ☐ remaining |

## Privacy

Everything runs locally; no cloud APIs for conversion or anything else. Uploaded PDFs and
all converted output live under `data/` and are **never** committed (`.gitignore`).
