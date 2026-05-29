import { describe, expect, it } from 'bun:test'
import { api } from './helpers'

const SECURITY_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
]

function assertHeaders(res: Response) {
  for (const h of SECURITY_HEADERS) expect(res.headers.has(h)).toBe(true)
  expect(res.headers.get('x-request-id')).toBeTruthy()
}

// Regression guard: headers must be present on errors too, not just 200s.
describe('security headers + correlation id', () => {
  it('on success (200)', async () => {
    const res = await api('/api/health', {}, false)
    expect(res.status).toBe(200)
    assertHeaders(res)
  })

  it('on a thrown AppError (404 envelope)', async () => {
    const res = await api('/api/books/999999')
    expect(res.status).toBe(404)
    assertHeaders(res)
  })

  it('on an unmatched route (404)', async () => {
    const res = await api('/api/nope')
    expect(res.status).toBe(404)
    assertHeaders(res)
  })
})
