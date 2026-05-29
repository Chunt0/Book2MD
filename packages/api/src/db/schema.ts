import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Book2MD data model — see NEW_PROJECT_SPEC.md §10. SQLite via Drizzle: integer
// autoincrement PKs, ISO-text timestamps defaulting to current_timestamp, JSON
// stored as text (parsed at the edge), enums as text + a TS union. After editing:
// `bun run db:generate`.

// ── books: an uploaded PDF + its conversion lifecycle ─────────────────────
export const books = sqliteTable(
  'books',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    author: text('author'),
    slug: text('slug').notNull().unique(), // filesystem-safe folder name under data/books/
    originalFilename: text('original_filename').notNull(),
    // lifecycle: uploaded → queued → converting → converted | failed
    status: text('status').notNull().default('uploaded'),
    pageCount: integer('page_count'),
    sizeBytes: integer('size_bytes'),
    conversionSettings: text('conversion_settings'), // JSON: { outputFormat, forceOcr }
    errorMessage: text('error_message'),
    approvedAt: text('approved_at'), // set by "mark book approved"
    createdAt: text('created_at')
      .notNull()
      .default(sql`(current_timestamp)`),
    convertedAt: text('converted_at'),
    deletedAt: text('deleted_at'), // soft delete
  },
  (t) => [index('books_status_idx').on(t.status), index('books_deleted_idx').on(t.deletedAt)],
)

// ── tags + book_tags: flat, free-form, many-to-many organization ──────────
export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
})

export const bookTags = sqliteTable(
  'book_tags',
  {
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.tagId] }), index('book_tags_tag_idx').on(t.tagId)],
)

// ── pages: one converted page; the editable working copy for QA ───────────
export const pages = sqliteTable(
  'pages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(), // 1-based
    markdown: text('markdown').notNull(), // working text (edited/cleaned)
    originalMarkdown: text('original_markdown').notNull(), // conversion baseline (diff + edit-protection)
    // review: pending → approved | needs_fix → fixed → approved
    status: text('status').notNull().default('pending'),
    editedAt: text('edited_at'), // set on first manual edit — the edit-protection flag
    flagsJson: text('flags_json').notNull().default('[]'), // lint findings
    layoutJson: text('layout_json'), // marker per-block polygons/bbox for alignment
    pageWidth: integer('page_width'),
    pageHeight: integer('page_height'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (t) => [
    uniqueIndex('pages_book_page_idx').on(t.bookId, t.pageNumber),
    index('pages_book_status_idx').on(t.bookId, t.status),
  ],
)

// ── jobs: long-running work (POST → id → poll). See lib/jobs.ts worker ─────
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // convert | lint | qa_llm
    status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | canceled
    stage: text('stage'), // human label: "calling marker", "splitting pages", …
    progress: real('progress').notNull().default(0), // 0..1
    paramsJson: text('params_json'),
    resultJson: text('result_json'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(current_timestamp)`),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('jobs_status_idx').on(t.status), index('jobs_book_idx').on(t.bookId)],
)

export type Book = typeof books.$inferSelect
export type NewBook = typeof books.$inferInsert
export type Tag = typeof tags.$inferSelect
export type Page = typeof pages.$inferSelect
export type Job = typeof jobs.$inferSelect

// Status unions (validated at the route edge; SQLite has no native enum).
export type BookStatus = 'uploaded' | 'queued' | 'converting' | 'converted' | 'failed'
export type PageStatus = 'pending' | 'approved' | 'needs_fix' | 'fixed'
export type JobType = 'convert' | 'lint' | 'qa_llm'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
