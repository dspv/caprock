/**
 * The file tab's readers that are loaded only when such a file is opened
 * (.ai/04-ui.md § File tabs): an HTML page drawn in a sandboxed frame, a
 * CSV or TSV file as a table, a picture file, and Split's two panes. FileView.tsx imports this module lazily, so the
 * app's own chunks stay as they were.
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { baseName, filesApi, fmtBytes } from '@/lib/files'
import { MAX_TABLE_ROWS, parseDelimited, previewHtml, type AssetReader } from '@/lib/filerich'
import { imageUrl } from '@/lib/mdreader'

/** A picture larger than this is left out of a rendered page. */
const MAX_PAGE_IMAGE_BYTES = 4 << 20

async function dataUrl(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${b.type || 'application/octet-stream'};base64,${btoa(bin)}`
}

/**
 * An HTML file as a browser draws it, in a frame with an empty `sandbox`
 * (no scripts, forms, pop-ups or origin) and a policy that loads nothing
 * from the network; its relative pictures and stylesheets are read from the
 * project through the daemon and inlined.
 */
export const HtmlPreview = memo(function HtmlPreview({ text, projectId, worktree, path }: { text: string; projectId: string; worktree: string; path: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const ref = { projectId, worktree }
    const read: AssetReader = {
      image: async (file) => {
        const u = await imageUrl(ref, file)
        try {
          const b = await (await fetch(u)).blob()
          if (b.size > MAX_PAGE_IMAGE_BYTES) throw new Error('too large')
          return await dataUrl(b)
        } finally {
          URL.revokeObjectURL(u)
        }
      },
      text: async (file) => {
        const f = await filesApi.read(ref, file)
        if (f.binary) throw new Error('binary')
        return f.text
      },
    }
    previewHtml(text, path, read).then((h) => { if (alive) setHtml(h) }, () => { if (alive) setHtml('') })
    return () => { alive = false }
  }, [text, projectId, worktree, path])
  if (html === null) return <p className="px-4 py-3 text-[12px] text-fg-faint">Drawing the page…</p>
  return (
    <iframe
      title={`${path}, rendered`}
      data-html-preview
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={html}
      className="block h-full w-full border-0 bg-white"
    />
  )
})

/** A CSV or TSV file as a table: the first row its header, row numbers, the first 2,000 rows. */
export const DelimitedTable = memo(function DelimitedTable({ text, tsv }: { text: string; tsv: boolean }) {
  const { rows, more } = useMemo(() => parseDelimited(text, tsv), [text, tsv])
  if (rows.length === 0) return <p className="px-4 py-3 text-[12px] text-fg-faint">No rows.</p>
  const [head, ...body] = rows
  const cols = Math.max(...rows.map((r) => r.length))
  const cell = 'max-w-[44ch] truncate border-b border-r border-[var(--app-hairline)] px-2.5 py-[3px] text-left align-top'
  return (
    <div className="pb-6">
      <table data-csv className="mono w-max min-w-full border-separate border-spacing-0 text-[12px] leading-[1.55]">
        <thead>
          <tr>
            <th aria-hidden data-gutter className={`${cell} sticky left-0 top-0 z-20 bg-panel text-fg-faint`} />
            {Array.from({ length: cols }, (_, i) => (
              <th key={i} title={head![i]} className={`${cell} sticky top-0 z-10 bg-panel font-medium text-fg`}>{head![i] ?? ''}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, n) => (
            <tr key={n} className="hover:bg-[var(--app-row-hover)]">
              <td aria-hidden data-gutter className={`${cell} sticky left-0 bg-bg text-right text-fg-faint`}>{n + 1}</td>
              {Array.from({ length: cols }, (_, i) => (
                <td key={i} title={r[i] && r[i]!.length > 40 ? r[i] : undefined} className={`${cell} text-fg-muted`}>{r[i] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more && <p className="px-4 pt-2 text-[11.5px] text-fg-faint">The first {MAX_TABLE_ROWS.toLocaleString()} rows are drawn; Source has the rest.</p>}
    </div>
  )
})

/**
 * Split: the source on the left, the page on the right, each scrolling on
 * its own; with `sync`, the one being scrolled leads and the other follows
 * at the same proportion of its length.
 */
export function SplitPanes({ left, right, sync, onPage }: { left: ReactNode; right: ReactNode; sync: boolean; onPage: (el: HTMLDivElement | null) => void }) {
  const src = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    onPage(page.current)
    return () => onPage(null)
  }, [onPage])
  useEffect(() => {
    const a = src.current
    const b = page.current
    if (!sync || !a || !b) return
    let lead: HTMLElement | null = null
    let frame = 0
    let release = 0
    const follow = (from: HTMLElement, to: HTMLElement) => () => {
      if (lead && lead !== from) return
      lead = from
      window.clearTimeout(release)
      release = window.setTimeout(() => { lead = null }, 150)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const room = from.scrollHeight - from.clientHeight
        to.scrollTop = (room > 0 ? from.scrollTop / room : 0) * (to.scrollHeight - to.clientHeight)
      })
    }
    const fromA = follow(a, b)
    const fromB = follow(b, a)
    a.addEventListener('scroll', fromA, { passive: true })
    b.addEventListener('scroll', fromB, { passive: true })
    return () => {
      a.removeEventListener('scroll', fromA)
      b.removeEventListener('scroll', fromB)
      cancelAnimationFrame(frame)
      window.clearTimeout(release)
    }
  }, [sync])
  return (
    <div className="flex h-full w-full" data-split>
      <div ref={src} data-split-source className="app-scroll h-full min-w-0 flex-1 overflow-auto border-r border-[var(--app-hairline)]">{left}</div>
      <div ref={page} data-split-page className="app-scroll h-full min-w-0 flex-1 overflow-auto">{right}</div>
    </div>
  )
}

/** A picture file, read through the daemon as a Markdown file's pictures are, with its size in pixels. */
export function ImageFile({ projectId, worktree, path, size }: { projectId: string; worktree: string; path: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [dims, setDims] = useState('')
  useEffect(() => {
    let alive = true
    let url = ''
    imageUrl({ projectId, worktree }, path)
      .then((u) => { if (alive) { url = u; setSrc(u) } else URL.revokeObjectURL(u) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [projectId, worktree, path])
  if (failed) return <p className="px-4 py-4 text-[12.5px] text-fg-muted">This picture could not be read.</p>
  if (!src) return <p className="px-4 py-3 text-[12px] text-fg-faint">Reading…</p>
  return (
    <figure className="flex min-h-full flex-col items-center justify-center gap-3 p-6" data-image-file>
      <img
        src={src}
        alt={baseName(path)}
        onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
        className="h-auto max-w-full rounded-[4px] [background:repeating-conic-gradient(var(--app-hairline)_0_25%,transparent_0_50%)_0_0/16px_16px]"
      />
      <figcaption className="num text-[11px] text-fg-faint">{dims ? `${dims} · ` : ''}{fmtBytes(size)}</figcaption>
    </figure>
  )
}
