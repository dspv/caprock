/**
 * A Page tab (ADR-070): a web page opened inside Caprock, beside the agents'
 * tabs and never among them — a quick viewer, not a browser.
 *
 * In the desktop app the page is a native child webview the shell lays over
 * the tab's content area (app/src-tauri/src/page.rs): its own data store, no
 * command of Caprock's, nothing loaded without a click. In a browser a page
 * on this machine (localhost, 127.0.0.1) shows in an iframe; any other
 * address opens in a browser tab, since most sites refuse to be framed.
 *
 * Pure helpers here; components/PageView.tsx draws the tab.
 */
import { shell } from './shell'

/** The shell's word on a page: what it loaded, its title, a new window, a download (page.rs EVENT). */
export const PAGE_EVENT = 'caprock:page'

/** Something in the window asks for a page in a tab: a ⌘-click on a link in a terminal or a chat. */
export const OPEN_PAGE_EVENT = 'caprock:open-page'

export interface OpenPageDetail {
  url: string
  /** The session whose terminal or chat the link was in. */
  sessionId?: string
}

/** Asks the workspace for a page in a tab (AppShell listens). */
export function requestOpenPage(d: OpenPageDetail): void {
  window.dispatchEvent(new CustomEvent<OpenPageDetail>(OPEN_PAGE_EVENT, { detail: d }))
}

/** What the shell says about a page (page.rs `tell`). */
export interface PageNews {
  id: string
  url?: string
  loading?: boolean
  title?: string
  /** A new window the page asked for: the workspace opens it as another Page tab. */
  open?: string
  /** A link to another app's scheme that the page was not let follow. */
  refused?: string
  /** A download finished: the file's name in Downloads; `ok` false when it failed. */
  saved?: string | null
  ok?: boolean
}

/** How long a page waits behind other tabs before its webview is closed, and its memory with it. */
export const UNLOAD_AFTER_MS = 5 * 60_000

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

/** Whether `host` is this machine: localhost, *.localhost, 127.x, ::1. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase()
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/** Whether `url` is a page on this machine. */
export function isLocalUrl(url: string): boolean {
  try {
    return isLocalHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * What the address field or ⌘K turns typed text into: an http(s) URL, or
 * null. `localhost:5173`, `127.0.0.1:8080/x` and `:3000` are http; a host
 * with a dot (`example.com`) is https; a full http(s) address stays as typed.
 * Anything else — a word, a path, `file:`, `javascript:` — is not an address.
 */
export function pageUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s || /\s/.test(s)) return null
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)
  let candidate: string
  if (scheme) {
    if (!/^https?$/i.test(scheme[1]!)) return null
    candidate = s
  } else if (/^:\d{2,5}(\/|$)/.test(s)) {
    candidate = `http://localhost${s}`
  } else {
    const host = s.split(/[/?#]/)[0]!.replace(/:\d+$/, '')
    if (isLocalHost(host)) candidate = `http://${s}`
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && /[a-z]/i.test(host.split('.').pop()!)) candidate = `https://${s}`
    else return null
  }
  try {
    const u = new URL(candidate)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null
    return u.href
  } catch {
    return null
  }
}

/**
 * Whether text typed into ⌘K is surely an address, for its fallback row: a
 * scheme, this machine, or a host on a common top-level domain. Stricter
 * than pageUrl, so `README.md` or `main.go` stays a task for a new agent.
 */
export function looksLikeAddress(raw: string): boolean {
  const s = raw.trim()
  const url = pageUrl(s)
  if (!url) return false
  if (/^https?:\/\//i.test(s) || isLocalUrl(url)) return true
  return /\.(com|org|net|dev|io|app|ai|co|edu|gov|so|me|info|page|site|tech|cloud)$/i.test(new URL(url).hostname)
}

/**
 * Whether a page can show in a tab here. In the desktop app every http(s)
 * page can. In a browser only one on this machine, and never the dashboard's
 * own origin (`self`): it would be Caprock inside Caprock.
 */
export function canShowInTab(url: string, inApp: boolean, self = typeof location === 'undefined' ? '' : location.origin): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (inApp) return true
  return isLocalHost(u.hostname) && u.origin !== self
}

/** The tab's name: the page's title, else its host and port. */
export function pageTitle(url: string, title?: string): string {
  const t = title?.trim()
  if (t) return t
  try {
    const u = new URL(url)
    return u.host || url
  } catch {
    return url
  }
}

let counter = 0
/** A new Page tab's key (its target's `sessionId`): `page:` and an id the shell takes as a webview label. */
export function newPageKey(now = Date.now()): string {
  counter += 1
  return `page:${now.toString(36)}-${counter.toString(36)}`
}

/** The id the shell knows the page by (page.rs `label`): the key without `page:`, letters, digits and dashes. */
export function pageId(key: string): string {
  return key.replace(/^page:/, '').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64) || 'x'
}

/** A rectangle in the window's logical pixels: the element's CSS box times the dashboard's zoom. */
export interface PageRect {
  x: number
  y: number
  width: number
  height: number
}

export function rectOf(r: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, zoom: number): PageRect {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return { x: Math.round(r.left * z), y: Math.round(r.top * z), width: Math.round(r.width * z), height: Math.round(r.height * z) }
}

export function sameRect(a: PageRect | null, b: PageRect | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** What the dashboard asks of a page in the app (page.rs `Act`). */
export type PageAct =
  | { do: 'open'; url: string; rect: PageRect }
  | { do: 'place'; rect: PageRect }
  | { do: 'show' }
  | { do: 'hide' }
  | { do: 'close' }
  | { do: 'go'; url: string }
  | { do: 'back' }
  | { do: 'forward' }
  | { do: 'reload' }

/** Sends `act` for the page `key` to the shell; a no-op outside the app. */
export function pageAct(key: string, act: PageAct): Promise<void> {
  return shell.pageTab(pageId(key), act)
}

/**
 * The selector for what the native page would hide: a sheet, a dialog, a
 * menu. While one is on screen the page is hidden, since a native view
 * always draws above the dashboard's own elements.
 */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"]'

/** The part of the window a page covers, in CSS pixels. */
export type Area = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>

/**
 * Whether a dialog or a menu is on screen over `area` (anywhere, without
 * one), outside `own`. A menu in the sidebar, or a card in a corner the page
 * does not reach, leaves the page shown.
 */
export function overlayOpen(doc: Pick<Document, 'querySelectorAll'>, own?: Element | null, area?: Area): boolean {
  for (const el of Array.from(doc.querySelectorAll(OVERLAYS))) {
    if (own && own.contains(el)) continue
    if (el.closest('[hidden]')) continue
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) continue
    if (area) {
      const r = el.getBoundingClientRect()
      const apart = r.right <= area.left || r.left >= area.right || r.bottom <= area.top || r.top >= area.bottom
      // A fixed backdrop or a sheet has a box; one that reports none is taken as over the page.
      if (apart && r.width + r.height > 0) continue
    }
    return true
  }
  return false
}
