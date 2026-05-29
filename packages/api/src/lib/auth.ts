import { Elysia } from 'elysia'

// ── Auth Mode A: none (localhost only) ───────────────────────────────────
// Book2MD runs on localhost (NEW_PROJECT_SPEC §2), so every request is the
// single local user. `user` is always present on the context. To harden for
// LAN exposure, switch to Mode B (shared bearer): gate /api/* on AUTH_TOKEN
// and have the SPA send `Authorization: Bearer <token>`. See SEED_SPEC §3.

export type User = { id: string } | null

export const authPlugin = new Elysia({ name: 'auth' }).derive(
  { as: 'global' },
  (): { user: User } => ({ user: { id: 'me' } }),
)
