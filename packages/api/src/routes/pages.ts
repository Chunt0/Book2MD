import { and, asc, desc, eq, gt, lt } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../db'
import { type Page, pages } from '../db/schema'
import { BadRequestError, NotFoundError } from '../lib/errors'
import { applySuggestion, type Flag, lintPage } from '../lib/lint'
import { ok } from '../lib/response'
import { idParam } from '../lib/schemas'

// Single-page detail + edits (the QA workspace). Book-scoped page *lists* live
// under /api/books/:id/pages (routes/books.ts).

const nowIso = () => new Date().toISOString()

const PAGE_STATUS = t.Union([
  t.Literal('pending'),
  t.Literal('approved'),
  t.Literal('needs_fix'),
  t.Literal('fixed'),
])

function serializePage(page: Page) {
  const prev = db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.bookId, page.bookId), lt(pages.pageNumber, page.pageNumber)))
    .orderBy(desc(pages.pageNumber))
    .limit(1)
    .get()
  const next = db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.bookId, page.bookId), gt(pages.pageNumber, page.pageNumber)))
    .orderBy(asc(pages.pageNumber))
    .limit(1)
    .get()
  return {
    id: page.id,
    bookId: page.bookId,
    pageNumber: page.pageNumber,
    markdown: page.markdown,
    originalMarkdown: page.originalMarkdown,
    status: page.status,
    edited: page.editedAt !== null,
    flags: JSON.parse(page.flagsJson) as unknown[],
    layout: page.layoutJson ? JSON.parse(page.layoutJson) : null,
    pageWidth: page.pageWidth,
    pageHeight: page.pageHeight,
    neighbors: { prevId: prev?.id ?? null, nextId: next?.id ?? null },
  }
}

function getPage(id: number): Page {
  const page = db.select().from(pages).where(eq(pages.id, id)).get()
  if (!page) throw new NotFoundError('Page not found')
  return page
}

const pagesRoutes = new Elysia({ prefix: '/api/pages' })
  .get('/:id', ({ params }) => ok(serializePage(getPage(params.id))), { params: idParam })
  .patch(
    '/:id',
    ({ params, body }) => {
      const page = getPage(params.id)
      const updates: Partial<Page> = { updatedAt: nowIso() }
      // Edit-protection: a real markdown change stamps editedAt (NEW_PROJECT_SPEC §17).
      if (body.markdown !== undefined && body.markdown !== page.markdown) {
        updates.markdown = body.markdown
        updates.editedAt = nowIso()
      }
      if (body.status !== undefined) updates.status = body.status
      const updated = db.update(pages).set(updates).where(eq(pages.id, page.id)).returning().get()
      return ok(serializePage(updated ?? page))
    },
    {
      params: idParam,
      body: t.Object({ markdown: t.Optional(t.String()), status: t.Optional(PAGE_STATUS) }),
    },
  )
  .post(
    '/:id/reset',
    ({ params }) => {
      const page = getPage(params.id)
      const updated = db
        .update(pages)
        .set({ markdown: page.originalMarkdown, editedAt: null, status: 'pending', updatedAt: nowIso() })
        .where(eq(pages.id, page.id))
        .returning()
        .get()
      return ok(serializePage(updated ?? page))
    },
    { params: idParam },
  )
  // Apply a flag's one-click suggestion (dehyphenate / strip line / normalize / dedupe),
  // then re-lint the page. Stamps editedAt when the text changes (NEW_PROJECT_SPEC §16.1/§17).
  .post(
    '/:id/apply-suggestion',
    ({ params, body }) => {
      const page = getPage(params.id)
      const flags = JSON.parse(page.flagsJson) as Flag[]
      const flag = flags[body.index]
      if (!flag?.suggestion) throw new BadRequestError('No suggestion at that index')
      const next = applySuggestion(page.markdown, flag.suggestion)
      const updates: Partial<Page> = { updatedAt: nowIso(), flagsJson: JSON.stringify(lintPage(next)) }
      if (next !== page.markdown) {
        updates.markdown = next
        updates.editedAt = nowIso()
      }
      const updated = db.update(pages).set(updates).where(eq(pages.id, page.id)).returning().get()
      return ok(serializePage(updated ?? page))
    },
    { params: idParam, body: t.Object({ index: t.Number() }) },
  )

export default pagesRoutes
