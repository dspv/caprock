/**
 * Sessions Caprock ended for sitting idle with no tab (.ai/03-contracts.md §
 * Ending idle sessions; owner, 2026-10-21): an agent session Caprock started
 * that no tab shows, idle for the window chosen in Settings → New sessions
 * (*End idle chats after*, 12 h by default), has its process ended. Its row
 * says so in one line rather than vanishing, and a click continues it from
 * where it stopped (`--resume`, as ⇧⌘T does).
 *
 * The daemon cannot see tabs — they live in this browser — so the app tells
 * it which sessions it has a tab for (lib/reportTabs.ts). A session in any
 * viewer's list is never ended. Pure.
 */
import type { EndIdleAfter, SessionSummary } from './api'

/** Settings' choices, in its order. */
export const END_IDLE_OPTIONS: { value: EndIdleAfter; label: string }[] = [
  { value: '2h', label: '2 h' },
  { value: '12h', label: '12 h' },
  { value: '24h', label: '24 h' },
  { value: 'never', label: 'Never' },
]

/** How long an idle-ended session stays under Running, no tab after it was ended. */
export const IDLE_ENDED_LINGER_MS = 24 * 60 * 60 * 1000

/** Whether Caprock ended this session for sitting idle (and it has not been continued since). */
export function idleEnded(s: Pick<SessionSummary, 'status' | 'idle_ended_at'> | undefined): boolean {
  return !!s && s.status === 'ended' && (s.idle_ended_at ?? 0) > 0
}

/** "12 h" for the window that ended it; minutes under an hour. */
function windowText(ms: number): string {
  const h = ms / 3_600_000
  if (h >= 1) return `${Math.round(h)} h`
  return `${Math.max(1, Math.round(ms / 60_000))} min`
}

/** "Ended after 12 h idle", or '' for a session not ended for idling. */
export function idleEndedText(s: Pick<SessionSummary, 'status' | 'idle_ended_at' | 'idle_ended_after_ms'> | undefined): string {
  if (!idleEnded(s)) return ''
  const after = s!.idle_ended_after_ms ?? 0
  return after > 0 ? `Ended after ${windowText(after)} idle` : 'Ended while idle'
}

/**
 * The sidebar row's state word, where the title needs the room: "12 h idle ·
 * continue" (the row's tooltip carries the whole sentence); '' otherwise.
 */
export function idleEndedWord(s: Pick<SessionSummary, 'status' | 'idle_ended_at' | 'idle_ended_after_ms'> | undefined): string {
  if (!idleEnded(s)) return ''
  const after = s!.idle_ended_after_ms ?? 0
  return after > 0 ? `${windowText(after)} idle · continue` : 'idle · continue'
}

/** Whether an idle-ended session still shows under Running, no tab. */
export function idleEndedRecently(s: SessionSummary, now = Date.now()): boolean {
  return idleEnded(s) && now - (s.idle_ended_at ?? 0) < IDLE_ENDED_LINGER_MS
}
