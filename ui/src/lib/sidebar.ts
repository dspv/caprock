/**
 * The sidebar's model, built from what the daemon reports (WP-06): projects,
 * their worktrees, the sessions and shells in each, and the inbox of sessions
 * waiting on you. A pure function, so 50 projects and 30 live sessions cost
 * one pass and can be tested without a screen.
 */
import { isQuickChat, quickChatTitle } from './quickchat'
import type { SessionSummary } from './api'
import { branchLabel, sessionHealth } from './sessionLabels'
import { folderName, matchLength, sessionRoot, worktreeKeyOf, type Project } from './projects'
import { uniqueSuffixes } from './sessionLabels'
import { promptTitle } from './sessionNames'

/**
 * The group for sessions in folders no listed project holds. The daemon lists
 * only repositories (03-contracts.md § Projects and shells, seeding), so a
 * session in, say, ~/Downloads would otherwise have no row at all.
 */
export const OTHER_FOLDERS_ID = 'other-folders'

export type Dot = 'working' | 'waiting' | 'looping' | 'idle' | 'ended'

export interface SessionNode {
  session: SessionSummary
  dot: Dot
  title: string
  isShell: boolean
  /** Open in a tab right now. */
  open: boolean
  /** Waits on you now: a permission prompt, or a turn ended in the last
   *  STALE_MS. Such a row is never hidden from the sidebar, and carries the
   *  amber mark there (the sidebar's one way of saying "needs you"). */
  waiting?: boolean
  /** Waits on a permission prompt: the row says "asks". */
  asks?: boolean
  /** Since when it waits (ms), when it does: a row hidden before this shows again. */
  waitingSince?: number
}

export interface WorktreeNode {
  key: string
  branch: string
  path: string
  isMain: boolean
  ahead?: number
  behind?: number
  changed?: number
  /** The member repository this row is, in a multi-repo project (ADR-055). */
  repo?: string
  sessions: SessionNode[]
}

export interface ProjectNode {
  project: Project
  costToday: number
  waiting: number
  looping: number
  /** Live sessions and shells: what keeps the project in the list. */
  live: number
  /** Live agent sessions (shells left out): the row's running count. */
  agents: number
  /** Of those, the ones working this moment. */
  working: number
  lastActive: number
  worktrees: WorktreeNode[]
  /** Turns and tool calls over the last hour, oldest bucket first (GET /v1/activity); absent when nothing ran. */
  activity?: number[]
}

export interface InboxItem {
  session: SessionSummary
  projectId: string
  projectName: string
  reason: 'permission' | 'waiting'
  title: string
  since: number
  /** Its turn ended more than STALE_MS ago: put down, not waiting. Folded
   *  under "Older" and left out of ⌘J and the badge, so a session left
   *  three days ago does not stand in front of the one that just finished. */
  stale: boolean
}

/** How long "your turn" stays waiting. A permission prompt never goes stale: the agent is blocked on it. */
export const STALE_MS = 12 * 60 * 60 * 1000

export interface SidebarInput {
  projects: Project[]
  sessions: SessionSummary[]
  /** Sessions with a permission prompt pending (ADR-035). */
  permissions: ReadonlySet<string>
  /** Today's spend per repository root, from /v1/stats/summary. */
  costs: ReadonlyMap<string, number>
  /** Sessions open in a tab: shown even after they end, so a tab never points at nothing. */
  openSessions: ReadonlySet<string>
  /** For staleness; the clock when absent. */
  now?: number
  /** Each session's activity buckets over the last hour (GET /v1/activity). */
  activity?: Readonly<Record<string, number[]>>
}

export interface SidebarModel {
  projects: ProjectNode[]
  inbox: InboxItem[]
}

/** The status dot for a session. A pending prompt outranks everything: it is the one thing only you can do. */
export function dotOf(s: SessionSummary, hasPermission: boolean): Dot {
  if (hasPermission && s.status !== 'ended') return 'waiting'
  switch (sessionHealth(s)) {
    case 'working': return 'working'
    case 'waiting-on-you': return 'waiting'
    case 'looping':
    case 'error': return 'looping'
    case 'ended': return 'ended'
    default: return 'idle'
  }
}

/**
 * What a session is called in a row: the name the user gave it, else the
 * agent's title, else a few words from its first meaningful prompt
 * (lib/sessionNames.ts), else its folder's branch.
 */
export function sessionTitle(s: SessionSummary): string {
  const branch = branchLabel(s.git_branch)
  if (s.kind === 'shell') return branch ? `shell · ${branch}` : 'shell'
  const name = s.name?.trim()
  // A quick chat is named as one, not by its dated folder (lib/quickchat.ts).
  if (!name && isQuickChat(s)) return quickChatTitle(s)
  const title = name || sessionAbout(s) || (branch ? `on ${branch}` : 'new session')
  return attemptLabel(s) ? `${attemptLabel(s)} · ${title}` : title
}

/** What the session is about without the user's name for it: the agent's title, else a few words of its first prompt. */
export function sessionAbout(s: SessionSummary): string {
  if (s.title?.trim()) return s.title.trim()
  // A description the user's name made is stale once that name is cleared.
  if (s.description_source === 'prompt') return promptTitle(s.description)
  return s.description_source === 'name' ? '' : (s.description ?? '').trim()
}

/** "attempt 2/3" for one of several started on one first message (ADR-052); '' otherwise. */
export function attemptLabel(s: Pick<SessionSummary, 'attempt' | 'attempts'>): string {
  return s.attempts && s.attempts > 1 && s.attempt ? `attempt ${s.attempt}/${s.attempts}` : ''
}

function ms(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

export function buildSidebar({ projects, sessions, permissions, costs, openSessions, now = Date.now(), activity }: SidebarInput): SidebarModel {
  const nodes: ProjectNode[] = projects
    .filter((p) => !p.archived_at)
    .map((p) => ({ project: p, costToday: p.cost_today ?? costs.get(p.root) ?? 0, waiting: 0, looping: 0, live: 0, agents: 0, working: 0, lastActive: Math.max(p.last_activity ?? 0, p.added_at ?? 0), worktrees: [] }))
  // The closest project claims a session: a project nested in another (a
  // monorepo package added on its own) before the outer one, and a
  // multi-repo project's member repository wherever it lies (ADR-055).
  const closest = (s: SessionSummary): ProjectNode | undefined => {
    let best: ProjectNode | undefined
    let bestLen = -1
    for (const n of nodes) {
      const l = matchLength(s, n.project)
      if (l > bestLen) { best = n; bestLen = l }
    }
    return best
  }
  const inbox: InboxItem[] = []
  const other: ProjectNode = {
    project: { id: OTHER_FOLDERS_ID, root: '', name: 'Outside projects', kind: 'folder' },
    costToday: 0, waiting: 0, looping: 0, live: 0, agents: 0, working: 0, lastActive: 0, worktrees: [],
  }

  for (const s of sessions) {
    if (!s) continue
    const shown = s.status !== 'ended' || openSessions.has(s.session_id)
    const listed = closest(s)
    // Only what is live or open goes to Other folders: it is not a history.
    if (!listed && !shown) continue
    const node = listed ?? other
    node.lastActive = Math.max(node.lastActive, s.last_event_at ?? 0)
    // An ended session's last hour still counts toward its project's line.
    const act = activity?.[s.session_id]
    if (act) node.activity = node.activity ? node.activity.map((v, i) => v + (act[i] ?? 0)) : [...act]
    if (!shown) continue
    const hasPermission = permissions.has(s.session_id)
    const dot = dotOf(s, hasPermission)
    const isShell = s.kind === 'shell'
    if (s.status !== 'ended') {
      node.live += 1
      if (!isShell) node.agents += 1
      if (!isShell && dot === 'working') node.working += 1
    }
    let waitsNow = false
    let waitingSince: number | undefined
    if (dot === 'waiting' && !isShell) {
      const since = ms(s.activity?.at) || s.last_event_at
      const stale = !hasPermission && now - since > STALE_MS
      waitsNow = !stale
      if (waitsNow) waitingSince = since
      if (!stale) node.waiting += 1
      inbox.push({
        session: s,
        projectId: node.project.id,
        projectName: node.project.name,
        reason: hasPermission ? 'permission' : 'waiting',
        title: sessionTitle(s),
        since,
        stale,
      })
    }
    if (dot === 'looping') node.looping += 1
    if (node === other) {
      // One group per folder, named by the folder.
      const root = sessionRoot(s)
      let wt = other.worktrees.find((w) => w.key === root)
      if (!wt) {
        wt = { key: root, branch: folderName(root), path: root, isMain: false, sessions: [] }
        other.worktrees.push(wt)
      }
      wt.sessions.push({ session: s, dot, title: sessionTitle(s), isShell, open: openSessions.has(s.session_id), waiting: waitsNow, asks: waitsNow && hasPermission, waitingSince })
      continue
    }
    const key = worktreeKeyOf(s, node.project)
    let wt = node.worktrees.find((w) => w.key === key)
    if (!wt) {
      const known = node.project.worktrees?.find((w) => w.name === key)
      const member = key.startsWith('repo:') ? node.project.repos?.find((r) => `repo:${r.path}` === key) : undefined
      wt = member ? {
        key,
        branch: member.branch || member.name,
        path: member.path,
        isMain: false,
        ahead: member.ahead,
        behind: member.behind,
        changed: member.changed,
        repo: member.name,
        sessions: [],
      } : {
        key,
        branch: branchLabel(known?.branch || (key === 'main' ? node.project.branch : '') || s.git_branch) || (key === 'main' ? '' : key),
        path: known?.path ?? (key === 'main' ? node.project.root : s.cwd),
        isMain: key === 'main',
        ahead: known?.ahead ?? (key === 'main' ? node.project.ahead : undefined),
        behind: known?.behind ?? (key === 'main' ? node.project.behind : undefined),
        changed: known?.changed ?? (key === 'main' ? node.project.changed : undefined),
        sessions: [],
      }
      node.worktrees.push(wt)
    }
    wt.sessions.push({ session: s, dot, title: sessionTitle(s), isShell, open: openSessions.has(s.session_id), waiting: waitsNow, asks: waitsNow && hasPermission, waitingSince })
  }

  for (const n of nodes) {
    // Worktrees the daemon knows of with nothing running in them still show:
    // they are places to start work.
    for (const w of n.project.worktrees ?? []) {
      const key = w.path === n.project.root ? 'main' : w.name
      if (n.worktrees.some((x) => x.key === key)) continue
      n.worktrees.push({ key, branch: w.branch, path: w.path, isMain: key === 'main', ahead: w.ahead, behind: w.behind, changed: w.changed, sessions: [] })
    }
    // Beside a linked worktree the main checkout is a row of its own, even
    // with nothing running in it: otherwise the project reads as flat, its
    // row names the linked worktree's branch, and the main checkout's
    // changes have nowhere to be opened from.
    if (n.project.root && n.worktrees.length > 0 && !n.worktrees.some((w) => w.isMain)) {
      const p = n.project
      n.worktrees.push({ key: 'main', branch: p.branch ?? '', path: p.root, isMain: true, ahead: p.ahead, behind: p.behind, changed: p.changed, sessions: [] })
    }
    n.worktrees.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.branch.localeCompare(b.branch))
    for (const w of n.worktrees) {
      // Agents before shells, then the most recently active first.
      w.sessions.sort((a, b) => Number(a.isShell) - Number(b.isShell) || (b.session.last_event_at ?? 0) - (a.session.last_event_at ?? 0))
    }
  }

  nodes.sort((a, b) =>
    Number(!!b.project.pinned) - Number(!!a.project.pinned) ||
    (a.project.sort ?? Infinity) - (b.project.sort ?? Infinity) ||
    b.lastActive - a.lastActive ||
    a.project.name.localeCompare(b.project.name),
  )
  // Permission prompts first: they block the agent outright. Then oldest first —
  // the one that has waited longest has cost the most time.
  if (other.worktrees.length > 0) {
    // Same-named folders read by the shortest path that tells them apart,
    // from each other and from the listed projects (~/Downloads/caprock
    // beside the caprock repository).
    const labels = uniqueSuffixes([...other.worktrees.map((w) => w.path), ...nodes.map((n) => n.project.root)])
    for (const w of other.worktrees) {
      w.branch = labels.get(w.path) ?? w.branch
      w.sessions.sort((a, b) => Number(a.isShell) - Number(b.isShell) || (b.session.last_event_at ?? 0) - (a.session.last_event_at ?? 0))
    }
    other.worktrees.sort((a, b) => a.branch.localeCompare(b.branch))
    nodes.push(other)
  }
  // Then the fresh before the put-down; among the fresh the oldest first, the
  // most recently put down first among the stale.
  inbox.sort((a, b) =>
    Number(b.reason === 'permission') - Number(a.reason === 'permission') ||
    Number(a.stale) - Number(b.stale) ||
    (a.stale ? b.since - a.since : a.since - b.since))
  return { projects: nodes, inbox }
}

export interface ProjectGroups {
  /** In view: every project while there are few, what is in play when there are many. */
  shown: ProjectNode[]
  /** Above FOLD_ABOVE projects, the ones not in play, under "More projects", closed until opened. */
  more: ProjectNode[]
  /** Hidden by hand. */
  hidden: ProjectNode[]
}

/** "More projects" folds only above this many projects: eight read at a glance. */
export const FOLD_ABOVE = 8

/**
 * Splits the sidebar's projects into what is in view, the rest ("More
 * projects") and what was hidden by hand (owner, 2026-10-09: eighteen
 * projects in a column were "a mess, unclear how to navigate", translated).
 *
 * With FOLD_ABOVE projects or fewer nothing folds: every project not hidden
 * by hand is in view. Above that, in view is what is in play: a live or
 * waiting session, a tab open (`tabbed`), pinned, or the project in front. A
 * project hidden by hand stays under Hidden whatever runs in it, the one in
 * front included, until it needs you again (`projectHidden`). Other folders
 * holds only what is live or open, so it is always in view, and last.
 *
 * Inside each group the order is stable: pinned first, then the order set by
 * hand, then by name. Activity never moves a row and neither does a click: a
 * project that jumps when picked has to be found again.
 */
export function groupProjects(
  nodes: ProjectNode[],
  { hidden, activeProjectId, tabbed }: { hidden: HiddenProjects; activeProjectId?: string; tabbed?: ReadonlySet<string> },
): ProjectGroups {
  const out: ProjectGroups = { shown: [], more: [], hidden: [] }
  const fold = nodes.filter((n) => n.project.id !== OTHER_FOLDERS_ID).length > FOLD_ABOVE
  let other: ProjectNode | undefined
  for (const n of nodes) {
    const id = n.project.id
    if (id === OTHER_FOLDERS_ID) { other = n; continue }
    const busy = n.live > 0 || n.waiting > 0 || !!tabbed?.has(id) || n.worktrees.some((w) => w.sessions.some((s) => s.open))
    // Hidden by hand wins over running (owner, 2026-10-11: "hide a project
    // with one button"): its sessions keep running under Hidden, dot and
    // count included. It wins over being in front and over a turn that had
    // already ended too: forcing those back out made Hide do nothing on the
    // very projects it is pressed on (owner, 2026-10-13).
    if (projectHidden(n, hidden)) out.hidden.push(n)
    else if (busy || id === activeProjectId) out.shown.push(n)
    else if (!fold || n.project.pinned) out.shown.push(n)
    else out.more.push(n)
  }
  for (const g of [out.shown, out.more, out.hidden]) g.sort(stableOrder)
  // Outside projects stays last, unless hidden by hand; then it waits under
  // Hidden too, unless something there waits on you.
  if (other) (projectHidden(other, hidden) ? out.hidden : out.shown).push(other)
  return out
}

/**
 * The projects ⌘1–⌘9 reach, in the order the sidebar lists them: the ones in
 * play, not those folded under More projects or Hidden, and not Outside
 * projects, which is a group (owner, 2026-10-13: "Command+digit focuses that
 * project", translated). ⌥⌘← ⌥⌘→ step through the same list.
 */
export function numberedProjects(groups: ProjectGroups): string[] {
  return groups.shown.filter((n) => n.project.root !== '' && n.project.id !== OTHER_FOLDERS_ID).map((n) => n.project.id)
}

/** Project ids hidden from the sidebar by hand, and when: this browser's. */
export type HiddenProjects = ReadonlyMap<string, number>

/**
 * Whether a project stays under Hidden: hidden by hand, and nothing in it
 * needs you since. As with a session row (`rowHidden`), a permission prompt
 * always brings it out, and so does a turn that ended after it was hidden; a
 * turn that had already ended when Hide was pressed does not, nor does
 * being the project in front.
 */
export function projectHidden(n: ProjectNode, hidden: HiddenProjects): boolean {
  const at = hidden.get(n.project.id)
  if (at === undefined) return false
  for (const wt of n.worktrees) {
    for (const x of wt.sessions) {
      if (x.asks) return false
      if (x.waiting && (x.waitingSince ?? 0) > at) return false
    }
  }
  return true
}

/** Pinned first, then the order set by hand, then by name: nothing that changes with activity. */
function stableOrder(a: ProjectNode, b: ProjectNode): number {
  return Number(!!b.project.pinned) - Number(!!a.project.pinned) ||
    (a.project.sort ?? Infinity) - (b.project.sort ?? Infinity) ||
    a.project.name.localeCompare(b.project.name, undefined, { sensitivity: 'base' }) ||
    a.project.id.localeCompare(b.project.id)
}

/** Session ids hidden from the sidebar by hand, and when: this browser's. */
export type HiddenSessions = ReadonlyMap<string, number>

/**
 * Whether a session's row stays out of the sidebar. Hidden by hand keeps it
 * out (rule 7: hiding never signals anything, it only unlists the row) —
 * until it needs you again: a permission prompt always shows, and so does a
 * turn that ended after the row was hidden. A waiting session is the one
 * thing the sidebar must never lose; the Waiting on you block that used to
 * list them separately is gone (owner, 2026-10-11), so its rows carry it.
 */
export function rowHidden(x: Pick<SessionNode, 'session' | 'asks' | 'waiting' | 'waitingSince'>, hidden: HiddenSessions | undefined): boolean {
  const at = hidden?.get(x.session.session_id)
  if (at === undefined) return false
  if (x.asks) return false
  return !(x.waiting && (x.waitingSince ?? 0) > at)
}
