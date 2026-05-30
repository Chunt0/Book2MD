import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { books, jobs, pages } from '../db/schema'
import { env } from './env'
import { ServiceUnavailableError } from './errors'
import { lintBook } from './lint'
import { logger } from './logger'
import { callMarker, parsePaginatedMarkdown, type ParsedPage } from './marker'
import { getPdfPageCount } from './pdf'
import { bookPaths, toMarkerPath, writeImages } from './storage'

// In-process sequential job worker (concurrency 1 — one book at a time, one GPU).
// A book is converted in page-range chunks (MARKER_CHUNK_PAGES each) because
// marker runs one blocking request per call and Bun's fetch hard-caps at ~300s
// (oven-sh/bun#16682) — a whole large book in one call always times out. Chunking
// also gives real per-chunk progress. Enqueue chains onto a promise so jobs run
// one at a time regardless of how many are submitted.

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
    const markerPath = toMarkerPath(p.pdf)
    const forceOcr = params.forceOcr ?? false

    // Chunk by absolute page range. marker rejects any range past the document,
    // so we need the exact count up front to clamp the final chunk. It numbers
    // both {N} page separators and image filenames ABSOLUTELY, so chunks merge
    // with no re-indexing and no image-name collisions.
    const pageCount = await getPdfPageCount(p.pdf)
    const chunkPages = Math.max(1, env.MARKER_CHUNK_PAGES)
    const numChunks = Math.ceil(pageCount / chunkPages)

    const images: Record<string, string> = {}
    const outputs: string[] = []
    const parsed: ParsedPage[] = []
    for (let c = 0; c < numChunks; c++) {
      if (performance.now() - t0 > env.CONVERT_TIMEOUT_MS) {
        throw new Error(`Conversion exceeded ${env.CONVERT_TIMEOUT_MS}ms budget after ${c}/${numChunks} chunks`)
      }
      const startPage = c * chunkPages
      const endPage = Math.min((c + 1) * chunkPages, pageCount) - 1
      db.update(jobs)
        .set({
          stage: `converting pages ${startPage + 1}-${endPage + 1} of ${pageCount} (chunk ${c + 1}/${numChunks})`,
          progress: Number(((c / numChunks) * 0.85).toFixed(3)),
        })
        .where(eq(jobs.id, jobId))
        .run()

      const chunkOpts = { forceOcr, pageRange: `${startPage}-${endPage}`, timeoutMs: env.MARKER_CHUNK_TIMEOUT_MS }
      let resp
      try {
        resp = await callMarker(markerPath, chunkOpts)
      } catch (e) {
        // Retry once on a transient transport failure (timeout/unreachable); an
        // upstream "marker failed" (BadGatewayError) is deterministic — don't retry.
        if (!(e instanceof ServiceUnavailableError)) throw e
        logger.warn({ jobId, bookId: book.id, chunk: c + 1, err: String(e) }, 'marker chunk transient failure — retrying once')
        resp = await callMarker(markerPath, chunkOpts)
      }
      Object.assign(images, resp.images)
      outputs.push(resp.output)
      parsed.push(...parsePaginatedMarkdown(resp.output))
    }

    db.update(jobs).set({ stage: 'post-processing', progress: 0.88 }).where(eq(jobs.id, jobId)).run()
    await writeImages(book.slug, images)
    await writeFile(join(p.markerDir, 'output.md'), outputs.join('\n\n'))

    db.update(jobs).set({ stage: 'splitting pages', progress: 0.92 }).where(eq(jobs.id, jobId)).run()
    // `parsed` already holds absolute-numbered pages across every chunk.
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
