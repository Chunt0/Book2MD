// Fail-fast environment validation. Parsed ONCE at boot; the API exits with a
// clear message if a required var is missing. Nothing else reads process.env.

import { resolve } from 'node:path'

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    console.error(`[env] Missing required environment variable: ${name}`)
    console.error('[env] Copy .env.example to .env and run scripts/init-project.sh.')
    process.exit(1)
  }
  return v
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export const env = {
  /** SQLite file path, or ":memory:" in tests. */
  DATABASE_PATH: required('DATABASE_PATH'),
  /** Auth Mode A (no auth): token optional, kept for an easy switch to Mode B. */
  AUTH_TOKEN: optional('AUTH_TOKEN', ''),
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: Number(optional('PORT', '3000')),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
  ENABLE_SWAGGER: optional('ENABLE_SWAGGER', 'false') === 'true',
  /** Set in the container to the SPA build dir so the API also serves the SPA. */
  STATIC_DIR: process.env.STATIC_DIR,

  // ── Book2MD: conversion services + storage (SPEC §20) ───────────────────
  /** Absolute host path to the data root (books/ live under it). */
  DATA_DIR: resolve(optional('DATA_DIR', '../../data')),
  /** The data root as the marker container sees it (host↔container translation). */
  MARKER_DATA_DIR: optional('MARKER_DATA_DIR', '/data'),
  /** marker_server base URL (the API proxies it; SPA never calls it directly). */
  MARKER_URL: optional('MARKER_URL', 'http://localhost:8001'),
  /** Upload size cap (MB). */
  MAX_UPLOAD_MB: Number(optional('MAX_UPLOAD_MB', '200')),
  /** Overall conversion budget across all chunks (ms). */
  CONVERT_TIMEOUT_MS: Number(optional('CONVERT_TIMEOUT_MS', '1800000')),
  /** Pages per marker request. Books convert in chunks because marker runs one
   * blocking request per call and Bun's fetch hard-caps at 5 min (oven-sh/bun#16682);
   * smaller chunks stay under the cap and give per-chunk progress. */
  MARKER_CHUNK_PAGES: Number(optional('MARKER_CHUNK_PAGES', '25')),
  /** Per-chunk fetch timeout (ms). Kept under Bun's ~300s fetch cap so a stuck
   * chunk fails cleanly with our message instead of Bun's opaque one. */
  MARKER_CHUNK_TIMEOUT_MS: Number(optional('MARKER_CHUNK_TIMEOUT_MS', '290000')),
  // No LLM / Ollama config — Book2MD conversion + QA are fully deterministic.
} as const

export const isProd = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
