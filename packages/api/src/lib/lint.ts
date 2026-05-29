import katex from 'katex'

// Lint catalog (NEW_PROJECT_SPEC §16.1). Pure, deterministic, no GPU. Detectors
// produce Flag[] stored in pages.flagsJson; the review UI surfaces them
// flagged-first with one-click suggestions. Equation validity is checked with the
// same KaTeX the renderer uses, so "valid" here == "renders in the QA view".

export type FlagType =
  | 'running_header'
  | 'running_footer'
  | 'page_number'
  | 'hyphenation'
  | 'bad_equation'
  | 'broken_table'
  | 'encoding_artifact'
  | 'empty_page'
  | 'repeated_block'

export type Severity = 'warn' | 'info'
export type SuggestionAction = 'dehyphenate' | 'strip_line' | 'normalize' | 'dedupe'

export interface Suggestion {
  action: SuggestionAction
  label: string
  /** For strip_line: the exact (trimmed) line to remove. */
  line?: string
  /** Offer a "strip from every page" variant (running headers/footers). */
  bookWide?: boolean
}

export interface Flag {
  type: FlagType
  severity: Severity
  message: string
  snippet?: string
  suggestion?: Suggestion
}

export interface PageInput {
  id: number
  pageNumber: number
  markdown: string
}

const HEADER_FREQ = 0.25 // recur on ≥25% of pages …
const MIN_PAGES_FOR_FREQ = 3 // … and ≥3 pages to count as a running header/footer
const MIN_PAGE_CHARS = 20
const MAX_EQUATION_FLAGS = 6
const HYPHEN_RE = /([A-Za-z]{2,})-\n([a-z]{2,})/g

function nonEmptyLines(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Strip digits/punctuation so "Chapter 3 | Intro" and "Chapter 7 | Intro" collapse. */
function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[0-9]+/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
}

// ── per-page detectors ─────────────────────────────────────────────────────
function detectEmpty(md: string): Flag | null {
  return md.trim().length < MIN_PAGE_CHARS
    ? { type: 'empty_page', severity: 'info', message: 'Page is empty or nearly empty' }
    : null
}

function detectPageNumber(md: string): Flag | null {
  for (const raw of md.split('\n')) {
    const t = raw.trim()
    if (/^(page\s+)?\d{1,4}$/i.test(t)) {
      return {
        type: 'page_number',
        severity: 'warn',
        message: `Likely a page number: "${t}"`,
        snippet: t,
        suggestion: { action: 'strip_line', line: t, label: 'Remove line' },
      }
    }
  }
  return null
}

function detectHyphenation(md: string): Flag | null {
  const matches = md.match(HYPHEN_RE)
  if (!matches || matches.length === 0) return null
  return {
    type: 'hyphenation',
    severity: 'info',
    message: `${matches.length} word(s) split across a line break (e.g. "${matches[0].replace('\n', '↵')}")`,
    suggestion: { action: 'dehyphenate', label: 'De-hyphenate' },
  }
}

function extractMath(md: string): { tex: string; display: boolean }[] {
  const out: { tex: string; display: boolean }[] = []
  const noBlocks = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    out.push({ tex: tex.trim(), display: true })
    return ' '
  })
  noBlocks.replace(/(?<!\\)\$([^$\n]+?)\$/g, (_m, tex: string) => {
    out.push({ tex: tex.trim(), display: false })
    return ' '
  })
  return out
}

function detectBadEquations(md: string): Flag[] {
  const flags: Flag[] = []
  for (const { tex, display } of extractMath(md)) {
    if (!tex) continue
    try {
      katex.renderToString(tex, { throwOnError: true, displayMode: display })
    } catch (e) {
      flags.push({
        type: 'bad_equation',
        severity: 'warn',
        message: `Equation doesn't parse: ${(e as Error).message.split('\n')[0].slice(0, 90)}`,
        snippet: tex.slice(0, 140),
      })
      if (flags.length >= MAX_EQUATION_FLAGS) break
    }
  }
  return flags
}

function detectBrokenTable(md: string): Flag | null {
  const lines = md.split('\n')
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim().startsWith('|')) {
      const block: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        block.push(lines[i].trim())
        i++
      }
      if (block.length >= 2) {
        const counts = block.map((l) => (l.match(/\|/g) ?? []).length)
        if (new Set(counts).size > 1) {
          return {
            type: 'broken_table',
            severity: 'warn',
            message: 'Table rows have inconsistent column counts',
            snippet: block.slice(0, 3).join('\n'),
          }
        }
      }
    } else {
      i++
    }
  }
  return null
}

function detectEncoding(md: string): Flag | null {
  return /�/.test(md)
    ? {
        type: 'encoding_artifact',
        severity: 'info',
        message: 'Contains replacement characters (�) — likely a decoding gap',
        suggestion: { action: 'normalize', label: 'Strip bad characters' },
      }
    : null
}

function detectRepeatedBlock(md: string): Flag | null {
  const paras = md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  for (let i = 1; i < paras.length; i++) {
    if (paras[i] === paras[i - 1] && paras[i].length > MIN_PAGE_CHARS) {
      return {
        type: 'repeated_block',
        severity: 'info',
        message: 'A paragraph is duplicated consecutively',
        snippet: paras[i].slice(0, 100),
        suggestion: { action: 'dedupe', label: 'Remove duplicate' },
      }
    }
  }
  return null
}

/** Page-level detectors (no cross-page context). Used to re-lint a single edited page. */
export function lintPage(md: string): Flag[] {
  const empty = detectEmpty(md)
  if (empty) return [empty]
  const flags: Flag[] = []
  const pn = detectPageNumber(md)
  if (pn) flags.push(pn)
  const hy = detectHyphenation(md)
  if (hy) flags.push(hy)
  flags.push(...detectBadEquations(md))
  const bt = detectBrokenTable(md)
  if (bt) flags.push(bt)
  const enc = detectEncoding(md)
  if (enc) flags.push(enc)
  const rep = detectRepeatedBlock(md)
  if (rep) flags.push(rep)
  return flags
}

/** Full-book lint: per-page detectors + cross-page running-header/footer detection. */
export function lintBook(pages: PageInput[]): Map<number, Flag[]> {
  const n = pages.length
  const firstCount = new Map<string, number>()
  const lastCount = new Map<string, number>()
  for (const p of pages) {
    const lines = nonEmptyLines(p.markdown)
    if (lines.length === 0) continue
    const f = normalizeLine(lines[0])
    const l = normalizeLine(lines[lines.length - 1])
    if (f) firstCount.set(f, (firstCount.get(f) ?? 0) + 1)
    if (l && lines.length > 1) lastCount.set(l, (lastCount.get(l) ?? 0) + 1)
  }
  const threshold = Math.max(MIN_PAGES_FOR_FREQ, Math.ceil(HEADER_FREQ * n))
  const headerSet = new Set([...firstCount].filter(([, c]) => c >= threshold).map(([k]) => k))
  const footerSet = new Set([...lastCount].filter(([, c]) => c >= threshold).map(([k]) => k))

  const result = new Map<number, Flag[]>()
  for (const p of pages) {
    const flags = lintPage(p.markdown)
    const lines = nonEmptyLines(p.markdown)
    if (lines.length > 0) {
      const first = lines[0]
      const last = lines[lines.length - 1]
      if (normalizeLine(first) && headerSet.has(normalizeLine(first))) {
        flags.unshift({
          type: 'running_header',
          severity: 'warn',
          message: `Running header: "${first}"`,
          snippet: first,
          suggestion: { action: 'strip_line', line: first, label: 'Strip line', bookWide: true },
        })
      }
      if (lines.length > 1 && normalizeLine(last) && footerSet.has(normalizeLine(last))) {
        flags.unshift({
          type: 'running_footer',
          severity: 'warn',
          message: `Running footer: "${last}"`,
          snippet: last,
          suggestion: { action: 'strip_line', line: last, label: 'Strip line', bookWide: true },
        })
      }
    }
    result.set(p.id, flags)
  }
  return result
}

// ── transforms (one-click suggestions + book-wide strip) ───────────────────
export function stripLine(md: string, line: string): string {
  const target = line.trim()
  return md
    .split('\n')
    .filter((l) => l.trim() !== target)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function dedupeParagraphs(md: string): string {
  const out: string[] = []
  for (const p of md.split(/\n{2,}/)) {
    if (out.length === 0 || out[out.length - 1].trim() !== p.trim()) out.push(p)
  }
  return out.join('\n\n')
}

export function applySuggestion(md: string, s: Suggestion): string {
  switch (s.action) {
    case 'dehyphenate':
      return md.replace(HYPHEN_RE, '$1$2')
    case 'strip_line':
      return s.line ? stripLine(md, s.line) : md
    case 'normalize':
      return md.replace(/�/g, '').replace(/[ \t]+\n/g, '\n')
    case 'dedupe':
      return dedupeParagraphs(md)
    default:
      return md
  }
}
