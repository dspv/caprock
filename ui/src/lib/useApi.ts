// Fetch-on-mount + refetch-on-live-tick hook. Keeps last-known data on error
// (staleness dot, not spinner), exposes the error for an inline notice.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveTick } from './live'
import { readCache, writeCache } from './swr'

export interface Loaded<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  refresh: () => void
  loadedAt: number
  /** `data` is the last answer kept in this browser (opts.cache), not yet
   *  confirmed by a fetch. A screen says so, and never presents it as live. */
  stale: boolean
  /** When the stale answer was fetched, unix ms; 0 when not stale. */
  cachedAt: number
}

export interface ApiOptions {
  live?: boolean
  intervalMs?: number
  /**
   * Keep the last successful answer under this key (lib/swr.ts) and show it,
   * marked stale, while a new question is first being answered. The key must
   * name the whole question — endpoint and every parameter — because the
   * cached answer is shown under it.
   */
  cache?: string
  /** What of an answer to keep: a big payload's live parts (a session's
   *  events) are dropped, so the kept copy stays small and says nothing
   *  about now. */
  cacheTrim?: (data: unknown) => unknown
}

export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: ApiOptions = {}): Loaded<T> {
  const { live = true, intervalMs = 0, cache } = opts
  const tick = useLiveTick(400)
  const [state, setState] = useState<Loaded<T>>(() => {
    const c = cache ? readCache<T>(cache) : undefined
    return { data: c?.data, error: undefined, loading: true, refresh: () => {}, loadedAt: 0, stale: !!c, cachedAt: c?.at ?? 0 }
  })
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const trimRef = useRef(opts.cacheTrim)
  trimRef.current = opts.cacheTrim
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  // A refetch keeps what is on screen; a *different question* does not.
  //
  // Both used to go through one path that spread the old state forward, so
  // pressing 7d while 30d was showing swapped the heading at once and left
  // every figure under it answering the previous range until the response
  // landed — around half a second on a large database, and longer on History.
  // On Now it was worse: the session list filters client-side and switched
  // instantly, so two panels visibly disagreed about which agent was on.
  //
  // The distinction is which of the two callers ran. A live tick or an
  // interval is the same question asked again, and blanking there would make
  // the screen flicker every few seconds. A dependency change is a new
  // question, and the honest answer to it is "reading…", not last question's
  // number under this question's title.
  //
  // A refetch never overlaps the one before it. Every live event asks again
  // (at most every 400ms), and an aggregate that takes a few seconds on a
  // large database used to be asked again before it answered — each request
  // slowing the next, until a busy session had dozens of the same query in
  // flight, the daemon at 167% CPU and today's totals 30-60s behind. A
  // refetch asked for while one is running is remembered and sent once, when
  // it lands. A new question is not held back: it cannot wait on the answer
  // to the old one.
  const inFlight = useRef(false)
  const again = useRef(false)
  const run = useCallback((fresh = false) => {
    if (!fresh && inFlight.current) {
      again.current = true
      return
    }
    const my = ++seq.current
    inFlight.current = true
    again.current = false
    if (fresh) {
      // A new question shows the last answer to THAT question when this
      // browser kept one, marked stale — never the previous question's.
      const c = cacheRef.current ? readCache<T>(cacheRef.current) : undefined
      setState((s) => ({ ...s, data: c?.data, error: undefined, loading: true, stale: !!c, cachedAt: c?.at ?? 0 }))
    }
    const key = cacheRef.current
    const settle = () => {
      if (my !== seq.current) return // a newer question owns the flag now
      inFlight.current = false
      if (again.current) run()
    }
    fnRef.current().then(
      (data) => {
        if (my === seq.current) {
          setState((s) => ({ ...s, data, error: undefined, loading: false, loadedAt: Date.now(), stale: false, cachedAt: 0 }))
          if (key) writeCache(key, trimRef.current ? trimRef.current(data) : data)
        }
        settle()
      },
      (error: Error) => { if (my === seq.current) setState((s) => ({ ...s, error, loading: false })); settle() },
    )
  }, [])

  // The first run is a dependency run too — it just has nothing to clear.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => run(true), [run, ...deps])
  useEffect(() => { if (live && tick > 0) run() }, [live, tick, run])
  useEffect(() => {
    if (!intervalMs) return
    // Wrapped, not passed: setInterval hands its callback nothing, but a bare
    // `run` here would take whatever a future caller passes as `fresh`.
    const id = window.setInterval(() => run(), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, run])

  // `refresh` is the manual one — a person pressing a button expects the
  // figures to stay put while it reloads, not to blink out.
  const refresh = useCallback(() => run(), [run])
  return { ...state, refresh }
}
