/**
 * Jarvis, pure (.ai/04-ui.md § Jarvis): the muted projects, what the screen
 * shows of a digest, and where a command line's `@project text` goes.
 *
 * Owner, 2026-11-15 (translated from Russian): "an orchestrator of the other
 * agents — not switching between projects, everything in one place, and from
 * there you can conveniently control it". V1 has no model: the daemon's
 * digest (GET /v1/jarvis) is deterministic, and so is everything here.
 */
import type { JarvisAgent, JarvisDigest, JarvisNeed } from './api'

/** The projects muted with a chip's ×, per browser. */
export const JARVIS_MUTED_KEY = 'caprock.jarvis.muted'

export function loadMuted(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(JARVIS_MUTED_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveMuted(muted: ReadonlySet<string>): void {
  try {
    if (muted.size === 0) localStorage.removeItem(JARVIS_MUTED_KEY)
    else localStorage.setItem(JARVIS_MUTED_KEY, JSON.stringify([...muted]))
  } catch {
    /* private window or blocked storage: muted for this visit only */
  }
}

/** What the screen draws: muted projects hidden everywhere, one project when a chip is picked. */
export function shownOf(d: JarvisDigest, muted: ReadonlySet<string>, only?: string): { needs: JarvisNeed[]; agents: JarvisAgent[] } {
  const keep = (project: string) => !muted.has(project) && (!only || project === only)
  return {
    // A task runner's approval belongs to no project (session_id and project
    // are ''): no chip picks or mutes it.
    needs: (d.needs_you ?? []).filter((n) => (n.kind === 'approval' && !n.session_id) || keep(n.project)),
    agents: (d.agents ?? []).filter((a) => keep(a.project)),
  }
}

/** A needs-you row's identity: one session can wait on one thing of each kind. */
export function needKey(n: JarvisNeed): string {
  return `${n.kind}:${n.session_id}:${n.approval_id ?? ''}`
}

/** The word a needs-you row leads with. */
export function needWord(kind: JarvisNeed['kind']): string {
  switch (kind) {
    case 'permission': return 'Permission'
    case 'question': return 'Question'
    case 'approval': return 'Approval'
    case 'loop': return 'Looping'
  }
}

/** A needs-you row older than this is drawn faded: still listed, never cut off (the digest has no age limit). */
export const OLD_NEED_MS = 12 * 3600_000

/** A turn stopped on an error, which the digest sends as a question ("Stopped: rate limit"). */
export function isStopped(n: JarvisNeed): boolean {
  return n.kind === 'question' && /^stopped\b/i.test(n.title)
}

/** Why a row offers only Open terminal (rule 7). */
export const NOT_OURS_TITLE = 'Caprock did not start this session, so it will not type into it. Answer it in its own terminal.'

/** The parsed command line. */
export type JarvisCommand =
  | { kind: 'hint'; text: string }
  | { kind: 'send'; project: string; text: string }

/**
 * `@project text`: the project is the longest known name the line starts
 * with (names may hold spaces), else the first word after the @.
 */
export function parseCommand(line: string, projects: readonly string[]): JarvisCommand {
  const t = line.trim()
  if (!t.startsWith('@')) return { kind: 'hint', text: 'Start with @project, then what to do' }
  const rest = t.slice(1)
  const lower = rest.toLowerCase()
  let project = ''
  for (const p of projects) {
    const pl = p.toLowerCase()
    if ((lower === pl || lower.startsWith(`${pl} `)) && p.length > project.length) project = p
  }
  if (!project) {
    const word = rest.split(/\s+/)[0] ?? ''
    if (!word) return { kind: 'hint', text: 'Name a project after the @' }
    return { kind: 'hint', text: `No project named ${word}` }
  }
  const text = rest.slice(project.length).trim()
  if (!text) return { kind: 'hint', text: `Say what ${project} should do` }
  return { kind: 'send', project, text }
}

/** The project names `@` offers while the first word is typed, best first. */
export function suggest(line: string, projects: readonly string[], limit = 6): string[] {
  const m = /^@(\S*)$/.exec(line.trimStart())
  if (!m) return []
  const q = m[1]!.toLowerCase()
  const starts = projects.filter((p) => p.toLowerCase().startsWith(q))
  const inside = projects.filter((p) => !p.toLowerCase().startsWith(q) && p.toLowerCase().includes(q))
  return [...starts, ...inside].slice(0, limit)
}

/** Where a command goes: the queue of a live agent Caprock started, or a new session in the project's folder. */
export type JarvisRoute =
  | { kind: 'queue'; agent: JarvisAgent; of: number; skipped: number }
  | { kind: 'spawn'; dir?: string; skipped: number }

/**
 * The project's live agent Caprock started, the most recently active one
 * when there are several (`of` says how many, for the toast). With none, a
 * new session; `skipped` counts the live ones it may not type into (rule 7).
 * The folder is any of its agents' (the digest carries no project folder).
 */
export function routeCommand(d: JarvisDigest, project: string): JarvisRoute {
  const mine = (d.agents ?? []).filter((a) => a.project === project)
  const ours = mine.filter((a) => a.controllable).sort((a, b) => b.last_activity_at - a.last_activity_at)
  const skipped = mine.length - ours.length
  if (ours[0]) return { kind: 'queue', agent: ours[0], of: ours.length, skipped }
  return { kind: 'spawn', dir: mine.find((a) => a.dir)?.dir, skipped }
}

/** The headline, in the order the owner reads it. */
export function headlineParts(h: JarvisDigest['headline']): { text: string; tone?: 'warn' | 'danger' }[] {
  const parts: { text: string; tone?: 'warn' | 'danger' }[] = [
    { text: `${h.working} working` },
    { text: `${h.waiting_you} waiting for you`, tone: h.waiting_you > 0 ? 'warn' : undefined },
  ]
  if (h.stuck > 0) parts.push({ text: `${h.stuck} stuck`, tone: 'danger' })
  parts.push({ text: `${h.sessions_today} ${h.sessions_today === 1 ? 'session' : 'sessions'} today` })
  return parts
}
