/**
 * A clock that re-renders on an interval.
 *
 * Anything showing a relative time ("8h ago", "live · now") needs one: those
 * labels are a function of the current time, not of the data, so a component
 * that renders only when its data changes will sit there displaying a stale
 * age indefinitely. On an idle machine that is not an edge case — it is the
 * normal state, and the moment the label matters most.
 */
import { useEffect, useState } from 'react'

export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}
