#!/usr/bin/env bun
/**
 * book2md — a terminal client for Book2MD.
 *
 * Thin HTTP wrapper over the running API (same contract the web UI uses), so the
 * server stays the single source of truth: uploads queue real conversion jobs on
 * the GPU lanes, lint/strip/approve hit the same handlers, export streams the
 * assembled book.md. The server must be up (docker compose up -d, or `bun run dev`).
 *
 *   bun scripts/book2md.ts <command> [args]            # from packages/api
 *   bun run book2md <command> [args]                   # from repo root
 *
 * Set API_URL to point elsewhere (default http://localhost:3000; dev API is :4000).
 * Run `book2md help` for the full command list.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const TOKEN = process.env.AUTH_TOKEN ?? '' // Mode A: unused; sent if Mode B is ever enabled.

// ── tiny ANSI helpers (no-op when piped) ──────────────────────────────────
const tty = Boolean(process.stdout.isTTY)
const paint = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s: string) => paint('2', s)
const bold = (s: string) => paint('1', s)
const red = (s: string) => paint('31', s)
const green = (s: string) => paint('32', s)
const yellow = (s: string) => paint('33', s)
const cyan = (s: string) => paint('36', s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── HTTP envelope client ──────────────────────────────────────────────────
interface ApiOpts {
  query?: Record<string, string>
  body?: unknown
  form?: FormData
}

function authHeaders(): Record<string, string> {
  return TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}
}

async function apiJson<T = any>(method: string, path: string, opts: ApiOpts = {}): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : ''
  const init: RequestInit = { method, headers: authHeaders() }
  if (opts.form) {
    init.body = opts.form
  } else if (opts.body !== undefined) {
    init.headers = { ...authHeaders(), 'content-type': 'application/json' }
    init.body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(`${API}${path}${qs}`, init)
  } catch (e) {
    throw new Error(`cannot reach API at ${API} — is the server running? (${String(e)})`)
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { code: string; message: string } } | null
  if (!res.ok || !body || body.ok === false) {
    throw new Error(body?.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status} ${res.statusText}`)
  }
  return body!.data as T
}

async function apiText(path: string): Promise<string> {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null
    throw new Error(body?.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`)
  }
  return res.text()
}

async function apiBuffer(path: string): Promise<Buffer> {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── shared types (a subset of the API's serialized shapes) ─────────────────
interface BookRow {
  id: number
  title: string
  author: string | null
  slug: string
  status: string
  pageCount: number | null
  tags: { id: number; name: string }[]
  review: { total: number; approved: number; needsFix: number; flagged: number }
  latestJob?: JobRow | null
}
interface JobRow {
  id: number
  bookId: number | null
  type: string
  status: string
  stage: string | null
  progress: number
  error: string | null
  resultJson: string | null
  createdAt: string
}

// Page through /api/books at the API's max page size (limit caps at 200).
async function fetchAllBooks(): Promise<BookRow[]> {
  const all: BookRow[] = []
  for (let offset = 0; ; offset += 200) {
    const page = await apiJson<BookRow[]>('GET', '/api/books', { query: { limit: '200', offset: String(offset) } })
    all.push(...page)
    if (page.length < 200) break
  }
  return all
}

// ── book resolution: accept a numeric id, a slug, or a title fragment ──────
async function resolveBook(ref: string): Promise<BookRow> {
  let id: number
  if (/^\d+$/.test(ref)) {
    id = Number(ref)
  } else {
    const list = await fetchAllBooks()
    const lower = ref.toLowerCase()
    const bySlug = list.find((b) => b.slug === ref)
    const exact = list.filter((b) => b.title.toLowerCase() === lower)
    const fuzzy = list.filter((b) => b.slug.includes(lower) || b.title.toLowerCase().includes(lower))
    const match = bySlug ?? (exact.length === 1 ? exact[0] : fuzzy.length === 1 ? fuzzy[0] : undefined)
    if (!match) {
      if (fuzzy.length === 0) throw new Error(`no book matches "${ref}" — try an id or slug (book2md list)`)
      throw new Error(`"${ref}" is ambiguous: ${fuzzy.slice(0, 6).map((b) => `#${b.id} ${b.slug}`).join(', ')} — use an id`)
    }
    id = match.id
  }
  return apiJson<BookRow>('GET', `/api/books/${id}`)
}

// ── job progress rendering (live in a TTY, change-only when piped) ─────────
function statusTag(status: string): string {
  if (status === 'succeeded' || status === 'converted' || status === 'approved') return green(status)
  if (status === 'failed' || status === 'canceled') return red(status)
  if (status === 'running' || status === 'converting' || status === 'queued') return cyan(status)
  return dim(status)
}

function bar(p: number, width = 22): string {
  const filled = Math.max(0, Math.min(width, Math.round((p ?? 0) * width)))
  return `${'█'.repeat(filled)}${dim('░'.repeat(width - filled))}`
}

function jobLine(label: string, j: JobRow): string {
  const pct = Math.round((j.progress ?? 0) * 100)
  const tail =
    j.status === 'failed' && j.error
      ? red(j.error.split('\n')[0].slice(0, 60))
      : j.status === 'succeeded'
        ? green(resultSummary(j))
        : dim(j.stage ?? '')
  return `  ${label.slice(0, 30).padEnd(30)} [${bar(j.progress)}] ${String(pct).padStart(3)}%  ${statusTag(j.status)}  ${tail}`
}

function resultSummary(j: JobRow): string {
  try {
    const r = j.resultJson ? (JSON.parse(j.resultJson) as { pageCount?: number; durationMs?: number }) : null
    if (r?.pageCount) return `${r.pageCount} pages${r.durationMs ? ` in ${Math.round(r.durationMs / 1000)}s` : ''}`
  } catch {
    /* ignore */
  }
  return 'done'
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

/** Poll the given jobs until all are terminal; returns the final job rows. */
async function waitForJobs(items: { jobId: number; label: string }[], quiet = false): Promise<JobRow[]> {
  let prevLines = 0
  const lastKey = new Map<number, string>()
  while (true) {
    const jobs = await Promise.all(
      items.map((it) => apiJson<JobRow>('GET', `/api/jobs/${it.jobId}`).catch(() => null)),
    )
    const lines = jobs.map((j, i) => (j ? jobLine(items[i].label, j) : `  ${items[i].label.slice(0, 30).padEnd(30)} ${dim('(unavailable)')}`))
    if (!quiet) {
      if (tty) {
        if (prevLines) process.stdout.write(`\x1b[${prevLines}A`)
        for (const l of lines) process.stdout.write(`\x1b[2K${l}\n`)
        prevLines = lines.length
      } else {
        jobs.forEach((j, i) => {
          if (!j) return
          const key = `${j.status}:${j.stage}:${Math.round(j.progress * 100)}`
          if (lastKey.get(items[i].jobId) !== key) {
            lastKey.set(items[i].jobId, key)
            console.log(jobLine(items[i].label, j))
          }
        })
      }
    }
    if (jobs.every((j) => j && TERMINAL.has(j.status))) return jobs as JobRow[]
    await sleep(2000)
  }
}

// ── argv parser: positionals + flags (known booleans don't eat the next arg) ─
const BOOL_FLAGS = new Set(['force-ocr', 'no-wait', 'wait', 'json', 'images', 'flagged', 'failed', 'quiet', 'help'])
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true
      } else {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) flags[key] = true
        else flags[key] = (i++, next)
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

// ── table printing for `list` / `pages` / `jobs` ───────────────────────────
function printBooks(books: BookRow[]): void {
  if (books.length === 0) return console.log(dim('no books'))
  console.log(bold(`  ${'ID'.padEnd(5)}${'STATUS'.padEnd(12)}${'PAGES'.padEnd(7)}${'REVIEW'.padEnd(20)}TITLE`))
  for (const b of books) {
    const r = b.review
    const review =
      r.total === 0
        ? dim('—')
        : r.flagged > 0
          ? yellow(`${r.approved}/${r.total} ✓  ${r.flagged}⚑`)
          : green(`${r.approved}/${r.total} ✓`)
    const tags = b.tags.length ? dim(`  [${b.tags.map((t) => t.name).join(', ')}]`) : ''
    console.log(
      `  ${String(b.id).padEnd(5)}${statusTag(b.status).padEnd(12 + (tty ? 9 : 0))}${String(b.pageCount ?? '·').padEnd(7)}${review.padEnd(20 + (tty ? 18 : 0))}${b.title}${tags}`,
    )
  }
  console.log(dim(`\n  ${books.length} book(s)`))
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdConvert(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const files = positionals
  if (files.length === 0) throw new Error('usage: book2md convert <pdf...> [--title T] [--author A] [--tags a,b] [--force-ocr] [--no-wait]')
  const queued: { jobId: number; label: string }[] = []
  for (const path of files) {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      console.error(red(`! not found, skipping: ${path}`))
      continue
    }
    const form = new FormData()
    form.append('file', file, basename(path))
    if (str(flags.title) && files.length === 1) form.append('title', str(flags.title)!)
    if (str(flags.author)) form.append('author', str(flags.author)!)
    if (str(flags.tags)) form.append('tags', str(flags.tags)!)
    if (flags['force-ocr']) form.append('forceOcr', 'true')
    const { book, job } = await apiJson<{ book: BookRow; job: JobRow }>('POST', '/api/books', { form })
    queued.push({ jobId: job.id, label: `#${book.id} ${book.title}` })
    console.log(green(`+ queued #${book.id}  ${book.title}  (job ${job.id})`))
  }
  if (queued.length === 0) throw new Error('nothing queued')
  if (flags['no-wait']) {
    console.log(dim(`\nQueued ${queued.length} conversion(s). Watch with: book2md status <id>`))
    return
  }
  console.log(dim(`\nConverting (${queued.length}) — runs on the GPU lanes, Ctrl-C is safe (the server keeps going):\n`))
  const done = await waitForJobs(queued, Boolean(flags.quiet))
  const failed = done.filter((j) => j.status === 'failed')
  console.log(failed.length ? red(`\n${failed.length}/${done.length} failed.`) : green(`\nAll ${done.length} converted. Review/export with: book2md status <id>`))
  if (failed.length) process.exitCode = 1
}

// Re-trigger conversion on books that already exist (failed/uploaded) — by ref,
// or in bulk with --failed / --status S. Hits POST /api/books/:id/convert (the
// same handler the UI's re-convert button uses); does NOT re-upload a file.
async function cmdReconvert(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  let targets: BookRow[]
  if (flags.failed || str(flags.status)) {
    const status = flags.failed ? 'failed' : str(flags.status)!
    targets = (await fetchAllBooks()).filter((b) => b.status === status)
    if (targets.length === 0) throw new Error(`no books with status "${status}"`)
  } else if (positionals.length) {
    targets = []
    for (const ref of positionals) targets.push(await resolveBook(ref))
  } else {
    throw new Error('usage: book2md reconvert <ref...> | --failed | --status S   [--force-ocr] [--no-wait]')
  }
  const queued: { jobId: number; label: string }[] = []
  for (const b of targets) {
    try {
      const { job } = await apiJson<{ job: JobRow }>('POST', `/api/books/${b.id}/convert`, flags['force-ocr'] ? { body: { forceOcr: true } } : {})
      queued.push({ jobId: job.id, label: `#${b.id} ${b.title}` })
      console.log(green(`+ re-queued #${b.id}  ${b.title}  (job ${job.id})`))
    } catch (e) {
      console.error(red(`! #${b.id} ${b.title}: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  if (queued.length === 0) throw new Error('nothing re-queued')
  if (flags['no-wait']) return void console.log(dim(`\nRe-queued ${queued.length}. Watch with: book2md jobs  (or  book2md list --status converting)`))
  console.log(dim(`\nConverting (${queued.length}) on the GPU lanes:\n`))
  const done = await waitForJobs(queued, Boolean(flags.quiet))
  const failed = done.filter((j) => j.status === 'failed')
  console.log(failed.length ? red(`\n${failed.length}/${done.length} failed again.`) : green(`\nAll ${done.length} converted.`))
  if (failed.length) process.exitCode = 1
}

// Soft-delete books (sets deletedAt — hidden from the library, reversible; the
// on-disk data under data/books/<slug>/ is left in place). By ref, or in bulk
// with --tag NAME / --status S.
async function cmdDelete(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  let targets: BookRow[]
  if (str(flags.tag) || str(flags.status)) {
    const all = await fetchAllBooks()
    targets = str(flags.tag)
      ? all.filter((b) => b.tags.some((t) => t.name === str(flags.tag)))
      : all.filter((b) => b.status === str(flags.status))
    if (targets.length === 0) throw new Error(`no books match ${str(flags.tag) ? `tag "${str(flags.tag)}"` : `status "${str(flags.status)}"`}`)
  } else if (positionals.length) {
    targets = []
    for (const ref of positionals) targets.push(await resolveBook(ref))
  } else {
    throw new Error('usage: book2md delete <ref...> | --tag NAME | --status S')
  }
  console.log(dim(`deleting ${targets.length} book(s):`))
  for (const b of targets) console.log(`  #${b.id}  ${b.title}  ${dim(`(${b.status})`)}`)
  let n = 0
  for (const b of targets) {
    try {
      await apiJson('DELETE', `/api/books/${b.id}`)
      n++
    } catch (e) {
      console.error(red(`! #${b.id} ${b.title}: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  console.log(green(`\ndeleted ${n}/${targets.length} book(s)`) + dim(' — soft delete; on-disk data under data/books/ is left in place'))
}

async function cmdList(flags: Record<string, string | true>): Promise<void> {
  const query: Record<string, string> = {}
  if (str(flags.status)) query.status = str(flags.status)!
  if (str(flags.q)) query.q = str(flags.q)!
  if (str(flags.limit)) query.limit = str(flags.limit)!
  if (str(flags.tagId)) query.tagId = str(flags.tagId)!
  else if (str(flags.tag)) {
    const tags = await apiJson<{ id: number; name: string }[]>('GET', '/api/tags')
    const t = tags.find((x) => x.name === str(flags.tag))
    if (!t) throw new Error(`no tag named "${str(flags.tag)}"`)
    query.tagId = String(t.id)
  }
  const books = await apiJson<BookRow[]>('GET', '/api/books', { query })
  if (flags.json) return void console.log(JSON.stringify(books, null, 2))
  printBooks(books)
}

async function cmdStatus(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const ref = positionals[0]
  if (!ref) throw new Error('usage: book2md status <id|slug> [--wait]')
  const book = await resolveBook(ref)
  if (flags.json) return void console.log(JSON.stringify(book, null, 2))
  const r = book.review
  console.log(`${bold(`#${book.id}`)} ${bold(book.title)}${book.author ? dim(` — ${book.author}`) : ''}`)
  console.log(`  slug     ${book.slug}`)
  console.log(`  status   ${statusTag(book.status)}${book.pageCount ? dim(`  (${book.pageCount} pages)`) : ''}`)
  console.log(`  tags     ${book.tags.length ? book.tags.map((t) => t.name).join(', ') : dim('none')}`)
  if (r.total) console.log(`  review   ${r.approved}/${r.total} approved, ${r.needsFix} need fix, ${yellow(`${r.flagged} flagged`)}`)
  const job = book.latestJob
  if (job) {
    console.log(`  job      ${jobLine(job.type, job).trim()}`)
    if (flags.wait && !TERMINAL.has(job.status)) {
      console.log(dim('\nfollowing job…\n'))
      await waitForJobs([{ jobId: job.id, label: `#${book.id} ${book.title}` }])
    }
  }
}

async function cmdExport(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const ref = positionals[0]
  if (!ref) throw new Error('usage: book2md export <id|slug> [--out PATH] [--images]')
  const book = await resolveBook(ref)
  const md = await apiText(`/api/books/${book.id}/export`)
  const out = str(flags.out)
  const mdPath = out?.endsWith('.md') ? out : join(out ?? '.', `${book.slug}.md`)
  await mkdir(dirname(mdPath), { recursive: true })
  await writeFile(mdPath, md)
  console.log(green(`wrote ${mdPath}`) + dim(`  (${(md.length / 1024).toFixed(0)} KB)`))
  if (flags.images) {
    const refs = [...new Set([...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g), ...md.matchAll(/<img[^>]+src=["']([^"']+)["']/g)].map((m) => basename(m[1])))].filter(
      (n) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n),
    )
    if (refs.length) {
      const imagesDir = join(dirname(mdPath), 'images')
      await mkdir(imagesDir, { recursive: true })
      let n = 0
      for (const name of refs) {
        try {
          await writeFile(join(imagesDir, name), await apiBuffer(`/api/books/${book.id}/images/${encodeURIComponent(name)}`))
          n++
        } catch {
          console.error(dim(`  ! missing image: ${name}`))
        }
      }
      console.log(green(`wrote ${n}/${refs.length} images → ${imagesDir}`))
    } else {
      console.log(dim('no image references found'))
    }
  }
}

async function cmdLint(positionals: string[]): Promise<void> {
  const book = await resolveBook(requireRef(positionals[0], 'lint'))
  const { pages, flagged } = await apiJson<{ pages: number; flagged: number }>('POST', `/api/books/${book.id}/lint`, {})
  console.log(`linted ${pages} pages — ${flagged ? yellow(`${flagged} flagged`) : green('all clean')}`)
}

async function cmdStrip(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const ref = positionals[0]
  const line = str(flags.line) ?? positionals[1]
  if (!ref || !line) throw new Error('usage: book2md strip <id|slug> --line "exact running header/footer text"')
  const book = await resolveBook(ref)
  const { affected } = await apiJson<{ affected: number }>('POST', `/api/books/${book.id}/strip`, { body: { line } })
  console.log(`stripped "${line}" from ${affected ? green(`${affected} page(s)`) : dim('0 pages')}`)
}

async function cmdApprove(positionals: string[]): Promise<void> {
  const book = await resolveBook(requireRef(positionals[0], 'approve'))
  const { approved } = await apiJson<{ approved: number }>('POST', `/api/books/${book.id}/approve-all`, {})
  console.log(green(`approved ${approved} pending page(s)`))
}

async function cmdPages(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const book = await resolveBook(requireRef(positionals[0], 'pages'))
  const rows = await apiJson<
    { id: number; pageNumber: number; status: string; edited: boolean; flagCount: number; flagTypes: string[] }[]
  >('GET', `/api/books/${book.id}/pages`, { query: { sort: 'flags' } })
  const shown = flags.flagged ? rows.filter((p) => p.flagCount > 0) : rows
  if (flags.json) return void console.log(JSON.stringify(shown, null, 2))
  if (shown.length === 0) return void console.log(dim('no pages'))
  console.log(bold(`  ${'PAGE'.padEnd(6)}${'STATUS'.padEnd(12)}${'FLAGS'.padEnd(7)}TYPES`))
  for (const p of shown) {
    const flags_ = p.flagCount ? yellow(String(p.flagCount).padEnd(7)) : dim('·'.padEnd(7))
    console.log(`  ${String(p.pageNumber).padEnd(6)}${statusTag(p.status).padEnd(12 + (tty ? 9 : 0))}${flags_}${dim(p.flagTypes.join(', '))}${p.edited ? cyan('  (edited)') : ''}`)
  }
  console.log(dim(`\n  ${shown.length} page(s)`))
}

async function cmdJobs(flags: Record<string, string | true>): Promise<void> {
  const query: Record<string, string> = {}
  if (str(flags.book)) query.bookId = String((await resolveBook(str(flags.book)!)).id)
  const jobs = await apiJson<JobRow[]>('GET', '/api/jobs', { query })
  if (flags.json) return void console.log(JSON.stringify(jobs, null, 2))
  if (jobs.length === 0) return void console.log(dim('no jobs'))
  for (const j of jobs) {
    console.log(`  ${bold(`job ${j.id}`)}  book ${j.bookId ?? '·'}  ${j.type}  ${statusTag(j.status)}  ${String(Math.round(j.progress * 100)).padStart(3)}%  ${dim(j.stage ?? '')}${j.error ? red(`  ${j.error.split('\n')[0].slice(0, 50)}`) : ''}`)
  }
}

function requireRef(ref: string | undefined, cmd: string): string {
  if (!ref) throw new Error(`usage: book2md ${cmd} <id|slug>`)
  return ref
}

const ex = (cmd: string, note?: string) => `  ${cmd}${note ? `\n      ${dim(note)}` : ''}`
const HELP = `${bold('book2md')} — terminal client for the Book2MD API ${dim(`(→ ${API})`)}

Convert PDFs, inspect the library, QA pages, and export Markdown — all from the
terminal.

${bold('HOW IT WORKS')}
  Every command is a thin HTTP call to the running API — the same endpoints the
  web UI uses, so the server stays the single source of truth: a ${cyan('convert')} queues a
  real conversion job on the GPU lanes, and ${cyan('lint')}/${cyan('strip')}/${cyan('approve')} hit the same
  handlers as the UI. No logic is duplicated here and there is no direct DB access.

  The API must be running — ${cyan('docker compose up -d')} (full stack on :3000) or
  ${cyan('bun run dev')} (dev API on :4000). Point at either with ${cyan('API_URL')}.

${bold('USAGE')}
  bun run book2md <command> [args]          ${dim('# from the repo root')}
  book2md <command> [args]                  ${dim('# if linked onto your PATH')}

  A ${bold('<ref>')} is a numeric id, an exact slug, or a unique title fragment
  ${dim('e.g.  70   american-government-4e   "u s history"')}

${bold('CONVERT & WATCH')}
  convert <pdf...>           upload PDF(s), queue conversion, follow live progress
      ${dim('--title T')}             ${dim('title for a single file (batches derive it per filename)')}
      ${dim('--author A')}            ${dim('author metadata')}
      ${dim('--tags a,b,c')}          ${dim('comma-separated tags')}
      ${dim('--force-ocr')}           ${dim('force OCR (scanned pages / garbled text layer)')}
      ${dim('--no-wait')}             ${dim('queue and return immediately, do not follow')}
      ${dim('--quiet')}               ${dim('suppress the live progress bar')}
  reconvert <ref...>         re-run conversion on books that already exist (no re-upload)
      ${dim('--failed')}              ${dim('re-queue every book with status=failed')}
      ${dim('--status S')}            ${dim('re-queue every book with the given status')}
      ${dim('--force-ocr  --no-wait  --quiet')}

${bold('INSPECT')}
  list                       books with status, page count, review stats
      ${dim('--status S')}            ${dim('uploaded | queued | converting | converted | failed')}
      ${dim('--tag NAME  --q TEXT  --limit N (API caps at 200)')}
  status <ref>               book detail + latest job        ${dim('(--wait to follow a live job)')}
  pages  <ref>               per-page status & lint flags, most-flagged first   ${dim('(--flagged)')}
  jobs                       recent conversion jobs          ${dim('(--book <ref> to filter)')}
  delete <ref...>            soft-delete books (hide from library; data/ left on disk)
      ${dim('--tag NAME')}            ${dim('delete every book with the given tag')}
      ${dim('--status S')}            ${dim('delete every book with the given status')}

${bold('QA & EXPORT')}
  lint    <ref>              re-run the deterministic linter over the whole book
  strip   <ref> --line TEXT  delete an exact line from every page ${dim('(kill a running header/footer)')}
  approve <ref>              bulk-approve all pending pages
  export  <ref>              download the assembled book.md
      ${dim('--out PATH')}            ${dim('a DIR/ (writes <slug>.md inside) or a path/to/file.md')}
      ${dim('--images')}              ${dim('also download referenced images into a sibling images/')}

  ${dim('--json works on list, status, pages, and jobs for scripting.')}

${bold('EXAMPLES')}
${dim('  # Convert one PDF with metadata and watch it finish')}
${ex('book2md convert calculus-vol1.pdf --title "Calculus Vol 1" --tags math,calculus')}

${dim('  # Queue a whole folder without blocking, then check on it later')}
${ex('book2md convert ./pdfs/*.pdf --no-wait')}
${ex('book2md list --status converting')}
${ex('book2md status 70 --wait')}

${dim('  # Find pages needing attention, kill a book-wide running header, re-lint')}
${ex('book2md pages american-government-4e --flagged')}
${ex('book2md strip american-government-4e --line "CHAPTER 3"')}
${ex('book2md lint american-government-4e')}

${dim('  # Approve everything, then export for the knowledge base')}
${ex('book2md approve 70')}
${ex('book2md export 70 --out ./export/ --images')}

${dim('  # Talk to the dev server (API on :4000) and emit JSON for scripts')}
${ex('API_URL=http://localhost:4000 book2md list --status converted --json')}`

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const cmd = positionals.shift()
  if (!cmd || cmd === 'help' || flags.help) {
    console.log(HELP)
    return
  }
  switch (cmd) {
    case 'convert':
      return cmdConvert(positionals, flags)
    case 'reconvert':
      return cmdReconvert(positionals, flags)
    case 'delete':
    case 'rm':
      return cmdDelete(positionals, flags)
    case 'list':
    case 'ls':
      return cmdList(flags)
    case 'status':
    case 'show':
      return cmdStatus(positionals, flags)
    case 'export':
      return cmdExport(positionals, flags)
    case 'lint':
      return cmdLint(positionals)
    case 'strip':
      return cmdStrip(positionals, flags)
    case 'approve':
      return cmdApprove(positionals)
    case 'pages':
      return cmdPages(positionals, flags)
    case 'jobs':
      return cmdJobs(flags)
    default:
      throw new Error(`unknown command "${cmd}" — run: book2md help`)
  }
}

main().catch((e: unknown) => {
  console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`))
  process.exit(1)
})
