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
  const run = useCallback(() => {
    const my = ++seq.current
    fnRef.current().then(
      (data) => { if (my === seq.current) setState((s) => ({ ...s, data, error: undefined, loading: false, loadedAt: Date.now() })) },
      (error: Error) => { if (my === seq.current) setState((s) => ({ ...s, error, loading: false })) },
    )
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, [run, ...deps])
  useEffect(() => { if (live && tick > 0) run() }, [live, tick, run])
  useEffect(() => {
    if (!intervalMs) return
    const id = window.setInterval(run, intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, run])
  return { ...state, refresh: run }
}
