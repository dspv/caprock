/**
 * What a cache hit-rate means, in one word.
 *
 * The dashboard showed the percentage and coloured it amber below 90% —
 * everything above that read identically, so 99% and 91% looked the same and
 * neither said anything. On the owner's own 122 sessions the rate runs from
 * 6% to 99.6% with a median of 93.6%, so there is a real spread to describe.
 *
 * The bands are chosen against that spread rather than picked for roundness.
 *
 * The top of the range was one step where the eye reads several: 98% and 99%
 * are not the same session, and both were "outstanding". `excellent` (98–99)
 * and `very good` (96–98) split the range a reader actually cares about, and
 * the old `good` band moves down to 90–96 to make room rather than overlapping
 * them.
 *
 * **A caveat worth knowing before touching these again.** Measured on the
 * owner's machine at the time this band was added, the distribution has moved
 * a long way since the file was written: the median hit rate is now 99.98%,
 * and 59% of sessions land in the top band — where the comment above says
 * `outstanding` was meant to be about one session in nine. So the new words
 * describe 3% of sessions each while the top word describes the majority. The
 * bands are honest about what they measure; whether the top one still earns a
 * word is a separate question, deliberately left open rather than decided
 * here (the alternatives were moving the top band to 99.9+, where the mass
 * really sits, or showing no word at all above 99% on the grounds that the
 * number speaks for itself).
 *
 * **It describes a state, never a performance.** The cache is Claude Code's
 * doing — Caprock only reads it — so nothing here congratulates anyone, and
 * `low` is a fact rather than a verdict: a short session has little to reuse
 * and a low rate is the honest result, not a fault.
 */

export type CacheLevel = 'outstanding' | 'excellent' | 'very good' | 'good' | 'ok' | 'low'

export interface CacheReading {
  /** The word shown beside the figure. */
  label: CacheLevel
  /** A Tailwind text colour class, or '' to leave the figure its default. */
  color: string
}

/**
 * Read a hit rate as a percentage (0–100).
 *
 * Returns undefined when there is nothing to describe — no cache activity at
 * all — because "0%, low" on a fresh install is a warning about something
 * that has not happened yet.
 */
export function cacheLevel(pct: number | undefined): CacheReading | undefined {
  if (pct === undefined || !Number.isFinite(pct) || pct <= 0) return undefined
  if (pct >= 99) return { label: 'outstanding', color: 'text-ok' }
  if (pct >= 98) return { label: 'excellent', color: 'text-ok' }
  if (pct >= 96) return { label: 'very good', color: 'text-ok' }
  if (pct >= 90) return { label: 'good', color: 'text-ok' }
  if (pct >= 85) return { label: 'ok', color: '' }
  return { label: 'low', color: 'text-warn' }
}

