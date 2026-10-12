/**
 * The spend scrubber's model (.ai/04-ui.md § Inspector, the cockpit's spend
 * spark): the session's priced model calls as bars, which call is under the
 * pointer, how thousands of calls fold into the width there is, and what the
 * readout says about that one call. Bars fold; the cursor never does.
 *
 * Kept apart from the component that paints it so the arithmetic is tested.
 * Nothing here is estimated: a field the data does not carry is left out of
 * the readout, never written as a zero.
 */
import type { Event, SessionCall, TokenDelta } from './api'
import { mainThread, toolDetail } from './cockpit'
import { fmtAgo, fmtTokens, fmtUSD } from './format'

/** One priced model call, as the scrubber reads it. */
export interface CallPoint {
  id: number
  /** Unix ms. */
  ts: number
  cost: number
  model?: string
  tokens?: TokenDelta
  /** The tool calls it asked for (the first few), when the agent records the link. */
  tools?: { tool: string; detail?: string }[]
  /** How many it asked for, which `tools` may hold fewer of. */
  toolCount?: number
}

/** A run of consecutive calls drawn as one bar: `from` inclusive, `to` exclusive. */
export interface Bucket {
  from: number
  to: number
}

/** Each bar is this many pixels wide with its gap; fewer slots than calls folds them. */
export const SLOT_PX = 3

/** The daemon's series (`/v1/sessions/{id}/calls`) as points. */
export function callsFromSeries(list: readonly SessionCall[]): CallPoint[] {
  return list.map((c) => ({
    id: c.id, ts: c.ts, cost: c.cost_usd,
    model: c.model_display || c.model || undefined,
    tokens: c.tokens,
    tools: c.tools?.length ? c.tools.map((t) => ({ tool: t.tool, detail: t.detail || undefined })) : undefined,
    toolCount: c.tool_count || undefined,
  }))
}

/**
 * The priced calls among the events the cockpit already holds, each joined to
 * the tool calls of the same message (`message_id` in both payloads). What
 * the scrubber shows before the full series arrives, and the calls made since.
 */
export function callsFromEvents(events: readonly Event[]): CallPoint[] {
  const toolsByMsg = new Map<string, { tool: string; detail?: string }[]>()
  for (const e of events) {
    if (e.kind !== 'tool.pre' || !mainThread(e)) continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    const msg = typeof p.message_id === 'string' ? p.message_id : ''
    const tool = e.tool || (typeof p.tool_name === 'string' ? p.tool_name : '')
    if (!msg || !tool) continue
    const detail = toolDetail(tool, p.tool_input)
    toolsByMsg.set(msg, [...(toolsByMsg.get(msg) ?? []), detail ? { tool, detail } : { tool }])
  }
  const seen = new Set<number>()
  const out: CallPoint[] = []
  for (const e of events) {
    if (e.kind !== 'turn.assistant' || !mainThread(e) || typeof e.cost_usd !== 'number' || !Number.isFinite(e.cost_usd) || seen.has(e.id)) continue
    seen.add(e.id)
    const p = (e.payload ?? {}) as Record<string, unknown>
    const tools = typeof p.message_id === 'string' && p.message_id ? toolsByMsg.get(p.message_id) : undefined
    const ts = Date.parse(e.ts)
    out.push({
      id: e.id, ts: Number.isFinite(ts) ? ts : 0, cost: e.cost_usd,
      model: e.model || undefined, tokens: e.tokens,
      tools: tools?.length ? tools : undefined, toolCount: tools?.length || undefined,
    })
  }
  return out
}

/** The full series plus any held call it does not have yet, oldest first. The series' own entry wins. */
export function mergeCalls(series: readonly CallPoint[], held: readonly CallPoint[]): CallPoint[] {
  if (held.length === 0) return [...series]
  const ids = new Set(series.map((c) => c.id))
  const extra = held.filter((c) => !ids.has(c.id))
  if (extra.length === 0) return [...series]
  return [...series, ...extra].sort((a, b) => a.ts - b.ts || a.id - b.id)
}

/** How many bars fit across `width` pixels: never fewer than one. */
export function slotsFor(width: number): number {
  return Math.max(1, Math.floor(width / SLOT_PX))
}

/**
 * The bars for `n` calls in `slots` slots: one per call while they fit,
 * otherwise contiguous runs whose sizes differ by at most one, oldest first.
 */
export function bucketize(n: number, slots: number): Bucket[] {
  if (n <= 0) return []
  const k = Math.max(1, Math.min(n, Math.floor(slots)))
  const out: Bucket[] = []
  for (let i = 0; i < k; i++) out.push({ from: Math.floor((i * n) / k), to: Math.floor(((i + 1) * n) / k) })
  return out
}

/**
 * The call under `x` pixels from the left of a chart `width` wide holding
 * `n` calls, clamped to the ends: always one exact call, however many calls
 * a bar draws. -1 when there are none; the newest when the width is unknown.
 */
export function callAt(x: number, width: number, n: number): number {
  if (n <= 0) return -1
  if (!(width > 0) || !Number.isFinite(x)) return n - 1
  return Math.max(0, Math.min(n - 1, Math.floor((x / width) * n)))
}

/** The bar that draws call `i`: the last bucket starting at or before it. */
export function bucketOf(buckets: readonly Bucket[], i: number): number {
  let lo = 0, hi = buckets.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((buckets[mid]?.from ?? Infinity) <= i) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Where the cursor line for call `i` of `n` sits across `width`: the middle of the call's own share of the width, inside its bar. */
export function cursorX(i: number, n: number, width: number): number {
  return n > 0 ? ((i + 0.5) / n) * width : 0
}

/** What a bar draws: one call's cost, or the sum of its run. */
export function bucketCost(calls: readonly CallPoint[], b: Bucket): number {
  let sum = 0
  for (let i = b.from; i < b.to; i++) sum += calls[i]?.cost ?? 0
  return sum
}

/** The readout's lines; any of the optional ones is absent when the data does not say. */
export interface Readout {
  /** "Call 412 of 640". */
  title: string
  /** "$0.08". */
  cost: string
  /** "14:32:05 · 3m ago". */
  when?: string
  model?: string
  /** "in 3 · cache read 120k · cache write 2.1k · out 400". */
  tokens?: string
  /** "Bash go test ./... · Read main.go". */
  did?: string
}

const n0 = new Intl.NumberFormat('en-US')

/** 14:32:05 in the viewer's own time. */
export function clock(ms: number): string {
  const d = new Date(ms)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function tokensLine(t: TokenDelta | undefined): string | undefined {
  if (!t) return undefined
  const parts = [`in ${fmtTokens(t.in)}`]
  if (t.cache_read > 0) parts.push(`cache read ${fmtTokens(t.cache_read)}`)
  if (t.cache_write > 0) parts.push(`cache write ${fmtTokens(t.cache_write)}`)
  parts.push(`out ${fmtTokens(t.out)}`)
  return parts.join(' · ')
}

function didLine(c: CallPoint): string | undefined {
  if (!c.tools?.length) return undefined
  const shown = c.tools.map((t) => (t.detail ? `${t.tool} ${t.detail}` : t.tool)).join(' · ')
  const more = (c.toolCount ?? c.tools.length) - c.tools.length
  return more > 0 ? `${shown} · +${more} more` : shown
}

/** What the readout says about call `i` of `calls`: always one call, never a run. */
export function readout(calls: readonly CallPoint[], i: number, now: number): Readout | undefined {
  const c = calls[i]
  if (!c) return undefined
  const r: Readout = { title: `Call ${n0.format(i + 1)} of ${n0.format(calls.length)}`, cost: fmtUSD(c.cost) }
  if (c.ts > 0) r.when = `${clock(c.ts)} · ${fmtAgo(c.ts, now)}`
  if (c.model) r.model = c.model
  const tk = tokensLine(c.tokens)
  if (tk) r.tokens = tk
  const did = didLine(c)
  if (did) r.did = did
  return r
}

/** The bar widths a session's spend is drawn in, by time: the smallest that keeps it to MAX_TIME_BARS. */
const STEPS_MIN = [5, 10, 30, 60, 180, 360, 1440]
export const MAX_TIME_BARS = 48

/** One stretch of wall-clock time and what was spent in it. */
export interface TimeBar {
  /** Unix ms, inclusive. */
  start: number
  end: number
  cost: number
  calls: number
  /** Tool name → how many calls asked for it, from the calls that say. */
  tools: Map<string, number>
}

/**
 * The session's calls by time rather than one bar a call (owner, 2026-10-11:
 * the per-call view was "not informative and not convenient"). Bars follow
 * the clock, so an idle stretch is an empty bar, and the step grows with the
 * session: 5 minutes for a short one up to a day for a long one. Steps of an
 * hour and up start on the local hour.
 */
export function timeBars(calls: readonly CallPoint[]): { step: number; bars: TimeBar[] } {
  const timed = calls.filter((c) => c.ts > 0)
  if (timed.length === 0) return { step: 0, bars: [] }
  const first = Math.min(...timed.map((c) => c.ts))
  const last = Math.max(...timed.map((c) => c.ts))
  const span = Math.max(1, last - first)
  const stepMin = STEPS_MIN.find((m) => Math.ceil(span / (m * 60_000)) + 1 <= MAX_TIME_BARS) ?? STEPS_MIN[STEPS_MIN.length - 1]!
  const step = stepMin * 60_000
  const offset = new Date(first).getTimezoneOffset() * 60_000
  const start0 = Math.floor((first - offset) / step) * step + offset
  const n = Math.floor((last - start0) / step) + 1
  const bars: TimeBar[] = Array.from({ length: n }, (_, i) => ({ start: start0 + i * step, end: start0 + (i + 1) * step, cost: 0, calls: 0, tools: new Map() }))
  for (const c of timed) {
    const b = bars[Math.min(n - 1, Math.floor((c.ts - start0) / step))]!
    b.cost += c.cost
    b.calls++
    for (const t of c.tools ?? []) b.tools.set(t.tool, (b.tools.get(t.tool) ?? 0) + 1)
  }
  return { step, bars }
}

/** "Today 14:00–15:00", "Fri 22:00–Sat 01:00", "Mon 6 Oct" for a day. */
export function barLabel(b: Pick<TimeBar, 'start' | 'end'>, step: number, now: number): string {
  const d = new Date(b.start)
  const e = new Date(b.end)
  const p = (v: number) => String(v).padStart(2, '0')
  const hm = (x: Date) => `${p(x.getHours())}:${p(x.getMinutes())}`
  const day = (x: Date) => {
    const t = new Date(now)
    const same = (a: Date, z: Date) => a.toDateString() === z.toDateString()
    if (same(x, t)) return 'Today'
    const y = new Date(now - 86_400_000)
    if (same(x, y)) return 'Yesterday'
    return x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  }
  if (step >= 86_400_000) return day(d)
  return d.toDateString() === e.toDateString() || (e.getHours() === 0 && e.getMinutes() === 0)
    ? `${day(d)} ${hm(d)}–${hm(e)}`
    : `${day(d)} ${hm(d)}–${day(e)} ${hm(e)}`
}

/** "Bash 40 · Edit 22 · Read 10": the tools a bar's calls asked for most. */
export function topTools(b: TimeBar, n = 3): string {
  return [...b.tools.entries()].sort((a, z) => z[1] - a[1]).slice(0, n).map(([t, k]) => `${t} ${k}`).join(' · ')
}

/** "10 min", "1 h", "1 day": a step in words. */
export function stepText(step: number): string {
  const m = step / 60_000
  if (m < 60) return `${m} min`
  if (m < 1440) return `${m / 60} h`
  return '1 day'
}
