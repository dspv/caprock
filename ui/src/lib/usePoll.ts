/**
 * Polling a daemon route for the CI views (the Pipeline page, the
 * inspector's CI and release blocks, the agent figures): asked while on and
 * the window visible, sooner while something runs, the last answer kept
 * per key (lib/deckCache) and drawn at once on the next mount. It came out
 * of the session deck when the deck was removed (2026-10-20); the keys
 * (`prs:`, `ci:`, `release:`, `branches:`, `stats:`) are the same.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { errText, type DeckFresh } from './api'
import { readDeck, writeDeck } from './deckCache'

/** How often a PR's CI, the release build and the default branch are asked
 *  again: soon while a job runs, else rarely. The daemon keeps a commit's
 *  runs 10 s while one runs and 2 min once all settled, so a poll inside
 *  that costs GitHub nothing. */
export const CI_RUNNING_MS = 12_000
export const CI_IDLE_MS = 60_000
/** The pull requests: sooner while a check runs. The daemon keeps each pull
 *  request about as long, so a poll it can answer from what it holds costs
 *  GitHub nothing. */
export const PRS_PENDING_MS = 20_000

/** How soon a poll is repeated when the daemon handed back the answer it
 *  kept while it composes a newer one: a local read, nothing asked of GitHub. */
const REFRESHING_MS = 1_500

/** A poll's state beside its answer: a read under way, the last one failed
 *  (and why), whether the shown answer came from the daemon since the view
 *  was opened, and a way to ask again now. */
export interface PollMeta {
  loading: boolean
  failed: boolean
  /** Why the last read failed, or why the daemon could not compose a newer
   *  answer (`refresh_error`): the shown one is older. */
  reason?: string
  /** The shown answer was read from the daemon since the view was opened —
   *  not only the copy kept from before (lib/deckCache). */
  confirmed: boolean
  /** Asks again now. */
  retry: () => void
}

const noRetry = () => {}

interface PollSnap<T> {
  k?: string
  d?: T
  at: number
}

function fromCache<T>(k: string | undefined): PollSnap<T> {
  const c = readDeck<T>(k)
  return { k, d: c?.d, at: c?.at ?? 0 }
}

/**
 * Asks read() while `on` and the window visible: every
 * `fast` ms while busy() says something runs, else every CI_IDLE_MS. Hidden,
 * nothing is asked and no timer is armed; it asks again once the window is
 * shown (lib/visible: a hidden window does no work).
 * The last answer stays while it is off. With a cache key, the answer last
 * kept under it (lib/deckCache) is shown at once — after a remount, a
 * restart of the app, a switch of view — while the read revalidates it.
 * keep(prev, next) says a failed read's answer is worse than the one shown:
 * the shown one stays, marked failed.
 */
export function usePoll<T>(on: boolean, key: string, read: () => Promise<T>, busy: (d: T) => boolean, fast = CI_RUNNING_MS, cacheKey?: string, keep?: (prev: T, next: T) => boolean): [T | undefined, number, PollMeta] {
  const [snap, setSnap] = useState<PollSnap<T>>(() => fromCache<T>(cacheKey))
  const [meta, setMeta] = useState<Omit<PollMeta, 'retry'>>({ loading: false, failed: false, confirmed: false })
  const retryRef = useRef<() => void>(noRetry)
  const shown = !cacheKey || snap.k === cacheKey ? snap : fromCache<T>(cacheKey)
  const fn = useRef({ read, busy, keep, shown })
  useEffect(() => { fn.current = { read, busy, keep, shown } })
  useEffect(() => {
    if (!on) return
    let alive = true
    let timer = 0
    // "updating…" stands for the first read of what is shown and while the
    // daemon says a newer answer is being composed, not for every poll.
    let revalidating = true
    let busyTick = false
    const tick = async () => {
      if (busyTick) return
      busyTick = true
      let next = CI_IDLE_MS
      if (!document.hidden) {
        if (revalidating) setMeta((m) => (m.loading ? m : { ...m, loading: true }))
        try {
          const d = await fn.current.read()
          if (!alive) return
          const prev = fn.current.shown.d
          const worse = prev !== undefined && !!fn.current.keep?.(prev, d)
          if (!worse) {
            setSnap({ k: cacheKey, d, at: Date.now() })
            if (cacheKey) writeDeck(cacheKey, d)
          }
          const fresh = d as DeckFresh | undefined
          revalidating = !!fresh?.refreshing
          // An answer kept back while a newer one is composed is not a
          // failure: it is on its way. One the daemon could not replace is:
          // it says why (refresh_error), and the header says it.
          const reason = fresh?.refresh_error || (worse ? (d as { error?: { message?: string } } | undefined)?.error?.message : undefined) || undefined
          setMeta({ loading: revalidating, failed: (worse || !!reason) && !revalidating, reason, confirmed: !worse })
          if (fn.current.busy(d)) next = fast
          if (revalidating) next = Math.min(next, REFRESHING_MS)
        } catch (e) {
          // The last answer stays, said to be not refreshed, and why.
          if (alive) setMeta((m) => ({ loading: false, failed: true, reason: errText(e), confirmed: m.confirmed }))
        }
      }
      busyTick = false
      if (alive && !document.hidden) timer = window.setTimeout(() => void tick(), next)
    }
    retryRef.current = () => { if (alive && !busyTick) { window.clearTimeout(timer); revalidating = true; void tick() } }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; retryRef.current = noRetry; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [on, key, fast, cacheKey])
  const retry = useCallback(() => retryRef.current(), [])
  return [shown.d, shown.at, { ...meta, retry }]
}

