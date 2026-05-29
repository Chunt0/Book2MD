import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownView } from '@/components/MarkdownView'

describe('MarkdownView', () => {
  it('renders KaTeX for math and rewrites relative image src to the book endpoint', () => {
    const md = 'Inline $x^2$ here:\n\n![fig](_page_1_figure_1.png)\n\n$$E = mc^2$$'
    const { container } = render(<MarkdownView markdown={md} bookId={7} />)
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/books/7/images/_page_1_figure_1.png',
    )
  })

  it('leaves absolute image URLs untouched', () => {
    const { container } = render(<MarkdownView markdown={'![x](https://e.com/a.png)'} bookId={1} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://e.com/a.png')
  })

  it('renders GFM tables', () => {
    const { container } = render(<MarkdownView markdown={'| a | b |\n|---|---|\n| 1 | 2 |'} bookId={1} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('td').length).toBe(2)
  })
})
