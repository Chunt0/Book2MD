# GOTCHAS.md

The sharp edges. Skim on clone; revisit `[deploy]` ones before exposing the app.

| ID | Gotcha | Tag |
|----|--------|-----|
| G1 | `.env` must exist before anything runs. `scripts/init-project.sh` creates it. | `[setup]` |
| G2 | Use `bun run test`, not bare `bun test` at the root (the frontend needs Vitest + jsdom; `bun run test` dispatches each package's own runner). | `[dev]` |
| G3 | `docker compose up` does **not** hot-reload — use `bun run dev` for HMR. | `[dev]` |
| G4 | Cross-cutting Elysia plugins must be globally scoped (`.derive({ as: 'global' })` / `.as('global')`) or they won't apply to later-registered routes. | `[extend]` |
| G5 | Eden Treaty's first arg is a **domain**, not a path — never pass `/api`. Empty `VITE_API_URL` = same-origin. | `[extend]` |
| G6 | `/docs` (Swagger) is live whenever `ENABLE_SWAGGER=true`. Turn it off before exposing the app. | `[deploy]` |
| G7 | The gitleaks pre-commit hook needs the `gitleaks` binary on PATH. Remove that block in `.lefthook.yml` if you don't want it. | `[setup]` |
| G8 | Dialogs/sheets need a `DialogTitle` + `DialogDescription` (use `sr-only` when decorative). `FormDialog`/`ConfirmDialog` handle this for you. | `[extend]` |
| G9 | `VITE_AUTH_TOKEN` ships in the SPA bundle **by design** (Mode B). Never put any other secret behind a `VITE_` prefix. | `[extend]` |
| G10 | API routes register in `routes/index.ts`; pages register in `routes.manifest.ts`. It's an explicit chain (not a glob) so Eden Treaty can infer the API as a static type — add the line when you add a resource. | `[extend]` |
| G11 | Keep the `@elysiajs/*` packages on the same minor as `elysia` (Eden's types track Elysia). | `[extend]` |
| G12 | Dev runs the API on `:4000` and Vite on `:3000` (Vite proxies `/api`). Production is a single Bun process on `:3000`. Don't set `PORT` in `.env`. | `[dev]` |
| G13 | The CSP is `connect-src 'self'` (same-origin, the default). If you set a non-empty `VITE_API_URL` for split-origin serving, the SPA's API calls get blocked until you widen `connect-src` to that origin in `app.ts` — and you'll also need CORS on the API. | `[extend]` |
| G14 | Bun's `fetch` hard-caps every request at ~300s and **ignores a longer `AbortSignal`** ([oven-sh/bun#16682](https://github.com/oven-sh/bun/issues/16682)). marker runs one blocking request per call, so the converter chunks a book by `page_range` (`MARKER_CHUNK_PAGES`, default 25) to keep each call under the cap. Don't "simplify" it back to one whole-book call — large books will time out at 5 min even though `CONVERT_TIMEOUT_MS` is 30 min. | `[extend]` |
| G15 | The `app` service uses `network_mode: host` and binds the **same `./data`** as marker. Both are required: marker (also host-net) listens on `localhost:8001`, so a bridge-networked app's `localhost` would be itself; and the app writes uploaded PDFs that marker must read by path. If you re-isolate the app's network or volume, conversions break (`marker unreachable` / file-not-found). | `[deploy]` |
| G16 | The PDF review viewer (pdf.js, `PdfPageView`) needs three CSP allowances in `app.ts` — `font-src data:` (embedded fonts), `img-src blob:` (decoded bitmaps), and `script-src 'wasm-unsafe-eval'` (the OpenJPEG/JBIG2 wasm decoders for scanned/JPEG2000 PDFs) — plus pdf.js's sidecar resources (`wasm/`, `cmaps/`, `standard_fonts/`, `iccs/`). Those resources are **not** bundled by Vite; the `pdfjsAssets` plugin in `vite.config.ts` serves them from `node_modules` in dev and copies them to `dist/pdfjs/` for prod, and `PdfPageView` points `getDocument` at `/pdfjs/...`. Drop any piece and pages render blank (text → blank if `font-src` missing; scanned → blank if wasm blocked or unconfigured). This only manifests in the prod build (the API serves the CSP); Vite's dev server has no CSP. | `[extend]` |
