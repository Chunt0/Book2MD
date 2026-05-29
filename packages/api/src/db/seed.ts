import { logger } from '../lib/logger'
import { sqlite } from './index'
import { runMigrations } from './migrate'

// Idempotent seed — safe to run repeatedly. Run via `bun run db:seed`.
export function seed(): void {
  runMigrations()
  // Add idempotent upserts for your own seed data here.
}

if (import.meta.main) {
  seed()
  logger.info('seed complete')
  sqlite.close()
}
