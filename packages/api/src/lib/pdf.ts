import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { BadRequestError } from './errors'

// Read a PDF's page count locally (no marker round-trip). The chunked converter
// (lib/jobs.ts) needs the exact count up front: marker_server rejects any
// page_range that exceeds the document ("Invalid page range…"), so the final
// chunk must be clamped to the real last page.
export async function getPdfPageCount(path: string): Promise<number> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (e) {
    throw new BadRequestError(`Could not read PDF at ${path}: ${String(e)}`)
  }
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
    const n = doc.getPageCount()
    if (n < 1) throw new Error('PDF reports 0 pages')
    return n
  } catch (e) {
    throw new BadRequestError(`Could not read PDF page count: ${String(e)}`)
  }
}
