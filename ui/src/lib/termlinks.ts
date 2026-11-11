/**
 * Links in a terminal: plain-text URLs (the web-links addon) and OSC 8
 * hyperlinks (xterm's `linkHandler`; Claude Code prints them), shared by the
 * dashboard's terminal (components/Terminal.tsx) and the app's tabs
 * (components/TerminalPane.tsx).
 *
 * A link opens on Cmd+click on macOS and Ctrl+click elsewhere, as in VS Code
 * and iTerm2. A plain click does nothing, so dragging a selection across a URL
 * still selects it. Before this no link opened at all: the addon was never
 * loaded, and xterm's own OSC 8 fallback asks through `window.confirm`, which
 * the desktop app's webview never shows.
 *
 * A long URL is one link however it wraps. xterm's own wrap marks the next
 * row as a continuation, but Claude Code breaks a URL wider than the screen
 * itself: a newline, then the indent, then the rest. Matching row by row, as
 * the web-links addon did, opened the URL cut at the first break (owner,
 * 2026-11-11, translated: "if I click it, only the first line or part of the
 * link is taken"). `urlRows` joins a row that is full to the right edge and
 * ends inside a URL with the next row's text, its indent dropped.
 *
 * Only http, https and mailto open. Anything else a program prints (file:,
 * javascript:, a custom scheme that launches an app) is ignored: the text in a
 * terminal comes from whatever ran there, not from the user.
 *
 * A `.md` path an agent prints (`docs/PLAN.md`, `/Users/…/NOTES.md:12`) is a
 * link too, on the same Cmd/Ctrl+click, when the caller passes `onPath`: the
 * app's terminal does, and the workspace opens the file in a file tab if it
 * lies inside a project Caprock knows (lib/mdreader). It never leaves the
 * machine.
 *
 * An http(s) link also takes **⇧⌘-click** (Ctrl+Shift+click elsewhere;
 * `LINK_CHOOSE_CLICK`, lib/appkeys.ts): a small chooser at the pointer lists
 * the browsers installed here, the default first, and *Copy link*
 * (components/LinkChooser.tsx, owner, 2026-10-17). A mailto link or a path
 * has no chooser: the chord opens it as ⌘-click does.
 */
import type { IBufferLine, IBufferRange, IDisposable, ILink, ILinkHandler, Terminal as Xterm } from '@xterm/xterm'
import { isMacPlatform, isTauri } from './appmode'
import { keys, LINK_CHOOSE_CLICK, LINK_OPEN_CLICK } from './appkeys'
import { shell } from './shell'
import { mdPathsIn } from './mdreader'

const SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** The URL to open for `raw`, normalised, or null when it is not one we open. */
export function openableUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!SCHEMES.has(u.protocol)) return null
  if (u.protocol !== 'mailto:' && !u.hostname) return null
  return u.href
}

/** Whether a click opens the link under it: Cmd on macOS, Ctrl elsewhere, not both. */
export function opensLink(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, mac: boolean): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** Whether a click opens the browser chooser: ⇧⌘ on macOS, Ctrl+Shift elsewhere, no Alt. */
export function choosesBrowser(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  return opensLink(e, mac) && e.shiftKey && !e.altKey
}

/** Whether a URL can go to a browser of the user's choosing: http and https. */
export function isWebUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

/**
 * The hover hint for the platform, through `keys()`. A web link names both
 * clicks; a mailto link, only the one that opens it.
 */
export function linkHint(mac: boolean, choose = false): string {
  const open = `${keys(LINK_OPEN_CLICK, mac)} to open`
  return choose ? `${open} · ${keys(LINK_CHOOSE_CLICK, mac)} to choose where it opens` : open
}

/** The chooser for `url` at the pointer, loaded on first use (components/LinkChooser.tsx). */
export function chooseBrowser(url: string, at: { x: number; y: number }): void {
  void import('@/components/LinkChooser')
    .then((m) => m.showLinkChooser(url, at))
    .catch(() => openLink(url))
}

/**
 * Opens `url` outside the page: the default browser in the desktop app (its
 * `open_external` command), a new tab in a browser. A shell that refuses the
 * command (an older app, before it took mailto) still gets the link through
 * `window.open`, which it hands to the browser too (app/src-tauri/src/shell.rs).
 */
export function openLink(url: string): void {
  const safe = openableUrl(url)
  if (!safe) return
  const viaPage = () => { window.open(safe, '_blank', 'noopener') }
  if (isTauri()) {
    shell.openExternal(safe).catch(viaPage)
    return
  }
  viaPage()
}

/**
 * Turns links on in `term`, which must already be open. Returns what to call
 * on teardown. `mac` and `open` are for tests.
 */
export function attachTerminalLinks(
  term: Xterm,
  opts: {
    mac?: boolean
    open?: (url: string) => void
    /** The chooser for a ⇧⌘-click on a web link; `chooseBrowser` by default. */
    choose?: (url: string, at: { x: number; y: number }) => void
    onPath?: (path: string) => void
  } = {},
): IDisposable {
  const mac = opts.mac ?? isMacPlatform()
  const open = opts.open ?? openLink
  const choose = opts.choose ?? chooseBrowser
  let tip: HTMLDivElement | null = null

  const hide = () => {
    tip?.remove()
    tip = null
  }
  const show = (e: MouseEvent, url: string, label?: string, says?: string) => {
    hide()
    const host = term.element
    if (!host) return
    const el = document.createElement('div')
    // xterm-hover: mouse events on the tip do not fall through to the grid.
    el.className = 'xterm-hover caprock-link-tip'
    el.setAttribute('role', 'tooltip')
    el.style.cssText = [
      'position:absolute', 'z-index:20', 'pointer-events:none', 'max-width:28rem',
      'padding:2px 6px', 'border-radius:4px', 'font:11px/1.4 var(--font-sans, sans-serif)',
      'background:var(--color-panel-2, #262422)', 'color:var(--color-fg-muted, #a9a59e)',
      'border:1px solid var(--color-border-strong, #3a3835)', 'white-space:nowrap',
      'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';')
    // An OSC 8 link can put any text over any address: name the address.
    const hint = linkHint(mac, isWebUrl(url))
    el.textContent = says ?? (label !== undefined && label !== url ? `${hint} · ${url}` : hint)
    const r = host.getBoundingClientRect()
    el.style.left = `${Math.max(0, e.clientX - r.left + 8)}px`
    el.style.top = `${Math.max(0, e.clientY - r.top + 14)}px`
    host.append(el)
    tip = el
  }
  const activate = (e: MouseEvent, url: string) => {
    if (!opensLink(e, mac)) return
    const safe = openableUrl(url)
    if (!safe) return
    e.preventDefault()
    hide()
    if (choosesBrowser(e, mac) && isWebUrl(safe)) choose(safe, { x: e.clientX, y: e.clientY })
    else open(safe)
  }

  // OSC 8: `text` is the link's URI. Non-http schemes reach us (mailto) and
  // activate filters them.
  const handler: ILinkHandler = {
    allowNonHttpProtocols: true,
    activate: (e, text) => activate(e, text),
    hover: (e, text, range) => {
      if (openableUrl(text)) show(e, text, labelOf(term, range))
    },
    leave: hide,
  }
  term.options.linkHandler = handler
  const urls = term.registerLinkProvider({
    provideLinks: (y, done) => {
      const links = urlsAt(term, y).map((u): ILink => ({
        range: u.range,
        text: u.url,
        decorations: { underline: true, pointerCursor: false },
        activate: (e) => activate(e, u.url),
        hover: (e) => show(e, u.url),
        leave: hide,
      }))
      done(links.length > 0 ? links : undefined)
    },
  })

  const onPath = opts.onPath
  const paths = onPath ? term.registerLinkProvider({
    provideLinks: (y, done) => {
      const line = term.buffer.active.getLine(y - 1)
      const text = line?.translateToString(true) ?? ''
      const hits = mdPathsIn(text)
      if (hits.length === 0) { done(undefined); return }
      done(hits.map((h): ILink => ({
        range: { start: { x: h.start + 1, y }, end: { x: h.end, y } },
        text: h.path,
        decorations: { underline: true, pointerCursor: false },
        activate: (e) => {
          if (!opensLink(e, mac)) return
          e.preventDefault()
          hide()
          onPath(h.path)
        },
        hover: (e) => show(e, h.path, undefined, `${linkHint(mac)} in a tab · ${h.path}`),
        leave: hide,
      })))
    },
  }) : null

  return {
    dispose: () => {
      hide()
      paths?.dispose()
      urls.dispose()
      if (term.options.linkHandler === handler) term.options.linkHandler = null
    },
  }
}

/** The text a link covers on screen, to tell an OSC 8 label from its address. */
function labelOf(term: Xterm, range: IBufferRange): string | undefined {
  try {
    const buf = term.buffer.active
    let out = ''
    for (let y = range.start.y; y <= range.end.y; y++) {
      const line = buf.getLine(y - 1)
      if (!line) return undefined
      const from = y === range.start.y ? range.start.x - 1 : 0
      const to = y === range.end.y ? range.end.x : undefined
      out += line.translateToString(true, from, to)
    }
    return out
  } catch {
    return undefined
  }
}

// The web-links addon's pattern: a URL never ends on punctuation that closes
// the sentence around it.
const URL_RE = /(?:https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]|mailto:[^\s"'<>`]+[^\s"'<>`.,;:!?)]/g

/** Rows joined at most, and characters: a runaway screen of one token stops here. */
const MAX_ROWS = 40
const MAX_CHARS = 4096

/** One row as text, with the 1-based cell each UTF-16 unit stands in. */
interface Row {
  text: string
  cells: number[]
}

function rowOf(line: IBufferLine, cols: number): Row {
  let text = ''
  const cells: number[] = []
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const ch = cell.getChars() || ' '
    text += ch
    for (let i = 0; i < ch.length; i++) cells.push(x + 1)
  }
  const end = text.trimEnd().length
  return { text: text.slice(0, end), cells: cells.slice(0, end) }
}

/** A row's text after its indent, and how many units the indent took. */
function unindent(row: Row): [string, number] {
  const body = row.text.trimStart()
  return [body, row.text.length - body.length]
}

/**
 * Whether row `y` (0-based) goes on in row `y + 1`: xterm wrapped it, or a
 * program broke a URL at the edge. A hard break counts only when `y` reaches
 * the last cells of the screen and its last word is a URL or a piece of one
 * (the whole row is that word), and the next row starts, after a short
 * indent, with a character a URL can hold. Prose that happens to end at the edge has a space in the row
 * and no scheme in its last word, so it never joins.
 */
function goesOn(term: Xterm, y: number): boolean {
  const buf = term.buffer.active
  const next = buf.getLine(y + 1)
  if (!next) return false
  if (next.isWrapped) return true
  const line = buf.getLine(y)
  if (!line) return false
  const row = rowOf(line, term.cols)
  const last = row.cells[row.cells.length - 1]
  if (last === undefined || last < term.cols - 2) return false
  const [body] = unindent(row)
  const word = body.slice(body.search(/\S+$/))
  if (!/:\/\/|^mailto:/i.test(word) && /\s/.test(body)) return false
  const [rest, indent] = unindent(rowOf(next, term.cols))
  // What goes on is URL text: a border or a bullet under the URL is not.
  return indent <= 8 && /^[\w\-.~:/?#[\]@!$&'()*+,;=%]/.test(rest)
}

/** The URLs that cover row `y` (1-based), each read across the rows it wraps over. */
export function urlsAt(term: Xterm, y: number): { url: string; range: IBufferRange }[] {
  const buf = term.buffer.active
  const at = y - 1
  if (!buf.getLine(at)) return []
  let top = at
  while (top > 0 && at - top < MAX_ROWS && goesOn(term, top - 1)) top--
  let bottom = at
  while (bottom - top < MAX_ROWS && goesOn(term, bottom)) bottom++

  let text = ''
  const where: { x: number; y: number }[] = []
  for (let r = top; r <= bottom && text.length < MAX_CHARS; r++) {
    const line = buf.getLine(r)
    if (!line) break
    const row = rowOf(line, term.cols)
    // A soft wrap keeps every cell; a hard break drops the indent it added.
    const skip = r > top && !line.isWrapped ? unindent(row)[1] : 0
    text += row.text.slice(skip)
    for (let i = skip; i < row.cells.length; i++) where.push({ x: row.cells[i]!, y: r + 1 })
  }

  const out: { url: string; range: IBufferRange }[] = []
  for (const m of text.matchAll(URL_RE)) {
    const from = where[m.index]
    const to = where[m.index + m[0].length - 1]
    if (!from || !to || to.y < y || from.y > y) continue
    if (!openableUrl(m[0])) continue
    out.push({ url: m[0], range: { start: from, end: to } })
  }
  return out
}
