import { beforeAll, describe, expect, it } from 'bun:test'
import { db } from '../db'
import { books, pages } from '../db/schema'
import { api, json } from './helpers'

let bookId: number

beforeAll(() => {
  const book = db
    .insert(books)
    .values({ title: 'QA', slug: 'qa-test', originalFilename: 'q.pdf', status: 'converted' })
    .returning()
    .get()
  bookId = book.id
  db.insert(pages)
    .values([
      { bookId, pageNumber: 1, markdown: 'Header X\n\nBody one, long enough to count here.', originalMarkdown: 'x' },
      { bookId, pageNumber: 2, markdown: 'Header X\n\nBody two, long enough to count here.', originalMarkdown: 'x' },
      { bookId, pageNumber: 3, markdown: 'Header X\n\nBody three, long enough to count here.', originalMarkdown: 'x' },
      { bookId, pageNumber: 4, markdown: 'Header X\n\n42', originalMarkdown: 'x' },
    ])
    .run()
})

describe('QA-fast endpoints', () => {
  it('POST /lint flags pages', async () => {
    const res = await api(`/api/books/${bookId}/lint`, { method: 'POST' })
    expect(res.status).toBe(200)
    const d = (await json(res)).data
    expect(d.pages).toBe(4)
    expect(d.flagged).toBeGreaterThan(0)
  })

  it('GET pages?sort=flags includes flagTypes', async () => {
    const res = await api(`/api/books/${bookId}/pages?sort=flags`)
    const d = (await json(res)).data
    expect(Array.isArray(d)).toBe(true)
    expect(d[0]).toHaveProperty('flagTypes')
  })

  it('POST /strip removes a running header book-wide', async () => {
    const res = await api(`/api/books/${bookId}/strip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ line: 'Header X' }),
    })
    expect((await json(res)).data.affected).toBe(4)
  })

  it('POST /approve-all approves remaining pending pages', async () => {
    const res = await api(`/api/books/${bookId}/approve-all`, { method: 'POST' })
    expect((await json(res)).data.approved).toBe(4)
  })
})
