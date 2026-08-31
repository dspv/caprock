/**
 * The pulse model: a session's recent activity as one bar per minute.
 *
 * This is deliberately pure and separate from the canvas that draws it, because
 * the interesting part is not the rendering — it is deciding what a bar means.
 * A bar carries how much happened in that minute and what kind of work it was,
 * and nothing is invented: every count comes from events the daemon already
 * recorded.
 *
 * The repeat count is the one figure that needs care. It uses the same
 * signature the loop detector uses — same tool, same arguments — but it is
 * reported as a measurement rather than a verdict. Polling a file with repeated
 * Reads looks identical to being stuck, and only the person working knows which
 * it was. `Bash true` and its cousins are dropped outright: an agent calls them
 * as placeholders hundreds of times (665 of 31,490 Bash calls on the author's
 * machine) and they carry no intent at all.
 */
import type { Event } from './api'

/** One minute of one session. */
export interface Bar {
  /** Events in this minute — the bar's height. */
  n: number
  /** Model turns in this minute. */
  turns: number
  /** Tool calls in this minute. */
  tools: number
  /** USD spent in this minute — what the bar's colour encodes. */
  cost: number
}

export interface Pulse {
  bars: Bar[]
  /** Most-repeated identical tool call inside the window, and what it was. */
  repeats: number
  repeatSample: string
}

/** Events recorded inside the window — what makes a track worth a row.
 *  A track with none of these is an hour of flat hairline, which says only
 *  that the session exists. */
export function windowEvents(p: Pulse): number {
  return p.bars.reduce((n, b) => n + b.n, 0)
}

/** What this session spent inside the window. The row used to show the
 *  session's lifetime cost beside an hour of bars, so a long-running session
 *  read $4,053.39 next to a $101.85 day — two true numbers answering
 *  different questions, printed as if they answered the same one. */
export function windowCost(p: Pulse): number {
  return p.bars.reduce((sum, b) => sum + b.cost, 0)
}

/** Minutes of history a track shows. */
export const PULSE_MINUTES = 60

/** Repeats at or above this are worth surfacing at all. */
export const REPEAT_FLOOR = 8

/** The window the repeat count is measured over, in minutes. */
const REPEAT_WINDOW_MIN = 6

/** Fields that never carry intent — mirrors internal/loop's Signature. */
const SKIP_FIELDS = new Set(['description', 'timeout', 'run_in_background'])

/** Placeholder commands: repeated constantly, meaning nothing. */
const NOISE_COMMANDS = new Set(['true', ':', 'echo', 'pwd', 'clear'])

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

/**
 * signature identifies "the same call again". Returns null for events that
 * cannot loop meaningfully, so they never inflate the count.
 */
export function signature(ev: Event): { sig: string; label: string } | null {
  if (ev.kind !== 'tool.pre') return null
  const tool = typeof ev.tool === 'string' ? ev.tool : ''
  if (!tool) return null

  const payload = ev.payload as { tool_input?: Record<string, unknown> } | null | undefined
  const input = payload && typeof payload === 'object' ? payload.tool_input : undefined
  const fields = input && typeof input === 'object' ? input : {}

  const command = asString((fields as Record<string, unknown>).command).trim()
  if (tool === 'Bash' && NOISE_COMMANDS.has(command)) return null

  const parts: string[] = [tool]
  let label = tool
  for (const key of Object.keys(fields).sort()) {
    if (SKIP_FIELDS.has(key)) continue
    let value = asString((fields as Record<string, unknown>)[key])
    // Edit/Write bodies: a looping agent rewrites near-identical content, so a
    // prefix is enough and keeps the key short.
    if (key === 'content' || key === 'new_string' || key === 'old_string') value = value.slice(0, 200)
    parts.push(`${key}=${value}`)
    if (label === tool && (key === 'command' || key === 'file_path' || key === 'pattern')) {
      label = `${tool} ${value.slice(0, 48)}`
    }
  }
  return { sig: parts.join('|'), label }
}

function msOf(ev: Event): number {
  const t = Date.parse(ev.ts)
  return Number.isFinite(t) ? t : 0
}

/**
 * buildPulse turns raw events into the bars for one track, ending at `now`.
 * Events outside the window are ignored rather than clamped into the last bar,
 * which would draw a spike that never happened.
 */
export function buildPulse(events: Event[], now: number, minutes = PULSE_MINUTES): Pulse {
  const bars: Bar[] = Array.from({ length: minutes }, () => ({ n: 0, turns: 0, tools: 0, cost: 0 }))
  const start = now - minutes * 60_000

  // Repeat counting needs events in time order; the caller's order is not
  // guaranteed once live frames and a backfill are merged.
  const ordered = [...events].sort((a, b) => msOf(a) - msOf(b))

  const window: { at: number; sig: string; label: string }[] = []
  const seen = new Map<string, number>()
  let repeats = 0
  let repeatSample = ''

  for (const ev of ordered) {
    const at = msOf(ev)
    if (at <= 0) continue

    if (at >= start && at <= now) {
      const idx = Math.min(minutes - 1, Math.floor((at - start) / 60_000))
      const bar = bars[idx]
      if (bar) {
        bar.n++
        if (ev.kind === 'turn.assistant') bar.turns++
        else if (ev.kind === 'tool.pre' || ev.kind === 'tool.post') bar.tools++
        const c = typeof ev.cost_usd === 'number' && Number.isFinite(ev.cost_usd) ? ev.cost_usd : 0
        bar.cost += c
      }
    }

    const s = signature(ev)
    if (!s) continue
    window.push({ at, sig: s.sig, label: s.label })
    // Drop what has aged out, keeping the tally in step.
    while (window.length > 0) {
      const head = window[0]
      if (!head || at - head.at <= REPEAT_WINDOW_MIN * 60_000) break
      window.shift()
      const left = (seen.get(head.sig) ?? 1) - 1
      if (left <= 0) seen.delete(head.sig)
      else seen.set(head.sig, left)
    }
    const count = (seen.get(s.sig) ?? 0) + 1
    seen.set(s.sig, count)
    if (count > repeats) {
      repeats = count
      repeatSample = s.label
    }
  }

  return { bars, repeats, repeatSample }
}

/**
 * trackState is what the row says on the right.
 *
 * It defers to the daemon's own health for the session rather than inferring
 * one from the bars. The narrator already distinguishes waiting-on-you from
 * working — it reads the last event, including the agent.stop that means "your
 * turn" — and a track that says "working" while Claude is waiting for you to
 * type is worse than saying nothing. Bars describe the past hour; health
 * describes this moment, and they are different questions.
 *
 * The repeat count still wins when it is high, because it is the one thing the
 * bars know that health does not. It is never phrased as a verdict.
 */
export function trackState(
  p: Pulse,
  health?: string,
): { kind: 'repeat' | 'waiting' | 'working' | 'error' | 'quiet'; label: string } {
  if (p.repeats >= REPEAT_FLOOR) return { kind: 'repeat', label: `×${p.repeats} same call` }
  switch (health) {
    case 'waiting-on-you':
      return { kind: 'waiting', label: 'waiting on you' }
    case 'error':
      return { kind: 'error', label: 'error' }
    case 'looping':
      return { kind: 'repeat', label: 'looping' }
    case 'ended':
      return { kind: 'quiet', label: 'ended' }
    case 'idle':
      return { kind: 'quiet', label: 'idle' }
    case 'working':
      return { kind: 'working', label: 'working' }
  }
  const active = p.bars.filter((b) => b.n > 0).length
  if (active === 0) return { kind: 'quiet', label: 'quiet' }
  return { kind: 'working', label: 'working' }
}

/**
 * costTier decides a bar's colour. Colour used to encode "mostly model turns
 * vs mostly tool calls", which sounded meaningful and was not: the ratio sits
 * near 1:2 almost every minute, so adjacent near-identical minutes came out
 * different colours and the legend explained a distinction nobody could see.
 *
 * Cost per minute does vary — eight-fold across one hour on a real session —
 * and it is the thing worth noticing. Three tiers, because a continuous
 * gradient reads as noise at this size.
 */
export function costTier(cost: number, median: number): 'low' | 'mid' | 'high' {
  if (median <= 0) return 'mid'
  if (cost >= median * 1.8) return 'high'
  if (cost <= median * 0.5) return 'low'
  return 'mid'
}

/** medianCost of the minutes that cost anything, for scaling the tiers. */
export function medianCost(bars: Bar[]): number {
  const spent = bars.filter((b) => b.cost > 0).map((b) => b.cost).sort((a, b) => a - b)
  if (spent.length === 0) return 0
  return spent[Math.floor(spent.length / 2)] ?? 0
}
