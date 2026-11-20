/**
 * Polling a daemon route for the CI views (the Pipeline page, the
 * inspector's CI and release blocks, the agent figures): asked while on and
 * the window visible, sooner while something runs, the last answer kept
 * per key (lib/deckCache) and drawn at once on the next mount. It came out
 * of the session deck when the deck was removed (2026-10-20); the keys
 * (`prs:`, `ci:`, `release:`, `branches:`, `stats:`) are the same.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { errText, type DeckFresh } from './api'
import { KEPT_FAINT_MS, keptAt, markReading, readDeck, writeDeck } from './deckCache'

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

/** The least time between two reads asked by the window coming to the
 *  front (focus): a quick switch back and forth asks once. The daemon
 *  answers from what it keeps per pull request, so even this costs GitHub
 *  nothing between its own reads. */
export const FOCUS_MIN_MS = 5_000

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
 * Asks read() while `on` and the window visible: at once on mount (a
 * window opened, a tab switched to, the app started), every `fast` ms
 * while busy() says something runs, else every CI_IDLE_MS, and at once when
 * the window is shown again or brought to the front (focus, at most every
 * FOCUS_MIN_MS). Hidden, nothing is asked and no timer is armed (lib/visible:
 * a hidden window does no work). While the kept copy shown is older than
 * KEPT_FAINT_MS and not yet replaced by a settled answer, its key is marked
 * as being read (lib/deckCache markReading), so it is drawn faint.
 * The last answer stays while it is off. With a cache key, the answer last
 * kept under it (lib/deckCache) is shown at once — after a remount, a
 * restart of the app, a switch of view — while the read revalidates it.
 * keep(prev, next) says a failed read's answer is worse than the one shown:
 * the shown one stays, marked failed.
 */
export function usePoll<T>(on: boolean, key: string, read: () => Promise<T>, busy: (d: T) => boolean, fast = CI_RUNNING_MS, cacheKey?: string, keep?: (prev: T, next: T) => boolean): [T | undefined, number, PollMeta] {
  const [snap, setSnap] = useState<PollSnap<T>>(() => fromCache<T>(cacheKey))
  // `of` is the answer `confirmed` speaks for (the cache key, else the poll's
  // key): a read of another pull request's checks confirms nothing of this one's.
  const [meta, setMeta] = useState<Omit<PollMeta, 'retry'> & { of?: string }>({ loading: false, failed: false, confirmed: false })
  const retryRef = useRef<() => void>(noRetry)
  const shown = !cacheKey || snap.k === cacheKey ? snap : fromCache<T>(cacheKey)
  const fn = useRef({ read, busy, keep, shown })
  useEffect(() => { fn.current = { read, busy, keep, shown } })
  // The kept copy shown is old and a read of it is under way: what draws
  // from it draws it faint, as of its age, until a settled answer lands
  // (lib/deckCache markReading). Marked before the first paint, so an old
  // red is never drawn at full strength first; unmarked once a settled
  // answer lands, or on the way out.
  const marked = useRef<string | undefined>(undefined)
  const unmark = useCallback(() => { const k = marked.current; if (k) { marked.current = undefined; markReading(k, false) } }, [])
  useLayoutEffect(() => {
    if (!on || !cacheKey) return
    const c = keptAt(readDeck(cacheKey))
    if (c !== undefined && Date.now() - c >= KEPT_FAINT_MS) { marked.current = cacheKey; markReading(cacheKey, true) }
    return unmark
  }, [on, cacheKey, unmark])
  useEffect(() => {
    if (!on) return
    let alive = true
    let timer = 0
    // "updating…" stands for the first read of what is shown and while the
    // daemon says a newer answer is being composed, not for every poll.
    let revalidating = true
    let busyTick = false
    let lastAsk = 0
    const tick = async () => {
      if (busyTick) return
      busyTick = true
      let next = CI_IDLE_MS
      if (!document.hidden) {
        lastAsk = Date.now()
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
          setMeta({ loading: revalidating, failed: (worse || !!reason) && !revalidating, reason, confirmed: !worse, of: cacheKey ?? key })
          if (!worse && !revalidating) unmark()
          if (fn.current.busy(d)) next = fast
          if (revalidating) next = Math.min(next, REFRESHING_MS)
        } catch (e) {
          // The last answer stays, said to be not refreshed, and why.
          if (alive) setMeta((m) => ({ loading: false, failed: true, reason: errText(e), confirmed: m.confirmed, of: m.of }))
        }
      }
      busyTick = false
      if (alive && !document.hidden) timer = window.setTimeout(() => void tick(), next)
    }
    retryRef.current = () => { if (alive && !busyTick) { window.clearTimeout(timer); revalidating = true; void tick() } }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    // The window brought to the front while it was shown (beside another
    // app, not covered): ask now rather than at the next interval (owner,
    // 2026-11-20: "CI statuses must load faster"). Hidden, nothing.
    const onFocus = () => { if (!document.hidden && Date.now() - lastAsk >= FOCUS_MIN_MS) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => { alive = false; retryRef.current = noRetry; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onFocus) }
  }, [on, key, fast, cacheKey, unmark])
  const retry = useCallback(() => retryRef.current(), [])
  const { of, ...said } = meta
  return [shown.d, shown.at, { ...said, confirmed: said.confirmed && of === (cacheKey ?? key), retry }]
}

