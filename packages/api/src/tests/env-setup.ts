// Imported FIRST by setup.ts so these are set before any module reads env.ts.
// (ESM evaluates imports in order; this file has no imports, so its assignments
// run before the db/app modules are imported.)
process.env.NODE_ENV = 'test'
process.env.DATABASE_PATH = ':memory:'
process.env.AUTH_TOKEN = 'test-token'
process.env.ENABLE_SWAGGER = 'false'
// Keep any disk writes (uploads) out of the repo data dir during tests.
process.env.DATA_DIR = '/tmp/book2md-test-data'
