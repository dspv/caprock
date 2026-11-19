/**
 * The cockpit's spend figures as each viewer has set them (.ai/04-ui.md §
 * Inspector): which three figures stand beside the agent (the headline and
 * two smaller lines), whether the Spend details are folded, whether they
 * read as a chart or numbers, which three figures, and the figures
 * themselves; and, per tab, whose spend (this session or all) over when. Kept
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
import { fmtCountCompact, fmtDuration, fmtPct, fmtTokens, fmtUSD, fmtUSDCompact } from './format'

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

/** The metrics only a session has: an *all sessions* period draws a dash for them. */
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
 * The three figures as drawn. For the whole session, a slot holding one of
 * the figures beside the agent shows the next metric not already shown
 * instead: the same figure twice, a few lines apart, says nothing new. A
 * window of the session, or every session's, is a different figure, so it
 * keeps it.
 */
export function shownSlots(slots: readonly Metric[], pick: SpendPick, hero: readonly Metric[]): Metric[] {
  const out = normalizeSlots(slots)
  if (!isWholeSession(pick)) return out
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
/**
 * Whose spend the figures and the chart are: this session's, or every
 * session's on the machine (owner, 2026-11-19: "I'd switch between this
 * session and all sessions", translated).
 */
export type SpendScope = 'session' | 'all'
export const SPEND_SCOPES: readonly SpendScope[] = ['session', 'all']
/**
 * Over when: the whole session (this session only, from its start), or
 * today, the last 7 or 30 days, each starting at a local midnight like the
 * daemon's own ranges.
 */
export type SpendWindow = 'whole' | 'today' | '7d' | '30d'
/** The windows that are a range of days: the only ones *all sessions* has. */
export type RangeWindow = Exclude<SpendWindow, 'whole'>
export const RANGE_WINDOWS: readonly RangeWindow[] = ['today', '7d', '30d']
/** The windows a scope offers, in their order. */
export function windowsFor(scope: SpendScope): readonly SpendWindow[] {
  return scope === 'session' ? ['whole', ...RANGE_WINDOWS] : RANGE_WINDOWS
}

/** A tab's two choices. */
export interface SpendPick {
  readonly scope: SpendScope
  readonly window: SpendWindow
}
/** What every tab opens on: its own session, start to now. */
export const WHOLE_SESSION: SpendPick = Object.freeze({ scope: 'session', window: 'whole' })

export function isWholeSession(p: SpendPick): boolean {
  return p.scope === 'session' && p.window === 'whole'
}

/**
 * The pick as drawn: *all sessions* has no whole span, so a tab on *whole*
 * that switches to all sessions reads today, and is back on the whole
 * session when it switches back — the window is only rewritten by a pick.
 */
export function shownPick(p: SpendPick): SpendPick {
  return p.scope === 'all' && p.window === 'whole' ? { scope: 'all', window: 'today' } : p
}

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
  /** The Numbers row's three metrics, left to right, never one twice. */
  slots: Metric[]
  /**
   * What the chart's bars measure (owner, 2026-10-13: "switch its
   * parameter, like cost and tokens beside the agent"); cost until a
   * viewer picks.
   */
  chartBy: ChartMetric
}

export const DEFAULT_SPEND_PREFS: SpendPrefs = { folded: false, hero: [...DEFAULT_HERO], headline: DEFAULT_HERO[0]!, view: 'chart', slots: [...DEFAULT_SLOTS], chartBy: 'cost' }

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
 * lacks: it reads as cost, and nothing else of it changes. 5 added burn
 * rate to the chart's metrics: a version 4 choice holds one of the three it
 * could pick then and is kept as picked, so there is no step for it — the
 * number says which menu the choice was made from. 6 took the period out:
 * it was one choice for every tab, so a Caprock-wide period picked once
 * put the same chart and dollars in every tab's cockpit (owner,
 * 2026-10-22). A stored period is dropped once and each tab opens on its
 * own session (`useSpendPick`).
 */
const VERSION = 6
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
  if (was < 6 && 'period' in v) {
    const { period: _dropped, ...rest } = v
    v = rest
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
  picks.clear()
}

export function useSpendPrefs(): SpendPrefs {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSpendPrefs,
    getSpendPrefs,
  )
}

/**
 * The scope and window each tab's cockpit shows, by session id, for as long
 * as the window is open. A tab opens on its own session, start to now — its
 * own agent's burn and spend — and a pick in one tab stays in that tab only
 * (owner, 2026-10-22: one stored period made every tab show the same chart
 * and dollars). Not stored: a reload opens every tab on its session.
 */
const picks = new Map<string, SpendPick>()
const pickListeners = new Set<() => void>()

/** The tab's pick as made; `shownPick` says what it draws. */
export function getSpendPick(sessionId: string): SpendPick {
  return picks.get(sessionId) ?? WHOLE_SESSION
}

function putPick(sessionId: string, p: SpendPick): void {
  if (isWholeSession(p)) picks.delete(sessionId)
  else picks.set(sessionId, p)
  for (const fn of pickListeners) fn()
}

/** Whose spend one tab's cockpit shows; the others keep theirs, and this one keeps its window. */
export function setSpendScope(sessionId: string, scope: SpendScope): void {
  if (!SPEND_SCOPES.includes(scope)) return
  putPick(sessionId, { scope, window: getSpendPick(sessionId).window })
}

/** Over when one tab's cockpit shows it; *whole* is the session's alone. */
export function setSpendWindow(sessionId: string, w: SpendWindow): void {
  const { scope } = getSpendPick(sessionId)
  if (!windowsFor(scope).includes(w)) return
  putPick(sessionId, { scope, window: w })
}

export function useSpendPick(sessionId: string): SpendPick {
  return useSyncExternalStore(
    (fn) => { pickListeners.add(fn); return () => { pickListeners.delete(fn) } },
    () => getSpendPick(sessionId),
    () => getSpendPick(sessionId),
  )
}

/** Where a window starts: local midnight today, six or 29 days before it (the daemon's rangeFrom). */
export function windowStart(w: RangeWindow, now: number): number {
  const d = new Date(now)
  const back = w === 'today' ? 0 : w === '7d' ? 6 : 29
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()
}

/** A window in a sentence: "today", "in the last 7 days". */
export function windowPhrase(w: SpendWindow): string {
  switch (w) {
    case 'whole': return 'since it started'
    case 'today': return 'today'
    case '7d': return 'in the last 7 days'
    case '30d': return 'in the last 30 days'
  }
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
  /**
   * Turns on a model with no price in the pricing table: their cost is not
   * in `cost`, so a positive count makes `cost` partial, or unknown when
   * nothing was priced (costNote). Absent or 0 when every turn was priced.
   */
  unpriced?: number
  /** The models those turns ran on, when known. */
  unpricedModels?: string[]
}

/**
 * The session's figures. `unpricedModels` names the models of the unpriced
 * turns the cockpit holds; with none, a session that priced nothing falls
 * back to its own model, since every turn of it ran unpriced.
 */
export function spendFigures(s: SessionSummary, calls: readonly CallPoint[], unpricedModels: readonly string[] = []): SpendFigures {
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
    ...(st?.unpriced_turns && st.unpriced_turns > 0
      ? { unpriced: st.unpriced_turns, unpricedModels: unpricedModels.length > 0 ? [...unpricedModels] : !(st.cost_usd > 0) ? [s.model || s.model_display || ''].filter(Boolean) : [] }
      : {}),
  }
}

/**
 * What a cost figure is when some turns had no price (rule 6: never a
 * $0.00 that says the work was free). `partial`: the figure is what could
 * be priced, drawn with a trailing `+`; `unknown`: nothing was priced, drawn
 * as a dash. `short` is a sentence for where the figure would be, `title`
 * the hover. Undefined when every turn was priced.
 */
export interface CostNote {
  state: 'partial' | 'unknown'
  short: string
  title: string
}

export function costNote(f: Pick<PeriodFigures, 'cost' | 'unpriced' | 'unpricedModels'>): CostNote | undefined {
  const n = f.unpriced ?? 0
  if (n <= 0) return undefined
  const models = (f.unpricedModels ?? []).filter(Boolean).join(', ')
  if (!(f.cost !== undefined && f.cost > 0)) {
    const who = models || 'this model'
    return {
      state: 'unknown',
      short: `No price for ${who}: the cost is unknown, not $0.00.`,
      title: `No price for ${who} in Caprock’s pricing table, so the cost is unknown — not $0.00`,
    }
  }
  const turns = `${n.toLocaleString('en-US')} turn${n === 1 ? '' : 's'}${models ? ` on ${models}` : ''}`
  return {
    state: 'partial',
    short: `Partial: ${turns} with no price ${n === 1 ? 'is' : 'are'} not in it.`,
    title: `Partial: ${fmtUSD(f.cost)} is what could be priced; ${turns} with no price in Caprock’s pricing table ${n === 1 ? 'is' : 'are'} not in it`,
  }
}

/**
 * A cost as the figures draw it: a dash when unknown, a trailing + when
 * partial; `compact` for a narrow cell ($7.92k, lib/format fmtUSDCompact).
 */
export function costText(f: Pick<PeriodFigures, 'cost' | 'unpriced' | 'unpricedModels'>, v = f.cost, compact = false): string {
  const c = costNote(f)
  if (v === undefined || c?.state === 'unknown') return '—'
  const t = compact ? fmtUSDCompact(v) : fmtUSD(v)
  return c ? `${t}+` : t
}

/** A short duration: "1h 12m", "14m", "40s". */
export function fmtSpan(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return fmtDuration(ms)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * A metric's value as a figure or the headline draws it; a dash when
 * unknown. `compact` is the Numbers row's: from 1,000 up a k, M or B with
 * two decimals ($7.92k, 13.71B), so a big figure fits its third of a 280px
 * cockpit instead of being cut (owner, 2026-11-19); the exact value is in
 * the cell's title and its spoken name.
 */
export function metricValue(m: Metric, f: PeriodFigures, compact = false): string {
  const usd = compact ? fmtUSDCompact : fmtUSD
  const count = (v: number) => (compact ? fmtCountCompact(v) : v.toLocaleString('en-US'))
  switch (m) {
    case 'cost': return costText(f, f.cost, compact)
    case 'burn': return f.burn ? `${usd(f.burn.perHour)}/h` : '—'
    case 'tokens': return f.tokens === undefined ? '—' : compact ? fmtCountCompact(f.tokens) : fmtTokens(f.tokens)
    case 'turns': return f.turns === undefined ? '—' : count(f.turns)
    case 'tools': return f.tools === undefined ? '—' : count(f.tools)
    case 'cache': return f.cache === undefined ? '—' : fmtPct(f.cache)
    case 'time': return f.timeMs === undefined ? '—' : fmtSpan(f.timeMs)
    case 'last': return f.last === undefined ? '—' : usd(f.last)
  }
}

/** What hovering a metric explains: what it is, and for a window or every session, whose and when. */
export function metricTitle(m: Metric, f: PeriodFigures, pick: SpendPick = WHOLE_SESSION): string {
  const base = metricTitleBase(m, f, shownPick(pick))
  const c = costNote(f)
  // Burn and the last call are summed from priced calls only.
  if (!c || !(m === 'cost' || (pick.scope === 'session' && (m === 'burn' || m === 'last')))) return base
  return `${base} · ${m === 'cost' ? c.title : c.state === 'unknown' ? c.title : 'priced calls only'}`
}

function metricTitleBase(m: Metric, f: PeriodFigures, pick: SpendPick): string {
  if (pick.scope === 'session' && pick.window !== 'whole') {
    const when = windowPhrase(pick.window)
    switch (m) {
      case 'cost': return `What the session spent ${when}, at API list price`
      case 'burn': return f.burn
        ? (f.burn.minutes >= 60 ? `Spent in its last hour of activity ${when}, per hour` : `Spent per hour over its ${f.burn.minutes} minutes of activity ${when}`)
        : `Needs two priced calls ${when}`
      case 'tokens': return f.tokens === undefined ? `Input tokens ${when}` : `${fmtTokens(f.tokens)} in · ${fmtTokens(f.tokensOut)} out, ${when}`
      case 'turns': return `Model calls the session made ${when}`
      case 'tools': return 'Tool calls are counted over the whole session only: pick whole to see them'
      case 'cache': return `Share of input tokens read from the prompt cache, ${when}`
      case 'time': return `From its first to its last call ${when}`
      case 'last': return 'What the newest model call cost'
    }
  }
  if (pick.scope === 'all') {
    const when = spendLabel(pick).split(' · ')[0]!.toLowerCase()
    if (SESSION_ONLY.has(m)) return 'A session’s own figure: pick this session to see it'
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
  /**
   * The period's dollars per active hour, when its bars are too fine to
   * carry active hours (a session drawn by 10 minutes): what the chart's
   * burn rate would read. Otherwise it is read from the bars.
   */
  activeBurn?: number
  /** A window of this session that holds no call: drawn as a sentence, never as zeros. */
  empty?: boolean
}

/**
 * One stretch of the chart: when, what was spent in it, and, when the
 * source says, its input tokens (cache reads and writes included), its
 * turns, and its active session-hours with what they cost (the burn rate's
 * two halves). An older daemon's period series has cost only: the other
 * fields are absent, never zero.
 */
export interface SpendBar {
  /** Unix ms, inclusive. */
  start: number
  end: number
  cost: number
  tokens?: number
  turns?: number
  /** Clock hours in the stretch in which one session made at least USUAL_MIN_CALLS priced calls costing more than nothing. */
  activeHours?: number
  /** What those hours cost; the stretch's other spend is not in it. */
  activeCost?: number
}

/**
 * What the chart's bars can measure. Cost, tokens and turns add up per
 * stretch; burn rate is a rate per stretch (owner, 2026-10-13: "for some
 * total spend matters more, for some burn rate, someone measures tokens").
 * Time working and the last call are the session's own single figures; the
 * cache hit rate is above 90% in every stretch of a working session, so its
 * bars all stand the same height and say nothing.
 */
export type ChartMetric = 'cost' | 'burn' | 'tokens' | 'turns'

export const CHART_METRICS: readonly { id: ChartMetric; name: string; short: string; hint: string }[] = [
  { id: 'cost', name: 'Cost', short: 'cost', hint: 'spent, at API list price' },
  { id: 'burn', name: 'Burn rate', short: 'burn', hint: 'per active hour: an hour with five or more calls' },
  { id: 'tokens', name: 'Tokens', short: 'tokens', hint: 'input, cache reads and writes included' },
  { id: 'turns', name: 'Turns', short: 'turns', hint: 'model calls, per stretch' },
]

/**
 * A bar's value for a metric; undefined when the source does not carry it.
 * Burn rate is the stretch's active hours' cost over those hours — not its
 * cost over the stretch's length, which would only be cost drawn again —
 * and undefined for a stretch with no active hour: idle is no rate, not
 * $0/h.
 */
export function barValue(m: ChartMetric, b: SpendBar): number | undefined {
  switch (m) {
    case 'cost': return b.cost
    case 'burn': return b.activeHours && b.activeHours > 0 ? (b.activeCost ?? 0) / b.activeHours : undefined
    case 'tokens': return b.tokens
    case 'turns': return b.turns
  }
}

/** Whether the source carries a metric for a bar at all, zero or not; a burn bar with no active hour still carries it. */
export function barCarries(m: ChartMetric, b: SpendBar): boolean {
  return m === 'burn' ? b.activeHours !== undefined : barValue(m, b) !== undefined
}

/** A chart value as its top line draws it: $12.40, $3.10/h, 950.1k, 1,204. */
export function chartValueText(m: ChartMetric, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  switch (m) {
    case 'cost': return fmtUSD(v)
    case 'burn': return `${fmtUSD(v)}/h`
    case 'tokens': return fmtTokens(v)
    case 'turns': return Math.round(v).toLocaleString('en-US')
  }
}

/** The period's burn rate from its bars: every active hour's cost over every active hour. Undefined with none. */
export function periodBurn(bars: readonly SpendBar[] | undefined): number | undefined {
  let h = 0, c = 0
  for (const b of bars ?? []) { h += b.activeHours ?? 0; c += b.activeCost ?? 0 }
  return h > 0 ? c / h : undefined
}

/**
 * The folded strip's figures: the chart's metric first, then cost, tokens,
 * turns and time working, three of them, leaving out any the period does
 * not carry rather than drawing a dash. The first is the chart's own total,
 * so a folded burn rate is the same figure the chart's top line reads.
 */
export function foldedFigures(first: ChartMetric, f: PeriodFigures): { id: Metric; label: string; value: string }[] {
  const order: Metric[] = [first, 'cost', 'tokens', 'turns', 'time']
  const out: { id: Metric; label: string; value: string }[] = []
  for (const m of order) {
    if (out.length >= 3 || out.some((x) => x.id === m)) continue
    // Cost's chart total is its figure; metricValue marks it partial or unknown.
    const value = m === first && m !== 'cost' ? chartValueText(first, chartTotal(first, f)) : metricValue(m, f)
    if (value === '—') continue
    out.push({ id: m, label: METRICS.find((x) => x.id === m)!.label, value })
  }
  return out
}

/**
 * The period's own figure for a metric, the chart's total. Burn rate is the
 * period's active hours' rate, read from its bars, so the top line and the
 * bars under it measure the same thing (the hero's burn, the last hour of
 * activity, is a different question).
 */
export function chartTotal(m: ChartMetric, f: PeriodFigures): number | undefined {
  switch (m) {
    case 'cost': return costNote(f)?.state === 'unknown' ? undefined : f.cost
    case 'burn': return f.activeBurn ?? periodBurn(f.series?.bars)
    case 'tokens': return f.tokens
    case 'turns': return f.turns
  }
}

/**
 * The folded strip's chip: *session* for the tab's whole session, the
 * window with *session* for a part of it (*today · session*), and with
 * *all* for every session's (*today · all*), so a strip that is every
 * session's is never read as this agent's. Short: the cockpit is about
 * 330px.
 */
export function periodChip(pick: SpendPick): string {
  const p = shownPick(pick)
  if (isWholeSession(p)) return 'session'
  return `${p.window} · ${p.scope}`
}

/** The two words of the scope control, short for the 280–460px cockpit, and its full name. */
export const SCOPE_NAMES: Record<SpendScope, { short: string; long: string }> = {
  session: { short: 'session', long: 'This session' },
  all: { short: 'all', long: 'All sessions' },
}

/** The period control's words, and its full name on hover and for a screen reader. */
export const WINDOW_NAMES: Record<SpendWindow, { short: string; long: string }> = {
  whole: { short: 'since start', long: 'Since start' },
  today: { short: 'today', long: 'Today' },
  '7d': { short: '7d', long: 'Last 7 days' },
  '30d': { short: '30d', long: 'Last 30 days' },
}

/**
 * Whose money the figures are and over when, both always said: "Since
 * start · this session", "Today · this session", "30 days · all sessions" (owner,
 * 2026-11-19: three tabs on 30d drew the same chart and nothing said it
 * was every session's).
 */
export function spendLabel(pick: SpendPick): string {
  const p = shownPick(pick)
  if (isWholeSession(p)) return 'Since start · this session'
  const when = p.window === 'today' ? 'Today' : p.window === '7d' ? '7 days' : '30 days'
  return `${when} · ${p.scope === 'session' ? 'this session' : 'all sessions'}`
}

/**
 * A window of this session, from its own calls (the full series the cockpit
 * reads from `/v1/sessions/{id}/calls`, with the held events merged in):
 * those inside [from, to] summed. Turns are its model calls; tool calls
 * stay a dash, since a call does not always carry its tools. No call in
 * the window: `empty`, every figure a dash, never a zero.
 */
export function windowFigures(calls: readonly CallPoint[], from: number, to: number): PeriodFigures {
  const inside = calls.filter((c) => Number.isFinite(c.ts) && c.ts >= from && c.ts <= to).sort((a, z) => a.ts - z.ts)
  if (inside.length === 0) return { empty: true }
  let cost = 0, input = 0, read = 0, out = 0, carry = false
  for (const c of inside) {
    if (Number.isFinite(c.cost)) cost += c.cost
    if (c.tokens) {
      carry = true
      input += (c.tokens.in || 0) + (c.tokens.cache_read || 0) + (c.tokens.cache_write || 0)
      read += c.tokens.cache_read || 0
      out += c.tokens.out || 0
    }
  }
  const first = inside[0]!.ts
  const last = inside[inside.length - 1]!
  return {
    cost,
    burn: burnRate(inside),
    tokens: carry ? input : undefined,
    tokensOut: carry ? out : undefined,
    cache: carry && input > 0 ? (read / input) * 100 : undefined,
    turns: inside.length,
    timeMs: last.ts > first ? last.ts - first : undefined,
    last: last.cost,
  }
}

/**
 * Every session's figures over a range, from that range's
 * `/v1/stats/summary`: its totals, its savings' hit rate, and the projects'
 * sparks (24 hours, 7 or 30 days) summed bucket by bucket into the chart's
 * bars — no new query. No summary yet: dashes, never zeros; no spark in
 * it: no series.
 */
export function rangeFigures(summary: Summary | undefined): PeriodFigures {
  if (!summary) return {}
  const tokens = summary.tokens_in + summary.cache_read + summary.cache_write
  const sums: number[] = []
  // Input, turns and the active hours, summed alike (a session lives in one
  // project, so its hours are counted once); a row from an older daemon
  // without one leaves that series undefined for every bar.
  const extra = { input: [] as number[], turns: [] as number[], active_hours: [] as number[], active_cost: [] as number[] }
  const has = { input: true, turns: true, active_hours: true, active_cost: true }
  let grid: { from: number; width: number } | undefined
  for (const proj of summary.projects ?? []) {
    const sp = proj.spark
    if (!sp?.cost?.length) continue
    if (!grid && sp.width_ms > 0) grid = { from: sp.from_ms, width: sp.width_ms }
    sp.cost.forEach((v, i) => { sums[i] = (sums[i] ?? 0) + (Number.isFinite(v) ? v : 0) })
    for (const k of ['input', 'turns', 'active_hours', 'active_cost'] as const) {
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
          ...(has.active_hours && has.active_cost ? { activeHours: extra.active_hours[i] ?? 0, activeCost: extra.active_cost[i] ?? 0 } : {}),
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
    ...(summary.unpriced && summary.unpriced.turns > 0 ? { unpriced: summary.unpriced.turns, unpricedModels: summary.unpriced.models } : {}),
  }
}
