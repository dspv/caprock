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
import type { IBufferRange, IDisposable, ILink, ILinkHandler, Terminal as Xterm } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
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
  const addon = new WebLinksAddon((e, uri) => activate(e, uri), {
    hover: (e, uri) => show(e, uri),
    leave: hide,
  })
  term.loadAddon(addon)

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
      addon.dispose()
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
