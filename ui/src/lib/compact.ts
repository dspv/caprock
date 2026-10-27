/**
 * Compact context (ADR-085; .ai/04-ui.md § Agent cockpit, Context): when the
 * button is offered, what it says before the press, and what it says after.
 * Pure, so every rule is a unit test.
 *
 * The press types Claude Code's own `/compact` into a session Caprock
 * started (rule 7), through the message queue: at once at the prompt, else
 * when the turn ends. The session carries on in place. Free.
 */
import type { Compaction, CompactionStats, CompactionView, SessionSummary } from './api'
import { fmtAgo, fmtTokens } from './format'

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
      text: `Usually ~${pct(typical.median_kept)}% stays`,
      source: `median of ${typical.count} compactions measured here, ${day(typical.from)} – ${day(typical.to)}; 9 in 10 kept ${pct(typical.p90_kept)}% or less`,
    }
  }
  const r = REFERENCE_KEPT
  return {
    text: `Usually ~${r.medianPct}% stays`,
    source: `measured on one machine: ${r.count} automatic compactions, ${r.from} – ${r.to}; 9 in 10 kept ${r.p90Pct}% or less`,
  }
}

/** The measured before → after of a compaction; the after waits for the next reply. */
export function resultLine(c: Compaction, now = Date.now(), justPressed = false): string {
  const head = justPressed ? 'Compacted' : `${c.trigger === 'auto' ? 'Auto-compacted' : 'Compacted'} ${fmtAgo(c.at, now)}`
  if (c.post_tokens && c.post_tokens > 0) return `${head}: ${fmtTokens(c.pre_tokens)} → ${fmtTokens(c.post_tokens)} tokens`
  return `${head} from ${fmtTokens(c.pre_tokens)} tokens · the size after shows with the next reply`
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
