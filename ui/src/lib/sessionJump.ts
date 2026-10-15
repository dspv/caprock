/**
 * What a live session's row on Home offers in the desktop app (Pulse.tsx
 * LiveSession; .ai/04-ui.md § Live pulse). The owner (2026-10-15,
 * translated): "From here I want to drop into the session itself — the same
 * running one — with one button", and "if a process is idle, let me close it
 * with one small button".
 *
 * - **A tab already shows it** (a terminal Caprock holds, or a read-only tab
 *   opened earlier): the row brings that tab forward, as its ⌘N does.
 * - **Caprock started it and holds its terminal**, no tab yet: the row opens
 *   its tab.
 * - **Started in the user's own terminal** (or Caprock's, with its terminal
 *   gone): there is nothing to go into — Caprock never types into or signals
 *   a process it did not start (rule 7). The row says so and offers what is
 *   safe: the session's page, and *Continue in Caprock*, a second process on
 *   a copy of the conversation (`--resume --fork-session`), which leaves the
 *   original alone.
 *
 * *End* is offered only for a session Caprock started that sits at its
 * prompt: never while it works, waits on a permission dialog or has
 * subagents running, and never for one another terminal started (ADR-059's
 * doctor stop is for abandoned processes the doctor lists, which a live
 * session at a terminal never is).
 */
import type { SessionSummary } from './api'

export type SessionJump =
  /** A tab shows it: `digit` is its ⌘N, null past ⌘9's reach. */
  | { kind: 'tab'; digit: number | null; typeable: boolean }
  /** Caprock's own, with a terminal, no tab yet: opening one. */
  | { kind: 'open' }
  /** Nothing to go into: another terminal's, or Caprock's without its terminal. */
  | { kind: 'away'; why: 'terminal' | 'detached' }

type Row = Pick<SessionSummary, 'status' | 'owned' | 'detached'>

/** Whether Caprock holds a terminal it may type into (the same test as ObservePane's `attachable`). */
export function typeable(s: Row): boolean {
  return s.owned && s.status !== 'ended' && !s.detached
}

/** What the row does, given the ⌘N of a tab showing the session (`undefined`: no tab). */
export function sessionJump(s: Row, tabDigit: number | null | undefined): SessionJump {
  if (tabDigit !== undefined) return { kind: 'tab', digit: tabDigit, typeable: typeable(s) }
  if (typeable(s)) return { kind: 'open' }
  return { kind: 'away', why: s.owned && s.detached ? 'detached' : 'terminal' }
}

/** What the narrator says of a session at its prompt after a turn (internal/narrate). */
const AT_PROMPT = 'waiting for you'

/**
 * Whether a session is idle at its prompt: not working, not showing a
 * permission dialog or a question, no subagents still running.
 */
export function atPrompt(s: Pick<SessionSummary, 'status' | 'activity' | 'live_subagents'>): boolean {
  if (s.status === 'ended') return false
  if ((s.live_subagents ?? 0) > 0 || (s.activity?.background ?? 0) > 0) return false
  const h = s.activity?.health ?? 'idle'
  if (h === 'idle') return true
  return h === 'waiting-on-you' && !s.activity?.tool && s.activity?.phrase === AT_PROMPT
}

/** Whether the row offers *End*: Caprock started it, and it sits at its prompt. */
export function endable(s: Pick<SessionSummary, 'status' | 'owned' | 'activity' | 'live_subagents'>): boolean {
  return s.owned && atPrompt(s)
}
