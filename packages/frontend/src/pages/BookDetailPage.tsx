import { ArrowLeft, ClipboardCheck, Download, FileText, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ErrorState } from '@/components/feedback/ErrorState'
import { LoadingState } from '@/components/feedback/LoadingState'
import { PageHeader } from '@/components/layout/PageHeader'
import { MarkdownView } from '@/components/MarkdownView'
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { toast } from '@/components/ui/sonner'
import { useBook, useConvertBook, useDeleteBook } from '@/hooks/use-books'
import { useBookPages, usePage } from '@/hooks/use-pages'
import { cn } from '@/lib/utils'

const PAGE_DOT: Record<string, string> = {
  approved: 'bg-primary',
  fixed: 'bg-primary/50',
  needs_fix: 'bg-destructive',
  pending: 'bg-muted-foreground/30',
}
const ACTIVE = new Set(['queued', 'converting'])

export default function BookDetailPage() {
  const { id } = useParams()
  const bookId = Number(id)
  const navigate = useNavigate()
  const { data: book, isLoading, error, refetch } = useBook(bookId)
  const { data: pages } = useBookPages(bookId)
  const convert = useConvertBook()
  const remove = useDeleteBook()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (pages && pages.length > 0 && selectedId === null) setSelectedId(pages[0].id)
  }, [pages, selectedId])

  const { data: page, isLoading: pageLoading } = usePage(selectedId)

  if (isLoading) return <LoadingState />
  if (error || !book) {
    return (
      <ErrorState
        description={error instanceof Error ? error.message : 'Book not found'}
        onRetry={() => refetch()}
      />
    )
  }

  const converting = ACTIVE.has(book.status)

  function handleReconvert() {
    convert.mutate(
      { id: bookId },
      {
        onSuccess: () => toast.success('Re-conversion queued'),
        onError: (e) => toast.error(e.message),
      },
    )
  }

  function handleDelete() {
    remove.mutate(bookId, {
      onSuccess: () => {
        toast.success('Deleted')
        navigate('/')
      },
      onError: (e) => toast.error(e.message),
    })
  }

  return (
    <div>
      <Link
        to="/"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Library
      </Link>

      <PageHeader
        title={book.title}
        description={
          [book.author, book.pageCount ? `${book.pageCount} pages` : null].filter(Boolean).join(' · ') ||
          undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={book.status === 'failed' ? 'destructive' : 'secondary'}>{book.status}</Badge>
            {book.pageCount ? (
              <Button size="sm" asChild>
                <Link to={`/books/${bookId}/review`}>
                  <ClipboardCheck /> Review
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/books/${bookId}/pdf`} target="_blank" rel="noreferrer">
                <FileText /> PDF
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/books/${bookId}/export`}>
                <Download /> Export
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReconvert}
              disabled={converting || convert.isPending}
            >
              <RefreshCw /> Re-convert
            </Button>
            <Button variant="ghost" size="icon" aria-label="Delete book" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          </div>
        }
      />

      {converting && (
        <Card className="mb-4">
          <CardContent className="flex items-center gap-3 py-3 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" />
            Converting… {book.latestJob?.stage ?? 'queued'}
          </CardContent>
        </Card>
      )}
      {book.status === 'failed' && book.errorMessage && (
        <Card className="mb-4 border-destructive">
          <CardContent className="py-3 text-sm text-destructive">
            Conversion failed: {book.errorMessage}
          </CardContent>
        </Card>
      )}

      {pages && pages.length > 0 ? (
        <div className="grid grid-cols-[180px_1fr] gap-4">
          <nav className="max-h-[72vh] space-y-0.5 overflow-y-auto rounded-lg border border-border p-2">
            {pages.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  p.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cn('size-2 rounded-full', PAGE_DOT[p.status] ?? 'bg-muted-foreground/30')} />
                  Page {p.pageNumber}
                </span>
                {p.flagCount > 0 && (
                  <Badge variant="outline" className="px-1 text-xs">
                    {p.flagCount}
                  </Badge>
                )}
              </button>
            ))}
          </nav>
          <Card>
            <CardContent className="py-5">
              {pageLoading || !page ? <LoadingState /> : <MarkdownView markdown={page.markdown} bookId={bookId} />}
            </CardContent>
          </Card>
        </div>
      ) : converting ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Pages will appear once conversion finishes.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No pages yet.</CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete book?"
        description={`"${book.title}" will be removed from the library.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        isConfirming={remove.isPending}
      />
    </div>
  )
}
