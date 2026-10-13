/**
 * A clock that re-renders on an interval.
 *
 * Anything showing a relative time ("8h ago", "live · now") needs one: those
 * labels are a function of the current time, not of the data, so a component
 * that renders only when its data changes will sit there displaying a stale
 * age indefinitely. On an idle machine that is not an edge case — it is the
 * normal state, and the moment the label matters most.
 */
import { useEffect, useRef, useState } from 'react'
import { everyWhileVisible } from './visible'

/**
 * The current time, refreshed every `ms` while the page is shown (none while
 * hidden; at once on showing). A caller may change `ms` with what it shows —
 * seconds while something runs, minutes otherwise — and the clock is read
 * afresh when it does, so a label never starts from a stale time.
 */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  const pace = useRef(ms)
  useEffect(() => {
    if (pace.current !== ms) setNow(Date.now())
    pace.current = ms
    return everyWhileVisible(() => setNow(Date.now()), ms)
  }, [ms])
  return now
}

/** Seconds show for a minute ("42s ago", lib/format fmtAgo): a clock that fast only while something is that fresh. */
export const FRESH_MS = 65_000
/** Otherwise labels read in minutes and hours, and this pace keeps them within a few seconds of right. */
export const SLOW_NOW_MS = 15_000

/**
 * useNow for a screen of relative times: every second while `latest` (the
 * newest thing it shows, unix ms) is under a minute old, else every
 * SLOW_NOW_MS. An idle session's screen redrew everything on it each second
 * to keep "4m ago" saying "4m ago".
 */
export function useNowFor(latest: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  const fresh = !!latest && now - latest < FRESH_MS
  useEffect(() => everyWhileVisible(() => setNow(Date.now()), fresh ? 1000 : SLOW_NOW_MS), [fresh])
  // A new event makes the screen fresh: read the clock now, not at the next slow tick.
  useEffect(() => { if (latest) setNow(Date.now()) }, [latest])
  return now
}
