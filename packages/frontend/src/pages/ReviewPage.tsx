import { markdown as cmMarkdown } from '@codemirror/lang-markdown'
import CodeMirror from '@uiw/react-codemirror'
import { ArrowLeft, Check, CheckCheck, RotateCcw, Save, Wand2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ErrorState } from '@/components/feedback/ErrorState'
import { LoadingState } from '@/components/feedback/LoadingState'
import { MarkdownView } from '@/components/MarkdownView'
import { PdfPageView } from '@/components/PdfPageView'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/sonner'
import { useApproveAll, useBook, useLintBook, useStripLine } from '@/hooks/use-books'
import {
  type PageStatus,
  useApplySuggestion,
  useBookPages,
  usePage,
  useResetPage,
  useUpdatePage,
} from '@/hooks/use-pages'
import { cn } from '@/lib/utils'

const PAGE_DOT: Record<string, string> = {
  approved: 'bg-primary',
  fixed: 'bg-primary/50',
  needs_fix: 'bg-destructive',
  pending: 'bg-muted-foreground/30',
}

export default function ReviewPage() {
  const { id } = useParams()
  const bookId = Number(id)
  const { data: book } = useBook(bookId)
  const [flaggedFirst, setFlaggedFirst] = useState(false)
  const { data: pages } = useBookPages(bookId, flaggedFirst ? 'flags' : undefined)
  const update = useUpdatePage(bookId)
  const reset = useResetPage(bookId)
  const applySuggestion = useApplySuggestion(bookId)
  const strip = useStripLine()
  const approveAll = useApproveAll()
  const lint = useLintBook()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (pages && pages.length > 0 && selectedId === null) setSelectedId(pages[0].id)
  }, [pages, selectedId])

  const { data: page, isLoading } = usePage(selectedId)

  // Load markdown into the draft only when the selected page changes — a status
  // edit or background refetch must not clobber an in-progress draft.
  const lastPageId = useRef<number | null>(null)
  useEffect(() => {
    if (page && page.id !== lastPageId.current) {
      lastPageId.current = page.id
      setDraft(page.markdown)
      setDirty(false)
    }
  }, [page])

  const goTo = useCallback((pid: number | null) => {
    if (pid != null) setSelectedId(pid)
  }, [])
  const next = useCallback(() => goTo(page?.neighbors.nextId ?? null), [page, goTo])
  const prev = useCallback(() => goTo(page?.neighbors.prevId ?? null), [page, goTo])

  const setStatus = useCallback(
    (status: PageStatus, advance = false) => {
      if (!page) return
      update.mutate(
        { id: page.id, status },
        {
          onError: (e) => toast.error(e.message),
          onSuccess: () => {
            if (advance) next()
          },
        },
      )
    },
    [page, update, next],
  )

  const save = useCallback(() => {
    if (!page || !dirty) return
    update.mutate(
      { id: page.id, markdown: draft },
      {
        onSuccess: () => {
          setDirty(false)
          toast.success('Saved')
        },
        onError: (e) => toast.error(e.message),
      },
    )
  }, [page, dirty, draft, update])

  // Keyboard shortcuts (ignored while typing in the editor / inputs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('.cm-editor'))
      if (typing) {
        if (e.key === 'Escape') el?.blur()
        return
      }
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          next()
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          prev()
          break
        case 'a':
          setStatus('approved', true)
          break
        case 'f':
          setStatus('needs_fix')
          break
        case 'r':
          setMode((m) => (m === 'rendered' ? 'source' : 'rendered'))
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, setStatus])

  // Keep the page navigator scrolled to the current page.
  useEffect(() => {
    if (selectedId != null) {
      navRef.current?.querySelector(`[data-pid="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedId])

  if (!book) return <LoadingState />

  const review = book.review
  const pct = review.total ? Math.round((review.approved / review.total) * 100) : 0

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
        <div className="flex items-center gap-3">
          <Link
            to={`/books/${bookId}`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back
          </Link>
          <span className="truncate font-medium">{book.title}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="hidden sm:inline">
            {review.approved}/{review.total} approved
          </span>
          {review.flagged > 0 && <Badge variant="outline">{review.flagged} flagged</Badge>}
          <div className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-muted md:block">
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={lint.isPending}
            onClick={() => lint.mutate(bookId, { onSuccess: (d) => toast.success(`${d.flagged} pages flagged`) })}
          >
            <Wand2 /> Re-lint
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={approveAll.isPending}
            onClick={() =>
              approveAll.mutate(bookId, { onSuccess: (d) => toast.success(`Approved ${d.approved} pages`) })
            }
          >
            <CheckCheck /> Approve all
          </Button>
        </div>
      </div>

      {!pages || pages.length === 0 ? (
        <ErrorState title="No pages" description="This book hasn't been converted yet." />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[120px_1fr_1fr]">
          {/* page navigator */}
          <div className="flex min-h-0 flex-col border-r border-border">
            <button
              type="button"
              onClick={() => setFlaggedFirst((v) => !v)}
              className="border-b border-border px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              {flaggedFirst ? '↕ By page' : '⚑ Flagged first'}
            </button>
            <div ref={navRef} className="min-h-0 flex-1 overflow-y-auto py-2 pr-2">
              {pages.map((p) => (
                <button
                  key={p.id}
                  data-pid={p.id}
                  type="button"
                  onClick={() => goTo(p.id)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    p.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className={cn('size-2 rounded-full', PAGE_DOT[p.status] ?? 'bg-muted-foreground/30')} />
                    {p.pageNumber}
                  </span>
                  {p.flagCount > 0 && (
                    <Badge variant="outline" className="px-1 text-xs">
                      {p.flagCount}
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* source PDF page */}
          <div className="overflow-y-auto border-r border-border bg-muted/30 p-3">
            {page && <PdfPageView bookId={bookId} pageNumber={page.pageNumber} />}
          </div>

          {/* markdown: rendered / source + actions */}
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <Tabs value={mode} onValueChange={(v) => setMode(v as 'rendered' | 'source')}>
                <TabsList>
                  <TabsTrigger value="rendered">Rendered</TabsTrigger>
                  <TabsTrigger value="source">Source</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex items-center gap-1">
                {page?.edited && (
                  <Badge variant="secondary" className="text-xs">
                    edited
                  </Badge>
                )}
                {dirty && (
                  <Button size="sm" onClick={save} disabled={update.isPending}>
                    <Save /> Save
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!page?.edited}
                  onClick={() =>
                    page &&
                    reset.mutate(page.id, {
                      onSuccess: (data) => {
                        setDraft(data.markdown)
                        setDirty(false)
                        toast.success('Reverted to original')
                      },
                    })
                  }
                >
                  <RotateCcw /> Reset
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {isLoading || !page ? (
                <LoadingState />
              ) : mode === 'rendered' ? (
                <MarkdownView markdown={draft} bookId={bookId} />
              ) : (
                <CodeMirror
                  value={draft}
                  extensions={[cmMarkdown()]}
                  onChange={(v) => {
                    setDraft(v)
                    setDirty(v !== page.markdown)
                  }}
                  basicSetup={{ lineNumbers: true }}
                />
              )}
            </div>

            {page && page.flags.length > 0 && (
              <div className="max-h-44 overflow-y-auto border-t border-border px-3 py-2">
                {page.flags.map((f, i) => {
                  const sug = f.suggestion
                  const bookWideLine = sug?.bookWide ? sug.line : undefined
                  return (
                    <div key={`${f.type}-${i}`} className="flex items-start gap-2 py-1 text-sm">
                      <span
                        className={cn(
                          'mt-1.5 size-1.5 shrink-0 rounded-full',
                          f.severity === 'warn' ? 'bg-destructive' : 'bg-muted-foreground',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div>{f.message}</div>
                        {f.snippet && (
                          <div className="truncate font-mono text-xs text-muted-foreground">{f.snippet}</div>
                        )}
                      </div>
                      {sug && (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={applySuggestion.isPending}
                            onClick={() => applySuggestion.mutate({ pageId: page.id, index: i })}
                          >
                            {sug.label}
                          </Button>
                          {bookWideLine && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={strip.isPending}
                              onClick={() =>
                                strip.mutate(
                                  { bookId, line: bookWideLine },
                                  { onSuccess: (d) => toast.success(`Stripped from ${d.affected} pages`) },
                                )
                              }
                            >
                              All pages
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-border px-3 py-2">
              <Button
                size="sm"
                variant={page?.status === 'approved' ? 'default' : 'outline'}
                onClick={() => setStatus('approved', true)}
              >
                <Check /> Approve
              </Button>
              <Button
                size="sm"
                variant={page?.status === 'needs_fix' ? 'destructive' : 'outline'}
                onClick={() => setStatus('needs_fix')}
              >
                <X /> Needs fix
              </Button>
              <Button
                size="sm"
                variant={page?.status === 'fixed' ? 'secondary' : 'outline'}
                onClick={() => setStatus('fixed')}
              >
                Fixed
              </Button>
              <span className="ml-auto hidden text-xs text-muted-foreground lg:block">
                j/k pages · a approve · f flag · r toggle
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
