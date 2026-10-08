/**
 * The sidebar's model, built from what the daemon reports (WP-06): projects,
 * their worktrees, the sessions and shells in each, and the inbox of sessions
 * waiting on you. A pure function, so 50 projects and 30 live sessions cost
 * one pass and can be tested without a screen.
 */
import type { SessionSummary } from './api'
import { branchLabel, sessionHealth } from './sessionLabels'
import { folderName, inProject, sessionRoot, worktreeKeyOf, type Project } from './projects'
import { uniqueSuffixes } from './sessionLabels'

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
}

export interface WorktreeNode {
  key: string
  branch: string
  path: string
  isMain: boolean
  ahead?: number
  behind?: number
  changed?: number
  sessions: SessionNode[]
}

export interface ProjectNode {
  project: Project
  costToday: number
  waiting: number
  looping: number
  live: number
  lastActive: number
  worktrees: WorktreeNode[]
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

/** What a session is called in a row: the agent's title, else its first meaningful prompt, else its folder's branch. */
export function sessionTitle(s: SessionSummary): string {
  const branch = branchLabel(s.git_branch)
  if (s.kind === 'shell') return branch ? `shell · ${branch}` : 'shell'
  return (s.title || s.description || '').trim() || (branch ? `on ${branch}` : 'new session')
}

function ms(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

export function buildSidebar({ projects, sessions, permissions, costs, openSessions, now = Date.now() }: SidebarInput): SidebarModel {
  const nodes: ProjectNode[] = projects
    .filter((p) => !p.archived_at)
    .map((p) => ({ project: p, costToday: p.cost_today ?? costs.get(p.root) ?? 0, waiting: 0, looping: 0, live: 0, lastActive: Math.max(p.last_activity ?? 0, p.added_at ?? 0), worktrees: [] }))
  // Longest root first, so a project nested in another (a monorepo package
  // added on its own) claims its sessions before the outer one does.
  const byDepth = [...nodes].sort((a, b) => b.project.root.length - a.project.root.length)
  const inbox: InboxItem[] = []
  const other: ProjectNode = {
    project: { id: OTHER_FOLDERS_ID, root: '', name: 'Other folders', kind: 'folder' },
    costToday: 0, waiting: 0, looping: 0, live: 0, lastActive: 0, worktrees: [],
  }

  for (const s of sessions) {
    if (!s) continue
    const shown = s.status !== 'ended' || openSessions.has(s.session_id)
    const listed = byDepth.find((n) => inProject(s, n.project))
    // Only what is live or open goes to Other folders: it is not a history.
    if (!listed && !shown) continue
    const node = listed ?? other
    node.lastActive = Math.max(node.lastActive, s.last_event_at ?? 0)
    if (!shown) continue
    const hasPermission = permissions.has(s.session_id)
    const dot = dotOf(s, hasPermission)
    const isShell = s.kind === 'shell'
    if (s.status !== 'ended') node.live += 1
    if (dot === 'waiting' && !isShell) {
      const since = ms(s.activity?.at) || s.last_event_at
      const stale = !hasPermission && now - since > STALE_MS
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
      wt.sessions.push({ session: s, dot, title: sessionTitle(s), isShell, open: openSessions.has(s.session_id) })
      continue
    }
    const key = worktreeKeyOf(s, node.project)
    let wt = node.worktrees.find((w) => w.key === key)
    if (!wt) {
      const known = node.project.worktrees?.find((w) => w.name === key)
      wt = {
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
    wt.sessions.push({ session: s, dot, title: sessionTitle(s), isShell, open: openSessions.has(s.session_id) })
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
