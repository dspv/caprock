// Fetch-on-mount + refetch-on-live-tick hook. Keeps last-known data on error
// (staleness dot, not spinner), exposes the error for an inline notice.
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useLiveTick } from './live'
import { LivePace, shared } from './refresh'
import { readCache, writeCache } from './swr'
import { everyWhileVisible } from './visible'

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
  /** While the page is hidden the interval rests (lib/visible.ts); this keeps it at a slower pace instead. */
  hiddenIntervalMs?: number
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
  /**
   * An answer equal to the one shown re-renders nothing (and leaves
   * `loadedAt` alone). For a hook whose caller redraws a lot on each answer —
   * the app's tray summary, asked on every live tick, redrew the whole
   * workspace up to twice a second while agents worked.
   */
  keepUnchanged?: boolean
  /** The slowest a live tick may refetch this, in ms; the screen's pace
   *  (LivePace, lib/refresh.ts) wins when it is slower. */
  liveMs?: number
  /** Share one request with every hook asking the same question at about the
   *  same time (lib/refresh.ts `shared`). Defaults to `cache`, which already
   *  names the whole question; `false` never shares. */
  share?: string | false
  /**
   * False while nobody can see what this feeds — a folded or off-screen
   * section. Live ticks and intervals then ask nothing; the first of them
   * missed is asked once when it turns true again. A new question (a
   * dependency change, the first run) is always asked.
   */
  active?: boolean
}

export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: ApiOptions = {}): Loaded<T> {
  const { live = true, intervalMs = 0, hiddenIntervalMs, cache, active = true } = opts
  const pace = Math.max(useContext(LivePace), opts.liveMs ?? 0)
  const tick = useLiveTick(pace)
  const [state, setState] = useState<Loaded<T>>(() => {
    const c = cache ? readCache<T>(cache) : undefined
    return { data: c?.data, error: undefined, loading: true, refresh: () => {}, loadedAt: 0, stale: !!c, cachedAt: c?.at ?? 0 }
  })
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const trimRef = useRef(opts.cacheTrim)
  trimRef.current = opts.cacheTrim
  const keepRef = useRef(opts.keepUnchanged)
  keepRef.current = opts.keepUnchanged
  const shareRef = useRef<string | undefined>(undefined)
  shareRef.current = opts.share === false ? undefined : (opts.share ?? cache)
  const activeRef = useRef(active)
  activeRef.current = active
  const missed = useRef(false)
  const lastRun = useRef(0)
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
  const againManual = useRef(false)
  const run = useCallback((fresh = false, manual = false) => {
    if (!fresh && !manual && !activeRef.current) {
      missed.current = true
      return
    }
    if (!fresh && inFlight.current) {
      again.current = true
      againManual.current ||= manual
      return
    }
    const my = ++seq.current
    inFlight.current = true
    again.current = false
    againManual.current = false
    missed.current = false
    lastRun.current = Date.now()
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
      if (again.current) run(false, againManual.current)
    }
    // A button press asks the daemon itself: it follows a change the person
    // made, and an answer shared from before it would undo what they saw.
    const share = manual ? undefined : shareRef.current
    ;(share ? shared(share, fnRef.current) : fnRef.current()).then(
      (data) => {
        if (my === seq.current) {
          setState((s) => (keepRef.current && !s.loading && !s.error && !s.stale && s.loadedAt > 0 && JSON.stringify(s.data) === JSON.stringify(data)
            ? s
            : { ...s, data, error: undefined, loading: false, loadedAt: Date.now(), stale: false, cachedAt: 0 }))
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
  // Only a tick that moved since mount: the first run already asked, and a
  // page that has seen any event mounted every hook with a tick above zero,
  // which asked each question twice on opening a screen.
  const seenTick = useRef(tick)
  useEffect(() => {
    if (!live || tick === seenTick.current) return
    seenTick.current = tick
    run()
  }, [live, tick, run])
  // Seen again: ask once if a tick or an interval came while it was not.
  useEffect(() => { if (active && missed.current) run() }, [active, run])
  useEffect(() => {
    if (!intervalMs) return
    // The interval is the floor for a quiet feed: a live tick that asked
    // within it has already answered, so it does not ask again.
    return everyWhileVisible(() => {
      if (Date.now() - lastRun.current >= intervalMs * 0.8) run()
    }, intervalMs, hiddenIntervalMs)
  }, [intervalMs, hiddenIntervalMs, run])

  // `refresh` is the manual one — a person pressing a button expects the
  // figures to stay put while it reloads, not to blink out.
  const refresh = useCallback(() => run(false, true), [run])
  return { ...state, refresh }
}
