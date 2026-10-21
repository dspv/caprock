/**
 * Needs you and Done (.ai/04-ui.md § Needs you and Done): a session whose
 * turn ended either wants something from its owner — a permission, a
 * question, a plan to approve, a failed turn, or a last message that asks
 * something — or is done and asks nothing. The daemon decides
 * (internal/narrate need.go); these are the words and the sorting every
 * screen shares, so Home, the sidebar, the tray and the phone never disagree.
 */
import type { Need, SessionSummary } from './api'

type S = Pick<SessionSummary, 'status' | 'activity'>

/** A live session that needs you: a dialog, a failed turn, or a turn that ended asking something. */
export function needsYou(s: S): boolean {
  return s.status !== 'ended' && s.activity?.health === 'waiting-on-you'
}

/** A live session whose turn ended asking nothing. */
export function isDone(s: S): boolean {
  return s.status !== 'ended' && s.activity?.health === 'done'
}

/** The chip's words: "permission", "asks a question", "plan to approve", "stopped: rate limit", "done". */
export function needLabel(n: Need | undefined): string {
  if (!n) return ''
  switch (n.reason) {
    case 'permission': return 'permission'
    case 'question': return 'asks a question'
    case 'plan': return 'plan to approve'
    case 'error': return n.detail ? `stopped: ${n.detail}` : 'stopped: error'
    case 'asks': return n.moved ? 'you marked it' : n.detail === 'choice' ? 'asks a choice' : 'asks a question'
    case 'done': return n.moved ? 'marked done' : 'done'
  }
  return ''
}

/**
 * One word for a native menu, which has no styling: "permission", "question",
 * "plan", "error", and a guess with a trailing "?" ("question?").
 */
export function needWord(n: Need | undefined): string {
  if (!n) return ''
  switch (n.reason) {
    case 'permission': return 'permission'
    case 'question': return 'question'
    case 'plan': return 'plan'
    case 'error': return 'error'
    case 'asks': return n.guess ? 'question?' : 'question'
    case 'done': return 'done'
  }
  return ''
}

/** The chip's colour: red for a failed turn, faint for Done, amber for the rest. */
export function needTone(n: Need | undefined): 'warn' | 'danger' | 'faint' {
  if (n?.reason === 'error') return 'danger'
  if (n?.reason === 'done') return 'faint'
  return 'warn'
}

/** What a guess's chip says on hover. */
export const GUESS_HINT =
  'A guess. Caprock read the last message Claude wrote. Claude Code is not showing a dialog, so nothing is blocked; it is waiting for your next message. Wrong? Move it with "needs me?" / "not needed".'

/** When it started waiting, unix ms: the turn's end, else the newest event. */
export function waitingSince(s: Pick<SessionSummary, 'activity' | 'last_event_at'>): number {
  const t = s.activity?.at ? Date.parse(s.activity.at) : NaN
  return Number.isFinite(t) && t > 0 ? t : s.last_event_at || 0
}

/** Oldest first: the one that has waited longest has cost the most time. */
export function oldestFirst<T extends Pick<SessionSummary, 'activity' | 'last_event_at'>>(list: readonly T[]): T[] {
  return list.slice().sort((a, b) => waitingSince(a) - waitingSince(b))
}

/** The sentence a list of reasons makes: "a question, a plan, an error, a question (guess)". */
export function reasonsSentence(list: readonly Pick<SessionSummary, 'activity'>[]): string {
  return list.map((s) => {
    const n = s.activity?.need
    switch (n?.reason) {
      case 'permission': return 'a permission'
      case 'question': return 'a question'
      case 'plan': return 'a plan'
      case 'error': return 'an error'
      case 'asks': return n.guess ? 'a question (guess)' : 'a question'
    }
    return 'your turn'
  }).join(', ')
}
