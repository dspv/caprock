/**
 * How the cockpit's headline compares with the viewer's own usual: above or
 * below, by how much, and where it falls among their own history.
 *
 * The baseline is the daemon's (`usual` on /v1/stats/summary, store.UsualSince):
 * eleven deciles (min, p10 … p90, max) of a distribution measured on this
 * machine over the last 30 days, never a figure from anywhere else.
 *
 * - **Burn rate**: dollars per active session-hour — every clock hour in
 *   which one session made at least five priced calls costing more than
 *   nothing, its spend in that hour. One session's hour, not the machine's: four sessions at once are
 *   not one session burning four times as fast.
 * - **Cost** and **Tokens**: every session's total over the 30 days. A
 *   running session is set against finished ones, so it reads *already more
 *   than*, never a forecast.
 * - **Cache hit rate**: the 30-day hit rate, in percentage points.
 *
 * Turns, time working, tool calls and the last call have no usual: a turn
 * count says nothing on its own and a single call's price is noise.
 */
import type { Metric, SpendFigures } from './spendview'

/** One distribution: how many samples, and its deciles (11 values, ascending). */
export interface Deciles {
  n: number
  q: number[]
}

/** The daemon's baseline; any part it could not measure is absent. */
export interface Usual {
  days: number
  /** $ per active session-hour. */
  burn?: Deciles
  /** Session totals, dollars. */
  cost?: Deciles
  /** Session totals, input tokens with cache reads and writes. */
  tokens?: Deciles
  /** The 30-day cache hit rate, 0..100. */
  cache?: number
}

/** Below this many samples there is no usual yet: a new user sees nothing, not a guess. */
export const MIN_SAMPLES: Partial<Record<Metric, number>> = { burn: 20, cost: 8, tokens: 8 }

export interface Versus {
  metric: Metric
  now: number
  /** The median, or for cache the 30-day rate. */
  usual: number
  /** now / usual − 1, e.g. 0.38 for 38% above. For cache, the difference in points. */
  delta: number
  /** 0..100: share of the viewer's own samples below now. Undefined for cache. */
  pct?: number
  /** Within ±15% (±2 points for cache): reads as "about usual". */
  near: boolean
  /** Whether higher is the good direction (cache) or the costly one (the rest). */
  higherIsGood: boolean
  dist?: Deciles
}

const NEAR = 0.15

/** Where `v` falls in the deciles, 0..100, interpolated inside a decile. */
export function percentileOf(v: number, q: readonly number[]): number {
  if (q.length < 2) return 50
  if (v <= q[0]!) return 0
  if (v >= q[q.length - 1]!) return 100
  const step = 100 / (q.length - 1)
  for (let i = 1; i < q.length; i++) {
    const lo = q[i - 1]!, hi = q[i]!
    if (v <= hi) return (i - 1) * step + (hi > lo ? ((v - lo) / (hi - lo)) * step : step / 2)
  }
  return 100
}

/** The headline set against the usual, or undefined where no honest comparison exists. */
export function versus(m: Metric, f: SpendFigures, u: Usual | undefined): Versus | undefined {
  if (!u) return undefined
  if (m === 'cache') {
    if (f.cache === undefined || u.cache === undefined) return undefined
    const delta = f.cache - u.cache
    return { metric: m, now: f.cache, usual: u.cache, delta, near: Math.abs(delta) < 2, higherIsGood: true }
  }
  const now = m === 'burn' ? f.burn?.perHour : m === 'cost' ? f.cost : m === 'tokens' ? f.tokens : undefined
  const dist = m === 'burn' ? u.burn : m === 'cost' ? u.cost : m === 'tokens' ? u.tokens : undefined
  if (now === undefined || !dist || dist.q.length !== 11 || dist.n < (MIN_SAMPLES[m] ?? Infinity)) return undefined
  const med = dist.q[5]!
  if (!(med > 0)) return undefined
  const delta = now / med - 1
  return { metric: m, now, usual: med, delta, pct: percentileOf(now, dist.q), near: Math.abs(delta) < NEAR, higherIsGood: false, dist }
}

/** "38%", "2.4×", "6 pts": the size of the difference, compact. */
export function deltaText(v: Versus): string {
  if (v.metric === 'cache') return `${Math.abs(v.delta) < 1 ? Math.abs(v.delta).toFixed(1) : Math.round(Math.abs(v.delta))} pts`
  const r = v.now / v.usual
  if (r >= 2) return `${r >= 10 ? Math.round(r) : r.toFixed(1)}×`
  return `${Math.round(Math.abs(v.delta) * 100)}%`
}

/** Which way, as an arrow: ▲ above, ▼ below, ≈ about usual. */
export function arrow(v: Versus): string {
  return v.near ? '≈' : v.delta > 0 ? '▲' : '▼'
}

/**
 * The tone: a colour speaks only when there is something to act on
 * (.ai/04-ui.md: a tone means "act", not "a value exists"). Amber when a
 * costly figure is in the top fifth of the viewer's own history, or the
 * cache hit rate is three points or more under their usual; everything
 * else, below usual included, stays muted. Measured spread is wide (the
 * owner's active session-hours run from cents to $68, median $3), so the
 * percentile decides, not a percentage of the median.
 */
export function tone(v: Versus): 'warn' | 'none' {
  if (v.metric === 'cache') return v.delta <= -3 ? 'warn' : 'none'
  return !v.near && v.delta > 0 && (v.pct ?? 0) >= 80 ? 'warn' : 'none'
}

/** What hovering says, in full: how far, from what, on what basis, and where among the viewer's own. */
export function versusTitle(v: Versus, fmt: (n: number) => string, days: number): string {
  if (v.metric === 'cache') {
    const what = `your ${days}-day hit rate of ${v.usual.toFixed(1)}%`
    return v.near ? `About ${what}` : `${deltaText(v)} ${v.delta > 0 ? 'above' : 'below'} ${what}`
  }
  const what = v.metric === 'burn' ? `your usual ${fmt(v.usual)}/h (the median active session-hour, ${days} days)`
    : `your median session, ${fmt(v.usual)} (${days} days)`
  const among = v.pct === undefined ? ''
    : v.metric === 'burn' ? ` · higher than ${Math.round(v.pct)}% of your session-hours`
      : ` · already more than ${Math.round(v.pct)}% of your sessions`
  if (v.near) return `About ${what}${among}`
  const how = v.now / v.usual >= 2 ? `${deltaText(v)} ${what}` : `${deltaText(v)} ${v.delta > 0 ? 'above' : 'below'} ${what}`
  return `${how}${among}`
}
