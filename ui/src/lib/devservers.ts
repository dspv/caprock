/**
 * Phone preview in one click (owner, 2026-10-22: Lena, a front-end hand,
 * should see her site as a phone shows it without four steps). A local dev
 * server's address printed in a terminal — Vite's `➜  Local:
 * http://localhost:5173/`, Next's `- Local: http://localhost:3000`,
 * webpack's `Loopback: http://localhost:8080/`, a bare `127.0.0.1:8000` —
 * gets a small *Preview on phone* action beside it. Clicking it opens the
 * page in a browser tab split beside the terminal, already in Phone mode
 * with Touch on (AppShell `openPreview`, components/BrowserView.tsx).
 *
 * - **Local only.** localhost, *.localhost, 127.x, 0.0.0.0, [::1] and [::].
 *   A remote address, a file path or anything else gets no action: the text
 *   in a terminal comes from whatever ran there, and only this machine's
 *   pages are a dev server's.
 * - **Cheap.** Scanned on parsed write batches (xterm's onWriteParsed), at
 *   most once per SCAN_MS, over the last SCAN_ROWS rows, and a row whose text
 *   has none of the local hosts in it is skipped before any pattern runs —
 *   the way lib/termupdate.ts watches for update notices.
 * - **Remembered for the window's life.** Each address seen is kept (newest
 *   first, MAX_SERVERS) for ⌘K's *Preview on phone…*, with the session it was
 *   seen in. Nothing is stored and nothing is probed.
 *
 * The page itself lives in the desktop app only (lib/browsertab
 * `browserAvailable`), so the action is drawn only there.
 */
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm'

/** How far up from the bottom of the buffer an address is looked for. */
export const SCAN_ROWS = 40
/** At most one scan this often while output flows. */
export const SCAN_MS = 400
/** How many servers ⌘K remembers. */
export const MAX_SERVERS = 8

/** The action's words beside the link. */
export const PREVIEW_LABEL = 'Preview on phone'
/** Cells the action takes: a glyph, a space, the words, a cell of air each side. */
export const PREVIEW_CELLS = PREVIEW_LABEL.length + 4

export interface DevUrl {
  /** The address as printed. */
  text: string
  /** The address to open: http(s), 0.0.0.0 and [::] made localhost. */
  url: string
  /** Its place in the line: the first character and one past the last. */
  start: number
  end: number
}

const HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|(?:[a-z0-9-]+\.)+localhost)`
/** A full address: scheme, a local host, an optional port and path. */
const WITH_SCHEME = new RegExp(String.raw`\bhttps?://${HOST}(?![\w.-])(?::\d{1,5})?(?:[/?#][^\s"'<>\`]*)?`, 'gi')
/** A bare host and port, never inside a path or another address. */
const BARE = new RegExp(String.raw`(?<![\w/.:@-])${HOST}:\d{2,5}(?:/[^\s"'<>\`]*)?`, 'gi')
/** A row is looked at only when it has one of these in it. */
const HINT = /localhost|127\.\d|0\.0\.0\.0|\[::/i
/** What a sentence leaves at an address's end. */
const TRAILING = /[.,;:!?)\]}'"]+$/

/** Whether `text` might hold a local address: the cheap test before any pattern. */
export function mightHoldDevUrl(text: string): boolean {
  return HINT.test(text)
}

/** The address to open for a local one as printed, or null for one that is not local. */
export function devUrlOf(raw: string): string | null {
  const s = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const h = u.hostname.toLowerCase()
  const local = h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0' || h === '[::1]' || h === '[::]'
  if (!local) return null
  // A server bound to every address answers on this machine's own.
  if (h === '0.0.0.0' || h === '[::]') u.hostname = 'localhost'
  return u.href
}

/** Every local dev-server address in one line of terminal text, left to right. */
export function devUrlsIn(line: string): DevUrl[] {
  if (!mightHoldDevUrl(line)) return []
  const out: DevUrl[] = []
  const taken: [number, number][] = []
  for (const re of [WITH_SCHEME, BARE]) {
    re.lastIndex = 0
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const text = m[0].replace(TRAILING, '')
      const start = m.index
      const end = start + text.length
      if (taken.some(([a, b]) => start < b && end > a)) continue
      const url = devUrlOf(text)
      if (!url) continue
      taken.push([start, end])
      out.push({ text, url, start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------
// What this window has seen

export interface DevServer {
  /** The address to open. */
  url: string
  /** The session whose terminal printed it. */
  sessionId?: string
  /** When it was last seen, ms. */
  seen: number
}

/** Said on window when the list changes. */
export const DEV_SERVERS_EVENT = 'caprock:dev-servers'

const seen = new Map<string, DevServer>()

/** Remembers `url` as seen now, in `sessionId`'s terminal. */
export function noteDevServer(url: string, sessionId?: string, now = Date.now()): void {
  let key = url
  try { key = new URL(url).origin } catch { /* kept as printed */ }
  const was = seen.get(key)
  seen.delete(key)
  seen.set(key, { url, ...(sessionId ? { sessionId } : was?.sessionId ? { sessionId: was.sessionId } : {}), seen: now })
  while (seen.size > MAX_SERVERS) seen.delete(seen.keys().next().value!)
  if (!was && typeof window !== 'undefined') window.dispatchEvent(new Event(DEV_SERVERS_EVENT))
}

/** The servers seen this window, newest first. */
export function devServers(): DevServer[] {
  return [...seen.values()].sort((a, b) => b.seen - a.seen)
}

/** Tests: forget them all. */
export function forgetDevServers(): void {
  seen.clear()
}

// ---------------------------------------------------------------------------
// Asking for a preview

/** Something asks for a phone preview: the terminal's action or ⌘K (AppShell listens). */
export const PHONE_PREVIEW_EVENT = 'caprock:phone-preview'

export interface PhonePreviewDetail {
  url: string
  /** The session whose terminal it came from: the preview opens beside it. */
  sessionId?: string
}

export function requestPhonePreview(d: PhonePreviewDetail): void {
  window.dispatchEvent(new CustomEvent<PhonePreviewDetail>(PHONE_PREVIEW_EVENT, { detail: d }))
}

// ---------------------------------------------------------------------------
// The action in a terminal

const PHONE_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>'

/** The button xterm places beside an address. */
function drawAction(el: HTMLElement, url: string, onPreview: (url: string) => void): void {
  if (el.dataset.devPreview) return
  el.dataset.devPreview = url
  // xterm-hover: the mouse on it does not start a selection in the grid.
  el.classList.add('xterm-hover')
  el.style.pointerEvents = 'auto'
  el.style.display = 'flex'
  el.style.alignItems = 'center'
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'caprock-dev-preview'
  b.title = `Open ${url} beside this terminal, as a phone shows it`
  b.setAttribute('aria-label', `${PREVIEW_LABEL}: ${url}`)
  b.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:4px', 'height:calc(100% - 2px)', 'margin-left:1ch',
    'padding:0 6px', 'border-radius:4px', 'cursor:pointer', 'white-space:nowrap',
    'font:11px/1 var(--font-sans, sans-serif)', 'color:var(--color-fg, #ece8e1)',
    'background:color-mix(in srgb, var(--color-accent, #e7bb63) 22%, var(--color-panel-2, #262422))',
    'border:1px solid color-mix(in srgb, var(--color-accent, #e7bb63) 55%, transparent)',
  ].join(';')
  b.innerHTML = `${PHONE_SVG}<span>${PREVIEW_LABEL}</span>`
  const stop = (e: Event) => { e.stopPropagation() }
  b.addEventListener('mousedown', stop)
  b.addEventListener('mouseup', stop)
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onPreview(url)
  })
  el.append(b)
}

/**
 * Watches `term` for local dev-server addresses: each is remembered for ⌘K
 * and, when `onPreview` is given, gets the action beside it — after the
 * line's text, when the row has room for it. Returns what to call on
 * teardown.
 */
export function attachDevServerWatch(
  term: Terminal,
  opts: { sessionId?: string; onPreview?: (url: string) => void } = {},
): IDisposable {
  let timer = 0
  let last = 0
  let gone = false
  const drawn: { marker: IMarker; deco?: IDecoration; start: number }[] = []
  const has = (y: number, start: number) => drawn.some((d) => !d.marker.isDisposed && d.marker.line === y && d.start === start)
  const scan = () => {
    timer = 0
    last = Date.now()
    if (gone) return
    const b = term.buffer.active
    if (b.type !== 'normal') return
    // A trimmed row takes its marker along.
    for (let i = drawn.length - 1; i >= 0; i--) if (drawn[i]!.marker.isDisposed) drawn.splice(i, 1)
    const end = b.length
    const cursor = b.baseY + b.cursorY
    for (let y = Math.max(0, end - SCAN_ROWS); y < end; y++) {
      const text = b.getLine(y)?.translateToString(true) ?? ''
      const hits = devUrlsIn(text)
      if (hits.length === 0) continue
      for (const h of hits) noteDevServer(h.url, opts.sessionId)
      const onPreview = opts.onPreview
      if (!onPreview) continue
      // One action a row, after its text: it never covers what was printed.
      const h = hits[hits.length - 1]!
      if (has(y, h.start)) continue
      const x = text.length
      if (x + PREVIEW_CELLS > term.cols) continue
      const marker = term.registerMarker(y - cursor)
      if (!marker) continue
      const deco = term.registerDecoration({ marker, x, width: PREVIEW_CELLS, layer: 'top' })
      deco?.onRender((el) => drawAction(el, h.url, onPreview))
      drawn.push({ marker, ...(deco ? { deco } : {}), start: h.start })
    }
  }
  const sub = term.onWriteParsed(() => {
    if (gone || timer) return
    timer = window.setTimeout(scan, Math.max(0, SCAN_MS - (Date.now() - last)))
  })
  return {
    dispose: () => {
      gone = true
      if (timer) window.clearTimeout(timer)
      sub.dispose()
      for (const d of drawn) { d.deco?.dispose(); d.marker.dispose() }
      drawn.length = 0
    },
  }
}
