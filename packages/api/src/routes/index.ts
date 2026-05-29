import { Elysia } from 'elysia'
import booksRoutes from './books'
import jobsRoutes from './jobs'
import pagesRoutes from './pages'
import tagsRoutes from './tags'

// ── The single place API routes are registered ───────────────────────────
// Add a resource: create routes/<name>.ts (default-export an Elysia instance
// prefixed `/api/<name>`), then add one `.use(...)` line below. This stays an
// explicit chain (not a runtime glob) on purpose — it's what lets Eden Treaty
// infer the whole API surface as a static type for the frontend. SEED_SPEC §5.13.
export const routes = new Elysia()
  .use(booksRoutes)
  .use(pagesRoutes)
  .use(jobsRoutes)
  .use(tagsRoutes)
