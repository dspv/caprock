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
  /** Model turns, which colour the bar amber rather than green. */
  turns: number
  /** Tool calls in this minute. */
  tools: number
}

export interface Pulse {
  bars: Bar[]
  /** Most-repeated identical tool call inside the window, and what it was. */
  repeats: number
  repeatSample: string
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
  const bars: Bar[] = Array.from({ length: minutes }, () => ({ n: 0, turns: 0, tools: 0 }))
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
 * trackState is what the row says on the right. It never claims a session is
 * stuck: a high repeat count is reported as the count it is.
 */
export function trackState(p: Pulse): { kind: 'repeat' | 'working' | 'quiet'; label: string } {
  if (p.repeats >= REPEAT_FLOOR) return { kind: 'repeat', label: `×${p.repeats} same call` }
  const active = p.bars.filter((b) => b.n > 0).length
  if (active === 0) return { kind: 'quiet', label: 'quiet' }
  return { kind: 'working', label: 'working' }
}
