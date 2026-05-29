import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { books, jobs, pages } from '../db/schema'
import { lintBook } from './lint'
import { logger } from './logger'
import { callMarker, parsePaginatedMarkdown } from './marker'
import { bookPaths, toMarkerPath, writeImages } from './storage'

// In-process sequential job worker (concurrency 1 — one book at a time, one GPU).
// The marker call is a single blocking request, so progress is stage-based, not
// per-page (NEW_PROJECT_SPEC §15). Enqueue chains onto a promise so jobs run one
// at a time regardless of how many are submitted.

const nowIso = () => new Date().toISOString()

let queue: Promise<void> = Promise.resolve()

export function enqueueConvert(jobId: number): void {
  queue = queue
    .then(() => runConvert(jobId))
    .catch((err) => logger.error({ jobId, err: String(err) }, 'convert job crashed'))
}

interface ConvertParams {
  forceOcr?: boolean
}

async function runConvert(jobId: number): Promise<void> {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()
  if (!job || job.status === 'canceled') return
  const book = job.bookId ? db.select().from(books).where(eq(books.id, job.bookId)).get() : null
  if (!book) {
    db.update(jobs)
      .set({ status: 'failed', error: 'Book not found', finishedAt: nowIso() })
      .where(eq(jobs.id, jobId))
      .run()
    return
  }

  const params: ConvertParams = job.paramsJson ? JSON.parse(job.paramsJson) : {}
  db.update(jobs)
    .set({ status: 'running', stage: 'calling marker', startedAt: nowIso(), attempts: job.attempts + 1 })
    .where(eq(jobs.id, jobId))
    .run()
  db.update(books).set({ status: 'converting', errorMessage: null }).where(eq(books.id, book.id)).run()

  const t0 = performance.now()
  try {
    const p = bookPaths(book.slug)
    const resp = await callMarker(toMarkerPath(p.pdf), {
      forceOcr: params.forceOcr ?? false,
    })

    db.update(jobs).set({ stage: 'post-processing', progress: 0.7 }).where(eq(jobs.id, jobId)).run()
    await writeImages(book.slug, resp.images)
    await writeFile(join(p.markerDir, 'output.md'), resp.output)

    db.update(jobs).set({ stage: 'splitting pages', progress: 0.85 }).where(eq(jobs.id, jobId)).run()
    const parsed = parsePaginatedMarkdown(resp.output)
    // First-conversion semantics: replace pages wholesale. Edit-protection on
    // re-conversion is M6 (NEW_PROJECT_SPEC §17).
    db.delete(pages).where(eq(pages.bookId, book.id)).run()
    if (parsed.length > 0) {
      const inserted = db
        .insert(pages)
        .values(
          parsed.map((pp) => ({
            bookId: book.id,
            pageNumber: pp.pageNumber,
            markdown: pp.markdown,
            originalMarkdown: pp.markdown,
          })),
        )
        .returning()
        .all()
      db.update(jobs).set({ stage: 'linting', progress: 0.93 }).where(eq(jobs.id, jobId)).run()
      const flagsByPage = lintBook(inserted.map((p) => ({ id: p.id, pageNumber: p.pageNumber, markdown: p.markdown })))
      for (const [pid, flags] of flagsByPage) {
        if (flags.length > 0) {
          db.update(pages).set({ flagsJson: JSON.stringify(flags) }).where(eq(pages.id, pid)).run()
        }
      }
    }

    const finished = nowIso()
    const settings = JSON.stringify({ outputFormat: 'markdown', forceOcr: params.forceOcr ?? false })
    db.update(books)
      .set({ status: 'converted', pageCount: parsed.length, convertedAt: finished, conversionSettings: settings })
      .where(eq(books.id, book.id))
      .run()
    db.update(jobs)
      .set({
        status: 'succeeded',
        stage: 'done',
        progress: 1,
        finishedAt: finished,
        resultJson: JSON.stringify({ pageCount: parsed.length, durationMs: Math.round(performance.now() - t0) }),
      })
      .where(eq(jobs.id, jobId))
      .run()
    logger.info({ jobId, bookId: book.id, pages: parsed.length }, 'conversion succeeded')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const finished = nowIso()
    db.update(jobs).set({ status: 'failed', error: msg, finishedAt: finished }).where(eq(jobs.id, jobId)).run()
    db.update(books).set({ status: 'failed', errorMessage: msg }).where(eq(books.id, book.id)).run()
    logger.error({ jobId, bookId: book.id, err: msg }, 'conversion failed')
  }
}

/** On boot: fail jobs left 'running' by a crash, then re-enqueue 'queued' ones. */
export function initJobs(): void {
  const interrupted = nowIso()
  db.update(jobs)
    .set({ status: 'failed', error: 'Interrupted by server restart', finishedAt: interrupted })
    .where(eq(jobs.status, 'running'))
    .run()
  db.update(books)
    .set({ status: 'failed', errorMessage: 'Conversion interrupted by server restart' })
    .where(eq(books.status, 'converting'))
    .run()
  const queued = db.select().from(jobs).where(eq(jobs.status, 'queued')).all()
  for (const j of queued) enqueueConvert(j.id)
  if (queued.length > 0) logger.info({ count: queued.length }, 'resumed queued jobs')
}
