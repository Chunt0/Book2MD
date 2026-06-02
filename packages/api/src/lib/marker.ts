import { env } from './env'
import { BadGatewayError, ServiceUnavailableError } from './errors'

// Adapter seam over the stock marker_server (NEW_PROJECT_SPEC §13). Pure
// deterministic conversion — NO LLM (M0: in-loop LLM = hours/book). We request
// output_format=markdown + paginate_output=true: marker's native high-fidelity
// Markdown with $$…$$ / $…$ math and a "{N}----" page separator. Per-block
// layout/polygons (json) are deferred to M4 (review alignment).

export interface MarkerOptions {
  /** OCR every page (scanned PDFs). */
  forceOcr?: boolean
  /** Subset of pages, e.g. "0,5-10". Omit for the whole document. */
  pageRange?: string
  /** Abort the request after this many ms. Defaults to CONVERT_TIMEOUT_MS.
   * NOTE: Bun's fetch hard-caps any request at ~300s regardless (oven-sh/bun#16682),
   * so callers must keep this — and the per-call work — under that ceiling. */
  timeoutMs?: number
}

export interface MarkerResponse {
  format: string
  output: string
  images: Record<string, string>
  metadata: unknown
  success: boolean
  error?: string
}

/** POST a conversion to a marker_server instance. `baseUrl` selects which instance
 *  (parallel conversion runs several). Maps transport/upstream failures to envelope errors. */
export async function callMarker(
  containerPath: string,
  opts: MarkerOptions = {},
  baseUrl: string = env.MARKER_URL,
): Promise<MarkerResponse> {
  const body: Record<string, unknown> = {
    filepath: containerPath,
    output_format: 'markdown',
    paginate_output: true,
    force_ocr: opts.forceOcr ?? false,
  }
  if (opts.pageRange) body.page_range = opts.pageRange

  let res: Response
  try {
    res = await fetch(`${baseUrl}/marker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? env.CONVERT_TIMEOUT_MS),
    })
  } catch (e) {
    throw new ServiceUnavailableError(`marker unreachable at ${baseUrl}: ${String(e)}`)
  }
  if (!res.ok) throw new BadGatewayError(`marker returned HTTP ${res.status}`)

  const data = (await res.json()) as MarkerResponse
  if (!data.success) throw new BadGatewayError(`marker failed: ${data.error ?? 'unknown error'}`)
  return data
}

export interface ParsedPage {
  pageNumber: number
  markdown: string
}

// paginate_output separates pages with a line: "{<markerIndex>}" + many dashes.
const PAGE_SEP = /\{(\d+)\}-{10,}\s*/g

/** Split paginated marker markdown into per-page chunks. pageNumber is 1-based. */
export function parsePaginatedMarkdown(output: string): ParsedPage[] {
  const matches = [...output.matchAll(PAGE_SEP)]
  if (matches.length === 0) {
    const md = output.trim()
    return md ? [{ pageNumber: 1, markdown: md }] : []
  }
  const pages: ParsedPage[] = []
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const markerIndex = Number(m[1])
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? output.length) : output.length
    pages.push({ pageNumber: markerIndex + 1, markdown: output.slice(start, end).trim() })
  }
  return pages
}
