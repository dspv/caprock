// Fetch-on-mount + refetch-on-live-tick hook. Keeps last-known data on error
// (staleness dot, not spinner), exposes the error for an inline notice.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveTick } from './live'

export interface Loaded<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  refresh: () => void
  loadedAt: number
}

export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { live?: boolean; intervalMs?: number } = {}): Loaded<T> {
  const { live = true, intervalMs = 0 } = opts
  const tick = useLiveTick(400)
  const [state, setState] = useState<Loaded<T>>({ data: undefined, error: undefined, loading: true, refresh: () => {}, loadedAt: 0 })
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
  const run = useCallback((fresh = false) => {
    const my = ++seq.current
    if (fresh) setState((s) => ({ ...s, data: undefined, error: undefined, loading: true }))
    fnRef.current().then(
      (data) => { if (my === seq.current) setState((s) => ({ ...s, data, error: undefined, loading: false, loadedAt: Date.now() })) },
      (error: Error) => { if (my === seq.current) setState((s) => ({ ...s, error, loading: false })) },
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
