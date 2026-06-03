#!/usr/bin/env bun
/**
 * Dump every converted book to a flat <out>/<title>.md — the QA-current markdown
 * (same assembly the export endpoint / web "Export" button produce, so any page
 * edits and equation fixes are included). Built to sit beside the Gutenberg
 * <category>/<title>.md tree as a uniform text corpus for the downstream vector DB.
 *
 * Text only — figures aren't pulled (they don't vectorize as text; captions live
 * in the markdown already). For one book's images use `book2md export <id> --images`.
 *
 *   bun packages/api/scripts/export-all.ts                    # -> ./book-exports/
 *   bun packages/api/scripts/export-all.ts --out /some/dir    # custom target
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : 'book-exports'

const safe = (s: string) => s.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim() || 'untitled'

interface BookRow {
  id: number
  title: string
  pageCount: number | null
}

async function apiJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`)
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { message: string } } | null
  if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  return body.data as T
}

// Enumerate every converted book (paginate at the API's 200 cap).
const books: BookRow[] = []
for (let offset = 0; ; offset += 200) {
  const page = await apiJson<BookRow[]>(`/api/books?status=converted&limit=200&offset=${offset}`)
  books.push(...page)
  if (page.length < 200) break
}

await mkdir(OUT, { recursive: true })
const used = new Set<string>()
let ok = 0
let bytes = 0
for (const b of books) {
  try {
    const res = await fetch(`${API}/api/books/${b.id}/export`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = await res.text()
    let name = `${safe(b.title)}.md`
    if (used.has(name)) name = `${safe(b.title)} (#${b.id}).md` // disambiguate same-title books
    used.add(name)
    await writeFile(join(OUT, name), md)
    ok++
    bytes += md.length
    console.log(`+ ${name}  (${(md.length / 1024).toFixed(0)} KB, ${b.pageCount ?? '?'} pages)`)
  } catch (e) {
    console.error(`! #${b.id} ${b.title}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
console.log(`\nexported ${ok}/${books.length} book(s) -> ${OUT}/  (${(bytes / 1e6).toFixed(1)} MB total)`)
