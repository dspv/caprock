/**
 * Projects and shells: the typed client for the contract in
 * .ai/21-app.md § Projects and § Shell tabs, and the fallback for a daemon
 * that does not serve it yet.
 *
 * The engine side (WP-05, WP-07) is built separately. Until a daemon answers
 * `GET /v1/projects`, the sidebar derives projects from the sessions it
 * already knows (grouped by repository, as the cost roll-up groups them) plus
 * folders added in this app, kept in localStorage. Everything that needs the
 * engine — clone, a new worktree, a shell — says so plainly instead of failing
 * quietly.
 */
import { ApiError, deviceToken, type SessionSummary } from './api'

export interface Worktree {
  /** The worktree's name: its directory name, or `main` for the primary checkout. */
  name: string
  path: string
  branch: string
  ahead?: number
  behind?: number
  changed?: number
  /** Caprock created it, so it may remove it while clean. */
  caprock?: boolean
}

export interface Project {
  id: string
  root: string
  name: string
  kind: 'repo' | 'folder'
  remote_url?: string
  default_branch?: string
  added_at?: number
  pinned?: boolean
  sort?: number
  archived_at?: number | null
  /** Live git state, from the list or from `project` frames on /v1/live. */
  branch?: string
  ahead?: number
  behind?: number
  changed?: number
  worktrees?: Worktree[]
  waiting?: number
}

/** A `project` frame on /v1/live: a project's git state changed. */
export interface ProjectFrame {
  id: string
  branch?: string
  ahead?: number
  behind?: number
  changed?: number
  worktrees?: Worktree[]
  waiting?: number
}

/** An `op` frame on /v1/live: progress of a clone or a worktree. */
export interface OpFrame {
  op_id: string
  state: 'running' | 'done' | 'error'
  progress?: number
  error?: string
  project_id?: string
}

export type AddProjectRequest =
  | { source: 'folder'; path: string; name?: string; op_id: string }
  | { source: 'new'; path: string; name?: string; op_id: string }
  | { source: 'clone'; url: string; path?: string; name?: string; op_id: string }

export interface ShellRequest {
  project_id?: string
  cwd?: string
  cols: number
  rows: number
}

/** Where the project list came from: the daemon's own, or derived here. */
export type ProjectSource = 'api' | 'derived'

/** The daemon does not serve this yet (an older release, or the engine not merged). */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`${what} needs a newer Caprock daemon.`)
  }
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (json) h['Content-Type'] = 'application/json'
  const t = deviceToken()
  if (t) h['X-Caprock-Device'] = t
  return h
}

/** 404, 405 and 501 all mean "this daemon has no such endpoint". */
function isMissing(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

async function call<T>(what: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: headers(init.body !== undefined),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (isMissing(res.status)) throw new NotSupportedError(what)
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** A fresh id for an idempotent long operation (clone, worktree). */
export function newOpId(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const projectsApi = {
  /** GET /v1/projects. Accepts a bare array or `{projects: [...]}`. */
  list: async (): Promise<Project[]> => {
    const v = await call<Project[] | { projects: Project[] }>('Projects', '/v1/projects')
    const list = Array.isArray(v) ? v : v?.projects
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string' && typeof p.root === 'string') : []
  },
  add: (req: AddProjectRequest) => call<Project>('Adding a project', '/v1/projects', { method: 'POST', body: req }),
  patch: (id: string, patch: Partial<Pick<Project, 'name' | 'pinned' | 'sort'>> & { archived?: boolean }) =>
    call<Project>('Editing a project', `/v1/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  branches: (id: string) => call<{ branches: string[]; current?: string }>('Branches', `/v1/projects/${encodeURIComponent(id)}/branches`),
  createWorktree: (id: string, req: { branch: string; create?: boolean; base?: string; op_id: string }) =>
    call<Worktree>('A new worktree', `/v1/projects/${encodeURIComponent(id)}/worktrees`, { method: 'POST', body: req }),
  removeWorktree: (id: string, name: string) =>
    call<void>('Removing a worktree', `/v1/projects/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** POST /v1/shells: a login shell under a pty-host, attached like a session. */
  startShell: async (req: ShellRequest): Promise<{ session_id: string; cwd?: string }> => {
    const v = await call<{ session_id?: string; id?: string; cwd?: string }>('Shell tabs', '/v1/shells', { method: 'POST', body: req })
    const id = v?.session_id ?? v?.id
    if (!id) throw new Error('The daemon started a shell but did not say which.')
    return { session_id: id, cwd: v.cwd }
  },
}

// ── Folders added in this app, for a daemon without /v1/projects ─────────

export interface LocalProject {
  root: string
  name: string
  pinned?: boolean
  archived?: boolean
}

export const LOCAL_PROJECTS_KEY = 'caprock.app.projects.local'

export function loadLocalProjects(): LocalProject[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_PROJECTS_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((p): p is LocalProject => !!p && typeof p.root === 'string' && p.root !== '' && typeof p.name === 'string') : []
  } catch {
    return []
  }
}

export function saveLocalProjects(list: LocalProject[]): void {
  try {
    localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(list))
  } catch { /* nothing to do */ }
}

/** The last path segment, as a project's default name. */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** The key a derived project is listed under: the repository root, else the folder. */
export function derivedProjectId(root: string): string {
  return `dir:${root}`
}

/** Where a session's project lives: its repository, else its own folder. */
export function sessionRoot(s: Pick<SessionSummary, 'repo_root' | 'cwd'>): string {
  return s.repo_root || s.cwd
}

/**
 * Projects for a daemon that has no project list: one per repository a
 * session ran in, plus folders added in this app. Archived local entries are
 * left out; nothing is ever removed from disk.
 */
export function deriveProjects(sessions: SessionSummary[], local: LocalProject[], labels: Map<string, string> = new Map()): Project[] {
  const byRoot = new Map<string, Project>()
  const archived = new Set(local.filter((l) => l.archived).map((l) => l.root))
  for (const l of local) {
    if (l.archived) continue
    byRoot.set(l.root, { id: derivedProjectId(l.root), root: l.root, name: l.name || folderName(l.root), kind: 'folder', pinned: l.pinned })
  }
  for (const s of sessions) {
    if (!s || s.kind === 'shell') continue
    const root = sessionRoot(s)
    if (!root || archived.has(root)) continue
    const known = byRoot.get(root)
    if (known) {
      if (known.kind === 'folder' && s.repo_root) known.kind = 'repo'
      if (!known.branch && s.git_branch && !s.worktree) known.branch = s.git_branch
      continue
    }
    byRoot.set(root, {
      id: derivedProjectId(root),
      root,
      name: labels.get(root) || s.project || folderName(root),
      kind: s.repo_root ? 'repo' : 'folder',
      branch: s.worktree ? undefined : s.git_branch || undefined,
    })
  }
  return disambiguate([...byRoot.values()])
}

/**
 * Two projects with one name ("proj" in two places) get the folder above
 * each, so a row never has to be opened to tell them apart.
 */
export function disambiguate(list: Project[]): Project[] {
  const count = new Map<string, number>()
  for (const p of list) count.set(p.name, (count.get(p.name) ?? 0) + 1)
  return list.map((p) => {
    if ((count.get(p.name) ?? 0) < 2) return p
    const parts = p.root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
    const parent = parts[parts.length - 2]
    return parent ? { ...p, name: `${parent}/${p.name}` } : p
  })
}

/**
 * Which worktree of a project a session runs in: the one whose path holds its
 * folder (longest match), else the worktree it was started in by name, else
 * the main checkout.
 */
export function worktreeKeyOf(s: Pick<SessionSummary, 'cwd' | 'worktree'>, project: Project): string {
  const wts = (project.worktrees ?? []).filter((w) => w.path && w.path !== project.root)
  let best: Worktree | undefined
  for (const w of wts) {
    if ((s.cwd === w.path || s.cwd.startsWith(`${w.path}/`) || s.cwd.startsWith(`${w.path}\\`)) && (!best || w.path.length > best.path.length)) best = w
  }
  if (best) return best.name
  if (s.worktree) return s.worktree
  const m = /[\\/]\.(?:caprock-worktrees|claude[\\/]worktrees)[\\/]([^\\/]+)/.exec(s.cwd)
  return m ? m[1]! : 'main'
}

/** Whether a session belongs to a project. */
export function inProject(s: Pick<SessionSummary, 'cwd' | 'repo_root'>, project: Project): boolean {
  const root = sessionRoot(s)
  if (root === project.root) return true
  return s.cwd === project.root || s.cwd.startsWith(`${project.root}/`) || s.cwd.startsWith(`${project.root}\\`)
}
