/**
 * The in-app browser (beta, ADR-075): a web page in a browser tab, beside
 * the agents' tabs and never among them.
 *
 * Off until the user turns it on (Settings → In-app browser); with it off
 * nothing here ever creates a webview. It lives in the desktop app only: the
 * page is a window of its own (app/src-tauri/src/browser.rs) that the shell
 * lays over the tab's content box, never a child webview of the dashboard's
 * window, whose crash and lost drops withdrew the Page tab (ADR-070). Its
 * data store is its own and kept nowhere; it gets no command of Caprock's.
 *
 * ⌘-click on a link keeps opening the default browser. The link chooser
 * (components/LinkChooser.tsx) offers *Caprock browser* wherever a browser
 * tab can exist (`browserAvailable()`), on or off, and `pickCaprock()` opens
 * it there — turning the setting on first when it was off, since picking it
 * is the user's consent (owner, 2026-10-17).
 *
 * Pure helpers and the setting; components/BrowserView.tsx draws the tab.
 */
import { useEffect, useState } from 'react'
import { isTauri } from './appmode'
import { shell } from './shell'
import type { PhoneSpec } from './phonemode'

// ---------------------------------------------------------------------------
// The setting

/** `on` once the user turned the in-app browser on; absent or anything else, off. */
export const BROWSER_ON_KEY = 'caprock.app.in-app-browser'
/** The search engine plain text in the address box goes to (SEARCH_ENGINES' ids). */
export const BROWSER_SEARCH_KEY = 'caprock.app.browser-search'
/** `off` when a video should keep playing while an agent waits on you. */
export const BROWSER_PAUSE_KEY = 'caprock.app.browser-pause'
/** Said on window when any of them changes, so Settings and the workspace agree at once. */
export const BROWSER_PREFS_EVENT = 'caprock:browser-prefs'

export interface SearchEngine {
  id: string
  name: string
  /** The address with `%s` where the words go. */
  url: string
}

/** DuckDuckGo first: the default, it keeps no profile of the searcher. */
export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
]

export function engineOf(id: string | null | undefined): SearchEngine {
  return SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0]!
}

export interface BrowserPrefs {
  /** The user turned it on. Whether it can show here is `browserAvailable()`. */
  on: boolean
  engine: string
  /** Pause a playing video when an agent starts waiting on you. */
  pause: boolean
}

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function loadBrowserPrefs(): BrowserPrefs {
  return { on: read(BROWSER_ON_KEY) === 'on', engine: engineOf(read(BROWSER_SEARCH_KEY)).id, pause: read(BROWSER_PAUSE_KEY) !== 'off' }
}

export function saveBrowserPrefs(next: Partial<BrowserPrefs>): void {
  try {
    if (next.on !== undefined) localStorage.setItem(BROWSER_ON_KEY, next.on ? 'on' : 'off')
    if (next.engine !== undefined) localStorage.setItem(BROWSER_SEARCH_KEY, engineOf(next.engine).id)
    if (next.pause !== undefined) localStorage.setItem(BROWSER_PAUSE_KEY, next.pause ? 'on' : 'off')
  } catch { /* private window: for this page only */ }
  window.dispatchEvent(new CustomEvent(BROWSER_PREFS_EVENT, { detail: next }))
}

export function useBrowserPrefs(): [BrowserPrefs, (next: Partial<BrowserPrefs>) => void] {
  const [prefs, setPrefs] = useState<BrowserPrefs>(loadBrowserPrefs)
  useEffect(() => {
    const on = () => setPrefs(loadBrowserPrefs())
    const onStorage = (e: StorageEvent) => { if (e.key === BROWSER_ON_KEY || e.key === BROWSER_SEARCH_KEY || e.key === BROWSER_PAUSE_KEY) on() }
    window.addEventListener(BROWSER_PREFS_EVENT, on)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(BROWSER_PREFS_EVENT, on)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return [prefs, saveBrowserPrefs]
}

/** Whether a browser tab can exist here at all: the desktop app only. */
export function browserAvailable(inApp = isTauri()): boolean {
  return inApp
}

/** Whether the in-app browser is on and can show: the desktop app, and the user's switch. */
export function browserOn(inApp = isTauri()): boolean {
  return browserAvailable(inApp) && loadBrowserPrefs().on
}

// ---------------------------------------------------------------------------
// Opening one

/** Something in the window asks for a browser tab: the menu, ⌘K, the link chooser, a page's new window. */
export const OPEN_BROWSER_EVENT = 'caprock:open-browser'

export interface OpenBrowserDetail {
  /** The address; absent for a new, empty tab with its address box focused. */
  url?: string
  /** The session whose terminal or chat the link was in. */
  sessionId?: string
  /** A line the workspace shows as a toast once the tab is asked for. */
  notice?: string
}

/** Asks the workspace for a browser tab (AppShell listens). */
export function requestBrowserTab(d: OpenBrowserDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenBrowserDetail>(OPEN_BROWSER_EVENT, { detail: d }))
}

/**
 * "Open in Caprock": `url` in a browser tab. False — and nothing done — when
 * the in-app browser is off or cannot show here, or `url` is not a web
 * address; the caller then does what it would have done without it.
 */
export function openInCaprock(url: string, sessionId?: string): boolean {
  if (!browserOn()) return false
  const u = pageUrl(url)
  if (!u) return false
  requestBrowserTab({ url: u, ...(sessionId ? { sessionId } : {}) })
  return true
}

/** The toast after *Caprock browser* turned the in-app browser on. */
export const TURNED_ON_NOTICE = 'In-app browser turned on · Settings → In-app browser to turn it off'

/**
 * The link chooser's *Caprock browser*: `url` in a browser tab. With the
 * in-app browser off it is turned on first — the pick is the consent — and
 * the tab's toast says so and where to turn it off. False, and nothing done,
 * outside the desktop app, for anything but a web address, or when the
 * setting cannot be kept (storage refused).
 */
export function pickCaprock(url: string, inApp = isTauri()): boolean {
  const u = pageUrl(url)
  if (!browserAvailable(inApp) || !u) return false
  const was = loadBrowserPrefs().on
  if (!was) {
    saveBrowserPrefs({ on: true })
    if (!loadBrowserPrefs().on) return false
  }
  requestBrowserTab({ url: u, ...(was ? {} : { notice: TURNED_ON_NOTICE }) })
  return true
}

// ---------------------------------------------------------------------------
// Addresses

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
 * What typed text is as an address: an http(s) URL, or null. `localhost:5173`,
 * `127.0.0.1:8080/x` and `:3000` are http; a host with a dot (`example.com`)
 * is https; a full http(s) address stays as typed. Anything else — a word, a
 * sentence, `file:`, `javascript:` — is not an address.
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

/** The search engine's address for `words`. */
export function searchUrl(words: string, engine: string): string {
  return engineOf(engine).url.replace('%s', encodeURIComponent(words.trim()))
}

/**
 * The address box: an address goes there, anything else is searched for
 * with the chosen engine (DuckDuckGo unless changed). Null for nothing typed.
 */
export function addressOrSearch(raw: string, engine: string): string | null {
  const s = raw.trim()
  if (!s) return null
  return pageUrl(s) ?? searchUrl(s, engine)
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

/** The tab's name: the page's title, else its host and port; "New tab" before it goes anywhere. */
export function pageTitle(url: string, title?: string): string {
  const t = title?.trim()
  if (t) return t
  if (!url) return 'New tab'
  try {
    const u = new URL(url)
    return u.host || url
  } catch {
    return url
  }
}

let counter = 0
/** A new browser tab's key (its target's `sessionId`): `page:` and an id the shell takes as a window label. */
export function newPageKey(now = Date.now()): string {
  counter += 1
  return `page:${now.toString(36)}-${counter.toString(36)}`
}

/** The id the shell knows the page by (browser.rs `label`): the key without `page:`, letters, digits and dashes. */
export function pageId(key: string): string {
  return key.replace(/^page:/, '').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64) || 'x'
}

// ---------------------------------------------------------------------------
// Keys

/** What a key does in a browser tab: the tab before or after, the address box, or phone mode on or off. */
export type BrowserKey = 'prev' | 'next' | 'address' | 'phone'

/** The subset of a KeyboardEvent read here. */
export interface BrowserKeyLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * A browser tab's own keys (owner, 2026-10-17: ⌥← ⌥→ between tabs). On
 * macOS ⌥← ⌥→ step to the tab before or after — outside a text field, where
 * they stay the field's word jump — and ⌘L puts the cursor in the address
 * box, as in every browser. Off macOS Alt+← → are the page's Back and
 * Forward in every browser there, so the tab keys are Ctrl+PageUp and
 * Ctrl+PageDown, what Chrome, Edge and Firefox use, and the address is
 * Ctrl+L. They act only while a browser tab is in front: in a terminal ⌥←
 * ⌥→ are word jumps and Ctrl+PageUp/PageDown PowerShell's, and stay so.
 *
 * Phone mode (lib/phonemode.ts) is ⌥⌘R on macOS, Safari's own key for its
 * Responsive Design Mode, so a front-end hand already knows it (Chrome's
 * ⇧⌘M is Mail here). Off macOS it is Ctrl+Alt+Shift+D, D for device:
 * Ctrl+Alt+Shift+R is GNOME's screencast, and Ctrl+Shift+M is Mail. Matched
 * by the key's code, since Option turns R into ®. A browser tab's key only,
 * never an app chord, so a terminal never loses it (appkeys PHONE_MODE_KEY).
 *
 * The page's own window reads the same keys through the script the shell
 * gives it (browser.rs KEYS_SCRIPT); keep the two in step.
 */
export function browserKey(e: BrowserKeyLike, isMac: boolean, inField = false): BrowserKey | null {
  if (isMac) {
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      return inField ? null : e.key === 'ArrowLeft' ? 'prev' : 'next'
    }
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'KeyL' || e.key === 'l')) return 'address'
    if (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyR') return 'phone'
    return null
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    if (e.key === 'PageUp') return 'prev'
    if (e.key === 'PageDown') return 'next'
    if (e.code === 'KeyL' || e.key === 'l') return 'address'
  }
  if (e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey && e.code === 'KeyD') return 'phone'
  return null
}

// ---------------------------------------------------------------------------
// The shell

/** The shell's word on a page (browser.rs `tell`). */
export const BROWSER_EVENT = 'caprock:browser'

/** What the shell says about a page. */
export interface BrowserNews {
  id: string
  url?: string
  loading?: boolean
  title?: string
  /** A new window the page asked for (a target=_blank link, window.open): another browser tab. */
  open?: string
  /** A link to another app's scheme that the page was not let follow. */
  refused?: string
  /** A download finished: the file's name in Downloads; `ok` false when it failed. */
  saved?: string | null
  ok?: boolean
  /** A browser key pressed in the page (browserKey). */
  key?: BrowserKey
  /** `measure`'s answer: the document's width and the width it is laid out in, CSS px. */
  doc?: number
  view?: number
}

/** Whether a page's document is wider than its window: it runs past the phone's edge. */
export function cutOff(n: Pick<BrowserNews, 'doc' | 'view'>): boolean {
  return typeof n.doc === 'number' && typeof n.view === 'number' && n.view > 0 && n.doc > n.view + 1
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

/** What the dashboard asks of a page (browser.rs `Act`). */
export type BrowserAct =
  /** `phone`: the device's user agent and touch (lib/phonemode); absent, a desktop page. */
  | { do: 'open'; url: string; rect: PageRect; focus: boolean; phone?: PhoneSpec }
  | { do: 'place'; rect: PageRect }
  | { do: 'show' }
  | { do: 'hide' }
  | { do: 'close' }
  | { do: 'go'; url: string }
  | { do: 'back' }
  | { do: 'forward' }
  | { do: 'reload' }
  | { do: 'focus' }
  /** Pause what plays in it: an agent is waiting on you. */
  | { do: 'pause' }
  /** Side by side: is its document wider than its window? The answer comes back as news (`doc`, `view`). */
  | { do: 'measure' }
  /** Close every page but these: the tabs the workspace still has after a reload. */
  | { do: 'retain'; ids: string[] }

/** Sends `act` for the page `key` to the shell; a no-op outside the app. */
export function browserAct(key: string, act: BrowserAct): Promise<void> {
  return shell.browserTab(pageId(key), act)
}

/**
 * The selector for what the page's window would hide: a sheet, a dialog, a
 * menu. While one is on screen the page is hidden, since a native window
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
