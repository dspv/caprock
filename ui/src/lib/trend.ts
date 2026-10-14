/**
 * The Today cells' trends: what each figure was on the previous 14 days, and
 * whether today's is usual for this machine (owner, 2026-10-14, translated:
 * "I see the number but don't understand whether it's average or above
 * average").
 *
 * Every comparison is against the viewer's own history from
 * /v1/stats/trends, never a figure from anywhere else (rule 6):
 *
 * - **Cost, sessions, turns** are running totals, so each previous day is
 *   cut at the same time of day as now. A morning set against whole days
 *   would read low every morning. The usual is the median of the previous
 *   14 days that had any work at all — a weekend off is not a usual of zero.
 * - **Burn now** is a rate, so it is set against the median active
 *   10-minute window of the previous 14 days (any window that spent
 *   anything), and its line is each day's own median window.
 * - **Cache hit** gets the line only: it sits near 98% every day, and a
 *   word under it would be news about nothing.
 *
 * Fewer than MIN_DAYS days with work and there is no usual: the cell says
 * "not enough history" rather than comparing with three days.
 */
import type { TrendDay, Trends } from './api'

export type TrendMetric = 'cost' | 'sessions' | 'turns' | 'burn' | 'cache'

/** Days with work below which there is no usual to compare with. */
export const MIN_DAYS = 5
/** Within ±15% reads as "usual" — the same band as the cockpit's (lib/usual). */
export const NEAR = 0.15

/** A day's value for one metric; undefined where the day has none (no rate on an idle day). */
export function dayValue(m: TrendMetric, d: TrendDay): number | undefined {
  switch (m) {
    case 'cost': return d.cost_usd
    case 'sessions': return d.sessions
    case 'turns': return d.turns
    case 'burn': return d.burn_usd_per_hour
    case 'cache': return d.hit_rate === undefined ? undefined : d.hit_rate * 100
  }
}

/**
 * The line's points, oldest first, today last. `live` replaces today's point
 * with the figure printed above it, so the line and the number never
 * disagree: the trends answer is minutes old, the summary seconds.
 */
export function trendPoints(t: Trends | undefined, m: TrendMetric, live?: number): (number | undefined)[] {
  if (!t || t.series.length === 0) return []
  const pts = t.series.map((d) => dayValue(m, d))
  if (live !== undefined && m !== 'burn') pts[pts.length - 1] = live
  return pts
}

export function median(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return 0
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

export type Compare =
  /** Fewer than MIN_DAYS days with work: nothing to compare with. */
  | { kind: 'thin'; days: number }
  /** Burn only: nothing is running now, so there is no rate to compare. */
  | { kind: 'idle'; usual: number; days: number }
  | { kind: 'usual' | 'above' | 'below'; now: number; usual: number; days: number; ratio?: number }

/** The usual for a metric — the median of the previous days — and how many days it rests on. */
export function usualOf(t: Trends, m: TrendMetric): { usual: number; days: number } | undefined {
  if (m === 'cache') return undefined
  if (m === 'burn') return t.burn ? { usual: t.burn.median_usd_per_hour, days: t.burn.days } : { usual: 0, days: 0 }
  const prior = t.series.slice(0, -1).filter((d) => d.active).map((d) => dayValue(m, d) ?? 0)
  return { usual: median(prior), days: prior.length }
}

/** Today's figure against the usual; undefined for cache, or before the trends arrive. */
export function compare(t: Trends | undefined, m: TrendMetric, now: number | undefined): Compare | undefined {
  if (!t || m === 'cache' || now === undefined) return undefined
  const u = usualOf(t, m)
  if (!u || u.days < MIN_DAYS) return { kind: 'thin', days: u?.days ?? 0 }
  if (m === 'burn' && !(now > 0)) return { kind: 'idle', usual: u.usual, days: u.days }
  if (!(u.usual > 0)) {
    // A usual of nothing by this hour: anything at all is above it.
    return now > 0 ? { kind: 'above', now, usual: 0, days: u.days } : { kind: 'usual', now, usual: 0, days: u.days }
  }
  const ratio = now / u.usual
  const kind = Math.abs(ratio - 1) < NEAR ? 'usual' : ratio > 1 ? 'above' : 'below'
  return { kind, now, usual: u.usual, days: u.days, ratio }
}

/** "+38%", "−20%", "2.4×"; empty when there is no ratio. */
export function deltaText(c: Compare): string {
  if (c.kind !== 'above' && c.kind !== 'below') return ''
  if (c.ratio === undefined) return ''
  if (c.ratio >= 2) return `${c.ratio >= 10 ? Math.round(c.ratio) : c.ratio.toFixed(1)}×`
  const pct = Math.round(Math.abs(c.ratio - 1) * 100)
  return `${c.ratio > 1 ? '+' : '−'}${pct}%`
}

/** The word under the figure: "usual", "above usual +38%", "below usual −20%". */
export function compareWord(c: Compare): string {
  switch (c.kind) {
    case 'thin': return 'not enough history'
    case 'idle': return 'idle now'
    case 'usual': return 'usual'
    case 'above':
    case 'below': return `${c.kind} usual${deltaText(c) ? ` ${deltaText(c)}` : ''}`
  }
}

/** "18:40", from minutes after midnight. */
export function cutClock(min: number): string {
  const h = Math.floor(min / 60), m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Hovering the word: what it is set against, in full. */
export function compareTitle(c: Compare, m: TrendMetric, t: Trends, fmt: (n: number) => string): string {
  const by = cutClock(t.cut_min)
  if (c.kind === 'thin') {
    return m === 'burn'
      ? `Not enough history: ${c.days} of the last ${t.days} days had anything running; a usual needs ${MIN_DAYS}`
      : `Not enough history: ${c.days} of the last ${t.days} days had any work; a usual needs ${MIN_DAYS}`
  }
  const basis = m === 'burn'
    ? `vs your ${t.days}-day median: ${fmt(c.usual)}/h, over ${t.burn?.windows ?? 0} ten-minute windows with anything running, on ${c.days} days`
    : `vs your ${t.days}-day median: ${fmt(c.usual)} by ${by}, on the ${c.days} days with any work`
  if (c.kind === 'idle') return `Nothing running in the last 10 minutes · ${basis}`
  const now = m === 'burn' ? `${fmt(c.now)}/h now` : `${fmt(c.now)} today`
  return `${now} · ${basis}`
}

/** One point's tooltip: "Tue 13 Oct · $302.04 by 18:40". */
export function pointTitle(d: TrendDay, v: number | undefined, m: TrendMetric, t: Trends, isToday: boolean, fmt: (n: number) => string): string {
  const [y, mo, da] = d.day.split('-').map(Number)
  const when = isToday ? 'Today' : new Date(y!, (mo ?? 1) - 1, da ?? 1).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  if (v === undefined) return `${when} · ${m === 'burn' ? 'nothing running' : 'no input'}`
  if (m === 'burn') return `${when} · ${fmt(v)}/h, the day's median 10-minute window`
  if (m === 'cache') return `${when} · ${v.toFixed(1)}%${isToday ? ' so far' : ` by ${cutClock(t.cut_min)}`}`
  return `${when} · ${fmt(v)}${isToday ? ' so far' : ` by ${cutClock(t.cut_min)}`}${!isToday && !d.active ? ' (no work that day)' : ''}`
}
