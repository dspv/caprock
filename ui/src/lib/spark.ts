/**
 * The project sparkline model: a repository's spend as one column per bucket.
 *
 * Like `pulse.ts`, this is deliberately pure and separate from the canvas that
 * draws it, because the interesting part is not the rendering — it is deciding
 * what a column means and how tall it gets.
 *
 * The daemon sends cost and tokens over the same buckets, so which of the two a
 * caller plots is a display choice rather than a request. That is the whole
 * reason both arrays travel together: re-basing the picture must never cost a
 * round-trip on a polled endpoint. The Projects panel plots tokens today
 * (SPARK_BASIS), and this module stays parametric so that stays a one-word
 * change rather than a rewrite.
 */
import type { Spark } from './api'

/** What the panel is measuring — the headline, the bar, and the sparkline. */
export type Measure = 'cost' | 'tokens'

/** One column of a project's sparkline. */
export interface SparkBar {
  /** The value this column represents, in the selected measure. */
  value: number
  /** Left edge of the bucket, unix ms — what a tooltip would name. */
  at: number
  /** Height as a fraction of the tallest column, 0..1, after gamma. */
  height: number
  /** True when nothing at all was spent here — drawn as a hairline. */
  empty: boolean
}

/**
 * Gamma applied to the height. A quiet day beside a heavy one would otherwise
 * be a sub-pixel smudge, and "a little happened here" is exactly what the
 * picture exists to show. Same exponent as the live pulse, so the two read as
 * one visual language.
 */
const GAMMA = 0.62

/** Pick the array the selected measure plots. */
export function seriesOf(s: Spark | undefined, m: Measure): number[] {
  if (!s) return []
  return m === 'tokens' ? (s.tokens ?? []) : (s.cost ?? [])
}

/**
 * buildSpark turns one project's series into drawable columns.
 *
 * `max` is passed in rather than taken from this project's own series: every
 * row in the panel is scaled to the SAME ceiling, so column heights are
 * comparable across rows. Scaling each row to itself would draw the quietest
 * repository with the same silhouette as the busiest, which contradicts the
 * numbers beside it — the exact failure the bar already avoids by being a share
 * of the largest project.
 *
 * A bucket of exactly zero is marked `empty` rather than given height 0, so the
 * canvas can draw silence as a hairline instead of leaving a gap. A gap in a
 * bar chart reads as a rendering fault; a flat floor reads as "nothing here",
 * which is the truth.
 */
export function buildSpark(s: Spark | undefined, m: Measure, max: number): SparkBar[] {
  const values = seriesOf(s, m)
  if (!s || values.length === 0) return []
  const ceiling = max > 0 ? max : 0
  return values.map((raw, i) => {
    // A negative or non-finite value cannot be drawn and must not silently
    // become a tall column; treat it as no data (rule 6).
    const value = Number.isFinite(raw) && raw > 0 ? raw : 0
    const height = ceiling > 0 && value > 0 ? Math.pow(Math.min(1, value / ceiling), GAMMA) : 0
    return { value, at: s.from_ms + i * s.width_ms, height, empty: value <= 0 }
  })
}

/**
 * peak is the tallest column across every project — the shared ceiling that
 * makes rows comparable. Computed over the rows the panel actually shows, so
 * hiding the long tail behind "show all" does not silently rescale the picture
 * of the rows that stay visible.
 */
export function peak(sparks: (Spark | undefined)[], m: Measure): number {
  let hi = 0
  for (const s of sparks) {
    for (const v of seriesOf(s, m)) {
      if (Number.isFinite(v) && v > hi) hi = v
    }
  }
  return hi
}

/**
 * label describes one column for a tooltip: the bucket's start, at the
 * resolution the bucket actually has. An hourly column named only by its date
 * would claim a precision the picture does not have, and a daily column named
 * with a clock time would claim one it does not need.
 */
export function bucketLabel(at: number, widthMs: number): string {
  const d = new Date(at)
  if (widthMs < 24 * 3600_000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
