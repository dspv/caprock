/**
 * What a cache hit-rate means, in one word.
 *
 * The dashboard showed the percentage and coloured it amber below 90% —
 * everything above that read identically, so 99% and 91% looked the same and
 * neither said anything. On the owner's own 122 sessions the rate runs from
 * 6% to 99.6% with a median of 93.6%, so there is a real spread to describe.
 *
 * The bands are chosen against that spread rather than picked for roundness:
 * `outstanding` lands on about one session in nine, which is what makes it
 * worth reading. A word that appears on everything is decoration.
 *
 * **It describes a state, never a performance.** The cache is Claude Code's
 * doing — Caprock only reads it — so nothing here congratulates anyone, and
 * `low` is a fact rather than a verdict: a short session has little to reuse
 * and a low rate is the honest result, not a fault.
 */

export type CacheLevel = 'outstanding' | 'good' | 'ok' | 'low'

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
  if (pct >= 95) return { label: 'good', color: 'text-ok' }
  if (pct >= 85) return { label: 'ok', color: '' }
  return { label: 'low', color: 'text-warn' }
}

