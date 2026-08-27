/**
 * A cache hit rate, with one word saying what it means.
 *
 * Three screens show this figure and all three showed it the same way: a
 * percentage, amber below 90%, indistinguishable above. So 99% and 91% read
 * identically and neither said anything — on a measurement that runs from 6%
 * to 99.6% across the owner's own sessions.
 *
 * One component rather than three call sites, because the bands are a product
 * decision (see `lib/cachelevel`) and three copies of a decision drift.
 *
 * No animation. The dashboard sits open all day; a flash that celebrates a
 * good number is charming once and an irritation by the afternoon, and this
 * product's rule is that motion means live data and nothing else.
 */
import { Stat } from '@/components/ui'
import { cacheLevel } from '@/lib/cachelevel'
import { fmtPct } from '@/lib/format'

export function CacheStat({
  hitRate,
  cutPct,
  measured,
  size = 'compact',
  label = 'Cache hit',
}: {
  /** 0–1, as the API reports it. */
  hitRate: number | undefined
  /** 0–100: how much of input cost the cache removed. */
  cutPct: number | undefined
  measured: boolean
  size?: 'hero' | 'default' | 'compact'
  label?: string
}) {
  const pct = measured && hitRate !== undefined ? hitRate * 100 : undefined
  const level = cacheLevel(pct)

  return (
    <Stat
      label={label}
      value={
        <span className="inline-flex items-baseline gap-2">
          <span>{pct === undefined ? '—' : fmtPct(pct)}</span>
          {/* The word sits beside the figure at a size that does not compete
            * with it: the number is the fact, the word is how to read it. */}
          {level && (
            <span className={`text-[11px] font-normal ${level.color || 'text-fg-faint'}`}>
              {level.label}
            </span>
          )}
        </span>
      }
      sub={measured && cutPct !== undefined ? `${fmtPct(cutPct)} input cost cut` : undefined}
      size={size}
    />
  )
}
