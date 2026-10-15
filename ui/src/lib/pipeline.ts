/**
 * Which repository the Pipeline shows (.ai/04-ui.md § Pipeline). It is a page
 * of the dashboard since 2026-10-15 (owner, translated: "build it into the
 * Dashboard as a separate page … Pipeline is part of the Dashboard"), so it
 * is no longer opened from one agent's tab: it shows a repository, picked in
 * its header, and reads it through the newest agent session in it — the
 * daemon's routes are a session's (…/sessions/{id}/ci/stats). Pure, apart
 * from the remembered choice.
 *
 * Only a git repository with a GitHub remote is a pipeline (owner, later that
 * day, translated: two "caprock" entries in the picker, the second one "This
 * folder is not a git repository with a remote"). A session's `repo_root` is
 * set only in a git repository, so a plain folder (a copy in Downloads, a
 * quick chat's folder, the paste folder) is never listed; the daemon's answer
 * for the rest (`GET /v1/repos/remotes`, `RepoRemotes`) drops a repository
 * with no remote or one on another host, and folds two clones of one GitHub
 * repository into one entry. Two entries that still share a folder name are
 * told apart by owner/name, else by their parent folder.
 */
import type { RepoRemote, SessionSummary } from './api'

/** One repository the Pipeline can show: its folder, its name, the session it is read through. */
export interface PipelineRepo {
  /** The repository's folder on this machine (the newest session's repo_root). */
  root: string
  /** Every folder folded into this entry: clones of one GitHub repository. */
  roots: string[]
  /** What the picker shows: the folder's name, or owner/name or parent/name when two would read the same. */
  name: string
  /** owner/name on GitHub, once the daemon said so. */
  remote?: string
  /** The newest agent session in it: the one the daemon is asked through. */
  session: SessionSummary
  /** Agent sessions running in it now. */
  live: number
}

/** The daemon's answer per folder (`GET /v1/repos/remotes`), by the folder asked. */
export type RepoRemotes = ReadonlyMap<string, RepoRemote>

const REPO_KEY = 'caprock.pipeline.repo'

/**
 * The folder a session's repository is known by: its `repo_root`, which the
 * daemon sets only inside a git repository. Empty for any other folder.
 */
export function repoOf(s: Pick<SessionSummary, 'repo_root'>): string {
  return s.repo_root || ''
}

const baseName = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
const parentAndBase = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/')

const running = (s: SessionSummary) => s.status !== 'ended' && !s.detached

/** Whether the daemon's answer rules a folder out: known, and not a GitHub repository. */
function notAPipeline(a: RepoRemote | undefined): boolean {
  return !!a && !a.guarded && !a.repo
}

/**
 * Every git repository an agent session worked in, those with one running
 * first, then the most recently active. Shells are not agents: they have no
 * pull requests of their own. With the daemon's `remotes`, a repository not
 * on GitHub is dropped and clones of one GitHub repository are one entry.
 */
export function pipelineRepos(sessions: readonly SessionSummary[], remotes?: RepoRemotes): PipelineRepo[] {
  const by = new Map<string, PipelineRepo>()
  for (const s of sessions) {
    if (s.kind === 'shell') continue
    const root = repoOf(s)
    if (!root || notAPipeline(remotes?.get(root))) continue
    const key = remotes?.get(root)?.repo?.toLowerCase() ?? root
    const r = by.get(key)
    if (!r) {
      by.set(key, { root, roots: [root], name: baseName(root), remote: remotes?.get(root)?.repo, session: s, live: running(s) ? 1 : 0 })
      continue
    }
    if (!r.roots.includes(root)) r.roots.push(root)
    if (running(s)) r.live++
    if ((s.last_event_at ?? 0) > (r.session.last_event_at ?? 0)) { r.session = s; r.root = root; r.name = baseName(root) }
  }
  const repos = [...by.values()].sort((a, b) => (b.live > 0 ? 1 : 0) - (a.live > 0 ? 1 : 0) || (b.session.last_event_at ?? 0) - (a.session.last_event_at ?? 0))
  // The same word twice tells nothing: say which one.
  const count = new Map<string, number>()
  for (const r of repos) count.set(r.name, (count.get(r.name) ?? 0) + 1)
  for (const r of repos) {
    if ((count.get(r.name) ?? 0) > 1) r.name = r.remote ?? parentAndBase(r.root)
  }
  return repos
}

/** What the Pipeline shows: the session it reads through, and the repository. */
export interface PipelinePick {
  repo?: PipelineRepo
  /** The session asked: `of` when it is in the repository shown, else the repository's newest. */
  session?: SessionSummary
}

/**
 * The repository shown: the one the address names, else the session it was
 * opened from, else the one picked last, else the first listed (one with an
 * agent running).
 */
export function pickPipeline(sessions: readonly SessionSummary[], want: { repo?: string; of?: string }, remembered = rememberedRepo(), remotes?: RepoRemotes): PipelinePick {
  const repos = pipelineRepos(sessions, remotes)
  const of = want.of ? sessions.find((s) => s.session_id === want.of && s.kind !== 'shell') : undefined
  const at = (root: string) => (root ? repos.find((r) => r.roots.includes(root)) : undefined)
  const named = want.repo || (of ? repoOf(of) : '')
  const repo = named || want.of ? at(named) : at(remembered) ?? repos[0]
  if (!repo) return {}
  return { repo, session: of && repo.roots.includes(repoOf(of)) ? of : repo.session }
}

/** The folders to ask the daemon about: each agent session's repository, once. */
export function remoteDirs(sessions: readonly SessionSummary[]): string[] {
  return [...new Set(sessions.filter((s) => s.kind !== 'shell').map(repoOf).filter(Boolean))].sort()
}

export function rememberedRepo(): string {
  try { return localStorage.getItem(REPO_KEY) ?? '' } catch { return '' }
}

export function rememberRepo(root: string): void {
  try { localStorage.setItem(REPO_KEY, root) } catch { /* this page only */ }
}
