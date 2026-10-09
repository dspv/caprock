/**
 * The spend scrubber's model (.ai/04-ui.md § Inspector, the cockpit's spend
 * spark): the session's priced model calls as bars, which bar is under the
 * pointer, how thousands of calls fold into the width there is, and what the
 * readout says about the call — or the run of calls — under the cursor.
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

/** The bar under `x` pixels from the left of a chart `width` wide with `bars` bars, clamped to the ends. */
export function barAt(x: number, width: number, bars: number): number {
  if (bars <= 0) return -1
  if (!(width > 0) || !Number.isFinite(x)) return bars - 1
  return Math.max(0, Math.min(bars - 1, Math.floor((x / width) * bars)))
}

/** What a bar stands for: one call's cost, or the sum of its run. */
export function bucketCost(calls: readonly CallPoint[], b: Bucket): number {
  let sum = 0
  for (let i = b.from; i < b.to; i++) sum += calls[i]?.cost ?? 0
  return sum
}

/** The readout's lines; any of the optional ones is absent when the data does not say. */
export interface Readout {
  /** "Call 12 of 340" or "Calls 1,201–1,240 of 3,000". */
  title: string
  /** "$0.08", or "$1.23 total" for a run. */
  cost: string
  /** "14:32:05 · 3m ago", or the run's first and last times. */
  when?: string
  model?: string
  /** "in 3 · cache read 120k · cache write 2.1k · out 400". */
  tokens?: string
  /** "Bash go test ./... · Read main.go"; one call's only. */
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

/** What the readout says about bar `b` of `calls`. */
export function readout(calls: readonly CallPoint[], b: Bucket, now: number): Readout | undefined {
  const total = n0.format(calls.length)
  const c = calls[b.from]
  if (!c) return undefined
  if (b.to - b.from <= 1) {
    const r: Readout = { title: `Call ${n0.format(b.from + 1)} of ${total}`, cost: fmtUSD(c.cost) }
    if (c.ts > 0) r.when = `${clock(c.ts)} · ${fmtAgo(c.ts, now)}`
    if (c.model) r.model = c.model
    const tk = tokensLine(c.tokens)
    if (tk) r.tokens = tk
    const did = didLine(c)
    if (did) r.did = did
    return r
  }
  const run = calls.slice(b.from, b.to)
  const lastCall = run[run.length - 1] ?? c
  const r: Readout = {
    title: `Calls ${n0.format(b.from + 1)}–${n0.format(b.to)} of ${total}`,
    cost: `${fmtUSD(bucketCost(calls, b))} total`,
  }
  const first = c.ts, last = lastCall.ts
  if (first > 0 && last > 0) r.when = `${clock(first)}–${clock(last)} · ${fmtAgo(last, now)}`
  const models = new Set(run.map((c) => c.model).filter(Boolean))
  if (models.size === 1 && run.every((c) => c.model)) r.model = [...models][0]
  else if (models.size > 1) r.model = `${models.size} models`
  // Token sums only when every call in the run reports them: a partial sum would read as the whole.
  if (run.every((c) => c.tokens)) {
    const sum: TokenDelta = { in: 0, out: 0, cache_read: 0, cache_write: 0 }
    for (const c of run) {
      const t = c.tokens as TokenDelta
      sum.in += t.in; sum.out += t.out; sum.cache_read += t.cache_read; sum.cache_write += t.cache_write
    }
    r.tokens = tokensLine(sum)
  }
  // No tool line for a run: a call without a recorded link reads the same as
  // one that asked for nothing, so a count over the run could only undercount.
  return r
}
