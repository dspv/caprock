/**
 * The views of the last few tabs, kept drawn but hidden, so switching back
 * to one shows it as it was left on the first frame (.ai/04-ui.md § The app
 * workspace, *Switching tabs*).
 *
 * A view switched away from is `display: none` at once, and for its first
 * `liveMs` (30 s, the terminal's own socket grace) it stays live but quiet:
 * its listeners follow the socket and the panels' live refetches rest
 * (ScreenShown false, lib/useApi), so going back and forth asks the daemon
 * nothing it did not miss. Past that it sits in React's `<Activity
 * mode="hidden">`: its effects are torn down — no poll, no timer, no live
 * listener runs for it — while its state stays. Shown again, its effects
 * mount once more and read what changed while what it held is already on
 * screen. Before this, the inspector and the chat were keyed by session and
 * a switch threw both away: 17 requests (22 with the chat) and "Reading…"
 * until the slowest landed, on every switch, back to a tab seen a second ago
 * included (measured 2026-11-24).
 *
 * Bounded: the `keep` views shown last (the one in front included), each
 * hidden for at most `hiddenMs`; a key `alive` no longer accepts (its tab
 * closed) goes at the next render.
 */
import { Activity, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { ScreenShown } from '@/lib/refresh'

/** How many views are kept, the one in front included. */
export const KEEP_VIEWS = 4
/** How long a hidden view is kept: the scrollback trim's ten minutes (HIDDEN_TRIM_MS). */
export const KEEP_HIDDEN_MS = 10 * 60_000
/** How long a hidden view stays live (listening, nothing polled) before its effects are torn down. */
export const KEEP_LIVE_MS = 30_000

interface Kept { node: ReactNode; at: number }

export function KeptViews({ current, children, keep = KEEP_VIEWS, hiddenMs = KEEP_HIDDEN_MS, liveMs = KEEP_LIVE_MS, alive }: {
  /** The key of the view in front; undefined keeps them all hidden. */
  current?: string
  /** The view in front, drawn under `current`. */
  children?: ReactNode
  keep?: number
  hiddenMs?: number
  liveMs?: number
  /** False for a key whose view should go now (its tab closed). */
  alive?: (key: string) => boolean
}) {
  // Insertion order is render order, so a switch moves no DOM node; `at` is
  // when each was last in front, which decides who goes first.
  const kept = useRef(new Map<string, Kept>())
  const outer = useContext(ScreenShown)
  const [, expire] = useReducer((n: number) => n + 1, 0)
  const now = Date.now()
  const map = kept.current
  if (current !== undefined) map.set(current, { node: children, at: now })
  for (const [k, v] of map) {
    if (k === current) continue
    if ((alive && !alive(k)) || now - v.at > hiddenMs) map.delete(k)
  }
  if (map.size > keep) {
    const old = [...map].filter(([k]) => k !== current).sort((a, b) => a[1].at - b[1].at)
    for (const [k] of old.slice(0, map.size - keep)) map.delete(k)
  }
  // A hidden view's times run out without a render to notice: one wakes it.
  const due = [...map].filter(([k]) => k !== current).flatMap(([, v]) => [v.at + liveMs, v.at + hiddenMs]).filter((t) => t > now)
  const next = due.length ? Math.min(...due) - now : 0
  useEffect(() => {
    if (!next) return
    const t = setTimeout(expire, next + 50)
    return () => clearTimeout(t)
  })
  return (
    <>
      {[...map].map(([k, v]) => {
        const front = k === current
        return (
          <Activity key={k} mode={front || now - v.at < liveMs ? 'visible' : 'hidden'}>
            <ScreenShown.Provider value={outer && front}>
              <div style={{ display: front ? 'contents' : 'none' }}>{v.node}</div>
            </ScreenShown.Provider>
          </Activity>
        )
      })}
    </>
  )
}
