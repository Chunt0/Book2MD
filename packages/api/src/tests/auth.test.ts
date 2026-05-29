import { describe, expect, it } from 'bun:test'
import { api, json } from './helpers'

// Mode A (no auth): every request is the single local user. /api/me always
// resolves with that user — no token required. (NEW_PROJECT_SPEC §2.)
describe('auth (mode A — none)', () => {
  it('returns the local user without a token', async () => {
    const res = await api('/api/me', {}, false)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.data.user.id).toBe('me')
  })
})
