#!/usr/bin/env bun
/**
 * Repair the one *safely* fixable class of bad_equation flags: literal `$`
 * (currency) that marker left unescaped inside a math span, e.g. a `$$…$$` block
 * containing "$90,000 - $45,000 = $33,750". The only transform is `$` → `\$`
 * inside a span, and it is kept ONLY if KaTeX then parses the result (the same
 * throwOnError check the linter uses) — so a real equation is never altered and
 * nothing is ever "fixed" into different-but-parseable garbage.
 *
 * Truncated/unclosed equations (page-split artifacts) and marker's empty
 * \begin{array}{ccc…} figure-garbage are left untouched — completing them would
 * fabricate content.
 *
 *   bun packages/api/scripts/fix-equations.ts            # dry run (default)
 *   bun packages/api/scripts/fix-equations.ts --apply    # write + re-lint
 */
import { Database } from 'bun:sqlite'
import katex from 'katex'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const APPLY = process.argv.includes('--apply')

// KaTeX logs non-fatal strict-mode warnings (e.g. "\\ does nothing in display
// mode") via console.warn — a flood across thousands of equations. Mute it; our
// check only cares whether renderToString *throws*, matching the linter exactly.
console.warn = () => {}

function parses(tex: string, display: boolean): boolean {
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: display })
    return true
  } catch {
    return false
  }
}

/** Returns the repaired tex, or null to leave the span exactly as-is. */
function tryFix(tex: string, display: boolean): string | null {
  const t = tex.trim()
  if (!t || parses(t, display)) return null // empty or already-valid → don't touch
  const cand = tex.replace(/(?<!\\)\$/g, '\\$') // escape literal currency $
  if (cand !== tex && parses(cand.trim(), display)) return cand
  return null // not safely fixable
}

interface Example {
  before: string
  after: string
}

/** Scan markdown for $$…$$ and $…$ spans (same shape as lib/lint.ts) and fix in
 *  place. A hand-written scanner, not nested regex, so $ delimiters never shift. */
function fixMath(md: string, examples?: Example[]): { md: string; count: number } {
  let count = 0
  const out: string[] = []
  const n = md.length
  let i = 0
  while (i < n) {
    if (md[i] === '$' && md[i + 1] === '$') {
      const end = md.indexOf('$$', i + 2)
      if (end === -1) {
        out.push(md.slice(i))
        break
      }
      const tex = md.slice(i + 2, end)
      const fixed = tryFix(tex, true)
      out.push(`$$${fixed ?? tex}$$`)
      if (fixed !== null) {
        count++
        if (examples && examples.length < 8) examples.push({ before: tex.trim().slice(0, 70), after: fixed.trim().slice(0, 70) })
      }
      i = end + 2
    } else if (md[i] === '$' && md[i - 1] !== '\\') {
      let j = i + 1
      while (j < n && md[j] !== '$' && md[j] !== '\n') j++
      if (j < n && md[j] === '$') {
        const tex = md.slice(i + 1, j)
        const fixed = tryFix(tex, false)
        out.push(`$${fixed ?? tex}$`)
        if (fixed !== null) {
          count++
          if (examples && examples.length < 8) examples.push({ before: tex.trim().slice(0, 70), after: fixed.trim().slice(0, 70) })
        }
        i = j + 1
      } else {
        out.push(md[i])
        i++
      }
    } else {
      out.push(md[i])
      i++
    }
  }
  return { md: out.join(''), count }
}

const db = new Database('data/app.db')
const rows = db
  .query<{ id: number; bookId: number; markdown: string }, []>(
    "SELECT p.id AS id, p.book_id AS bookId, p.markdown AS markdown FROM pages p JOIN books b ON b.id=p.book_id WHERE b.deleted_at IS NULL AND p.flags_json LIKE '%bad_equation%'",
  )
  .all()

const examples: Example[] = []
const updates: { id: number; md: string }[] = []
const affectedBooks = new Set<number>()
let eqsFixed = 0
for (const r of rows) {
  const { md, count } = fixMath(r.markdown, examples)
  if (count > 0 && md !== r.markdown) {
    updates.push({ id: r.id, md })
    affectedBooks.add(r.bookId)
    eqsFixed += count
  }
}

console.log(`pages carrying a bad_equation flag: ${rows.length}`)
console.log(`safely fixable: ${eqsFixed} equation(s) across ${updates.length} page(s) in ${affectedBooks.size} book(s)`)
console.log('\nexample repairs (before → after):')
for (const e of examples) console.log(`  - ${e.before}\n    → ${e.after}`)

if (!APPLY) {
  console.log('\nDRY RUN — re-run with --apply to write the fixes and re-lint affected books.')
  process.exit(0)
}

const tx = db.transaction((items: { id: number; md: string }[]) => {
  const stmt = db.prepare('UPDATE pages SET markdown=?, edited_at=current_timestamp, updated_at=current_timestamp WHERE id=?')
  for (const u of items) stmt.run(u.md, u.id)
})
tx(updates)
console.log(`\nwrote ${updates.length} page(s).`)

// Re-lint each affected book through the API (book-level lintBook → correct flags).
let relinted = 0
for (const bid of affectedBooks) {
  const res = await fetch(`${API}/api/books/${bid}/lint`, { method: 'POST' }).catch(() => null)
  if (res?.ok) relinted++
}
console.log(`re-linted ${relinted}/${affectedBooks.size} affected book(s).`)
