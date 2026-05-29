import { describe, expect, it } from 'bun:test'
import { api, json } from './helpers'

describe('books routes', () => {
  it('GET /api/books returns an ok envelope with an array + page meta', async () => {
    const res = await api('/api/books')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.meta).toBeDefined()
  })

  it('GET /api/books/:id 404s for a missing book', async () => {
    const res = await api('/api/books/999999')
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('POST /api/books rejects a non-PDF upload (before any side effects)', async () => {
    const fd = new FormData()
    fd.append('file', new File(['hello world'], 'notes.txt', { type: 'text/plain' }))
    const res = await api('/api/books', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('GET /api/books/:id/export 404s for a missing book', async () => {
    const res = await api('/api/books/999999/export')
    expect(res.status).toBe(404)
  })

  it('GET /api/books/:id/pdf 404s for a missing book', async () => {
    const res = await api('/api/books/999999/pdf')
    expect(res.status).toBe(404)
  })
})

describe('tags + jobs routes', () => {
  it('GET /api/tags returns an ok array', async () => {
    const res = await api('/api/tags')
    expect(res.status).toBe(200)
    expect((await json(res)).ok).toBe(true)
  })

  it('GET /api/jobs returns an ok array', async () => {
    const res = await api('/api/jobs')
    expect(res.status).toBe(200)
    expect(Array.isArray((await json(res)).data)).toBe(true)
  })
})
