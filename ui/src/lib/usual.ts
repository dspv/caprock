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
import { barValue, chartValueText, periodBurn, type ChartMetric, type Metric, type SpendBar, type SpendFigures } from './spendview'

/** One distribution: how many samples, and its deciles (11 values, ascending). */
export interface Deciles {
  n: number
  q: number[]
  /** The samples' mean; absent from a daemon before the chart's pace line. */
  mean?: number
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

/**
 * The chart's pace line (.ai/04-ui.md § Inspector): a faint dashed level
 * across the bars for what a stretch usually measures, so a bar reads as
 * above or below it rather than as a height alone (owner, 2026-10-13: "it's
 * a chart, but it's unclear — pace").
 *
 * - **Burn rate**: the viewer's usual, every active session-hour's cost
 *   over every active hour of the last 30 days (`usual.burn.mean`). A bar
 *   is the mean of its own active hours, so it is set against the mean,
 *   not the median the headline uses for a single hour: the distribution
 *   is skewed, and on the owner's 30 days (2026-10-13) the median was
 *   $3.82/h and the mean $8.25/h — against the median every day read two
 *   to four times usual. Without enough hours, or from an older daemon
 *   with no mean, the period's own rate.
 * - **Cost, tokens, turns**: the period's own average stretch, over the
 *   stretches with any activity — an idle night is not a slow hour. There
 *   is no 30-day usual per stretch to draw: the daemon's are per session
 *   and per session-hour, and a stretch is neither.
 *
 * Fewer than two stretches with a value: no line. One bar set against its
 * own average says nothing.
 */
export interface Pace {
  /** In the metric's own unit. */
  value: number
  /** 'usual': the viewer's 30-day median; 'avg': the period's own average. */
  kind: 'usual' | 'avg'
  /** The distribution behind a usual, for the clearly-high tone. */
  dist?: Deciles
}

export function paceOf(m: ChartMetric, bars: readonly SpendBar[], u: Usual | undefined): Pace | undefined {
  const values = bars.map((b) => barValue(m, b)).filter((v): v is number => v !== undefined && v > 0)
  if (values.length < 2) return undefined
  if (m === 'burn') {
    const d = u?.burn
    if (d && d.q.length === 11 && d.n >= (MIN_SAMPLES.burn ?? Infinity) && d.mean !== undefined && d.mean > 0) return { value: d.mean, kind: 'usual', dist: d }
    const own = periodBurn(bars)
    return own !== undefined && own > 0 ? { value: own, kind: 'avg' } : undefined
  }
  return { value: values.reduce((a, v) => a + v, 0) / values.length, kind: 'avg' }
}

/** The line's label at its right end: "usual $3.00/h", "avg 1.2M". */
export function paceLabel(m: ChartMetric, p: Pace): string {
  return `${p.kind === 'usual' ? 'usual' : 'avg'} ${chartValueText(m, p.value)}`
}

/** What the line is, on hover. */
export function paceTitle(m: ChartMetric, p: Pace, days = 30): string {
  const v = chartValueText(m, p.value)
  if (p.kind === 'usual') return `Your usual, ${v}: every active session-hour’s cost over every active hour, ${days} days`
  return m === 'burn'
    ? `This period’s own rate, ${v}: too few active hours yet for a usual`
    : `The average stretch with any activity, ${v}`
}

/**
 * Where one bar stands against the line: 'high' only when a usual says it
 * is in the top fifth of the viewer's own hours (the headline's amber rule,
 * `tone`), else 'above' or 'below'. An average has no distribution, so it
 * is never 'high': above the average is not something to act on.
 */
export function barPace(v: number | undefined, p: Pace | undefined): 'high' | 'above' | 'below' | undefined {
  if (v === undefined || !p || !(v > 0)) return undefined
  if (v <= p.value) return 'below'
  const near = Math.abs(v / p.value - 1) < NEAR
  if (p.dist && !near && percentileOf(v, p.dist.q) >= 80) return 'high'
  return 'above'
}

/**
 * The bar against the line, in words: "38% above your usual", "2.4× your
 * usual", "about the average", "55% below the average". `short` is the
 * form the chart's top line has room for in a 330px cockpit beside the
 * date: "38% above usual", "55% below avg". Undefined without a value or
 * a line.
 */
export function paceSentence(v: number | undefined, p: Pace | undefined, short = false): string | undefined {
  if (v === undefined || !p || !(p.value > 0)) return undefined
  const what = p.kind === 'usual' ? (short ? 'usual' : 'your usual') : (short ? 'avg' : 'the average')
  const r = v / p.value
  if (Math.abs(r - 1) < NEAR) return `about ${what}`
  if (r >= 2) return `${r >= 10 ? Math.round(r) : r.toFixed(1)}× ${what}`
  return `${Math.round(Math.abs(r - 1) * 100)}% ${r > 1 ? 'above' : 'below'} ${what}`
}
