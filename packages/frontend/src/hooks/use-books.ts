import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/lib/api'

export interface BookTag {
  id: number
  name: string
}

export interface BookReview {
  total: number
  approved: number
  needsFix: number
  flagged: number
}

export interface Book {
  id: number
  title: string
  author: string | null
  slug: string
  status: string
  pageCount: number | null
  sizeBytes: number | null
  errorMessage: string | null
  approvedAt: string | null
  createdAt: string
  convertedAt: string | null
  tags: BookTag[]
  review: BookReview
}

export interface Job {
  id: number
  bookId: number | null
  type: string
  status: string
  stage: string | null
  progress: number
  error: string | null
  createdAt: string
}

export interface BookListParams {
  q?: string
  status?: string
  tagId?: number
}

// Typed query-key factory — call a function, never hand-format the key array.
export const bookKeys = {
  all: ['books'] as const,
  list: (params?: BookListParams) => ['books', 'list', params ?? {}] as const,
  detail: (id: number) => ['books', 'detail', id] as const,
}

const ACTIVE_STATUS = new Set(['queued', 'converting'])

export function useBooks(params?: BookListParams) {
  return useQuery({
    queryKey: bookKeys.list(params),
    queryFn: () =>
      unwrap<Book[]>(
        api.books.get({
          query: {
            ...(params?.q ? { q: params.q } : {}),
            ...(params?.status ? { status: params.status } : {}),
            ...(params?.tagId !== undefined ? { tagId: params.tagId } : {}),
          },
        }),
      ),
    // Poll while any book is mid-conversion so status updates live.
    refetchInterval: (query) => {
      const data = query.state.data as Book[] | undefined
      return data?.some((b) => ACTIVE_STATUS.has(b.status)) ? 2500 : false
    },
  })
}

export function useUploadBook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      file: File
      title?: string
      author?: string
      tags?: string
      forceOcr?: boolean
    }) =>
      unwrap<{ book: Book; job: Job }>(
        api.books.post({
          file: input.file,
          ...(input.title ? { title: input.title } : {}),
          ...(input.author ? { author: input.author } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          forceOcr: input.forceOcr ? 'true' : 'false',
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: bookKeys.all }),
  })
}

export function useDeleteBook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => unwrap<{ id: number; deleted: boolean }>(api.books({ id }).delete()),
    onSuccess: () => qc.invalidateQueries({ queryKey: bookKeys.all }),
  })
}

export interface BookDetail extends Book {
  latestJob: Job | null
}

export function useBook(id: number) {
  return useQuery({
    queryKey: bookKeys.detail(id),
    queryFn: () => unwrap<BookDetail>(api.books({ id }).get()),
    // Poll while the book is mid-conversion so status/stage update live.
    refetchInterval: (query) => {
      const d = query.state.data as BookDetail | undefined
      return d && ACTIVE_STATUS.has(d.status) ? 2000 : false
    },
  })
}

export function useConvertBook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; forceOcr?: boolean }) =>
      unwrap<{ job: Job }>(api.books({ id: input.id }).convert.post({ forceOcr: input.forceOcr ?? false })),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: bookKeys.detail(vars.id) })
      qc.invalidateQueries({ queryKey: bookKeys.all })
    },
  })
}

// ── M4: QA-fast book-level actions ──────────────────────────────────────
export function useApproveAll() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bookId: number) =>
      unwrap<{ approved: number }>(api.books({ id: bookId })['approve-all'].post()),
    onSuccess: (_d, bookId) => {
      qc.invalidateQueries({ queryKey: ['books', bookId, 'pages'] })
      qc.invalidateQueries({ queryKey: bookKeys.detail(bookId) })
    },
  })
}

export function useLintBook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bookId: number) =>
      unwrap<{ pages: number; flagged: number }>(api.books({ id: bookId }).lint.post()),
    onSuccess: (_d, bookId) => qc.invalidateQueries({ queryKey: ['books', bookId, 'pages'] }),
  })
}

export function useStripLine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { bookId: number; line: string }) =>
      unwrap<{ affected: number }>(api.books({ id: input.bookId }).strip.post({ line: input.line })),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['books', vars.bookId, 'pages'] })
      qc.invalidateQueries({ queryKey: bookKeys.detail(vars.bookId) })
      qc.invalidateQueries({ queryKey: ['pages'] })
    },
  })
}
