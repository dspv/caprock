/**
 * The sidebar's model, built from what the daemon reports (WP-06): projects,
 * their worktrees, the sessions and shells in each, and the inbox of sessions
 * waiting on you. A pure function, so 50 projects and 30 live sessions cost
 * one pass and can be tested without a screen.
 */
import type { SessionSummary } from './api'
import { inProject, worktreeKeyOf, type Project } from './projects'

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
}

export interface SidebarInput {
  projects: Project[]
  sessions: SessionSummary[]
  /** Sessions with a permission prompt pending (ADR-035). */
  permissions: ReadonlySet<string>
  /** Today's spend per repository root, from /v1/stats/summary. */
  costs: ReadonlyMap<string, number>
  /** Sessions open in a tab: shown even after they end, so a tab never points at nothing. */
  openSessions: ReadonlySet<string>
}

export interface SidebarModel {
  projects: ProjectNode[]
  inbox: InboxItem[]
}

/** The status dot for a session. A pending prompt outranks everything: it is the one thing only you can do. */
export function dotOf(s: SessionSummary, hasPermission: boolean): Dot {
  if (hasPermission) return 'waiting'
  if (s.status === 'ended') return 'ended'
  switch (s.activity?.health) {
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
  if (s.kind === 'shell') return s.git_branch ? `shell · ${s.git_branch}` : 'shell'
  return (s.title || s.description || '').trim() || (s.git_branch ? `on ${s.git_branch}` : 'new session')
}

function ms(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

export function buildSidebar({ projects, sessions, permissions, costs, openSessions }: SidebarInput): SidebarModel {
  const nodes: ProjectNode[] = projects
    .filter((p) => !p.archived_at)
    .map((p) => ({ project: p, costToday: costs.get(p.root) ?? 0, waiting: 0, looping: 0, live: 0, lastActive: p.added_at ?? 0, worktrees: [] }))
  // Longest root first, so a project nested in another (a monorepo package
  // added on its own) claims its sessions before the outer one does.
  const byDepth = [...nodes].sort((a, b) => b.project.root.length - a.project.root.length)
  const inbox: InboxItem[] = []

  for (const s of sessions) {
    if (!s) continue
    const shown = s.status !== 'ended' || openSessions.has(s.session_id)
    const node = byDepth.find((n) => inProject(s, n.project))
    if (!node) continue
    node.lastActive = Math.max(node.lastActive, s.last_event_at ?? 0)
    if (!shown) continue
    const hasPermission = permissions.has(s.session_id)
    const dot = dotOf(s, hasPermission)
    const isShell = s.kind === 'shell'
    if (s.status !== 'ended') node.live += 1
    if (dot === 'waiting' && !isShell) {
      node.waiting += 1
      inbox.push({
        session: s,
        projectId: node.project.id,
        projectName: node.project.name,
        reason: hasPermission ? 'permission' : 'waiting',
        title: sessionTitle(s),
        since: ms(s.activity?.at) || s.last_event_at,
      })
    }
    if (dot === 'looping') node.looping += 1
    const key = worktreeKeyOf(s, node.project)
    let wt = node.worktrees.find((w) => w.key === key)
    if (!wt) {
      const known = node.project.worktrees?.find((w) => w.name === key)
      wt = {
        key,
        branch: known?.branch || (key === 'main' ? node.project.branch : '') || s.git_branch || key,
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
  inbox.sort((a, b) => Number(b.reason === 'permission') - Number(a.reason === 'permission') || a.since - b.since)
  return { projects: nodes, inbox }
}
