import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { cn } from '@/lib/utils'

const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

/**
 * Renders a page's Markdown with GFM tables + KaTeX math. Relative image refs
 * (marker emits bare filenames) resolve to the book's image endpoint.
 */
export function MarkdownView({
  markdown,
  bookId,
  className,
}: {
  markdown: string
  bookId: number
  className?: string
}) {
  return (
    <div className={cn('markdown text-sm text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          img(props) {
            const raw = typeof props.src === 'string' ? props.src : ''
            const src = /^(https?:|data:|\/)/.test(raw)
              ? raw
              : `/api/books/${bookId}/images/${raw.replace(/^\.?\//, '')}`
            return <img src={src} alt={props.alt ?? ''} />
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
