import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// pdf.js needs its sidecar resources at runtime: the wasm image decoders
// (OpenJPEG/JBIG2 — required for scanned/JPEG2000 PDFs), CMaps, standard fonts
// and ICC profiles. Rather than vendor ~4MB into the repo, serve them straight
// from node_modules in dev and copy them into the build for prod, both under
// `/pdfjs/<dir>/`. PdfPageView points pdf.js at these URLs.
const PDFJS_DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs']
const PDFJS_MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
}

function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url)
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'))
  let outDir = ''
  let isBuild = false
  return {
    name: 'pdfjs-assets',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir)
      isBuild = c.command === 'build'
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!PDFJS_DIRS.includes(rel.split('/')[0])) return next()
        const file = path.join(root, rel)
        if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next()
        const mime = PDFJS_MIME[path.extname(file)]
        if (mime) res.setHeader('Content-Type', mime)
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      if (!isBuild) return // also fires on dev-server shutdown — skip the copy there
      for (const dir of PDFJS_DIRS) {
        const from = path.join(root, dir)
        if (existsSync(from)) cpSync(from, path.join(outDir, 'pdfjs', dir), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  // Read VITE_* vars from the repo-root .env (single source of truth).
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 3000,
    // Dev: browser hits :3000, Vite forwards /api to the API on :4000.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  build: {
    // Split vendors so no single chunk dominates (and they cache independently).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('@radix-ui')) return 'radix'
          if (id.includes('@tanstack')) return 'query'
          if (id.includes('react') || id.includes('scheduler')) return 'react'
          return 'vendor'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
})
