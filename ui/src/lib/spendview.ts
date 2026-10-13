/**
 * The cockpit's spend figures as each viewer has set them (.ai/04-ui.md §
 * Inspector): which three figures stand beside the agent (the headline and
 * two smaller lines), whether the Spend details are folded, whether they
 * read as a chart or numbers, over which period, which three figures, and
 * the figures themselves. Kept
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

/** What a figure can be, beside the agent or in the Numbers row. */
export type Metric = 'cost' | 'burn' | 'tokens' | 'turns' | 'cache' | 'time' | 'tools' | 'last'
/** What the big figure beside the agent can be: any metric. */
export type Headline = Metric

/**
 * The menu of the three figures beside the agent, in its order: its name,
 * the short word after a smaller line's value (*$4.08/h burn ▾*), and what
 * it is. One list for all three (owner, 2026-10-12: "let several numbers
 * be changeable").
 */
export const HEADLINES: readonly { id: Metric; name: string; short: string; hint: string }[] = [
  { id: 'cost', name: 'Cost', short: 'cost', hint: 'what the session has spent' },
  { id: 'burn', name: 'Burn rate', short: 'burn', hint: 'per hour, over the last hour of activity' },
  { id: 'tokens', name: 'Tokens', short: 'tok', hint: 'input, cache reads and writes included' },
  { id: 'cache', name: 'Cache hit rate', short: 'cache', hint: 'input read from the prompt cache' },
  { id: 'turns', name: 'Turns', short: 'turns', hint: 'prompts the agent answered' },
  { id: 'time', name: 'Time working', short: 'time', hint: 'from its start to its last activity' },
  { id: 'last', name: 'Last call', short: 'last call', hint: 'what the newest model call cost' },
  { id: 'tools', name: 'Tool calls', short: 'tools', hint: 'tool calls made' },
]

/**
 * The figures beside the agent before a viewer picks: burn rate big, then
 * tokens and cost — what a session is doing now first, what it has added up
 * to under it (owner, 2026-10-13: "the most useful by default; users change
 * them as they like").
 */
export const DEFAULT_HERO: readonly Metric[] = ['burn', 'tokens', 'cost']
/** The defaults before version 3, which a stored choice may only have been given. */
const OLD_HERO: readonly Metric[] = ['cost', 'burn', 'tokens']
const HERO_FILL: readonly Metric[] = ['burn', 'tokens', 'cost', 'cache', 'turns', 'time', 'last', 'tools']

/** Three distinct metrics from whatever was stored, the defaults filling any gap. */
function distinct3(raw: unknown, fill: readonly Metric[]): Metric[] {
  const valid = new Set(HEADLINES.map((m) => m.id))
  const out: Metric[] = []
  for (const v of Array.isArray(raw) ? raw : []) {
    if (out.length < 3 && valid.has(v as Metric) && !out.includes(v as Metric)) out.push(v as Metric)
  }
  for (const m of fill) if (out.length < 3 && !out.includes(m)) out.push(m)
  return out
}

/** The three figures beside the agent, the headline first. */
export function normalizeHero(raw: unknown): Metric[] {
  return distinct3(raw, HERO_FILL)
}

/** Slot `i` set to `m`; a slot that already held `m` takes what `i` had, so none is ever shown twice. */
function swapIn(out: Metric[], i: number, m: Metric): Metric[] {
  const j = out.indexOf(m)
  const old = out[i]
  if (old === undefined || j === i) return out
  out[i] = m
  if (j >= 0) out[j] = old
  return out
}

/** A figure beside the agent set to `m`, swapping with the one that showed it. */
export function pickHero(hero: readonly Metric[], i: number, m: Metric): Metric[] {
  return swapIn(normalizeHero(hero), i, m)
}

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
  return distinct3(raw, [...DEFAULT_SLOTS, ...FILL_ORDER])
}

/**
 * The three figures as drawn. For *session*, a slot holding one of the
 * figures beside the agent shows the next metric not already shown
 * instead: the same figure twice, a few lines apart, says nothing new. A
 * Caprock-wide period is a different figure, so it keeps it.
 */
export function shownSlots(slots: readonly Metric[], period: SpendPeriod, hero: readonly Metric[]): Metric[] {
  const out = normalizeSlots(slots)
  if (period !== 'session') return out
  const beside = new Set(hero)
  const shown: Metric[] = []
  out.forEach((m, i) => {
    if (!beside.has(m)) { shown.push(m); return }
    const taken = new Set<Metric>([...beside, ...shown, ...out.slice(i + 1)])
    shown.push(FILL_ORDER.find((x) => !taken.has(x)) ?? m)
  })
  return shown
}

/** Slot `i` set to `m`; a slot that already showed `m` takes what `i` had, so no metric is ever shown twice. */
export function pickSlot(slots: readonly Metric[], i: number, m: Metric): Metric[] {
  return swapIn(normalizeSlots(slots), i, m)
}

/** How the unfolded Spend block reads: the period's spend as a chart, or three figures. */
export type SpendView = 'numbers' | 'chart'
/** What the figures and the chart cover: this session, or every session on the machine over a range. */
export type SpendPeriod = 'session' | 'today' | '7d' | '30d'
export const SPEND_PERIODS: readonly SpendPeriod[] = ['session', 'today', '7d', '30d']

export interface SpendPrefs {
  /** The Spend details folded to one line; unfolded by default, so the chart is in sight. */
  folded: boolean
  /** The three figures beside the agent, the big one first, never one twice. */
  hero: Metric[]
  /** The big one, `hero[0]`. */
  headline: Headline
  /**
   * Chart or Numbers (owner, 2026-10-12: "you can choose what you see —
   * the chart or the numbers, and which ones"). Chart by default: the
   * figures beside the agent carry the numbers (owner, 2026-10-12: "where
   * did you put the chart?").
   */
  view: SpendView
  /** What the figures and the chart cover. */
  period: SpendPeriod
  /** The Numbers row's three metrics, left to right, never one twice. */
  slots: Metric[]
  /**
   * What the chart's bars measure (owner, 2026-10-13: "switch its
   * parameter, like cost and tokens beside the agent"); cost until a
   * viewer picks.
   */
  chartBy: ChartMetric
}

export const DEFAULT_SPEND_PREFS: SpendPrefs = { folded: false, hero: [...DEFAULT_HERO], headline: DEFAULT_HERO[0]!, view: 'chart', period: 'session', slots: [...DEFAULT_SLOTS], chartBy: 'cost' }

/**
 * A stored view, including 0.111.0's: *Full* drew the cells and *Spend
 * over time*, so it reads as Chart; *Compact* drew three figures, so it
 * reads as Numbers.
 */
function viewOf(v: unknown): SpendView {
  if (v === 'numbers' || v === 'chart') return v
  if (v === 'full') return 'chart'
  if (v === 'compact') return 'numbers'
  return DEFAULT_SPEND_PREFS.view
}

const KEY = 'caprock.app.cockpit.spend'
/**
 * The stored choices' version. Before 2, Numbers and a folded block were the
 * defaults, and a stored choice cannot say whether the viewer picked them or
 * was given them, so every older one is opened on the chart once. Before 3,
 * cost was the big figure by default: a stored hero that is exactly the old
 * default takes the new one, and any other order was picked and stays.
 * 4 added the chart's metric, which a stored choice from before simply
 * lacks: it reads as cost, and nothing else of it changes.
 */
const VERSION = 4
const listeners = new Set<() => void>()

/** Whatever was stored, made valid field by field. */
export function normalizeSpendPrefs(raw: unknown): SpendPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // Before the three figures, one headline was stored: it stays the big one.
  const hero = normalizeHero(Array.isArray(v.hero) ? v.hero : [v.headline, ...DEFAULT_HERO])
  return {
    folded: typeof v.folded === 'boolean' ? v.folded : DEFAULT_SPEND_PREFS.folded,
    hero,
    headline: hero[0]!,
    view: viewOf(v.view),
    period: SPEND_PERIODS.includes(v.period as SpendPeriod) ? (v.period as SpendPeriod) : DEFAULT_SPEND_PREFS.period,
    slots: normalizeSlots(v.slots),
    chartBy: CHART_METRICS.some((m) => m.id === v.chartBy) ? (v.chartBy as ChartMetric) : DEFAULT_SPEND_PREFS.chartBy,
  }
}

/**
 * A choice stored before the current version, brought up to it once (see
 * VERSION). Each step applies only to what was stored before it: a version
 * 3 choice is past both, and keeps its view, fold and figures as picked.
 */
export function migrateSpendPrefs(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  let v = raw as Record<string, unknown>
  const was = typeof v.v === 'number' ? v.v : 1
  if (was >= VERSION) return raw
  if (was < 2) v = { ...v, view: 'chart', folded: false }
  if (was < 3 && Array.isArray(v.hero) && v.hero.length === OLD_HERO.length && v.hero.every((m, i) => m === OLD_HERO[i])) {
    v = { ...v, hero: [...DEFAULT_HERO], headline: DEFAULT_HERO[0] }
  }
  return v
}

function read(): SpendPrefs {
  try {
    const s = localStorage.getItem(KEY)
    return normalizeSpendPrefs(migrateSpendPrefs(s ? JSON.parse(s) : undefined))
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
    localStorage.setItem(KEY, JSON.stringify({ ...current, v: VERSION }))
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
    case 'turns': return f.turns === undefined ? '—' : f.turns.toLocaleString('en-US')
    case 'tools': return f.tools === undefined ? '—' : f.tools.toLocaleString('en-US')
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

/**
 * The figures for a period, and the period's spend as bars. A figure the
 * source does not carry is undefined (a dash); `series` is undefined when
 * the source has no series to draw, never an empty line.
 */
export interface PeriodFigures extends Omit<SpendFigures, 'cost'> {
  cost?: number
  series?: { step: number; bars: SpendBar[] }
}

/**
 * One stretch of the chart: when, what was spent in it, and, when the
 * source says, its input tokens (cache reads and writes included) and its
 * turns. An older daemon's period series has cost only: the other fields
 * are absent, never zero.
 */
export interface SpendBar {
  /** Unix ms, inclusive. */
  start: number
  end: number
  cost: number
  tokens?: number
  turns?: number
}

/**
 * What the chart's bars can measure: only what adds up per stretch. Burn
 * rate, time working and the last call are the session's own single
 * figures, not a per-stretch sum; the cache hit rate is above 90% in every
 * stretch of a working session, so its bars all stand the same height and
 * say nothing (owner, 2026-10-13, picked cost, tokens and turns).
 */
export type ChartMetric = 'cost' | 'tokens' | 'turns'

export const CHART_METRICS: readonly { id: ChartMetric; name: string; short: string; hint: string }[] = [
  { id: 'cost', name: 'Cost', short: 'cost', hint: 'spent, at API list price' },
  { id: 'tokens', name: 'Tokens', short: 'tokens', hint: 'input, cache reads and writes included' },
  { id: 'turns', name: 'Turns', short: 'turns', hint: 'model calls, per stretch' },
]

/** A bar's value for a metric; undefined when the source does not carry it. */
export function barValue(m: ChartMetric, b: SpendBar): number | undefined {
  switch (m) {
    case 'cost': return b.cost
    case 'tokens': return b.tokens
    case 'turns': return b.turns
  }
}

/** A chart value as its top line draws it: $12.40, 950.1k, 1,204. */
export function chartValueText(m: ChartMetric, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  switch (m) {
    case 'cost': return fmtUSD(v)
    case 'tokens': return fmtTokens(v)
    case 'turns': return Math.round(v).toLocaleString('en-US')
  }
}

/**
 * The folded strip's figures: the chart's metric first, then cost, tokens,
 * turns and time working, three of them, leaving out any the period does
 * not carry rather than drawing a dash.
 */
export function foldedFigures(first: ChartMetric, f: PeriodFigures): { id: Metric; label: string; value: string }[] {
  const order: Metric[] = [first, 'cost', 'tokens', 'turns', 'time']
  const out: { id: Metric; label: string; value: string }[] = []
  for (const m of order) {
    if (out.length >= 3 || out.some((x) => x.id === m)) continue
    const value = metricValue(m, f)
    if (value === '—') continue
    out.push({ id: m, label: METRICS.find((x) => x.id === m)!.label, value })
  }
  return out
}

/** The period's own figure for a metric, the chart's total. */
export function chartTotal(m: ChartMetric, f: PeriodFigures): number | undefined {
  switch (m) {
    case 'cost': return f.cost
    case 'tokens': return f.tokens
    case 'turns': return f.turns
  }
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
  // Input and turns, summed alike; a row from an older daemon without them
  // leaves that series undefined for every bar.
  const extra = { input: [] as number[], turns: [] as number[] }
  const has = { input: true, turns: true }
  let grid: { from: number; width: number } | undefined
  for (const proj of summary.projects ?? []) {
    const sp = proj.spark
    if (!sp?.cost?.length) continue
    if (!grid && sp.width_ms > 0) grid = { from: sp.from_ms, width: sp.width_ms }
    sp.cost.forEach((v, i) => { sums[i] = (sums[i] ?? 0) + (Number.isFinite(v) ? v : 0) })
    for (const k of ['input', 'turns'] as const) {
      const arr = sp[k]
      if (!Array.isArray(arr)) { has[k] = false; continue }
      arr.forEach((v, i) => { extra[k][i] = (extra[k][i] ?? 0) + (Number.isFinite(v) ? v : 0) })
    }
  }
  const series = grid
    ? {
        step: grid.width,
        bars: Array.from(sums, (v, i): SpendBar => ({
          start: grid!.from + i * grid!.width, end: grid!.from + (i + 1) * grid!.width, cost: v ?? 0,
          ...(has.input ? { tokens: extra.input[i] ?? 0 } : {}),
          ...(has.turns ? { turns: extra.turns[i] ?? 0 } : {}),
        })),
      }
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
