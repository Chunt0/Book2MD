import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/lib/api'
import { bookKeys } from '@/hooks/use-books'

export type PageStatus = 'pending' | 'approved' | 'needs_fix' | 'fixed'

export interface Suggestion {
  action: 'dehyphenate' | 'strip_line' | 'normalize' | 'dedupe'
  label: string
  line?: string
  bookWide?: boolean
}

export interface Flag {
  type: string
  severity: 'warn' | 'info'
  message: string
  snippet?: string
  suggestion?: Suggestion
}

export interface PageListItem {
  id: number
  pageNumber: number
  status: PageStatus
  edited: boolean
  flagCount: number
  flagTypes: string[]
}

export interface PageDetail {
  id: number
  bookId: number
  pageNumber: number
  markdown: string
  originalMarkdown: string
  status: PageStatus
  edited: boolean
  flags: Flag[]
  layout: unknown
  pageWidth: number | null
  pageHeight: number | null
  neighbors: { prevId: number | null; nextId: number | null }
}

export const pageKeys = {
  list: (bookId: number) => ['books', bookId, 'pages'] as const,
  detail: (id: number) => ['pages', id] as const,
}

export function useBookPages(bookId: number, sort?: 'flags') {
  return useQuery({
    queryKey: [...pageKeys.list(bookId), sort ?? 'number'],
    queryFn: () =>
      unwrap<PageListItem[]>(api.books({ id: bookId }).pages.get({ query: sort ? { sort } : {} })),
  })
}

export function usePage(id: number | null) {
  return useQuery({
    queryKey: pageKeys.detail(id ?? 0),
    enabled: id != null,
    queryFn: () => unwrap<PageDetail>(api.pages({ id: id as number }).get()),
  })
}

function invalidateAround(
  qc: ReturnType<typeof useQueryClient>,
  bookId: number,
  data: PageDetail,
) {
  qc.setQueryData(pageKeys.detail(data.id), data)
  qc.invalidateQueries({ queryKey: pageKeys.list(bookId) })
  qc.invalidateQueries({ queryKey: bookKeys.detail(bookId) })
}

export function useUpdatePage(bookId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; markdown?: string; status?: PageStatus }) =>
      unwrap<PageDetail>(
        api.pages({ id: input.id }).patch({
          ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
          ...(input.status ? { status: input.status } : {}),
        }),
      ),
    onSuccess: (data) => invalidateAround(qc, bookId, data),
  })
}

export function useResetPage(bookId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => unwrap<PageDetail>(api.pages({ id }).reset.post()),
    onSuccess: (data) => invalidateAround(qc, bookId, data),
  })
}

export function useApplySuggestion(bookId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { pageId: number; index: number }) =>
      unwrap<PageDetail>(api.pages({ id: input.pageId })['apply-suggestion'].post({ index: input.index })),
    onSuccess: (data) => invalidateAround(qc, bookId, data),
  })
}
