import { describe, expect, it } from 'bun:test'
import { parsePaginatedMarkdown } from '../lib/marker'
import { slugify, toMarkerPath } from '../lib/storage'

const SEP = '------------------------------------------------'

describe('parsePaginatedMarkdown', () => {
  it('splits on the {N}---- separator and 1-bases page numbers, keeping $math$', () => {
    const out = `\n\n{0}${SEP}\n\nPage one with $x^2 + y^2$\n\n{1}${SEP}\n\nPage two`
    const pages = parsePaginatedMarkdown(out)
    expect(pages.length).toBe(2)
    expect(pages[0].pageNumber).toBe(1)
    expect(pages[0].markdown).toContain('Page one')
    expect(pages[0].markdown).toContain('$x^2 + y^2$')
    expect(pages[1].pageNumber).toBe(2)
    expect(pages[1].markdown).toBe('Page two')
  })

  it('preserves the absolute marker index (page_range slices)', () => {
    const pages = parsePaginatedMarkdown(`{464}${SEP}\n\ncontent`)
    expect(pages[0].pageNumber).toBe(465)
  })

  it('treats output with no separators as a single page', () => {
    const pages = parsePaginatedMarkdown('just one chunk')
    expect(pages.length).toBe(1)
    expect(pages[0].pageNumber).toBe(1)
  })

  it('returns nothing for empty output', () => {
    expect(parsePaginatedMarkdown('   ')).toHaveLength(0)
  })
})

describe('storage helpers', () => {
  it('toMarkerPath maps the host DATA_DIR to the container /data view', () => {
    expect(toMarkerPath('/tmp/book2md-test-data/books/foo/source.pdf')).toBe('/data/books/foo/source.pdf')
  })

  it('slugify produces a filesystem-safe slug', () => {
    expect(slugify('Machine Learning in Finance!')).toBe('machine-learning-in-finance')
  })
})
