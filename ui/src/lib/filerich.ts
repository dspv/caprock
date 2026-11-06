/**
 * The pure halves of the file tab's richer readers (.ai/04-ui.md § File
 * tabs): an HTML page made safe to draw in a sandboxed frame, and a CSV or
 * TSV file read into rows. Imported only by components/FileRich.tsx, which
 * the tab loads on demand, so neither costs the app's own chunks anything.
 */
import { resolveLink } from './files'

/**
 * The policy the rendered page carries: nothing loads from anywhere — no
 * script, no request, not even to the daemon — except the pictures and
 * styles inlined below as data. The frame's empty `sandbox` already stops
 * scripts, forms, pop-ups and the page's own origin; this stops the network.
 */
export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:"

/** Reads a project file for the page: a picture as a data URL, a stylesheet as text. */
export interface AssetReader {
  image: (file: string) => Promise<string>
  text: (file: string) => Promise<string>
}

/** At most this many pictures and stylesheets are read into one page. */
export const MAX_PAGE_IMAGES = 40
export const MAX_PAGE_SHEETS = 8

const DROP = 'script, base, iframe, frame, frameset, object, embed, portal, applet, meta[http-equiv]:not([http-equiv="content-type" i])'

/** A path inside the worktree for a relative reference; null for anything on the web or outside. */
function local(fromPath: string, ref: string | null): string | null {
  const r = (ref ?? '').trim()
  if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('//')) return null
  const to = resolveLink(fromPath, r)
  return to && 'file' in to ? to.file : null
}

/**
 * The page as srcdoc: scripts, frames, plugins, refreshes and base URLs
 * gone, every link and form made inert, event attributes stripped, a
 * Content-Security-Policy put first in its head; a relative picture or
 * stylesheet inside the project read through `read` and inlined, anything
 * on the web left out. Without `read`, no picture or stylesheet comes in.
 */
export async function previewHtml(text: string, fromPath: string, read: AssetReader | null): Promise<string> {
  const doc = new DOMParser().parseFromString(text, 'text/html')
  for (const el of doc.querySelectorAll(DROP)) el.remove()
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || a.name === 'srcset' || a.name === 'ping' || a.name === 'formaction') el.removeAttribute(a.name)
    }
  }
  for (const a of doc.querySelectorAll('a[href], area[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue
    a.setAttribute('title', href)
    a.removeAttribute('href')
  }
  for (const f of doc.querySelectorAll('form')) f.removeAttribute('action')
  for (const s of doc.querySelectorAll('source, track')) s.remove()
  for (const m of doc.querySelectorAll('video[src], audio[src], video[poster], input[src]')) { m.removeAttribute('src'); m.removeAttribute('poster') }

  const jobs: Promise<void>[] = []
  let sheets = 0
  for (const l of doc.querySelectorAll('link')) {
    const file = /\bstylesheet\b/i.test(l.getAttribute('rel') ?? '') ? local(fromPath, l.getAttribute('href')) : null
    if (!file || !read || sheets >= MAX_PAGE_SHEETS) { l.remove(); continue }
    sheets++
    jobs.push(read.text(file).then(
      (css) => { const s = doc.createElement('style'); s.textContent = css.replace(/<\/style/gi, '<\\/style'); l.replaceWith(s) },
      () => l.remove(),
    ))
  }
  let images = 0
  for (const img of doc.querySelectorAll('img')) {
    const file = local(fromPath, img.getAttribute('src'))
    img.removeAttribute('src')
    if (!file || !read || images >= MAX_PAGE_IMAGES) continue
    images++
    jobs.push(read.image(file).then((url) => img.setAttribute('src', url), () => {}))
  }
  await Promise.all(jobs)

  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', PREVIEW_CSP)
  doc.head.prepend(csp)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

/** At most this many rows of a CSV or TSV file are drawn as a table. */
export const MAX_TABLE_ROWS = 2000
export const MAX_TABLE_COLS = 100

/**
 * The rows of a CSV (RFC 4180: quoted fields, doubled quotes, line breaks
 * inside quotes) or TSV file, at most `maxRows`; `more` when there were
 * more. A `.csv` whose first line holds semicolons and no commas is read
 * with semicolons, as spreadsheets in many locales write it.
 */
export function parseDelimited(text: string, tsv: boolean, maxRows = MAX_TABLE_ROWS): { rows: string[][]; more: boolean } {
  let sep = tsv ? '\t' : ','
  if (!tsv) {
    const first = text.slice(0, text.indexOf('\n') >>> 0)
    if (!first.includes(',') && first.includes(';')) sep = ';'
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length
  const endRow = () => {
    row.push(field)
    field = ''
    if (!(row.length === 1 && row[0] === '')) rows.push(row.slice(0, MAX_TABLE_COLS))
    row = []
  }
  for (; i < n; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
      if (rows.length > maxRows) break
    } else field += c
  }
  if (i >= n && (field !== '' || row.length > 0)) endRow()
  return { rows: rows.slice(0, maxRows), more: rows.length > maxRows }
}
