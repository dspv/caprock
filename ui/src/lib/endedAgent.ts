/**
 * An agent session that ended and nobody asked it to (owner, 2026-11-20,
 * translated: a Claude Code session Caprock started died when he quit
 * Chrome, its tab silently became a shell, and the session was nowhere to
 * be found, not even in Recently closed).
 *
 * The daemon decides (agents.Unexpected, GET /v1/agents/{id}/exit
 * `unexpected`): a non-zero exit or a signal, not a Stop, a closed tab, a
 * freed session or a restart from Caprock, and not an exit at once (that one
 * has its own panel, components/EarlyExit.tsx). A clean `/exit` is the
 * user's own and says nothing.
 *
 * The tab that falls back to a shell keeps the session's name and shows one
 * line at its top (components/EndedNotice.tsx) with Resume and a ×; the
 * session goes on Recently closed with *ended unexpectedly*. What the line
 * says is kept on the shell's tab target (`TabTarget.ended`), so it
 * survives a reload and a restart of the background service.
 */
import type { AgentExit } from './api'

export interface EndedAgent {
  /** The agent session that ended; Resume continues it under this id. */
  sessionId: string
  /** Its name or title when it ended: the tab keeps it. */
  title: string
  /** Its exit code; -1 when a signal killed it. */
  code: number
  /** When it ended, unix ms. */
  at: number
  /** The folder it ran in, where Resume starts it. */
  cwd?: string
  /** The × was pressed: the line is gone, the tab keeps the name. */
  dismissed?: boolean
}

/** The report says nobody asked it to end. */
export function endedUnexpectedly(rep: AgentExit | null | undefined): boolean {
  return !!rep && rep.unexpected === true && !rep.early
}

/** Why it ended, in words: a signal (code -1, as the OS reports it) or the code. */
export function endCause(code: number): string {
  return code < 0 ? 'killed by a signal' : `exited with code ${code}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "19:58" today; "18 Nov 19:58" on another day. Local time. */
export function endedClock(at: number, now = Date.now()): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const n = new Date(now)
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return today ? hm : `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`
}

/** The notice's line: "ops ended unexpectedly at 19:58 (killed by a signal)". */
export function endedText(e: EndedAgent, now = Date.now()): string {
  return `${e.title || 'The session'} ended unexpectedly at ${endedClock(e.at, now)} (${endCause(e.code)})`
}

/** A stored value, checked: anything malformed is not trusted. */
export function validEnded(x: unknown): x is EndedAgent {
  const e = x as EndedAgent
  return !!e && typeof e === 'object' && typeof e.sessionId === 'string' && e.sessionId !== '' &&
    typeof e.title === 'string' && typeof e.code === 'number' && typeof e.at === 'number'
}
