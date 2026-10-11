/**
 * The Queue view's arithmetic and words (GET /v1/queue, .ai/03-contracts.md
 * § Queue). Every estimate is a range and says what it is made of: measured
 * on the owner's own history (2026-10-12), the median of past turns missed a
 * turn's length by about as much as the typical turn lasts, so a single time
 * would claim a precision the data does not have (rule 6, RISK-08).
 */
import type { BoardSession, ETA, TurnEstimate } from './api'
import type { Frame as LiveFrame } from './live'

/** "48 s", "3 min", "1 h 20 min". */
export function fmtSpan(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** A range as words: "2–9 min", "under a minute", "1–2 h". Lo rounds down, hi up. */
export function fmtRange(lo: number, hi: number): string {
  lo = Math.max(0, lo)
  hi = Math.max(lo, hi)
  if (hi < 60_000) return 'under a minute'
  const loM = Math.floor(lo / 60_000)
  const hiM = Math.ceil(hi / 60_000)
  if (hiM <= 90) return loM === hiM ? `~${hiM} min` : `${loM}–${hiM} min`
  const loH = Math.floor(lo / 3_600_000)
  const hiH = Math.ceil(hi / 3_600_000)
  return loH === hiH ? `~${hiH} h` : `${loH}–${hiH} h`
}

/** An ETA, less what has passed since the board was read, as a range. */
export function etaRange(e: ETA, passed: number): string {
  return fmtRange(e.lo_ms - passed, e.hi_ms - passed)
}

/** "starts in 2–9 min · done in 4–14 min"; "starts when this turn ends" for the first. */
export function itemEta(start: ETA | undefined, finish: ETA | undefined, passed: number): string {
  if (!start || !finish) return ''
  const s = start.hi_ms - passed <= 0 ? 'starts any moment' : `starts in ${etaRange(start, passed)}`
  return `${s} · done in ${etaRange(finish, passed)}`
}

/** When a session could take a new message: "free now", "free in under a minute", "free in about 2–9 min". */
export function freeLabel(e: ETA): string {
  if (e.hi_ms <= 0) return 'free now'
  const r = fmtRange(e.lo_ms, e.hi_ms)
  return r.startsWith('under') ? `free in ${r}` : `free in about ${r}`
}

/** What every estimate on the screen is made of. */
export function basisLabel(e: TurnEstimate, project?: string): string {
  const where = project ? ` in ${project}` : ' in this project'
  return `rough estimate: middle half of the last ${e.turns} turns${where} (${fmtSpan(e.p25_ms)}–${fmtSpan(e.p75_ms)}, typical ${fmtSpan(e.median_ms)})`
}

export function ordinal(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/** Where a queued message stands: "next, after the current turn", "2nd after the current turn". */
export function positionLabel(position: number, working: boolean): string {
  if (!working) return position === 1 ? 'next' : `${ordinal(position)} in line`
  return position === 1 ? 'next, after the current turn' : `${ordinal(position)} after the current turn`
}

/** A session's name in the picker and the rows. */
export function sessionName(s: Pick<BoardSession, 'title' | 'project' | 'session_id' | 'agent'>): string {
  // Untitled sessions of one project would read alike: the id tells them apart.
  const base = s.title || (s.project ? `${s.project} · ${s.session_id.slice(0, 8)}` : s.session_id.slice(0, 8))
  return s.agent && s.agent !== 'claude' ? `${base} · ${s.agent}` : base
}

/** What a session is doing, in a word or three. */
export function stateLabel(s: BoardSession): string {
  switch (s.waiting) {
    case 'turn': return 'working'
    case 'permission': return 'waiting for your approval'
    case 'question': return 'asked you a question'
    default: return s.queue.length > 0 ? 'stopped with messages left' : 'at its prompt'
  }
}

/** The projects the sessions are in, by directory, labelled by name: [dir, label]. */
export function projectsOf(sessions: readonly BoardSession[]): [string, string][] {
  const out = new Map<string, string>()
  for (const s of sessions) {
    const dir = s.dir ?? ''
    if (!out.has(dir)) out.set(dir, s.project || dir.split(/[\\/]/).filter(Boolean).pop() || dir || 'no folder')
  }
  return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1]))
}

/**
 * "Whichever is free first" in a project: the session whose next message
 * would start soonest by its estimate. Only Claude Code sessions have one
 * (the one agent whose turn end Caprock hears); without any estimate, a
 * session at its prompt with nothing queued, then the shortest queue.
 * Sessions waiting on a prompt or question are never picked.
 */
export function pickFree(sessions: readonly BoardSession[], dir: string): BoardSession | undefined {
  const pool = sessions.filter((s) => (s.dir ?? '') === dir && s.waiting !== 'permission' && s.waiting !== 'question')
  const timed = pool.filter((s) => s.free_in).sort((a, b) => a.free_in!.mid_ms - b.free_in!.mid_ms || a.queue.length - b.queue.length)
  if (timed.length > 0) return timed[0]
  const claude = pool.filter((s) => s.agent === 'claude')
  const idle = claude.find((s) => s.waiting === '' && s.queue.length === 0)
  if (idle) return idle
  return [...claude].sort((a, b) => a.queue.length - b.queue.length)[0]
}

const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan'])
const TURN_KINDS = new Set(['turn.user', 'agent.stop', 'throttle', 'agent.spawn', 'session.end', 'permission.prompt'])

/** Whether a live frame can change the board: its queues, a turn's start or end, a task list, a prompt. */
export function changesBoard(f: LiveFrame): boolean {
  switch (f.type) {
    case 'queue':
    case 'permission':
    case 'reset':
      return true
    case 'session':
      // A session that ended leaves the board; any other session frame is
      // its stats moving, every event.
      return f.data.session.status === 'ended'
    case 'event':
      return TURN_KINDS.has(f.data.kind) || (f.data.kind === 'tool.pre' && TODO_TOOLS.has(f.data.tool ?? ''))
    default:
      return false
  }
}
