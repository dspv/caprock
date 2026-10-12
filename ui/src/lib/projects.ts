/**
 * Projects and shells: the typed client for .ai/03-contracts.md § Projects
 * and shells, and the fallback for a daemon that does not serve it.
 *
 * The wire shapes (`ApiProject`, `ApiWorktree`, `ApiShell`) are turned into the
 * flat `Project` the sidebar reads by `fromApiProject`. An older daemon
 * answers `GET /v1/projects` with 404: the sidebar then derives projects from
 * the sessions it already knows (grouped by repository, as the cost roll-up
 * groups them) plus folders added in this app, kept in localStorage.
 * Everything that needs the engine — clone, a new worktree, a shell — says so
 * plainly instead of failing quietly.
 */
import { ApiError, deviceToken, type SessionSummary } from './api'
import { branchLabel, uniqueSuffixes } from './sessionLabels'
import { cleanupOf, type CleanupRestored, type CleanupView, type CopiesView, type CopyRemoved } from './copies'

export interface Worktree {
  /** The worktree's name: git's name for it, or `main` for the primary checkout. */
  name: string
  path: string
  branch: string
  ahead?: number
  behind?: number
  changed?: number
  /** Caprock created it, so it may remove it while clean. */
  caprock?: boolean
}

/** `Project.git` on the wire: `null` for a folder that is not a repository. */
export interface ApiGitStatus {
  branch: string
  detached?: boolean
  dirty: boolean
  changed: number
  ahead: number
  behind: number
  upstream?: string
  default_branch?: string
  remote_url?: string
  error?: string
  at: number
}

/** A linked worktree on the wire (`<git common dir>/worktrees/*`). */
export interface ApiWorktree {
  name: string
  path: string
  branch?: string
  /** The commit, when detached. */
  head?: string
  caprock: boolean
  locked?: boolean
  missing?: boolean
  dirty: boolean
  changed: number
  error?: string
}

/** `Project` as `GET /v1/projects` and the `project` live frame carry it. */
export interface ApiProject {
  id: number | string
  name: string
  root: string
  kind: 'repo' | 'folder'
  source?: string
  pinned?: boolean
  sort?: number
  added_at?: number
  archived?: boolean
  exists?: boolean
  git?: ApiGitStatus | null
  sessions?: { live: number; waiting: number; total: number }
  cost_today?: number
  last_activity?: number
  worktrees?: ApiWorktree[]
  /** Sent alone with `id` when the project is unlisted. */
  removed?: boolean
  defaults?: ProjectDefaults
  /** A multi-repo project's member repositories (ADR-055); absent otherwise. */
  repos?: ApiRepo[]
}

/** One member of a multi-repo project on the wire (`RepoView`). */
export interface ApiRepo {
  path: string
  /** Below the project's folder, forward slashes: `api`, `services/web`. */
  name: string
  exists?: boolean
  git?: ApiGitStatus | null
  sessions?: { live: number; waiting: number; total: number }
  cost_today?: number
  last_activity?: number
  /** Open pull requests on GitHub, when `GET …/repos` was asked and GitHub is connected. */
  open_prs?: number
  prs_error?: string
}

/** A member repository, flattened like `Project`. */
export interface RepoInfo {
  path: string
  name: string
  exists: boolean
  branch?: string
  ahead?: number
  behind?: number
  changed?: number
  gitError?: string
  remote_url?: string
  live: number
  waiting: number
  total: number
  cost_today: number
  last_activity?: number
  open_prs?: number
  prs_error?: string
}

/** The wire member, flattened. */
export function fromApiRepo(r: ApiRepo): RepoInfo {
  const git = r.git ?? undefined
  return {
    path: r.path,
    name: r.name || folderName(r.path),
    exists: r.exists !== false,
    branch: git ? branchLabel(git.branch) || (git.detached ? 'detached' : undefined) : undefined,
    ahead: git?.ahead,
    behind: git?.behind,
    changed: git?.changed,
    gitError: git?.error || undefined,
    remote_url: git?.remote_url || undefined,
    live: r.sessions?.live ?? 0,
    waiting: r.sessions?.waiting ?? 0,
    total: r.sessions?.total ?? 0,
    cost_today: r.cost_today ?? 0,
    last_activity: r.last_activity,
    open_prs: r.open_prs,
    prs_error: r.prs_error,
  }
}

/** One repository a scan found below a folder (`GET /v1/projects/scan`). */
export interface FoundRepo {
  path: string
  name: string
  /** Listed as a project of its own. */
  project_id?: number
  project_name?: string
  /** A member of this multi-repo project. */
  member_of?: number
}

/** What adding a folder would add: the repository it is in, or the ones below it. */
export interface ScanResult {
  root: string
  repo_root?: string
  repos: FoundRepo[]
  capped?: boolean
}

/**
 * A project's defaults (`PATCH /v1/projects/{id}` replaces them whole).
 * `system_prompt` is the project's instructions, appended to the system prompt
 * of every Claude Code session started in it. `setup_command` runs in a new
 * copy's terminal before its agent starts (ADR-050).
 */
export interface ProjectDefaults {
  agent?: string
  model?: string
  permission_mode?: string
  system_prompt?: string
  setup_command?: string
}

/** A shell tab (`POST`/`GET /v1/shells`). It has no session row. */
export interface ApiShell {
  id: string
  cwd: string
  command?: string
  started_at: number
  survives_restart?: boolean
  project_id?: number
  /** What runs in front of the prompt ("claude", "npm"); absent while the shell is idle. */
  program?: string
  kind: 'shell'
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
  /** Today's spend, as the daemon counts it for this root. */
  cost_today?: number
  last_activity?: number
  defaults?: ProjectDefaults
  /** A multi-repo project's member repositories (ADR-055); absent for one repository or folder. */
  repos?: RepoInfo[]
}

/** A `project` frame on /v1/live: the whole project, or `{id, removed: true}`. */
export type ProjectFrame = ApiProject

/** An `op` frame on /v1/live: progress of a clone. */
export interface OpFrame {
  op_id: string
  kind?: 'clone'
  state: 'running' | 'done' | 'failed'
  phase?: string
  progress?: number
  url?: string
  dest?: string
  error?: string
  project_id?: number
}

export type AddProjectRequest =
  | { path: string; repos?: string[] }
  | { create: { parent: string; name: string; git_init?: boolean } }
  | { clone: { url: string; parent: string; name?: string }; op_id: string }

export type AddProjectResult =
  | { project: Project; created: boolean }
  | { op: OpFrame; existing: boolean }

export interface ShellRequest {
  project_id?: number
  cwd?: string
  cols: number
  rows: number
  /** The session whose exited program this shell replaces: every client asking gets the same shell. */
  replaces?: string
  /** One line typed at the prompt once the shell has drawn it, not run unless `run`: an agent's install or sign-in. */
  type?: string
  /** Press Enter after `type`: a saved command the user picked to run (ADR-051). */
  run?: boolean
}

/** What a branch row says for a checkout: the branch, or `detached @ <sha7>` when git names a commit. */
function checkoutLabel(branch: string | undefined, head: string | undefined): string {
  if (branch && branch !== 'HEAD') return branch
  return head ? `detached @ ${head.slice(0, 7)}` : ''
}

/** The wire project, flattened for the sidebar. */
export function fromApiProject(p: ApiProject): Project {
  const git = p.git ?? undefined
  return {
    id: String(p.id),
    root: p.root,
    name: p.name,
    kind: p.kind,
    remote_url: git?.remote_url,
    default_branch: git?.default_branch,
    added_at: p.added_at,
    pinned: p.pinned,
    sort: p.sort,
    archived_at: p.archived ? 1 : null,
    branch: git ? branchLabel(git.branch) || undefined : undefined,
    ahead: git?.ahead,
    behind: git?.behind,
    changed: git?.changed,
    waiting: p.sessions?.waiting,
    cost_today: p.cost_today,
    last_activity: p.last_activity,
    defaults: p.defaults,
    ...(Array.isArray(p.repos) && p.repos.length > 0 ? { repos: p.repos.map(fromApiRepo) } : {}),
    worktrees: (p.worktrees ?? [])
      .filter((w) => !w.missing)
      .map((w) => ({ name: w.name, path: w.path, branch: checkoutLabel(w.branch, w.head), changed: w.changed, caprock: w.caprock })),
  }
}

/**
 * A shell as a sidebar row. A shell writes no session row (03-contracts.md
 * § Projects and shells), so the app lists it from `GET /v1/shells` and
 * shows it like a live session of kind `shell`, held by Caprock.
 */
export function shellAsSession(sh: ApiShell): SessionSummary {
  const started = sh.started_at
  return {
    session_id: sh.id, cwd: sh.cwd, project: folderName(sh.cwd), model: '', started_at: started, last_event_at: started,
    status: 'active', transcript_path: '', has_hooks: false, has_transcript: false, git_branch: '', version: '', owned: true, kind: 'shell', program: sh.program,
    stats: { session_id: sh.id, turns: 0, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    activity: { phrase: '', at: '', health: 'idle' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
  } as SessionSummary
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

/** The PATCH that sets a project's instructions, keeping its other defaults; "" clears them. */
export function instructionsPatch(defaults: ProjectDefaults | undefined, text: string): { defaults: ProjectDefaults } {
  const { system_prompt: _old, ...rest } = defaults ?? {}
  const t = text.trim()
  return { defaults: t ? { ...rest, system_prompt: t } : rest }
}

/** The PATCH that sets a project's setup command, keeping its other defaults; "" clears it. */
export function setupPatch(defaults: ProjectDefaults | undefined, command: string): { defaults: ProjectDefaults } {
  const { setup_command: _old, ...rest } = defaults ?? {}
  const t = command.trim()
  return { defaults: t ? { ...rest, setup_command: t } : rest }
}

/** A branch a new copy can start from (agents.Branch on the wire). */
export interface BranchInfo {
  name: string
  main?: boolean
  default?: boolean
  local?: boolean
  remote?: string
  committed_ms: number
}

export const projectsApi = {
  /** GET /v1/projects → `{projects}`, flattened; a bare array is read too. */
  list: async (): Promise<Project[]> => {
    const v = await call<ApiProject[] | { projects: ApiProject[] }>('Projects', '/v1/projects')
    const list = Array.isArray(v) ? v : v?.projects
    return Array.isArray(list)
      ? list.filter((p) => p && (typeof p.id === 'number' || typeof p.id === 'string') && typeof p.root === 'string').map(fromApiProject)
      : []
  },
  /** POST /v1/projects: a folder or a new one answer with the project; a clone with its operation (202). */
  add: async (req: AddProjectRequest): Promise<AddProjectResult> => {
    const v = await call<{ project?: ApiProject; created?: boolean; op?: OpFrame; existing?: boolean }>('Adding a project', '/v1/projects', { method: 'POST', body: req })
    if (v?.op) return { op: v.op, existing: !!v.existing }
    if (v?.project) return { project: fromApiProject(v.project), created: !!v.created }
    throw new Error('The daemon answered without a project.')
  },
  /** GET /v1/projects/ops: the clones the daemon remembers, for a client that missed their frames. */
  ops: async (): Promise<OpFrame[]> => {
    const v = await call<{ ops?: OpFrame[] }>('Clone progress', '/v1/projects/ops')
    return Array.isArray(v?.ops) ? v.ops.filter((o) => o && typeof o.op_id === 'string') : []
  },
  patch: async (id: string, patch: Partial<Pick<Project, 'name' | 'pinned' | 'sort' | 'defaults'>> & { repos?: string[] }): Promise<Project> => {
    const v = await call<{ project: ApiProject }>('Editing a project', `/v1/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
    return fromApiProject(v.project)
  },
  /** GET /v1/projects/scan: what adding a folder would add (ADR-055). */
  scan: async (path: string): Promise<ScanResult> => {
    const v = await call<ScanResult>('Finding repositories', `/v1/projects/scan?path=${encodeURIComponent(path)}`)
    return { root: v?.root ?? path, repo_root: v?.repo_root || undefined, repos: Array.isArray(v?.repos) ? v.repos.filter((r) => r && typeof r.path === 'string') : [], capped: !!v?.capped }
  },
  /** GET /v1/projects/{id}/repos: the members with fresh git state and open pull requests. */
  repos: async (id: string): Promise<RepoInfo[]> => {
    const v = await call<{ repos?: ApiRepo[] }>('Repositories', `/v1/projects/${encodeURIComponent(id)}/repos`)
    return Array.isArray(v?.repos) ? v.repos.filter((r) => r && typeof r.path === 'string').map(fromApiRepo) : []
  },
  /** POST /v1/projects/{id}/split: each member becomes a project of its own. */
  split: async (id: string): Promise<Project[]> => {
    const v = await call<{ projects?: ApiProject[] }>('Splitting a project', `/v1/projects/${encodeURIComponent(id)}/split`, { method: 'POST', body: {} })
    return Array.isArray(v?.projects) ? v.projects.map(fromApiProject) : []
  },
  /** POST /v1/projects/merge: one multi-repo project of these projects' repositories. */
  merge: async (ids: string[]): Promise<Project> => {
    const v = await call<{ project: ApiProject }>('Merging projects', '/v1/projects/merge', { method: 'POST', body: { ids: ids.map(Number) } })
    return fromApiProject(v.project)
  },
  /** DELETE /v1/projects/{id}: unlists it; nothing on disk is touched. */
  unlist: (id: string) => call<void>('Removing a project', `/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }),
  createWorktree: async (id: string, req: { branch: string; create?: boolean; base?: string }): Promise<{ path: string; branch: string; tracks?: string }> => {
    const v = await call<{ worktree: { path: string; branch: string; tracks?: string } }>('A new worktree', `/v1/projects/${encodeURIComponent(id)}/worktrees`, { method: 'POST', body: req })
    return v.worktree
  },
  /** GET /v1/projects/{id}/branches: main branches first, then by newest commit. */
  branches: async (id: string): Promise<BranchInfo[]> => {
    const v = await call<{ branches?: BranchInfo[] }>('Branches', `/v1/projects/${encodeURIComponent(id)}/branches`)
    return Array.isArray(v?.branches) ? v.branches : []
  },
  removeWorktree: (id: string, name: string) =>
    call<void>('Removing a worktree', `/v1/projects/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(name)}`, { method: 'DELETE', body: {} }),
  /** GET /v1/projects/{id}/copies: every worktree, the main checkout first, with state and size (lib/copies). */
  copies: async (id: string): Promise<CopiesView> => {
    const v = await call<CopiesView>('Copies', `/v1/projects/${encodeURIComponent(id)}/copies`)
    const copies = Array.isArray(v?.copies) ? v.copies.filter((c) => c && typeof c.path === 'string').map((c) => ({ ...c, live: Array.isArray(c.live) ? c.live : [] })) : []
    return { ...v, copies, total: typeof v?.total === 'number' ? v.total : 0, has_remote: !!v?.has_remote }
  },
  /** POST /v1/projects/{id}/copies/remove: one result per copy asked for. */
  removeCopies: async (id: string, copies: { path: string; force?: boolean }[], deleteMergedBranches: boolean): Promise<CopyRemoved[]> => {
    const v = await call<{ results?: CopyRemoved[] }>('Removing copies', `/v1/projects/${encodeURIComponent(id)}/copies/remove`, {
      method: 'POST',
      body: { copies, delete_merged_branches: deleteMergedBranches },
    })
    return Array.isArray(v?.results) ? v.results : []
  },
  /** GET /v1/projects/{id}/cleanup: the finished copies, the day's removals, the history. */
  cleanup: async (id: string): Promise<CleanupView> =>
    cleanupOf(await call<CleanupView>('Finished copies', `/v1/projects/${encodeURIComponent(id)}/cleanup`)),
  /** POST /v1/projects/{id}/cleanup: removes exactly these finished copies, each judged again. */
  cleanUp: async (id: string, paths: string[]): Promise<{ results: CopyRemoved[]; cleanup: CleanupView }> => {
    const v = await call<{ results?: CopyRemoved[]; cleanup?: CleanupView }>('Cleaning up copies', `/v1/projects/${encodeURIComponent(id)}/cleanup`, { method: 'POST', body: { paths } })
    return { results: Array.isArray(v?.results) ? v.results : [], cleanup: cleanupOf(v?.cleanup) }
  },
  /** POST /v1/projects/{id}/cleanup/restore: puts removed copies back (Undo, Restore). */
  restoreCopies: async (id: string, ids: string[]): Promise<{ results: CleanupRestored[]; cleanup: CleanupView }> => {
    const v = await call<{ results?: CleanupRestored[]; cleanup?: CleanupView }>('Restoring copies', `/v1/projects/${encodeURIComponent(id)}/cleanup/restore`, { method: 'POST', body: { ids } })
    return { results: Array.isArray(v?.results) ? v.results : [], cleanup: cleanupOf(v?.cleanup) }
  },
  /** POST /v1/shells: a login shell under a pty-host, attached like a session. */
  startShell: async (req: ShellRequest): Promise<ApiShell> => {
    const v = await call<{ shell?: ApiShell }>('Shell tabs', '/v1/shells', { method: 'POST', body: req })
    if (!v?.shell?.id) throw new Error('The daemon started a shell but did not say which.')
    return v.shell
  },
  /** GET /v1/shells: every running shell. */
  shells: async (): Promise<ApiShell[]> => {
    const v = await call<{ shells?: ApiShell[] }>('Shell tabs', '/v1/shells')
    return Array.isArray(v?.shells) ? v.shells.filter((sh) => sh && typeof sh.id === 'string') : []
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

/**
 * Where a session runs, as the inspector's header says it: the project's
 * name as the sidebar shows it, then the branch only when it is not the
 * project's default (main or master when git did not say), and the full path
 * for a tooltip. A path cut to fit (`…nt-a874ec5240fb37a9d`) told nobody
 * which project it was (owner, 2026-10-09).
 */
export function sessionPlace(
  s: Pick<SessionSummary, 'cwd' | 'repo_root' | 'project' | 'git_branch'>,
  project?: Pick<Project, 'name' | 'default_branch'>,
): { project: string; branch: string; path: string } {
  const name = project?.name || s.project || folderName(sessionRoot(s) || '')
  const branch = branchLabel(s.git_branch)
  const isDefault = project?.default_branch ? branch === project.default_branch : branch === 'main' || branch === 'master'
  return { project: name, branch: isDefault ? '' : branch, path: s.cwd }
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
      if (!known.branch && branchLabel(s.git_branch) && !s.worktree) known.branch = branchLabel(s.git_branch)
      continue
    }
    byRoot.set(root, {
      id: derivedProjectId(root),
      root,
      name: labels.get(root) || s.project || folderName(root),
      kind: s.repo_root ? 'repo' : 'folder',
      branch: s.worktree ? undefined : branchLabel(s.git_branch) || undefined,
    })
  }
  return disambiguate([...byRoot.values()])
}

/**
 * Two projects with one name ("caprock" in ~/dev and in ~/Downloads) get the
 * shortest path suffix that tells them apart, so a row never has to be
 * opened to know which is which.
 */
export function disambiguate(list: Project[]): Project[] {
  const count = new Map<string, number>()
  for (const p of list) count.set(p.name, (count.get(p.name) ?? 0) + 1)
  const clashing = list.filter((p) => (count.get(p.name) ?? 0) > 1)
  if (clashing.length === 0) return list
  const labels = uniqueSuffixes(clashing.map((p) => p.root))
  return list.map((p) => ((count.get(p.name) ?? 0) > 1 ? { ...p, name: labels.get(p.root) ?? p.name } : p))
}

/**
 * Which worktree of a project a session runs in: the one whose path holds its
 * folder (longest match), else the worktree it was started in by name, else
 * the main checkout.
 */
export function worktreeKeyOf(s: Pick<SessionSummary, 'cwd' | 'worktree'>, project: Project): string {
  // In a multi-repo project the row is the member repository the session
  // is in, keyed by its path (ADR-055).
  const member = memberOf(s.cwd, project)
  if (member) return `repo:${member.path}`
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
  return matchLength(s, project) >= 0
}

/** Whether `dir` is `root` or below it, in either separator. */
export function pathWithin(dir: string, root: string): boolean {
  if (!root) return false
  return dir === root || dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`)
}

/** The member repository of a multi-repo project that holds `dir`, the deepest one. */
export function memberOf(dir: string, project: Pick<Project, 'repos'>): RepoInfo | undefined {
  let best: RepoInfo | undefined
  for (const r of project.repos ?? []) {
    if (pathWithin(dir, r.path) && (!best || r.path.length > best.path.length)) best = r
  }
  return best
}

/**
 * How closely a project holds a session: the length of its root or member
 * repository that holds the session's folder, the longest; -1 when it does
 * not. The sidebar gives a session to the closest project, as the daemon's
 * attribution does (a member wins a tie with a root).
 */
export function matchLength(s: Pick<SessionSummary, 'cwd' | 'repo_root'>, project: Project): number {
  const root = sessionRoot(s)
  let best = -1
  if (root === project.root || pathWithin(s.cwd, project.root)) best = project.root.length
  for (const r of project.repos ?? []) {
    if ((root && pathWithin(root, r.path)) || pathWithin(s.cwd, r.path)) best = Math.max(best, r.path.length + 0.5)
  }
  return best
}
