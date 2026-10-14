/**
 * The dashboard keeps its place (.ai/04-ui.md § The dashboard keeps its place).
 *
 * Owner, 2026-10-14, translated: "When I switch between the dashboard and
 * tabs, I lose the position — where I was, what I was looking at on the
 * dashboard. Don't do that; I want to continue from the same place."
 *
 * Two halves:
 *
 * - **Kept screens.** The dashboard's own screens (KEPT_SCREENS: Home, Cost,
 *   Lifetime, Week, Memory, Tasks) stay mounted once opened and are hidden,
 *   not dropped, while another screen or a terminal tab is in front — so an
 *   opened row, a fold, a filter is still there on return. A hidden one asks
 *   nothing and its clocks stop (`ScreenShown`, lib/refresh.ts). The rest —
 *   a session's page, Settings — mount only while shown: Settings listens for
 *   Escape on the window, which must never reach it from behind a terminal.
 * - **Scroll, per screen.** `useScrollPlace` remembers where each screen was
 *   scrolled and puts it back before the screen paints, so there is no jump.
 *
 * And a way home: ⌘0 a second time, or a click on Home where it already is,
 * goes to Home at its top (`goHomeTop`).
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { href, type Route } from './router'

/** The dashboard screens kept mounted once opened, by route name. */
export const KEPT_SCREENS: readonly Route['name'][] = ['now', 'cost', 'history', 'week', 'notes', 'tasks']

/** The kept screen a route shows, or undefined for one that mounts only while shown. */
export function keptScreen(r: Route): Route['name'] | undefined {
  return KEPT_SCREENS.includes(r.name) ? r.name : undefined
}

/** Where a route's scroll position is kept: its screen when kept, else the whole route. */
export function placeKey(r: Route): string {
  return keptScreen(r) ?? href(r)
}

/** Asks the dashboard to put Home at its top (and forget where it was). */
export const HOME_TOP_EVENT = 'caprock:home-top'

/** Home is the screen in front of this hash. */
export function isHomeHash(hash: string): boolean {
  const h = hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  return h === '' || h === 'now' || h === 'home'
}

/**
 * Home, at its top: from another dashboard screen, from a terminal, or from
 * Home itself scrolled down. `go` moves the hash (AppShell passes its own, so
 * the next render already sees it).
 */
export function goHomeTop(go: (hash: string) => void = (h) => { location.hash = h }): void {
  // First, so the place Home comes back to is its top.
  window.dispatchEvent(new Event(HOME_TOP_EVENT))
  if (!isHomeHash(location.hash)) go('#/')
}

/** The page's own scroller in a browser tab; the app passes its dashboard's. */
export function pageScroller(): HTMLElement | null {
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/**
 * Keeps each screen's scroll position in `scroller`: recorded as it scrolls,
 * put back in the layout phase when `key` changes or the dashboard is shown
 * again, so the first frame is already in place. A screen never seen before
 * opens at its top.
 */
export function useScrollPlace(key: string, shown: boolean, scroller: () => HTMLElement | null) {
  const places = useRef(new Map<string, number>())
  const keyRef = useRef(key)
  const shownRef = useRef(shown)
  const getRef = useRef(scroller)
  getRef.current = scroller

  useLayoutEffect(() => {
    keyRef.current = key
    shownRef.current = shown
    if (!shown) return
    const el = getRef.current()
    if (el) el.scrollTop = places.current.get(key) ?? 0
  }, [key, shown])

  useEffect(() => {
    const el = getRef.current()
    if (!el) return
    const page = el === document.scrollingElement || el === document.documentElement
    const target: HTMLElement | Window = page ? window : el
    const onScroll = () => {
      // Hidden (display: none) reads 0 and would overwrite the real place.
      if (!shownRef.current || el.clientHeight === 0) return
      places.current.set(keyRef.current, el.scrollTop)
    }
    const onHome = () => {
      places.current.set('now', 0)
      if (shownRef.current && keyRef.current === 'now') el.scrollTop = 0
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener(HOME_TOP_EVENT, onHome)
    return () => {
      target.removeEventListener('scroll', onScroll)
      window.removeEventListener(HOME_TOP_EVENT, onHome)
    }
  }, [])
}
