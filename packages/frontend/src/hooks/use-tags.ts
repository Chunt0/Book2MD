import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '@/lib/api'

export interface TagItem {
  id: number
  name: string
  count: number
}

export const tagKeys = { all: ['tags'] as const }

export function useTags() {
  return useQuery({
    queryKey: tagKeys.all,
    queryFn: () => unwrap<TagItem[]>(api.tags.get()),
  })
}
