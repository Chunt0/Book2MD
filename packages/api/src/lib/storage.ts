import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'
import { env } from './env'

// On-disk layout for books (NEW_PROJECT_SPEC §9):
//   <DATA_DIR>/books/<slug>/{source.pdf, marker/, images/, book.md}
// The marker container mounts <DATA_DIR> at MARKER_DATA_DIR (/data), so we hand
// marker the *container* path via toMarkerPath().

export const booksRoot = (): string => join(env.DATA_DIR, 'books')

export function bookDir(slug: string): string {
  return join(booksRoot(), slug)
}

export function bookPaths(slug: string) {
  const dir = bookDir(slug)
  return {
    dir,
    pdf: join(dir, 'source.pdf'),
    markerDir: join(dir, 'marker'),
    imagesDir: join(dir, 'images'),
    bookMd: join(dir, 'book.md'),
  }
}

/** Map a host path under DATA_DIR to the marker container's view (/data/...). */
export function toMarkerPath(hostPath: string): string {
  const rel = relative(env.DATA_DIR, hostPath)
  return posix.join(env.MARKER_DATA_DIR, rel.split(/[\\/]/).join('/'))
}

/** filesystem-safe base slug from a title (uniqueness handled by the caller). */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base || 'book'
}

export async function ensureBookDirs(slug: string): Promise<void> {
  const p = bookPaths(slug)
  await mkdir(p.imagesDir, { recursive: true })
  await mkdir(p.markerDir, { recursive: true })
}

/** Write marker's base64 images to <book>/images/. Returns the filenames written. */
export async function writeImages(slug: string, images: Record<string, string>): Promise<string[]> {
  const { imagesDir } = bookPaths(slug)
  await mkdir(imagesDir, { recursive: true })
  const names: string[] = []
  for (const [name, b64] of Object.entries(images ?? {})) {
    const safe = name.replace(/[\\/]/g, '_')
    await writeFile(join(imagesDir, safe), Buffer.from(b64, 'base64'))
    names.push(safe)
  }
  return names
}
