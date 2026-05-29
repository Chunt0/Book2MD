import { Library as LibraryIcon } from 'lucide-react'
import { type ComponentType, lazy, type LazyExoticComponent } from 'react'

export interface RouteEntry {
  /** URL path. '/' is the index route. */
  path: string
  /** Sidebar label. */
  label: string
  /** Sidebar icon. */
  icon: ComponentType<{ className?: string }>
  /** Lazily-loaded page (default export). */
  Component: LazyExoticComponent<ComponentType>
}

// ── The single source of truth for app pages ─────────────────────────────
// Add a page: append one entry here. router.tsx builds the routes from this
// list and Sidebar.tsx builds the nav from it — they cannot drift. (SEED_SPEC §6.3)
export const routes: RouteEntry[] = [
  { path: '/', label: 'Library', icon: LibraryIcon, Component: lazy(() => import('@/pages/LibraryPage')) },
]
