import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../db'
import { type Book, bookTags, books, jobs, pages, tags } from '../db/schema'
import { env } from '../lib/env'
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors'
import { enqueueConvert } from '../lib/jobs'
import { lintBook, lintPage, stripLine } from '../lib/lint'
import { pageMeta, resolvePagination } from '../lib/pagination'
import { ok } from '../lib/response'
import { idParam } from '../lib/schemas'
import { bookPaths, ensureBookDirs, slugify } from '../lib/storage'

// ── helpers ───────────────────────────────────────────────────────────────
interface Review {
  total: number
  approved: number
  needsFix: number
  flagged: number
}
const EMPTY_REVIEW: Review = { total: 0, approved: 0, needsFix: 0, flagged: 0 }

function uniqueSlug(title: string): string {
  const base = slugify(title)
  let slug = base
  let n = 2
  while (db.select({ id: books.id }).from(books).where(eq(books.slug, slug)).get()) {
    slug = `${base}-${n++}`
  }
  return slug
}

function tagsForBooks(ids: number[]): Map<number, { id: number; name: string }[]> {
  const map = new Map<number, { id: number; name: string }[]>()
  if (ids.length === 0) return map
  const rows = db
    .select({ bookId: bookTags.bookId, id: tags.id, name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(bookTags.tagId, tags.id))
    .where(inArray(bookTags.bookId, ids))
    .all()
  for (const r of rows) {
    const list = map.get(r.bookId) ?? []
    list.push({ id: r.id, name: r.name })
    map.set(r.bookId, list)
  }
  return map
}

function reviewForBooks(ids: number[]): Map<number, Review> {
  const map = new Map<number, Review>()
  if (ids.length === 0) return map
  const rows = db
    .select({
      bookId: pages.bookId,
      total: sql<number>`count(*)`,
      approved: sql<number>`sum(case when ${pages.status} = 'approved' then 1 else 0 end)`,
      needsFix: sql<number>`sum(case when ${pages.status} = 'needs_fix' then 1 else 0 end)`,
      flagged: sql<number>`sum(case when ${pages.flagsJson} <> '[]' then 1 else 0 end)`,
    })
    .from(pages)
    .where(inArray(pages.bookId, ids))
    .groupBy(pages.bookId)
    .all()
  for (const r of rows) {
    map.set(r.bookId, {
      total: Number(r.total),
      approved: Number(r.approved),
      needsFix: Number(r.needsFix),
      flagged: Number(r.flagged),
    })
  }
  return map
}

function serialize(b: Book, tagList: { id: number; name: string }[] = [], review: Review = EMPTY_REVIEW) {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    slug: b.slug,
    status: b.status,
    pageCount: b.pageCount,
    sizeBytes: b.sizeBytes,
    errorMessage: b.errorMessage,
    approvedAt: b.approvedAt,
    createdAt: b.createdAt,
    convertedAt: b.convertedAt,
    tags: tagList,
    review,
  }
}

function assignTags(bookId: number, csv: string): void {
  for (const raw of csv.split(',')) {
    const name = raw.trim()
    if (!name) continue
    db.insert(tags).values({ name }).onConflictDoNothing().run()
    const tag = db.select().from(tags).where(eq(tags.name, name)).get()
    if (tag) db.insert(bookTags).values({ bookId, tagId: tag.id }).onConflictDoNothing().run()
  }
}

function getActiveBook(id: number): Book {
  const book = db
    .select()
    .from(books)
    .where(and(eq(books.id, id), isNull(books.deletedAt)))
    .get()
  if (!book) throw new NotFoundError('Book not found')
  return book
}

// ── routes ──────────────────────────────────────────────────────────────
const booksRoutes = new Elysia({ prefix: '/api/books' })
  .get(
    '/',
    ({ query }) => {
      const { limit, offset } = resolvePagination(query)
      const conds = [isNull(books.deletedAt)]
      if (query.status) conds.push(eq(books.status, query.status))
      if (query.q) conds.push(like(books.title, `%${query.q}%`))
      if (query.tagId !== undefined) {
        const ids = db
          .select({ b: bookTags.bookId })
          .from(bookTags)
          .where(eq(bookTags.tagId, query.tagId))
          .all()
          .map((r) => r.b)
        if (ids.length === 0) return ok([], pageMeta(0, limit, offset))
        conds.push(inArray(books.id, ids))
      }
      const where = and(...conds)
      const rows = db.select().from(books).where(where).orderBy(desc(books.id)).limit(limit).offset(offset).all()
      const total = db.select({ c: sql<number>`count(*)` }).from(books).where(where).get()?.c ?? 0
      const ids = rows.map((r) => r.id)
      const tagMap = tagsForBooks(ids)
      const reviewMap = reviewForBooks(ids)
      const data = rows.map((b) => serialize(b, tagMap.get(b.id) ?? [], reviewMap.get(b.id)))
      return ok(data, pageMeta(total, limit, offset))
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
        offset: t.Optional(t.Numeric({ minimum: 0 })),
        q: t.Optional(t.String()),
        status: t.Optional(t.String()),
        tagId: t.Optional(t.Numeric()),
      }),
    },
  )
  .post(
    '/',
    async ({ body }) => {
      const file = body.file
      const bytes = Buffer.from(await file.arrayBuffer())
      if (!bytes.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
        throw new BadRequestError('Uploaded file is not a PDF')
      }

      const fallbackName = file.name?.replace(/\.pdf$/i, '') ?? 'Untitled'
      const title = body.title?.trim() || fallbackName || 'Untitled'
      const slug = uniqueSlug(title)
      const created = db
        .insert(books)
        .values({
          title,
          author: body.author?.trim() || null,
          slug,
          originalFilename: file.name ?? 'upload.pdf',
          sizeBytes: file.size,
          status: 'queued',
        })
        .returning()
        .get()

      await ensureBookDirs(slug)
      await Bun.write(bookPaths(slug).pdf, bytes)
      if (body.tags) assignTags(created.id, body.tags)

      const job = db
        .insert(jobs)
        .values({
          bookId: created.id,
          type: 'convert',
          status: 'queued',
          paramsJson: JSON.stringify({ forceOcr: body.forceOcr === 'true' }),
        })
        .returning()
        .get()
      enqueueConvert(job.id)

      const tagMap = tagsForBooks([created.id])
      return ok({ book: serialize(created, tagMap.get(created.id) ?? []), job })
    },
    {
      body: t.Object({
        file: t.File({ maxSize: env.MAX_UPLOAD_MB * 1024 * 1024 }),
        title: t.Optional(t.String()),
        author: t.Optional(t.String()),
        tags: t.Optional(t.String()),
        forceOcr: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/:id',
    ({ params }) => {
      const book = getActiveBook(params.id)
      const tagMap = tagsForBooks([book.id])
      const reviewMap = reviewForBooks([book.id])
      const latestJob = db.select().from(jobs).where(eq(jobs.bookId, book.id)).orderBy(desc(jobs.id)).limit(1).get()
      return ok({ ...serialize(book, tagMap.get(book.id) ?? [], reviewMap.get(book.id)), latestJob: latestJob ?? null })
    },
    { params: idParam },
  )
  .get(
    '/:id/pages',
    ({ params, query }) => {
      getActiveBook(params.id)
      const rows = db
        .select({
          id: pages.id,
          pageNumber: pages.pageNumber,
          status: pages.status,
          editedAt: pages.editedAt,
          flagsJson: pages.flagsJson,
        })
        .from(pages)
        .where(eq(pages.bookId, params.id))
        .orderBy(pages.pageNumber)
        .all()
      const data = rows.map((p) => {
        const flags = JSON.parse(p.flagsJson) as { type: string }[]
        return {
          id: p.id,
          pageNumber: p.pageNumber,
          status: p.status,
          edited: p.editedAt !== null,
          flagCount: flags.length,
          flagTypes: [...new Set(flags.map((f) => f.type))],
        }
      })
      if (query.sort === 'flags') {
        data.sort((a, b) => b.flagCount - a.flagCount || a.pageNumber - b.pageNumber)
      }
      return ok(data)
    },
    { params: idParam, query: t.Object({ sort: t.Optional(t.String()) }) },
  )
  // Re-run the lint catalog over every page (also auto-runs after conversion).
  .post(
    '/:id/lint',
    ({ params }) => {
      const book = getActiveBook(params.id)
      const rows = db
        .select({ id: pages.id, pageNumber: pages.pageNumber, markdown: pages.markdown })
        .from(pages)
        .where(eq(pages.bookId, book.id))
        .all()
      const flagsByPage = lintBook(rows)
      let flagged = 0
      for (const [pid, flags] of flagsByPage) {
        db.update(pages).set({ flagsJson: JSON.stringify(flags) }).where(eq(pages.id, pid)).run()
        if (flags.length > 0) flagged++
      }
      return ok({ pages: rows.length, flagged })
    },
    { params: idParam },
  )
  // Bulk-approve all still-pending pages.
  .post(
    '/:id/approve-all',
    ({ params }) => {
      const book = getActiveBook(params.id)
      const pending = db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.bookId, book.id), eq(pages.status, 'pending')))
        .all()
      db.update(pages)
        .set({ status: 'approved', updatedAt: sql`(current_timestamp)` })
        .where(and(eq(pages.bookId, book.id), eq(pages.status, 'pending')))
        .run()
      return ok({ approved: pending.length })
    },
    { params: idParam },
  )
  // Strip an exact line from EVERY page (kill a running header/footer book-wide).
  .post(
    '/:id/strip',
    ({ params, body }) => {
      const book = getActiveBook(params.id)
      const line = body.line.trim()
      const rows = db
        .select({ id: pages.id, markdown: pages.markdown })
        .from(pages)
        .where(eq(pages.bookId, book.id))
        .all()
      let affected = 0
      for (const r of rows) {
        const next = stripLine(r.markdown, line)
        if (next !== r.markdown) {
          db.update(pages)
            .set({
              markdown: next,
              editedAt: sql`(current_timestamp)`,
              flagsJson: JSON.stringify(lintPage(next)),
              updatedAt: sql`(current_timestamp)`,
            })
            .where(eq(pages.id, r.id))
            .run()
          affected++
        }
      }
      return ok({ affected })
    },
    { params: idParam, body: t.Object({ line: t.String({ minLength: 1 }) }) },
  )
  .post(
    '/:id/convert',
    ({ params, body }) => {
      const book = getActiveBook(params.id)
      const active = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.bookId, book.id), eq(jobs.type, 'convert'), inArray(jobs.status, ['queued', 'running'])))
        .get()
      if (active) throw new ConflictError('A conversion is already in progress for this book')
      const job = db
        .insert(jobs)
        .values({
          bookId: book.id,
          type: 'convert',
          status: 'queued',
          paramsJson: JSON.stringify({ forceOcr: body?.forceOcr ?? false }),
        })
        .returning()
        .get()
      db.update(books).set({ status: 'queued' }).where(eq(books.id, book.id)).run()
      enqueueConvert(job.id)
      return ok({ job })
    },
    {
      params: idParam,
      body: t.Optional(t.Object({ forceOcr: t.Optional(t.Boolean()) })),
    },
  )
  .delete(
    '/:id',
    ({ params }) => {
      const updated = db
        .update(books)
        .set({ deletedAt: sql`(current_timestamp)` })
        .where(and(eq(books.id, params.id), isNull(books.deletedAt)))
        .returning()
        .get()
      if (!updated) throw new NotFoundError('Book not found')
      return ok({ id: updated.id, deleted: true })
    },
    { params: idParam },
  )
  // Assemble current pages → book.md on disk (the KB contract) + stream it down.
  .get(
    '/:id/export',
    async ({ params, set }) => {
      const book = getActiveBook(params.id)
      const rows = db
        .select({ markdown: pages.markdown })
        .from(pages)
        .where(eq(pages.bookId, book.id))
        .orderBy(pages.pageNumber)
        .all()
      const content = rows.map((r) => r.markdown).join('\n\n')
      await writeFile(bookPaths(book.slug).bookMd, content)
      set.headers['content-type'] = 'text/markdown; charset=utf-8'
      set.headers['content-disposition'] = `attachment; filename="${book.slug}.md"`
      return content
    },
    { params: idParam },
  )
  // Extracted images referenced by the rendered Markdown.
  .get(
    '/:id/images/:name',
    async ({ params, set }) => {
      const book = getActiveBook(params.id)
      const file = Bun.file(join(bookPaths(book.slug).imagesDir, basename(params.name)))
      if (!(await file.exists())) throw new NotFoundError('Image not found')
      set.headers['cache-control'] = 'private, max-age=3600'
      return file
    },
    { params: t.Object({ id: t.Numeric(), name: t.String() }) },
  )
  // The source PDF (download now; pdf.js viewer in M3).
  .get(
    '/:id/pdf',
    async ({ params, set }) => {
      const book = getActiveBook(params.id)
      const file = Bun.file(bookPaths(book.slug).pdf)
      if (!(await file.exists())) throw new NotFoundError('PDF not found')
      set.headers['content-type'] = 'application/pdf'
      return file
    },
    { params: idParam },
  )

export default booksRoutes
