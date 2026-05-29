import { Trash2, Upload } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog'
import { type Column, DataTable } from '@/components/patterns/DataTable'
import { FormDialog } from '@/components/patterns/FormDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/sonner'
import { type Book, useBooks, useDeleteBook, useUploadBook } from '@/hooks/use-books'
import { useTags } from '@/hooks/use-tags'

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  approved: 'default',
  converted: 'secondary',
  converting: 'outline',
  queued: 'outline',
  uploaded: 'outline',
  failed: 'destructive',
}

export default function LibraryPage() {
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [tagId, setTagId] = useState<number | undefined>(undefined)
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading, error, refetch } = useBooks({ q: q || undefined, tagId })
  const { data: tags } = useTags()
  const upload = useUploadBook()
  const remove = useDeleteBook()

  const [formOpen, setFormOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [toDelete, setToDelete] = useState<Book | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function resetForm() {
    setFile(null)
    setTitle('')
    setTagsInput('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!file) {
      toast.error('Choose a PDF file')
      return
    }
    upload.mutate(
      { file, title: title.trim() || undefined, tags: tagsInput.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Uploaded — converting in the background')
          setFormOpen(false)
          resetForm()
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  function handleDelete() {
    if (!toDelete) return
    remove.mutate(toDelete.id, {
      onSuccess: () => {
        toast.success('Deleted')
        setToDelete(null)
      },
      onError: (err) => toast.error(err.message),
    })
  }

  const columns: Column<Book>[] = [
    {
      key: 'title',
      header: 'Title',
      cell: (b) => (
        <Link to={`/books/${b.id}`} className="block hover:underline">
          <div className="font-medium">{b.title}</div>
          {b.author && <div className="text-xs text-muted-foreground">{b.author}</div>}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (b) => <Badge variant={STATUS_VARIANT[b.status] ?? 'outline'}>{b.status}</Badge>,
    },
    {
      key: 'pages',
      header: 'Pages',
      cell: (b) => <span className="text-muted-foreground">{b.pageCount ?? '—'}</span>,
    },
    {
      key: 'reviewed',
      header: 'Reviewed',
      cell: (b) =>
        b.review.total > 0 ? (
          <span className="text-muted-foreground">
            {Math.round((b.review.approved / b.review.total) * 100)}%
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'tags',
      header: 'Tags',
      cell: (b) =>
        b.tags.length ? (
          <div className="flex flex-wrap gap-1">
            {b.tags.map((tag) => (
              <Badge key={tag.id} variant="outline">
                {tag.name}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12 text-right',
      cell: (b) => (
        <Button variant="ghost" size="icon" aria-label={`Delete ${b.title}`} onClick={() => setToDelete(b)}>
          <Trash2 />
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Library"
        description="Upload PDF textbooks and convert them to Markdown."
        actions={
          <Button onClick={() => setFormOpen(true)}>
            <Upload /> Upload
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search titles…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={tagId === undefined ? 'all' : String(tagId)}
          onValueChange={(v) => setTagId(v === 'all' ? undefined : Number(v))}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All tags" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tags</SelectItem>
            {tags?.map((tag) => (
              <SelectItem key={tag.id} value={String(tag.id)}>
                {tag.name} ({tag.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={data}
        getRowKey={(b) => b.id}
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        emptyTitle="No books"
        emptyDescription="Upload your first PDF to convert it."
      />

      <FormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o)
          if (!o) resetForm()
        }}
        title="Upload a PDF"
        description="Convert a textbook PDF to Markdown."
        onSubmit={handleUpload}
        submitLabel="Upload & convert"
        isSubmitting={upload.isPending}
      >
        <div className="space-y-2">
          <Label htmlFor="file">PDF file</Label>
          <Input
            id="file"
            type="file"
            accept="application/pdf"
            ref={fileRef}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="title">Title (optional)</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to the filename"
            maxLength={200}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tags">Tags (comma-separated, optional)</Label>
          <Input
            id="tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="e.g. finance, machine-learning"
          />
        </div>
      </FormDialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => {
          if (!o) setToDelete(null)
        }}
        title="Delete book?"
        description={toDelete ? `"${toDelete.title}" will be removed from the library.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        isConfirming={remove.isPending}
      />
    </div>
  )
}
