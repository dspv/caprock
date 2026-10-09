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
 */
import type { IBufferRange, IDisposable, ILinkHandler, Terminal as Xterm } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { isMacPlatform, isTauri } from './appmode'
import { shell } from './shell'

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

/** The hover hint for the platform. */
export function linkHint(mac: boolean): string {
  return mac ? '⌘-click to open' : 'Ctrl+click to open'
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
  opts: { mac?: boolean; open?: (url: string) => void } = {},
): IDisposable {
  const mac = opts.mac ?? isMacPlatform()
  const open = opts.open ?? openLink
  let tip: HTMLDivElement | null = null

  const hide = () => {
    tip?.remove()
    tip = null
  }
  const show = (e: MouseEvent, url: string, label?: string) => {
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
    el.textContent = label !== undefined && label !== url ? `${linkHint(mac)} · ${url}` : linkHint(mac)
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
    open(safe)
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

  return {
    dispose: () => {
      hide()
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
