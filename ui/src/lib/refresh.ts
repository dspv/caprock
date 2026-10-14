/**
 * One refresh for a screen of sections (.ai/04-ui.md § A hidden window does
 * no work → *The Now screen refreshes once*).
 *
 * Every section of the Now screen read its own figures on every live tick:
 * under a steady stream of hook events the screen asked the daemon about 770
 * times a minute — `/v1/history?range=all` 260 times, four panels asking the
 * same question — for figures that move by cents (bench, 2026-10-13). Three
 * things make it one refresh:
 *
 * - **One pace.** A screen sets the live pace its sections refresh at
 *   (`LivePace`); `useApi` takes the slower of that and its own `liveMs`. The
 *   tick is shared per pace (useLiveTick), so every section of the screen
 *   asks on the same tick.
 * - **One question, one request.** Identical questions asked on the same tick
 *   share one request (`shared`), keyed by the same name `useApi`'s `cache`
 *   uses — the whole question, endpoint and every parameter.
 * - **Nobody looking, nothing asked.** A section that is folded or scrolled
 *   out of view (`useOnScreen`) skips its refreshes and asks once when it is
 *   seen again; a hidden page asks nothing at all (lib/visible.ts).
 */
import { createContext, useCallback, useEffect, useRef, useState } from 'react'

/** The live pace for screens that set none: what useApi always used. */
export const DEFAULT_LIVE_MS = 400
/** The Now screen's sections refresh together, at most once per this. */
export const NOW_LIVE_MS = 2000
/** All-time figures (history, glance, daily): they move by cents a minute. */
export const SLOW_LIVE_MS = 10_000

/** The live pace for every useApi under it; a hook's own `liveMs` may only slow it. */
export const LivePace = createContext<number>(DEFAULT_LIVE_MS)

/**
 * False under a screen that is kept but not shown: a dashboard screen behind
 * another one, or the whole dashboard behind a terminal tab (lib/screenPlace.ts).
 * useApi asks nothing and its tick rests; clocks (useNow) stop. Shown again,
 * each asks once, as a folded section does.
 */
export const ScreenShown = createContext<boolean>(true)

/** How long a settled answer is handed to a hook that asks the same question late. */
export const SHARE_MS = 500

const flights = new Map<string, { promise: Promise<unknown>; settledAt: number }>()

/**
 * Asks `fn` once for everyone asking `key` at about the same time: a request
 * still in flight is joined, and one that settled under SHARE_MS ago is
 * handed over. A failed answer is never handed over late.
 */
export function shared<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const f = flights.get(key)
  if (f && (f.settledAt === 0 || Date.now() - f.settledAt < SHARE_MS)) return f.promise as Promise<T>
  const entry = { promise: undefined as unknown as Promise<unknown>, settledAt: 0 }
  const promise = fn().then(
    (v) => {
      entry.settledAt = Date.now()
      return v
    },
    (e: unknown) => {
      if (flights.get(key) === entry) flights.delete(key)
      throw e
    },
  )
  entry.promise = promise
  flights.set(key, entry)
  return promise
}

/** Forgets every shared answer (tests; a reset of the live link). */
export function clearShared(): void {
  flights.clear()
}

/**
 * Whether an element is in or near the viewport: a section scrolled out of
 * sight does not refresh. Starts true, so a section's first answer is never
 * held back, and stays true where IntersectionObserver does not exist.
 * Returns a ref callback for the element and the flag.
 */
export function useOnScreen(margin = '200px'): [(el: Element | null) => void, boolean] {
  const [onScreen, setOnScreen] = useState(true)
  const io = useRef<IntersectionObserver | null>(null)
  const ref = useCallback(
    (el: Element | null) => {
      io.current?.disconnect()
      io.current = null
      if (!el || typeof IntersectionObserver !== 'function') return
      io.current = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1]
        if (e) setOnScreen(e.isIntersecting)
      }, { rootMargin: margin })
      io.current.observe(el)
    },
    [margin],
  )
  useEffect(() => () => io.current?.disconnect(), [])
  return [ref, onScreen]
}
