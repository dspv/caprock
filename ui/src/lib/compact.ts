/**
 * Compact context (ADR-085; .ai/04-ui.md § Agent cockpit, Context): when the
 * button is offered, what it says before the press, and what it says after.
 * Pure, so every rule is a unit test.
 *
 * The press types Claude Code's own `/compact` into a session Caprock
 * started (rule 7), through the message queue: at once at the prompt, else
 * when the turn ends. The session carries on in place. Free.
 */
import type { Compaction, CompactionEstimate, CompactionStats, CompactionView, SavingPoint, SessionSummary } from './api'
import { fmtAgo, fmtModel, fmtUSD } from './format'

/** Under this much context the action is hidden: there is little to gain. */
export const COMPACT_MIN_TOKENS = 100_000
/** From this fill the collapsed Context line carries the small icon. */
export const COMPACT_ICON_PCT = 60

/** What the typed command is, for a session the user types into themselves. */
export const COMPACT_COMMAND = '/compact'

/**
 * The measured reference shown until this machine has five measured
 * compactions of its own: the owner's machine, 2026-09-29 to 2026-10-25,
 * 70 automatic compactions, the first real main-thread turn after each
 * boundary against the boundary's preTokens (.ai/08-decisions.md ADR-085).
 * Always shown with its source, never as a promise.
 */
export const REFERENCE_KEPT = { count: 70, medianPct: 15, p90Pct: 25, from: '2026-09-29', to: '2026-10-25' } as const

/** How the cockpit offers compaction for a session: press it, type it, or nothing. */
export type CompactOffer = 'press' | 'type' | 'none'

function isClaude(s: Pick<SessionSummary, 'agent'>): boolean {
  return !s.agent || s.agent === 'claude'
}

/**
 * press: a live Claude Code session Caprock started, with enough context.
 * type: the same, but someone else's terminal holds it — Caprock never types
 * there; it shows the command and Continue here. none: anything else.
 */
export function compactOffer(s: Pick<SessionSummary, 'agent' | 'status' | 'owned' | 'detached' | 'context'>, canControl = true): CompactOffer {
  if (!isClaude(s) || s.status === 'ended' || !s.context || s.context.tokens < COMPACT_MIN_TOKENS) return 'none'
  if (s.owned && !s.detached) return canControl ? 'press' : 'none'
  return 'type'
}

/** Whether the collapsed line carries the icon: offered, and the context 60% full or more. */
export function compactIcon(s: Pick<SessionSummary, 'agent' | 'status' | 'owned' | 'detached' | 'context'>, canControl = true): boolean {
  return compactOffer(s, canControl) !== 'none' && (s.context?.pct ?? 0) >= COMPACT_ICON_PCT
}

function pct(share: number): number {
  return Math.round(share * 100)
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * What usually stays, with where the figure comes from — this machine's own
 * compactions from the fifth on, the labelled reference before.
 */
export function keptLine(typical: CompactionStats | undefined): { text: string; source: string } {
  if (typical && typical.count >= 5) {
    return {
      text: `~${pct(typical.median_kept)}% stays`,
      source: `median of ${typical.count} compactions measured here, ${day(typical.from)} – ${day(typical.to)}; 9 in 10 kept ${pct(typical.p90_kept)}% or less`,
    }
  }
  const r = REFERENCE_KEPT
  return {
    text: `~${r.medianPct}% stays`,
    source: `measured on one machine: ${r.count} automatic compactions, ${r.from} – ${r.to}; 9 in 10 kept ${r.p90Pct}% or less`,
  }
}

/** A press this page made: when, and whether it was typed or is waiting for the turn. */
export interface CompactPress {
  at: number
  sent: boolean
}

/** How long after a press the page keeps watching for its boundary. */
export const COMPACT_WATCH_MS = 10 * 60_000

/** What the action says now, from the daemon's view and the page's own press. */
export type CompactPhase =
  | { kind: 'idle' }
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'done'; last: Compaction }

export function compactPhase(view: CompactionView | undefined, press: CompactPress | undefined, now = Date.now()): CompactPhase {
  // A boundary at or after the press is the press's: the clocks are the same
  // machine's, with a second's slack for the transcript's own stamp.
  if (press && view?.last && view.last.at >= press.at - 1000) return { kind: 'done', last: view.last }
  if (view?.running) return { kind: 'running' }
  if (view?.queued) return { kind: 'queued' }
  if (press && now - press.at < COMPACT_WATCH_MS) return press.sent ? { kind: 'running' } : { kind: 'queued' }
  return { kind: 'idle' }
}

/** Tokens as the one line shows them: 442k, 19k, 1.2M, 950. */
export function tokShort(v: number): string {
  if (v >= 999_500) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (v >= 1_000) return `${Math.round(v / 1000)}k`
  return String(Math.round(v))
}

/** An estimated dollar figure: always with ≈ (rule 6). */
export function approxUSD(v: number): string {
  return `≈ ${fmtUSD(v)}`
}

/**
 * The one line under the button (V2, owner 2026-10-30): when, before → after,
 * and the compaction's estimated cost when the daemon has made it —
 * *32h ago · 442k → 19k · cost ≈ $0.09*. The after waits for the next reply on
 * an older Claude Code. The estimate is used only when it is this
 * compaction's.
 */
export function compactLine(c: Compaction, est: CompactionEstimate | undefined, now = Date.now()): string {
  const when = fmtAgo(c.at, now)
  const sizes = c.post_tokens && c.post_tokens > 0
    ? `${tokShort(c.pre_tokens)} → ${tokShort(c.post_tokens)}`
    : `from ${tokShort(c.pre_tokens)} · the after shows with the next reply`
  const cost = est && est.at === c.at && est.est_cost_usd !== undefined ? ` · cost ${approxUSD(est.est_cost_usd)}` : ''
  return `${when} · ${sizes}${cost}`
}

/** The saving to show under the line: only this compaction's, and once a call has followed it. */
export function savingOf(c: Compaction | undefined, est: CompactionEstimate | undefined): CompactionEstimate | undefined {
  return c && est && est.at === c.at && est.turns_after > 0 && est.series.length > 1 ? est : undefined
}

/**
 * The cumulative savings curve as an SVG path over a w×h box: a step at each
 * point, time on x from the boundary to the newest call, the saving on y from
 * 0 to its end. Empty for fewer than two points.
 */
export function savingsPath(series: readonly SavingPoint[], w: number, h: number): string {
  if (series.length < 2) return ''
  const t0 = series[0]!.at
  const span = Math.max(1, series[series.length - 1]!.at - t0)
  const top = Math.max(...series.map((p) => p.saved_usd))
  const y = (v: number) => (top > 0 ? h - 1 - (v / top) * (h - 2) : h - 1)
  const x = (at: number) => ((at - t0) / span) * w
  let d = `M0 ${y(series[0]!.saved_usd).toFixed(1)}`
  let prev = y(series[0]!.saved_usd)
  for (const p of series.slice(1)) {
    const px = x(p.at).toFixed(1)
    d += ` L${px} ${prev.toFixed(1)} L${px} ${y(p.saved_usd).toFixed(1)}`
    prev = y(p.saved_usd)
  }
  return d
}

/**
 * What the ⓘ says: what /compact is, what usually stays and from where, and
 * how the cost and the saving are estimated, with the assumptions named.
 */
export function compactInfo(kept: { text: string; source: string }, c: Compaction | undefined, est: CompactionEstimate | undefined): { lead: string; text: string }[] {
  const out = [
    { lead: COMPACT_COMMAND, text: 'Claude Code summarises the conversation; the session carries on here.' },
    { lead: kept.text, text: `${kept.source}.` },
  ]
  const mine = c && est && est.at === c.at ? est : undefined
  const model = mine?.model ? fmtModel(mine.model) : "the session's model"
  const summary = mine?.summary_tokens_est !== undefined ? `the summary (~${tokShort(mine.summary_tokens_est)} tokens) as output` : 'the summary as output when its length is known'
  out.push({
    lead: 'Cost ≈',
    text: `Claude Code records no usage for the summary call, so it is estimated: the context before, read from the cache when the last call was within the cache's life (5 minutes, or 1 hour when the session writes the long cache) and sent again in full when not, plus ${summary}, at ${model}'s list prices.${mine ? ` This one: cache ${mine.warm ? 'warm' : 'cold'}.` : ''}`,
  })
  const dropped = c?.post_tokens ? Math.max(0, c.pre_tokens - c.post_tokens) : 0
  out.push({
    lead: 'Saved ≈',
    text: mine && mine.turns_after > 0 && dropped > 0
      ? `Each of the ${mine.turns_after} calls since re-read ${tokShort(dropped)} fewer tokens, at its model's cache-read price. An estimate; not counted against the cost above.`
      : "Each call after it re-reads the dropped context no more, at its model's cache-read price. An estimate.",
  })
  return out
}
