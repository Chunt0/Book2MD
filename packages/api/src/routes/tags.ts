import { eq, sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { db } from '../db'
import { bookTags, tags } from '../db/schema'
import { ok } from '../lib/response'

// Flat tag list with book counts (Library filter).
const tagsRoutes = new Elysia({ prefix: '/api/tags' }).get('/', () => {
  const rows = db
    .select({ id: tags.id, name: tags.name, count: sql<number>`count(${bookTags.bookId})` })
    .from(tags)
    .leftJoin(bookTags, eq(bookTags.tagId, tags.id))
    .groupBy(tags.id)
    .orderBy(tags.name)
    .all()
  return ok(rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) })))
})

export default tagsRoutes
