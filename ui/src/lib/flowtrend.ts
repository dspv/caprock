/**
 * The Pipeline's figures in dynamics (owner, 2026-10-15, translated: "I want
 * the figures in dynamics, like everywhere else in our app — the metric,
 * plus a small chart, and above/below the average indicator"): each figure
 * with a series (BoardFlow.series, internal/api/prboardseries.go) gets the
 * Today cells' line and word (components/TodayTrend), today set against the
 * previous days of the same 14-day window. Pure.
 *
 * Measured from the board's own answer, never a figure from anywhere else
 * (rule 6). How today is set against the previous days depends on what the
 * figure is:
 *
 * - **A level** (in flight): the open count now against the median of the
 *   previous days' counts at their end.
 * - **A running total** (throughput, agent cost): today so far against the
 *   previous days cut at the same time of day (`by_now`), over the days with
 *   any merge — a morning set against whole days would read low every
 *   morning, and a day with no merge is not a usual of zero (lib/trend).
 * - **A median** (CI, opened → merged, merged → released): today's median
 *   against the median of the previous days' medians, over the days with a
 *   sample; a day without one is a gap. Nothing today says so, not "below".
 *
 * Fewer than FLOW_MIN_DAYS previous days with data and there is no
 * comparison: "not enough history". Pull requests are fewer a day than
 * sessions are, so the floor is lower than the Today cells' five.
 *
 * Colour says better or worse only where one direction is: a shorter run,
 * merge or release lag is better, more merges a day is better; the open
 * count and the agent cost are neither, so they stay muted.
 */
import { spanText } from './prstats'
import { fmtRun } from './ci'
import { median, NEAR } from './trend'
import type { FlowPoint, SeriesKey } from './prboard'

/** Previous days with data below which there is no comparison. */
export const FLOW_MIN_DAYS = 3

type Shape = 'level' | 'total' | 'median'
const SHAPE: Record<SeriesKey, Shape> = { flight: 'level', throughput: 'total', cost: 'total', ci: 'median', ttm: 'median', lag: 'median' }

/** Which way is better for a figure; 'none' keeps it muted. */
export const BETTER: Record<SeriesKey, 'lower' | 'higher' | 'none'> = { flight: 'none', throughput: 'higher', cost: 'none', ci: 'lower', ttm: 'lower', lag: 'lower' }

export type FlowCompare =
  /** Fewer than FLOW_MIN_DAYS previous days with data. */
  | { kind: 'thin'; days: number }
  /** A median with no sample today: nothing to set against the usual. */
  | { kind: 'quiet'; usual: number; days: number }
  | { kind: 'usual' | 'above' | 'below'; now: number; usual: number; days: number; ratio?: number }

const isNum = (v: number | undefined): v is number => v !== undefined

/** Today against the previous days of the window; undefined without a series. */
export function flowCompare(key: SeriesKey, pts: readonly FlowPoint[]): FlowCompare | undefined {
  if (pts.length < 2) return undefined
  const shape = SHAPE[key]
  const today = pts[pts.length - 1]!
  const prior = pts.slice(0, -1)
  const base = shape === 'total'
    ? prior.filter((p) => p.n > 0).map((p) => p.by_now ?? p.value ?? 0)
    : prior.map((p) => p.value).filter(isNum)
  if (base.length < FLOW_MIN_DAYS) return { kind: 'thin', days: base.length }
  const usual = median(base)
  const now = shape === 'total' ? (today.by_now ?? today.value) : today.value
  if (now === undefined) return { kind: 'quiet', usual, days: base.length }
  if (!(usual > 0)) return now > 0 ? { kind: 'above', now, usual: 0, days: base.length } : { kind: 'usual', now, usual: 0, days: base.length }
  const ratio = now / usual
  const kind = Math.abs(ratio - 1) < NEAR ? 'usual' : ratio > 1 ? 'above' : 'below'
  return { kind, now, usual, days: base.length, ratio }
}

/**
 * The dashed usual to draw across the line, or none: a running total's
 * usual is by this time of day while its line is whole days, so drawing it
 * there would set two different things against each other.
 */
export function flowUsualLine(key: SeriesKey, usual: number): number | undefined {
  return SHAPE[key] === 'total' ? undefined : usual
}

/** Better, worse, or neither: the word's colour. */
export function flowTone(key: SeriesKey, c: FlowCompare | undefined): 'ok' | 'warn' | 'none' {
  if (!c || (c.kind !== 'above' && c.kind !== 'below')) return 'none'
  const b = BETTER[key]
  if (b === 'none') return 'none'
  return (c.kind === 'above') === (b === 'higher') ? 'ok' : 'warn'
}

/** "+38%", "−20%", "2.4×"; empty without a ratio (lib/trend's form). */
function deltaText(c: FlowCompare): string {
  if ((c.kind !== 'above' && c.kind !== 'below') || c.ratio === undefined) return ''
  if (c.ratio >= 2) return `${c.ratio >= 10 ? Math.round(c.ratio) : c.ratio.toFixed(1)}×`
  return `${c.ratio > 1 ? '+' : '−'}${Math.round(Math.abs(c.ratio - 1) * 100)}%`
}

const NONE_TODAY: Record<SeriesKey, string> = {
  flight: 'nothing open', throughput: 'no merge yet today', cost: 'no merge yet today',
  ci: 'no run yet today', ttm: 'no merge yet today', lag: 'no release yet today',
}

/** The word under the line: "usual", "above usual +38%", "no merge yet today". */
export function flowWord(key: SeriesKey, c: FlowCompare): string {
  switch (c.kind) {
    case 'thin': return 'not enough history'
    case 'quiet': return NONE_TODAY[key]
    case 'usual': return 'usual'
    case 'above':
    case 'below': return `${c.kind} usual${deltaText(c) ? ` ${deltaText(c)}` : ''}`
  }
}

/** A figure's value as its tile prints it. */
export function flowValueText(key: SeriesKey, v: number): string {
  switch (key) {
    case 'ci': return fmtRun(v)
    case 'ttm': return spanText(v)
    case 'lag': return `~${spanText(v)}`
    case 'cost': return `$${v.toFixed(2)}`
    default: return Number.isInteger(v) ? String(v) : v.toFixed(1)
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What one day is, on hover: "Tue 13 Oct · 30m, median of 3 merges". */
export function flowPointTitle(key: SeriesKey, p: FlowPoint, isToday: boolean): string {
  const [y, mo, da] = p.day.split('-').map(Number)
  const when = isToday ? 'Today' : new Date(y!, (mo ?? 1) - 1, da ?? 1).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const v = p.value
  switch (key) {
    case 'flight': return `${when} · ${v ?? 0} open ${isToday ? 'now' : 'at the day’s end'}`
    case 'throughput': return `${when} · ${plural(v ?? 0, 'merge')}${isToday ? ' so far' : ''}`
    case 'cost': return `${when} · ${flowValueText(key, v ?? 0)} on ${plural(p.n, 'pull request')} merged${isToday ? ' so far' : ''}`
    case 'ci': return v === undefined ? `${when} · no successful run` : `${when} · ${fmtRun(v)}, median of ${plural(p.n, 'successful run')}`
    case 'ttm': return v === undefined ? `${when} · no merge` : `${when} · ${spanText(v)}, median of ${plural(p.n, 'merge')}`
    case 'lag': return v === undefined ? `${when} · no release` : `${when} · ~${spanText(v)}, median of ${plural(p.n, 'merge')} its releases shipped`
  }
}

const SAMPLE_DAYS: Record<SeriesKey, string> = {
  flight: 'days', throughput: 'days with a merge', cost: 'days with a merge',
  ci: 'days with a successful run', ttm: 'days with a merge', lag: 'days with a release',
}

/** Hovering the word: what today is set against, on what basis, in full. */
export function flowCompareTitle(key: SeriesKey, c: FlowCompare, windowDays: number): string {
  const prev = windowDays - 1
  if (c.kind === 'thin') {
    return `Not enough history: ${c.days} of the previous ${prev} days ${key === 'flight' ? 'were read' : `had ${SAMPLE_DAYS[key].replace(/^days with /, '')}`}; a comparison needs ${FLOW_MIN_DAYS}`
  }
  const u = flowValueText(key, c.usual)
  const basis = SHAPE[key] === 'level'
    ? `vs the median of the previous ${prev} days, each at its end: ${u}`
    : SHAPE[key] === 'total'
      ? `vs the median of the previous ${prev} days by this time of day: ${u}, on the ${c.days} ${SAMPLE_DAYS[key]}`
      : `vs the median of the daily medians, last ${windowDays} days: ${u}, on the ${c.days} ${SAMPLE_DAYS[key]}`
  if (c.kind === 'quiet') return `${NONE_TODAY[key][0]!.toUpperCase()}${NONE_TODAY[key].slice(1)} · ${basis}`
  const now = flowValueText(key, c.now)
  const today = SHAPE[key] === 'level' ? `${now} open now` : SHAPE[key] === 'total' ? `${now} today so far` : `${now} today`
  return `${today} · ${basis}`
}
