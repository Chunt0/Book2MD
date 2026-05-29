import { beforeAll, describe, expect, it } from 'bun:test'
import { db } from '../db'
import { books, pages } from '../db/schema'
import { api, json } from './helpers'

let pageId: number

beforeAll(() => {
  const book = db
    .insert(books)
    .values({ title: 'Patch Test', slug: 'patch-test', originalFilename: 'x.pdf', status: 'converted' })
    .returning()
    .get()
  const page = db
    .insert(pages)
    .values({ bookId: book.id, pageNumber: 1, markdown: 'orig', originalMarkdown: 'orig' })
    .returning()
    .get()
  pageId = page.id
})

function patch(id: number, body: unknown) {
  return api(`/api/pages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('page edit-protection', () => {
  it('PATCH markdown stamps editedAt (edited=true)', async () => {
    const res = await patch(pageId, { markdown: 'edited text' })
    expect(res.status).toBe(200)
    const d = (await json(res)).data
    expect(d.markdown).toBe('edited text')
    expect(d.edited).toBe(true)
  })

  it('PATCH status updates review status', async () => {
    const res = await patch(pageId, { status: 'approved' })
    expect((await json(res)).data.status).toBe('approved')
  })

  it('reset reverts markdown, clears edited, sets status pending', async () => {
    const res = await api(`/api/pages/${pageId}/reset`, { method: 'POST' })
    const d = (await json(res)).data
    expect(d.markdown).toBe('orig')
    expect(d.edited).toBe(false)
    expect(d.status).toBe('pending')
  })

  it('PATCH rejects an invalid status (422)', async () => {
    const res = await patch(pageId, { status: 'bogus' })
    expect(res.status).toBe(422)
  })

  it('PATCH 404s for a missing page', async () => {
    const res = await patch(999999, { status: 'approved' })
    expect(res.status).toBe(404)
  })
})
