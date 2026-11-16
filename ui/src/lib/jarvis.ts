/**
 * Jarvis, pure (.ai/04-ui.md § Jarvis): the muted projects, what the screen
 * shows of a digest, and where a command line's `@project text` goes.
 *
 * Owner, 2026-11-15 (translated from Russian): "an orchestrator of the other
 * agents — not switching between projects, everything in one place, and from
 * there you can conveniently control it". Everything here is deterministic:
 * what a model does (Jarvis V2's brain) happens on the daemon. V2 adds the
 * cards' options, Later and Dismiss, the chat's target and its words.
 */
import type { HandledItem, JarvisAgent, JarvisBrain, JarvisDigest, JarvisMessage, JarvisNeed, JarvisOption } from './api'

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

/** Agents by project, in first-seen order (the daemon's: waiting, stuck, working). */
export function byProject(agents: readonly JarvisAgent[]): [string, JarvisAgent[]][] {
  const m = new Map<string, JarvisAgent[]>()
  for (const a of agents) {
    const list = m.get(a.project)
    if (list) list.push(a)
    else m.set(a.project, [a])
  }
  return [...m]
}

/** The screen's first sentence: the state of things in plain words. */
export function summaryLine(needs: number, active: readonly JarvisAgent[], finished: number): string {
  const projects = [...new Set(active.map((a) => a.project))]
  const named = projects.length <= 3 ? projects.join(', ') : `${projects.slice(0, 3).join(', ')} and ${projects.length - 3} more`
  const work = active.length === 0 ? 'No agent is working right now'
    : `${active.length} ${active.length === 1 ? 'agent is' : 'agents are'} working, in ${named}`
  const you = needs === 0 ? 'nothing needs you' : `${needs} ${needs === 1 ? 'thing needs' : 'things need'} you`
  const rest = finished > 0 ? ` ${finished} finished and ${finished === 1 ? 'waits' : 'wait'} for a next task.` : ''
  return `${work}; ${you}.${rest}`
}

/* ── Jarvis V2: decision cards, Handled for you, the chat, the brain ── */

/** "(Recommended)" as Claude Code marks the option it suggests; stripped from what is shown. */
const RECOMMENDED = /\s*\(recommended\)\s*/i

/** An option's label as shown: without "(Recommended)". */
export function optionLabel(label: string): string {
  return label.replace(RECOMMENDED, ' ').replace(/\s+/g, ' ').trim()
}

/** An option to draw, with `index` its place in the agent's own list — what POST answer presses. */
export interface ShownOption {
  index: number
  label: string
  description?: string
  recommended: boolean
}

/**
 * The options in the order drawn: the recommended one first (starred), the
 * rest as the agent listed them. Only one is starred, the first so marked.
 */
export function shownOptions(options: readonly JarvisOption[] | undefined): ShownOption[] {
  const all = (options ?? []).map((o, index) => ({
    index,
    label: optionLabel(o.label),
    description: o.description,
    recommended: o.recommended || RECOMMENDED.test(o.label),
  }))
  const star = all.findIndex((o) => o.recommended)
  if (star < 0) return all
  return [all[star]!, ...all.filter((_, i) => i !== star).map((o) => ({ ...o, recommended: false }))]
}

/** Whether a tap answers this need here: a question Caprock can press, on a device that controls. */
export function tapAnswerable(n: JarvisNeed, canControl: boolean): boolean {
  return n.kind === 'question' && canControl && n.controllable && !!n.answerable
    && (n.options?.length ?? 0) > 0 && !((n.more_questions ?? 0) > 0)
}

/** Later and Dismiss, per browser. */
export const JARVIS_LATER_KEY = 'caprock.jarvis.later'
export const JARVIS_DISMISSED_KEY = 'caprock.jarvis.dismissed'
/** How long Later hides a card. */
export const LATER_MS = 3600_000

/**
 * What a need is now: Dismiss hides it until this changes — a new question
 * in the same session, or the same one asked again, comes back.
 */
export function needPrint(n: JarvisNeed): string {
  return `${needKey(n)}|${n.since}|${n.title}|${n.detail ?? ''}`
}

/** need key → unix ms it is hidden until. */
export type LaterMap = Record<string, number>
/** need key → the print it had when dismissed. */
export type DismissedMap = Record<string, string>

function readMap<T>(key: string, ok: (v: unknown) => v is T): Record<string, T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, T> = {}
    for (const [k, x] of Object.entries(v)) if (ok(x)) out[k] = x
    return out
  } catch {
    return {}
  }
}

function writeMap(key: string, m: Record<string, unknown>): void {
  try {
    if (Object.keys(m).length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(m))
  } catch {
    /* private window or blocked storage: hidden for this visit only */
  }
}

export const loadLater = (): LaterMap => readMap(JARVIS_LATER_KEY, (v): v is number => typeof v === 'number')
export const saveLater = (m: LaterMap): void => writeMap(JARVIS_LATER_KEY, m)
export const loadDismissed = (): DismissedMap => readMap(JARVIS_DISMISSED_KEY, (v): v is string => typeof v === 'string')
export const saveDismissed = (m: DismissedMap): void => writeMap(JARVIS_DISMISSED_KEY, m)

/** Whether Later or Dismiss hides a need now. */
export function isHidden(n: JarvisNeed, later: LaterMap, dismissed: DismissedMap, now: number): boolean {
  const k = needKey(n)
  return (later[k] ?? 0) > now || dismissed[k] === needPrint(n)
}

/** The maps without what no longer applies: an expired Later, a need gone or changed. */
export function pruneHidden(needs: readonly JarvisNeed[], later: LaterMap, dismissed: DismissedMap, now: number): { later: LaterMap; dismissed: DismissedMap } {
  const prints = new Map(needs.map((n) => [needKey(n), needPrint(n)]))
  const l: LaterMap = {}
  for (const [k, until] of Object.entries(later)) if (until > now && prints.has(k)) l[k] = until
  const d: DismissedMap = {}
  for (const [k, p] of Object.entries(dismissed)) if (prints.get(k) === p) d[k] = p
  return { later: l, dismissed: d }
}

/** Where a chat message goes, and why there. */
export interface JarvisTarget {
  project: string
  /** An @project in the text, the chip picked on top, or the project worked in last. */
  by: 'mention' | 'chip' | 'recent'
  /** The text without its leading @project. */
  text: string
}

/**
 * The chat's target: `@project` at the start of the text, else the project
 * chip picked, else the project with the most recent activity (muted ones
 * left out). Null when there is none: Jarvis then decides, or says it cannot.
 */
export function chatTarget(line: string, names: readonly string[], only: string, d: JarvisDigest, muted: ReadonlySet<string> = new Set()): JarvisTarget | null {
  const t = line.trim()
  if (t.startsWith('@')) {
    const lower = t.slice(1).toLowerCase()
    const named = [...names].sort((a, b) => b.length - a.length)
      .find((p) => lower === p.toLowerCase() || lower.startsWith(`${p.toLowerCase()} `))
    if (named) return { project: named, by: 'mention', text: t.slice(1 + named.length).trim() }
  }
  if (only) return { project: only, by: 'chip', text: t }
  const recent = [...(d.agents ?? [])]
    .filter((a) => a.project && !muted.has(a.project))
    .sort((a, b) => b.last_activity_at - a.last_activity_at)[0]
  return recent ? { project: recent.project, by: 'recent', text: t } : null
}

/** " I handled N things myself today." — the summary's last sentence; empty with none. */
export function handledLine(n: number | undefined): string {
  if (!n || n <= 0) return ''
  return ` I handled ${n} ${n === 1 ? 'thing' : 'things'} myself today.`
}

/** The brain's word in the top line, and its tone. */
export function brainWord(b: JarvisBrain | undefined): { text: string; tone: 'ok' | 'warn' | 'muted' } | null {
  if (!b) return null
  const who = b.agent === 'codex' ? 'Codex' : 'Claude'
  switch (b.state) {
    case 'ready': return { text: `${who} · ready`, tone: 'ok' }
    case 'signed-out': return { text: `${who} · signed out`, tone: 'warn' }
    case 'error': return { text: `${who} · not answering`, tone: 'warn' }
    case 'off': return { text: 'Brain off', tone: 'muted' }
    case 'unchosen': return { text: 'Brain: not set up', tone: 'muted' }
  }
}

/** "Not now" on the brain's first-use card, per browser: unix ms it stays hidden until. */
export const JARVIS_BRAIN_LATER_KEY = 'caprock.jarvis.brainLater'
export const BRAIN_LATER_MS = 7 * 24 * 3600_000

export function brainCardHidden(now: number): boolean {
  try {
    return Number(localStorage.getItem(JARVIS_BRAIN_LATER_KEY) ?? 0) > now
  } catch {
    return false
  }
}

export function hideBrainCard(now: number): void {
  try {
    localStorage.setItem(JARVIS_BRAIN_LATER_KEY, String(now + BRAIN_LATER_MS))
  } catch {
    /* blocked storage: hidden for this visit only (the screen keeps it in state) */
  }
}

/** A "Done: …" message: an agent Jarvis gave work to finished its turn. */
export function isDoneMessage(m: Pick<JarvisMessage, 'role' | 'text'>): boolean {
  return m.role === 'jarvis' && /^done:/i.test(m.text.trim())
}

/** The thread with messages added or replaced by id (a pending one settling, a live frame repeating a reply), oldest first. */
export function mergeMessages(list: readonly JarvisMessage[], add: readonly JarvisMessage[]): JarvisMessage[] {
  const byId = new Map(list.map((m) => [m.id, m]))
  for (const m of add) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id - b.id)
}

/** Handled items, newest first, without repeats. */
export function mergeHandled(list: readonly HandledItem[], add: readonly HandledItem[]): HandledItem[] {
  const byId = new Map(list.map((h) => [h.id, h]))
  for (const h of add) byId.set(h.id, h)
  return [...byId.values()].sort((a, b) => b.at - a.at || b.id - a.id)
}

/** The start of today, local time, in unix ms: Handled for you lists what happened since. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Handled for you starts open with this many items or fewer, folded to one line beyond. */
export const HANDLED_OPEN_MAX = 5

/** "14:02", local time, for the thread and Handled for you. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
