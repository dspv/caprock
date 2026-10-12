/**
 * The cockpit's spend figures as each viewer has set them (.ai/04-ui.md §
 * Inspector): which figure is the headline beside the agent, whether the
 * Spend details are folded, whether they read as numbers or a chart, over
 * which period, which three figures, and the figures themselves. Kept
 * apart from the components so the arithmetic and the choice of figures
 * are tested.
 *
 * Every figure is the daemon's or summed from the calls the cockpit already
 * holds; one the data does not carry is `undefined`, drawn as a dash, never
 * as a zero.
 */
import { useSyncExternalStore } from 'react'
import type { SessionSummary, Summary } from './api'
import type { CallPoint } from './scrub'
import { fmtDuration, fmtPct, fmtTokens, fmtUSD } from './format'

/** What the big figure can be. */
export type Headline = 'cost' | 'burn' | 'tokens' | 'turns' | 'cache' | 'time'
/** What a figure of the Numbers row can be: any headline, tool calls, and the last call's cost. */
export type Metric = Headline | 'tools' | 'last'

/** The headline menu, in its order, with what each one is. */
export const HEADLINES: readonly { id: Headline; name: string; hint: string }[] = [
  { id: 'cost', name: 'Cost', hint: 'what the session has spent' },
  { id: 'burn', name: 'Burn rate', hint: 'per hour, over the last hour of activity' },
  { id: 'tokens', name: 'Tokens', hint: 'input, cache reads and writes included' },
  { id: 'turns', name: 'Turns', hint: 'prompts the agent answered' },
  { id: 'cache', name: 'Cache hit rate', hint: 'input read from the prompt cache' },
  { id: 'time', name: 'Time working', hint: 'from its start to its last activity' },
]

/**
 * The Numbers row's menu, in its order: what each figure can show, its
 * short label over the figure, and what it is. Burn rate, time working and
 * the last call are a session's own; a Caprock-wide period has a dash there.
 */
export const METRICS: readonly { id: Metric; name: string; label: string; hint: string }[] = [
  { id: 'cost', name: 'Spent', label: 'Spent', hint: 'at API list price' },
  { id: 'burn', name: 'Burn rate', label: 'Burn', hint: 'per hour, over the last hour of activity' },
  { id: 'tokens', name: 'Tokens', label: 'Tokens', hint: 'input, cache reads and writes included' },
  { id: 'cache', name: 'Cache hit rate', label: 'Cache', hint: 'input read from the prompt cache' },
  { id: 'last', name: 'Last call', label: 'Last call', hint: 'what the newest model call cost' },
  { id: 'time', name: 'Time working', label: 'Time', hint: 'from its start to its last activity' },
  { id: 'turns', name: 'Turns', label: 'Turns', hint: 'prompts the agent answered' },
  { id: 'tools', name: 'Tool calls', label: 'Tools', hint: 'tool calls made' },
]

/** The metrics only a session has: a Caprock-wide period draws a dash for them. */
export const SESSION_ONLY: ReadonlySet<Metric> = new Set<Metric>(['burn', 'time', 'last'])

/** The three figures before a viewer picks: what #472's Compact showed. */
export const DEFAULT_SLOTS: readonly Metric[] = ['cost', 'tokens', 'cache']
/** What fills a slot that is empty or would repeat the headline: the first of these not shown already. */
const FILL_ORDER: readonly Metric[] = ['cost', 'tokens', 'cache', 'burn', 'last', 'time', 'turns', 'tools']

/** Three distinct metrics from whatever was stored, the defaults filling any gap. */
export function normalizeSlots(raw: unknown): Metric[] {
  const valid = new Set(METRICS.map((m) => m.id))
  const out: Metric[] = []
  for (const v of Array.isArray(raw) ? raw : []) {
    if (out.length < 3 && valid.has(v as Metric) && !out.includes(v as Metric)) out.push(v as Metric)
  }
  for (const m of [...DEFAULT_SLOTS, ...FILL_ORDER]) if (out.length < 3 && !out.includes(m)) out.push(m)
  return out
}

/**
 * The three figures as drawn. For *session*, a slot holding the hero's
 * headline shows the next metric not already shown instead: the same
 * figure twice, a few lines apart, says nothing new. A Caprock-wide period
 * is a different figure, so it keeps it.
 */
export function shownSlots(slots: readonly Metric[], period: SpendPeriod, headline: Headline): Metric[] {
  const out = normalizeSlots(slots)
  if (period !== 'session') return out
  return out.map((m, i) => {
    if (m !== headline) return m
    const taken = new Set<Metric>([headline, ...out.filter((_, j) => j !== i)])
    return FILL_ORDER.find((x) => !taken.has(x)) ?? m
  })
}

/** Slot `i` set to `m`; a slot that already showed `m` takes what `i` had, so no metric is ever shown twice. */
export function pickSlot(slots: readonly Metric[], i: number, m: Metric): Metric[] {
  const out = normalizeSlots(slots)
  const j = out.indexOf(m)
  const old = out[i]
  if (old === undefined || j === i) return out
  out[i] = m
  if (j >= 0) out[j] = old
  return out
}

/** How the unfolded Spend block reads: three figures, or the period's spend as a chart. */
export type SpendView = 'numbers' | 'chart'
/** What the figures and the chart cover: this session, or every session on the machine over a range. */
export type SpendPeriod = 'session' | 'today' | '7d' | '30d'
export const SPEND_PERIODS: readonly SpendPeriod[] = ['session', 'today', '7d', '30d']

export interface SpendPrefs {
  /** The Spend details folded to one line: the default, since most viewers want context and the plan first. */
  folded: boolean
  headline: Headline
  /**
   * Numbers or Chart (owner, 2026-10-12: "you can choose what you see —
   * the chart or the numbers, and which ones"). Numbers by default.
   */
  view: SpendView
  /** What the figures and the chart cover. */
  period: SpendPeriod
  /** The Numbers row's three metrics, left to right, never one twice. */
  slots: Metric[]
}

export const DEFAULT_SPEND_PREFS: SpendPrefs = { folded: true, headline: 'cost', view: 'numbers', period: 'session', slots: [...DEFAULT_SLOTS] }

/**
 * A stored view, including 0.111.0's: *Full* drew the cells and *Spend
 * over time*, so it reads as Chart; *Compact* drew three figures, so it
 * reads as Numbers.
 */
function viewOf(v: unknown): SpendView {
  if (v === 'numbers' || v === 'chart') return v
  if (v === 'full') return 'chart'
  return DEFAULT_SPEND_PREFS.view
}

const KEY = 'caprock.app.cockpit.spend'
const listeners = new Set<() => void>()

/** Whatever was stored, made valid field by field. */
export function normalizeSpendPrefs(raw: unknown): SpendPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    folded: typeof v.folded === 'boolean' ? v.folded : DEFAULT_SPEND_PREFS.folded,
    headline: HEADLINES.some((x) => x.id === v.headline) ? (v.headline as Headline) : DEFAULT_SPEND_PREFS.headline,
    view: viewOf(v.view),
    period: SPEND_PERIODS.includes(v.period as SpendPeriod) ? (v.period as SpendPeriod) : DEFAULT_SPEND_PREFS.period,
    slots: normalizeSlots(v.slots),
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
  /** What the newest priced model call cost. */
  last?: number
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
    last: calls.length > 0 ? calls[calls.length - 1]!.cost : undefined,
  }
}

/** A short duration: "1h 12m", "14m", "40s". */
export function fmtSpan(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return fmtDuration(ms)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A metric's value as a figure or the headline draws it; a dash when unknown. */
export function metricValue(m: Metric, f: PeriodFigures): string {
  switch (m) {
    case 'cost': return f.cost === undefined ? '—' : fmtUSD(f.cost)
    case 'burn': return f.burn ? `${fmtUSD(f.burn.perHour)}/h` : '—'
    case 'tokens': return f.tokens === undefined ? '—' : fmtTokens(f.tokens)
    case 'turns': return f.turns === undefined ? '—' : String(f.turns)
    case 'tools': return f.tools === undefined ? '—' : String(f.tools)
    case 'cache': return f.cache === undefined ? '—' : fmtPct(f.cache)
    case 'time': return f.timeMs === undefined ? '—' : fmtSpan(f.timeMs)
    case 'last': return f.last === undefined ? '—' : fmtUSD(f.last)
  }
}

/** What hovering a metric explains; for a Caprock-wide period, whose figure it is. */
export function metricTitle(m: Metric, f: PeriodFigures, period: SpendPeriod = 'session'): string {
  if (period !== 'session') {
    const when = periodScope(period).split(' · ')[0]!.toLowerCase()
    if (SESSION_ONLY.has(m)) return 'A session’s own figure: pick session to see it'
    switch (m) {
      case 'cost': return `What every session spent, ${when}, at API list price`
      case 'tokens': return `Input tokens of every session, ${when}, cache reads and writes included`
      case 'cache': return `Share of input tokens read from the prompt cache, every session, ${when}`
      case 'turns': return `Prompts answered, every session, ${when}`
      case 'tools': return `Tool calls, every session, ${when}`
    }
  }
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
    case 'last': return 'What the newest model call cost'
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
    case 'last': return f.last === undefined ? undefined : `last call ${fmtUSD(f.last)}`
  }
}

/** The folded line: the headline first, then cost, turns and time. "Spent $12.40 · 48 turns · 1h 12m". */
export function foldedLine(h: Headline, f: SpendFigures): string {
  const order: Metric[] = [h, ...(['cost', 'turns', 'time'] as Metric[]).filter((m) => m !== h)]
  const line = order.map((m) => phrase(m, f)).filter((x): x is string => !!x).slice(0, 3).join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/**
 * The figures for a period, and the period's spend as bars. A figure the
 * source does not carry is undefined (a dash); `series` is undefined when
 * the source has no series to draw, never an empty line.
 */
export interface PeriodFigures extends Omit<SpendFigures, 'cost'> {
  cost?: number
  series?: { step: number; bars: SpendBar[] }
}

/** One stretch of the chart: when, and what was spent in it. */
export interface SpendBar {
  /** Unix ms, inclusive. */
  start: number
  end: number
  cost: number
}

/** Whose money the figures are: "This session", "Today · all sessions". */
export function periodScope(p: SpendPeriod): string {
  switch (p) {
    case 'session': return 'This session'
    case 'today': return 'Today · all sessions'
    case '7d': return '7 days · all sessions'
    case '30d': return '30 days · all sessions'
  }
}

/**
 * The figures for a period. *session* is this session's own figures (its
 * chart is drawn from its full call series, `SpendOverTime`). today, 7d and
 * 30d are Caprock-wide, from that range's `/v1/stats/summary`: its totals,
 * its savings' hit rate, and the projects' sparks (24 hours, 7 or 30 days)
 * summed bucket by bucket into the chart's bars — no new query. No summary
 * yet: dashes, never zeros; no spark in it: no series.
 */
export function periodFigures(p: SpendPeriod, f: SpendFigures, summary: Summary | undefined): PeriodFigures {
  if (p === 'session') return f
  if (!summary) return {}
  const tokens = summary.tokens_in + summary.cache_read + summary.cache_write
  const sums: number[] = []
  let grid: { from: number; width: number } | undefined
  for (const proj of summary.projects ?? []) {
    const sp = proj.spark
    if (!sp?.cost?.length) continue
    if (!grid && sp.width_ms > 0) grid = { from: sp.from_ms, width: sp.width_ms }
    sp.cost.forEach((v, i) => { sums[i] = (sums[i] ?? 0) + (Number.isFinite(v) ? v : 0) })
  }
  const series = grid
    ? { step: grid.width, bars: Array.from(sums, (v, i) => ({ start: grid!.from + i * grid!.width, end: grid!.from + (i + 1) * grid!.width, cost: v ?? 0 })) }
    : undefined
  return {
    cost: summary.cost_usd,
    tokens,
    cache: tokens > 0 ? (summary.savings?.hit_rate ?? 0) * 100 : undefined,
    turns: summary.turns,
    tools: summary.tool_calls,
    series,
  }
}
