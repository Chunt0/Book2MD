#!/usr/bin/env bun
/**
 * Import the OpenStax PDFs in GutenburgPress/openstax/ into Book2MD exactly as a
 * webapp upload would: one `books` row (status 'uploaded'), the PDF hardlinked
 * into data/books/<slug>/source.pdf, and subject tags (see TAGS below). With
 * --convert it then POSTs /api/books/:id/convert to the running app so the REAL
 * in-process worker converts them — smallest file first, for fast review feedback.
 *
 * Idempotent: a PDF already imported (matched by original filename) keeps its row
 * but re-applies tags; --convert only (re)triggers books in 'uploaded' or 'failed'.
 *
 * Run from packages/api (so DATA_DIR/db paths resolve to <repo>/data):
 *   DATABASE_PATH=../../data/app.db bun run scripts/import-openstax.ts            # import only
 *   DATABASE_PATH=../../data/app.db bun run scripts/import-openstax.ts --convert  # import + queue conversions
 */
import { copyFile, link, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../src/db'
import { bookTags, books, tags } from '../src/db/schema'
import { bookPaths, ensureBookDirs, slugify } from '../src/lib/storage'

const SRC_DIR = process.env.SRC_DIR ?? '/home/comfy/Book2MD/GutenburgPress/openstax'
const API = process.env.API_URL ?? 'http://localhost:3000'
const doConvert = process.argv.includes('--convert')

// Subject tags per PDF (lowercase-hyphenated, matching existing tag style).
// 'openstax' is added to every book as the source/grouping tag.
const TAGS: Record<string, string[]> = {
  'Additive_Manufacturing_Essentials.pdf': ['engineering', 'manufacturing'],
  'Algebra_1.pdf': ['mathematics', 'algebra'],
  'Algebra_and_Trigonometry_2e.pdf': ['mathematics', 'algebra', 'trigonometry'],
  'American_Government_4e.pdf': ['political-science', 'government', 'social-science'],
  'Anatomy_and_Physiology_2e.pdf': ['biology', 'anatomy', 'physiology', 'medicine'],
  'Astronomy_2e.pdf': ['astronomy', 'physics', 'science'],
  'Biology_2e.pdf': ['biology', 'science'],
  'Biology_for_AP_Courses.pdf': ['biology', 'science', 'ap'],
  'Business_Ethics.pdf': ['business', 'ethics'],
  'Business_Law_I_Essentials.pdf': ['business', 'law'],
  'C_lculo_volumen_1.pdf': ['mathematics', 'calculus', 'spanish'],
  'C_lculo_volumen_2.pdf': ['mathematics', 'calculus', 'spanish'],
  'C_lculo_volumen_3.pdf': ['mathematics', 'calculus', 'spanish'],
  'Calculus_Volume_1.pdf': ['mathematics', 'calculus'],
  'Calculus_Volume_2.pdf': ['mathematics', 'calculus'],
  'Calculus_Volume_3.pdf': ['mathematics', 'calculus'],
  'Chemistry_2e.pdf': ['chemistry', 'science'],
  'Chemistry_Atoms_First_2e.pdf': ['chemistry', 'science'],
  'Clinical_Nursing_Skills.pdf': ['nursing', 'medicine', 'health'],
  'College_Algebra_2e.pdf': ['mathematics', 'algebra'],
  'College_Algebra_2e_with_Corequisite_Support.pdf': ['mathematics', 'algebra'],
  'College_Physics_2e.pdf': ['physics', 'science'],
  'College_Physics_For_AP_Courses_2e.pdf': ['physics', 'science', 'ap'],
  'College_Success.pdf': ['college-success', 'study-skills'],
  'College_Success_Concise.pdf': ['college-success', 'study-skills'],
  'Concepts_of_Biology.pdf': ['biology', 'science'],
  'Contemporary_Mathematics.pdf': ['mathematics'],
  'Elementary_Algebra_2e.pdf': ['mathematics', 'algebra'],
  'Entrepreneurship.pdf': ['business', 'entrepreneurship'],
  'F_sica_universitaria_volumen_1.pdf': ['physics', 'science', 'spanish'],
  'F_sica_universitaria_volumen_2.pdf': ['physics', 'science', 'spanish'],
  'F_sica_universitaria_volumen_3.pdf': ['physics', 'science', 'spanish'],
  'Foundations_of_Information_Systems.pdf': ['information-systems', 'business', 'technology'],
  'Fundamentals_of_Nursing.pdf': ['nursing', 'medicine', 'health'],
  'Intermediate_Algebra_2e.pdf': ['mathematics', 'algebra'],
  'Introducci_n_a_la_estad_stica.pdf': ['mathematics', 'statistics', 'spanish'],
  'Introducci_n_a_la_estad_stica_empresarial.pdf': ['statistics', 'business', 'spanish'],
  'Introduction_to_Anthropology.pdf': ['anthropology', 'social-science'],
  'Introduction_to_Behavioral_Neuroscience.pdf': ['neuroscience', 'psychology', 'biology'],
  'Introduction_to_Business_2e.pdf': ['business'],
  'Introduction_to_Computer_Science.pdf': ['computer-science', 'technology'],
  'Introduction_to_Intellectual_Property.pdf': ['law', 'intellectual-property'],
  'Introduction_to_Philosophy.pdf': ['philosophy', 'humanities'],
  'Introduction_to_Political_Science.pdf': ['political-science', 'social-science'],
  'Introduction_to_Python_Programming.pdf': ['computer-science', 'programming', 'python'],
  'Introduction_to_Sociology_3e.pdf': ['sociology', 'social-science'],
  'Introductory_Business_Statistics_2e.pdf': ['statistics', 'business'],
  'Introductory_Statistics_2e.pdf': ['mathematics', 'statistics'],
  'Lifespan_Development.pdf': ['psychology', 'social-science'],
  'Maternal_Newborn_Nursing.pdf': ['nursing', 'medicine', 'health'],
  'Medical_Surgical_Nursing.pdf': ['nursing', 'medicine', 'health'],
  'Microbiology.pdf': ['biology', 'microbiology', 'science'],
  'Nutrition_for_Nurses.pdf': ['nursing', 'nutrition', 'health'],
  'Organic_Chemistry_A_Tenth_Edition.pdf': ['chemistry', 'organic-chemistry', 'science'],
  'Organizational_Behavior.pdf': ['business', 'management'],
  'Pharmacology_for_Nurses.pdf': ['nursing', 'pharmacology', 'medicine'],
  'Physics.pdf': ['physics', 'science'],
  'Population_Health_for_Nurses.pdf': ['nursing', 'public-health', 'health'],
  'Prealgebra_2e.pdf': ['mathematics', 'algebra'],
  'Prec_lculo_2ed.pdf': ['mathematics', 'precalculus', 'spanish'],
  'Precalculus_2e.pdf': ['mathematics', 'precalculus'],
  'Preparing_for_College_Success.pdf': ['college-success', 'study-skills'],
  'Principles_of_Accounting_Volume_1_Financial_Accounting.pdf': ['accounting', 'finance', 'business'],
  'Principles_of_Accounting_Volume_2_Managerial_Accounting.pdf': ['accounting', 'business'],
  'Principles_of_Data_Science.pdf': ['data-science', 'computer-science', 'statistics'],
  'Principles_of_Economics_3e.pdf': ['economics', 'social-science'],
  'Principles_of_Finance.pdf': ['finance', 'business'],
  'Principles_of_Macroeconomics_3e.pdf': ['economics', 'macroeconomics'],
  'Principles_of_Management.pdf': ['business', 'management'],
  'Principles_of_Marketing.pdf': ['business', 'marketing'],
  'Principles_of_Microeconomics_3e.pdf': ['economics', 'microeconomics'],
  'Psychiatric_Mental_Health_Nursing.pdf': ['nursing', 'mental-health', 'psychology'],
  'Psychology_2e.pdf': ['psychology', 'social-science'],
  'Qu_mica_2ed.pdf': ['chemistry', 'science', 'spanish'],
  'Qu_mica_Comenzando_con_los_tomos_2ed.pdf': ['chemistry', 'science', 'spanish'],
  'Statistics.pdf': ['mathematics', 'statistics'],
  'U_S_History.pdf': ['history', 'social-science'],
  'University_Physics_Volume_1.pdf': ['physics', 'science'],
  'University_Physics_Volume_2.pdf': ['physics', 'science'],
  'University_Physics_Volume_3.pdf': ['physics', 'science'],
  'Workplace_Software_and_Skills.pdf': ['computer-skills', 'technology', 'business'],
  'World_History_Volume_1_to_1500.pdf': ['history', 'world-history'],
  'World_History_Volume_2_from_1400.pdf': ['history', 'world-history'],
  'Writing_Guide_with_Handbook.pdf': ['writing', 'english', 'humanities'],
}

/** All tags for a file: 'openstax' (source) + subject tags. */
function tagsFor(filename: string): string[] {
  return ['openstax', ...(TAGS[filename] ?? [])]
}

/** Filename → human title: drop .pdf, underscores → spaces. (Webapp default keeps
 *  the filename; we tidy it since OpenStax names are underscore-separated.) */
function humanize(filename: string): string {
  return (
    filename
      .replace(/\.pdf$/i, '')
      .replace(/_+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  )
}

// Mirrors uniqueSlug() in routes/books.ts.
function uniqueSlug(title: string): string {
  const base = slugify(title)
  let slug = base
  let n = 2
  while (db.select({ id: books.id }).from(books).where(eq(books.slug, slug)).get()) {
    slug = `${base}-${n++}`
  }
  return slug
}

// Mirrors assignTags() in routes/books.ts: idempotent tag + join-row creation.
function applyTags(bookId: number, names: string[]): void {
  for (const name of names) {
    db.insert(tags).values({ name }).onConflictDoNothing().run()
    const tag = db.select().from(tags).where(eq(tags.name, name)).get()
    if (tag) db.insert(bookTags).values({ bookId, tagId: tag.id }).onConflictDoNothing().run()
  }
}

async function isPdf(path: string): Promise<boolean> {
  return (await Bun.file(path).slice(0, 5).text()).startsWith('%PDF')
}

// ── enumerate PDFs, smallest file first (fast feedback when converting) ─────
const names = (await readdir(SRC_DIR)).filter((f) => f.toLowerCase().endsWith('.pdf'))
const entries = await Promise.all(
  names.map(async (f) => ({ f, path: join(SRC_DIR, f), size: (await stat(join(SRC_DIR, f))).size })),
)
entries.sort((a, b) => a.size - b.size)

const all: { id: number; title: string }[] = []
let added = 0

for (const { f, path, size } of entries) {
  if (!(f in TAGS)) console.log(`?? no tag mapping for ${f} — tagging 'openstax' only`)

  const existing = db
    .select()
    .from(books)
    .where(and(eq(books.originalFilename, f), isNull(books.deletedAt)))
    .get()
  if (existing) {
    applyTags(existing.id, tagsFor(f)) // re-apply tags on re-run (idempotent)
    all.push({ id: existing.id, title: existing.title })
    continue
  }
  if (!(await isPdf(path))) {
    console.log(`!! not a PDF, skipping: ${f}`)
    continue
  }

  const title = humanize(f)
  const slug = uniqueSlug(title)
  const created = db
    .insert(books)
    .values({ title, slug, originalFilename: f, sizeBytes: size, status: 'uploaded' })
    .returning()
    .get()

  await ensureBookDirs(slug)
  const dest = bookPaths(slug).pdf
  try {
    await link(path, dest) // hardlink — same filesystem, no 8GB duplication
  } catch {
    await copyFile(path, dest)
  }
  applyTags(created.id, tagsFor(f))

  all.push({ id: created.id, title })
  added++
  console.log(`+ #${String(created.id).padStart(3)}  ${(size / 1e6).toFixed(0).padStart(4)}MB  ${title}  [${tagsFor(f).join(', ')}]`)
}

console.log(`\nImported ${added} new book(s); ${all.length - added} already present (${all.length} total).`)

if (!doConvert) {
  console.log('Import-only (no --convert) — books are status "uploaded". Re-run with --convert to queue them.')
  process.exit(0)
}

// ── trigger the real worker; only for books that need it ────────────────────
console.log(`\nQueuing conversions (smallest first) via ${API} ...`)
let queued = 0
for (const b of all) {
  const row = db.select({ status: books.status }).from(books).where(eq(books.id, b.id)).get()
  if (!row || (row.status !== 'uploaded' && row.status !== 'failed')) {
    console.log(`  skip   #${b.id}  ${b.title}  (status: ${row?.status})`)
    continue
  }
  try {
    const res = await fetch(`${API}/api/books/${b.id}/convert`, { method: 'POST' })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { code?: string } } | null
    if (res.ok && body?.ok) {
      queued++
      console.log(`  queued #${b.id}  ${b.title}`)
    } else {
      console.log(`  fail   #${b.id}  ${b.title}: HTTP ${res.status} ${body?.error?.code ?? ''}`)
    }
  } catch (e) {
    console.log(`  ERROR  #${b.id}  ${b.title}: ${String(e)}`)
  }
}
console.log(`\nQueued ${queued} conversion(s). They run 4 at a time on the GPU — watch progress in the webapp.`)
