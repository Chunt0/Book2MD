import { describe, expect, it } from 'bun:test'
import { applySuggestion, lintBook, lintPage } from '../lib/lint'

describe('lint detectors', () => {
  it('flags a bare page number and strips it', () => {
    const md = 'Some intro text on this page.\n\n42'
    const pn = lintPage(md).find((f) => f.type === 'page_number')
    expect(pn?.suggestion).toBeDefined()
    const out = pn?.suggestion ? applySuggestion(md, pn.suggestion) : md
    expect(out.includes('42')).toBe(false)
  })

  it('flags hyphenation and de-hyphenates', () => {
    const md = 'This is an exam-\nple of hyphenation in body text.'
    const hy = lintPage(md).find((f) => f.type === 'hyphenation')
    expect(hy?.suggestion).toBeDefined()
    const out = hy?.suggestion ? applySuggestion(md, hy.suggestion) : md
    expect(out).toContain('example')
  })

  it('flags invalid LaTeX and accepts valid LaTeX (KaTeX)', () => {
    expect(lintPage('a bad one $\\frac{1}{$ here').some((f) => f.type === 'bad_equation')).toBe(true)
    expect(lintPage('good $E = mc^2$ and $$\\sum_{k=0}^{n} k$$').some((f) => f.type === 'bad_equation')).toBe(
      false,
    )
  })

  it('flags ragged tables', () => {
    expect(lintPage('| a | b |\n| --- | --- |\n| 1 |').some((f) => f.type === 'broken_table')).toBe(true)
  })

  it('flags nearly-empty pages', () => {
    expect(lintPage('  \n ').some((f) => f.type === 'empty_page')).toBe(true)
  })
})

describe('lintBook', () => {
  it('detects a running header repeated across pages', () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      pageNumber: i + 1,
      markdown: `Chapter 1 | Intro\n\nBody text of page ${i + 1}, long enough to count.`,
    }))
    const flags = lintBook(pages).get(1) ?? []
    expect(flags.some((f) => f.type === 'running_header')).toBe(true)
  })
})
