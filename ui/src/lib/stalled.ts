/**
 * A session row's *no reply 2d* (.ai/04-ui.md § Sidebar, *Stalled*): a live
 * Claude Code session whose turn is open — the daemon's `turn_open`, a prompt
 * or a call with no Stop after it — and whose newest event, in any thread, is
 * older than STALL_MS. The chat says the same in its card (ChatStalled); the
 * list says it without loading the session's events, so a silently stuck
 * agent is seen without opening it (owner, 2026-11-22).
 */
import type { SessionSummary } from './api'
import { STALL_MS } from './chatActivity'
import { useNow } from './useNow'

/** The row's tooltip: what happened, and what to do. */
export const STALLED_TIP = 'Your last message got no reply. Open it to send again.'

/**
 * How long the session has gone without an event (ms), when its row says
 * stalled; null when it does not. Something waiting on you — a permission
 * prompt (`blocked`), a turn the daemon reads as waiting on you — is never
 * stalled, nor is a loop, which has its own red mark.
 */
export function stalledAge(s: Pick<SessionSummary, 'turn_open' | 'status' | 'last_event_at' | 'activity'>, now: number, blocked = false): number | null {
  if (!s.turn_open || s.status === 'ended' || blocked) return null
  const h = s.activity?.health
  if (h === 'waiting-on-you' || h === 'looping') return null
  if (!s.last_event_at) return null
  const age = now - s.last_event_at
  return age >= STALL_MS ? age : null
}

/** An age as compactly as it reads: 25m, 2h, 12h, 2d. Whole units, rounded down. */
export function fmtAgeCompact(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** The row's words: *no reply 2d*. */
export function stalledWord(age: number): string {
  return `no reply ${fmtAgeCompact(age)}`
}

/**
 * stalledAge on a clock: a row whose turn is open checks every 30 seconds,
 * so it turns without a new read; any other reads the clock rarely, since
 * only a new list (which redraws it anyway) can open a turn.
 */
export function useStalledAge(s: SessionSummary | undefined, blocked = false): number | null {
  const now = useNow(s?.turn_open ? 30_000 : 10 * 60_000)
  return s ? stalledAge(s, now, blocked) : null
}
