import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'
import { LoadingState } from '@/components/feedback/LoadingState'

GlobalWorkerOptions.workerSrc = workerUrl

// pdf.js sidecar resources, served by the Vite `pdfjsAssets` plugin (dev) and
// copied into the build (prod). wasmUrl is what makes scanned/JPEG2000 (JPX)
// and JBIG2 PDFs render — without it the image decoders never initialize and
// such pages come out blank. The rest cover CMap/standard-font/ICC fallbacks.
const PDFJS_RESOURCES = {
  wasmUrl: '/pdfjs/wasm/',
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  iccUrl: '/pdfjs/iccs/',
}

/** Renders one page of the book's source PDF to a canvas (fit-to-width, retina). */
export function PdfPageView({ bookId, pageNumber }: { bookId: number; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)

  // Load the document once per book.
  useEffect(() => {
    let cancelled = false
    setError(null)
    setDoc(null)
    const task = getDocument({ url: `/api/books/${bookId}/pdf`, ...PDFJS_RESOURCES })
    task.promise.then(
      (d) => {
        if (cancelled) void d.destroy()
        else setDoc(d)
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [bookId])

  // Render the requested page.
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    let renderTask: RenderTask | undefined
    setRendering(true)
    ;(async () => {
      try {
        const num = Math.min(Math.max(pageNumber, 1), doc.numPages)
        const page = await doc.getPage(num)
        if (cancelled) return
        const canvas = canvasRef.current
        const wrap = wrapRef.current
        if (!canvas || !wrap) return
        const dpr = window.devicePixelRatio || 1
        const base = page.getViewport({ scale: 1 })
        const cssWidth = wrap.clientWidth || 600
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr })
        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.style.width = `${cssWidth}px`
        canvas.style.height = `${viewport.height / dpr}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        renderTask = page.render({ canvas, canvasContext: ctx, viewport })
        await renderTask.promise
      } catch (e) {
        if (!cancelled && (e as { name?: string }).name !== 'RenderingCancelledException') {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNumber])

  if (error) return <div className="p-4 text-sm text-destructive">Couldn't render PDF: {error}</div>

  return (
    <div ref={wrapRef} className="relative">
      {(!doc || rendering) && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-card/60">
          <LoadingState />
        </div>
      )}
      <canvas ref={canvasRef} className="block w-full rounded border border-border bg-white" />
    </div>
  )
}
