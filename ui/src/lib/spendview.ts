/**
 * The cockpit's spend figures as each viewer has set them (.ai/04-ui.md §
 * Inspector): which figure is the headline beside the agent, whether the
 * Spend details are folded, whether *Spend over time* is open, and the
 * figures themselves. Kept apart from the components so the arithmetic and
 * the choice of cells are tested.
 *
 * Every figure is the daemon's or summed from the calls the cockpit already
 * holds; one the data does not carry is `undefined`, drawn as a dash, never
 * as a zero.
 */
import { useSyncExternalStore } from 'react'
import type { SessionSummary, Summary } from './api'
import { timeBars, type CallPoint } from './scrub'
import { fmtDuration, fmtPct, fmtTokens, fmtUSD } from './format'

/** What the big figure can be. */
export type Headline = 'cost' | 'burn' | 'tokens' | 'turns' | 'cache' | 'time'
/** What a small cell can be: any headline, and tool calls. */
export type Metric = Headline | 'tools'

/** The headline menu, in its order, with what each one is. */
export const HEADLINES: readonly { id: Headline; name: string; hint: string }[] = [
  { id: 'cost', name: 'Cost', hint: 'what the session has spent' },
  { id: 'burn', name: 'Burn rate', hint: 'per hour, over the last hour of activity' },
  { id: 'tokens', name: 'Tokens', hint: 'input, cache reads and writes included' },
  { id: 'turns', name: 'Turns', hint: 'prompts the agent answered' },
  { id: 'cache', name: 'Cache hit rate', hint: 'input read from the prompt cache' },
  { id: 'time', name: 'Time working', hint: 'from its start to its last activity' },
]

/** The small cells' order of usefulness: the first four that are not the headline. */
const CELL_ORDER: readonly Metric[] = ['cost', 'turns', 'tools', 'tokens', 'cache', 'burn', 'time']

/** The four cells under a headline, never repeating it. */
export function cellsFor(h: Headline): Metric[] {
  return CELL_ORDER.filter((m) => m !== h).slice(0, 4)
}

/** The short label a cell carries. */
export const CELL_LABEL: Record<Metric, string> = {
  cost: 'Cost', burn: 'Burn', tokens: 'Tokens', turns: 'Turns', cache: 'Cache', time: 'Time', tools: 'Tools',
}

/** How the unfolded Spend block reads: three figures and a spark, or the cells and *Spend over time*. */
export type SpendView = 'compact' | 'full'
/** What the compact figures cover: this session, or every session on the machine over a range. */
export type SpendPeriod = 'session' | 'today' | '7d' | '30d'
export const SPEND_PERIODS: readonly SpendPeriod[] = ['session', 'today', '7d', '30d']

export interface SpendPrefs {
  /** The Spend details folded to one line: the default, since most viewers want context and the plan first. */
  folded: boolean
  headline: Headline
  /** *Spend over time* open under the cells. */
  chart: boolean
  /** Compact by default (owner, 2026-10-12: about half as tall, only the figures that inform). */
  view: SpendView
  /** What the compact figures cover. */
  period: SpendPeriod
}

export const DEFAULT_SPEND_PREFS: SpendPrefs = { folded: true, headline: 'cost', chart: false, view: 'compact', period: 'session' }

const KEY = 'caprock.app.cockpit.spend'
const listeners = new Set<() => void>()

/** Whatever was stored, made valid field by field. */
export function normalizeSpendPrefs(raw: unknown): SpendPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    folded: typeof v.folded === 'boolean' ? v.folded : DEFAULT_SPEND_PREFS.folded,
    headline: HEADLINES.some((x) => x.id === v.headline) ? (v.headline as Headline) : DEFAULT_SPEND_PREFS.headline,
    chart: typeof v.chart === 'boolean' ? v.chart : DEFAULT_SPEND_PREFS.chart,
    view: v.view === 'compact' || v.view === 'full' ? v.view : DEFAULT_SPEND_PREFS.view,
    period: SPEND_PERIODS.includes(v.period as SpendPeriod) ? (v.period as SpendPeriod) : DEFAULT_SPEND_PREFS.period,
  }
}

function read(): SpendPrefs {
  try {
    const s = localStorage.getItem(KEY)
    return normalizeSpendPrefs(s ? JSON.parse(s) : undefined)
  } catch {
    return DEFAULT_SPEND_PREFS
  }
}

let current: SpendPrefs | undefined

export function getSpendPrefs(): SpendPrefs {
  if (!current) current = read()
  return current
}

/** Change some of the choices; every open cockpit follows. */
export function setSpendPrefs(patch: Partial<SpendPrefs>): void {
  current = normalizeSpendPrefs({ ...getSpendPrefs(), ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Private storage: the choice holds until the window closes.
  }
  for (const fn of listeners) fn()
}

/** For tests: forget what was read, so the next read is from storage. */
export function resetSpendPrefsForTest(): void {
  current = undefined
}

export function useSpendPrefs(): SpendPrefs {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSpendPrefs,
    getSpendPrefs,
  )
}

/** One hour, the burn rate's window. */
const HOUR_MS = 3_600_000
/** A shorter stretch is not divided by less than this, so two calls a second apart are not a rate. */
const MIN_SPAN_MS = 5 * 60_000

export interface Burn {
  /** Dollars an hour. */
  perHour: number
  /** The minutes of activity it was measured over: 60, or fewer for a younger session. */
  minutes: number
}

/**
 * Dollars an hour over the last hour of activity: what the calls in the hour
 * ending at the newest call cost. A session with less than an hour behind it
 * is measured over what it has (at least five minutes). Undefined with fewer
 * than two priced calls: one call is a price, not a rate.
 */
export function burnRate(calls: readonly CallPoint[], startedAt?: number): Burn | undefined {
  const priced = calls.filter((c) => Number.isFinite(c.ts) && c.ts > 0 && Number.isFinite(c.cost))
  if (priced.length < 2) return undefined
  const newest = Math.max(...priced.map((c) => c.ts))
  const from = newest - HOUR_MS
  const first = Math.min(...priced.map((c) => c.ts))
  const start = startedAt && startedAt > 0 && startedAt <= first ? startedAt : first
  const span = Math.min(HOUR_MS, Math.max(MIN_SPAN_MS, newest - Math.max(start, from)))
  let sum = 0
  for (const c of priced) if (c.ts > from) sum += c.cost
  return { perHour: sum / (span / HOUR_MS), minutes: Math.round(span / 60_000) }
}

/** The figures; any one the data does not carry is undefined. */
export interface SpendFigures {
  cost: number
  burn?: Burn
  /** Input tokens with cache reads and writes. */
  tokens?: number
  tokensOut?: number
  turns?: number
  tools?: number
  /** Percent of input read from the cache. */
  cache?: number
  /** From the start to the last activity, ms. */
  timeMs?: number
}

export function spendFigures(s: SessionSummary, calls: readonly CallPoint[]): SpendFigures {
  const st = s.stats
  const tokens = st ? st.tokens_in + st.cache_read + st.cache_write : undefined
  const end = s.worked_at || s.last_event_at
  return {
    cost: st?.cost_usd ?? 0,
    burn: burnRate(calls, s.started_at),
    tokens,
    tokensOut: st?.tokens_out,
    turns: st?.turns,
    tools: st?.tool_calls,
    cache: tokens ? (s.savings?.hit_rate ?? 0) * 100 : undefined,
    timeMs: s.started_at > 0 && end > s.started_at ? end - s.started_at : undefined,
  }
}

/** A short duration: "1h 12m", "14m", "40s". */
export function fmtSpan(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return fmtDuration(ms)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A metric's value as a cell or the headline draws it; a dash when unknown. */
export function metricValue(m: Metric, f: SpendFigures): string {
  switch (m) {
    case 'cost': return fmtUSD(f.cost)
    case 'burn': return f.burn ? `${fmtUSD(f.burn.perHour)}/h` : '—'
    case 'tokens': return f.tokens === undefined ? '—' : fmtTokens(f.tokens)
    case 'turns': return f.turns === undefined ? '—' : String(f.turns)
    case 'tools': return f.tools === undefined ? '—' : String(f.tools)
    case 'cache': return f.cache === undefined ? '—' : fmtPct(f.cache)
    case 'time': return f.timeMs === undefined ? '—' : fmtSpan(f.timeMs)
  }
}

/** What hovering a metric explains. */
export function metricTitle(m: Metric, f: SpendFigures): string {
  switch (m) {
    case 'cost': return 'What the session has spent, at API list price'
    case 'burn': return f.burn
      ? (f.burn.minutes >= 60 ? 'Spent in the last hour of activity, per hour' : `Spent per hour over its ${f.burn.minutes} minutes of activity`)
      : 'Needs two priced calls'
    case 'tokens': return f.tokens === undefined ? 'Input tokens' : `${fmtTokens(f.tokens)} in · ${fmtTokens(f.tokensOut)} out`
    case 'turns': return 'Prompts the agent answered'
    case 'tools': return 'Tool calls'
    case 'cache': return 'Share of input tokens read from the prompt cache'
    case 'time': return 'From the session’s start to its last prompt, reply or tool call'
  }
}

/** A metric as a phrase in the folded line. */
function phrase(m: Metric, f: SpendFigures): string | undefined {
  switch (m) {
    case 'cost': return `spent ${fmtUSD(f.cost)}`
    case 'burn': return f.burn ? `${fmtUSD(f.burn.perHour)}/h` : undefined
    case 'tokens': return f.tokens === undefined ? undefined : `${fmtTokens(f.tokens)} tokens`
    case 'turns': return f.turns === undefined ? undefined : `${f.turns} ${f.turns === 1 ? 'turn' : 'turns'}`
    case 'tools': return f.tools === undefined ? undefined : `${f.tools} tool calls`
    case 'cache': return f.cache === undefined ? undefined : `${fmtPct(f.cache)} cache hits`
    case 'time': return f.timeMs === undefined ? undefined : fmtSpan(f.timeMs)
  }
}

/** The folded line: the headline first, then cost, turns and time. "Spent $12.40 · 48 turns · 1h 12m". */
export function foldedLine(h: Headline, f: SpendFigures): string {
  const order: Metric[] = [h, ...(['cost', 'turns', 'time'] as Metric[]).filter((m) => m !== h)]
  const line = order.map((m) => phrase(m, f)).filter((x): x is string => !!x).slice(0, 3).join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** What the compact block shows for a period. A figure the source does not carry is undefined (a dash). */
export interface PeriodFigures {
  cost?: number
  /** Input tokens with cache reads and writes, as the session's Tokens counts them. */
  tokens?: number
  /** Percent of input read from the cache. */
  cache?: number
  /** Spend over the period, oldest first: the spark under the figures. */
  series: number[]
}

/** Whose money the compact figures are: "This session", "Today · all sessions". */
export function periodScope(p: SpendPeriod): string {
  switch (p) {
    case 'session': return 'This session'
    case 'today': return 'Today · all sessions'
    case '7d': return '7 days · all sessions'
    case '30d': return '30 days · all sessions'
  }
}

/**
 * The compact figures for a period. *session* is this session's own figures
 * and its calls summed by time (`timeBars`, as *Spend over time* draws
 * them). today, 7d and 30d are Caprock-wide, from that range's
 * `/v1/stats/summary`: its totals, its savings' hit rate, and the projects'
 * sparks (24 hours, 7 or 30 days) summed bucket by bucket — no new query.
 * No summary yet: dashes, never zeros.
 */
export function periodFigures(p: SpendPeriod, f: SpendFigures, calls: readonly CallPoint[], summary: Summary | undefined): PeriodFigures {
  if (p === 'session') {
    return { cost: f.cost, tokens: f.tokens, cache: f.cache, series: timeBars(calls).bars.map((b) => b.cost) }
  }
  if (!summary) return { series: [] }
  const tokens = summary.tokens_in + summary.cache_read + summary.cache_write
  const series: number[] = []
  for (const proj of summary.projects ?? []) {
    proj.spark?.cost.forEach((v, i) => { series[i] = (series[i] ?? 0) + (Number.isFinite(v) ? v : 0) })
  }
  return {
    cost: summary.cost_usd,
    tokens,
    cache: tokens > 0 ? (summary.savings?.hit_rate ?? 0) * 100 : undefined,
    series: Array.from(series, (v) => v ?? 0),
  }
}
