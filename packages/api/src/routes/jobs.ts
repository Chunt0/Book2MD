import { desc, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../db'
import { jobs } from '../db/schema'
import { NotFoundError } from '../lib/errors'
import { ok } from '../lib/response'
import { idParam } from '../lib/schemas'

// Job status — the SPA polls GET /api/jobs/:id while a conversion is active.
const jobsRoutes = new Elysia({ prefix: '/api/jobs' })
  .get(
    '/',
    ({ query }) => {
      const rows =
        query.bookId !== undefined
          ? db.select().from(jobs).where(eq(jobs.bookId, query.bookId)).orderBy(desc(jobs.id)).limit(50).all()
          : db.select().from(jobs).orderBy(desc(jobs.id)).limit(50).all()
      return ok(rows)
    },
    { query: t.Object({ bookId: t.Optional(t.Numeric()) }) },
  )
  .get(
    '/:id',
    ({ params }) => {
      const job = db.select().from(jobs).where(eq(jobs.id, params.id)).get()
      if (!job) throw new NotFoundError('Job not found')
      return ok(job)
    },
    { params: idParam },
  )

export default jobsRoutes
