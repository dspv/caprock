/**
 * Which repository the Pipeline shows (.ai/04-ui.md § Pipeline). It is a page
 * of the dashboard since 2026-10-15 (owner, translated: "build it into the
 * Dashboard as a separate page … Pipeline is part of the Dashboard"), so it
 * is no longer opened from one agent's tab: it shows a repository, picked in
 * its header, and reads it through the newest agent session in it — the
 * daemon's routes are a session's (…/sessions/{id}/ci/stats). Pure, apart
 * from the remembered choice.
 */
import type { SessionSummary } from './api'

/** One repository the Pipeline can show: its folder, its name, the session it is read through. */
export interface PipelineRepo {
  /** The repository's folder on this machine (a session's repo_root, else its cwd). */
  root: string
  name: string
  /** The newest agent session in it: the one the daemon is asked through. */
  session: SessionSummary
  /** Agent sessions running in it now. */
  live: number
}

const REPO_KEY = 'caprock.pipeline.repo'

/** The folder a session's repository is known by. */
export function repoOf(s: Pick<SessionSummary, 'repo_root' | 'cwd'>): string {
  return s.repo_root || s.cwd || ''
}

function nameOf(root: string, s: SessionSummary): string {
  const base = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return base || s.project || root
}

const running = (s: SessionSummary) => s.status !== 'ended' && !s.detached

/**
 * Every repository an agent session worked in, those with one running first,
 * then the most recently active. Shells are not agents: they have no pull
 * requests of their own.
 */
export function pipelineRepos(sessions: readonly SessionSummary[]): PipelineRepo[] {
  const by = new Map<string, PipelineRepo>()
  for (const s of sessions) {
    if (s.kind === 'shell') continue
    const root = repoOf(s)
    if (!root) continue
    const r = by.get(root)
    if (!r) { by.set(root, { root, name: nameOf(root, s), session: s, live: running(s) ? 1 : 0 }); continue }
    if (running(s)) r.live++
    if ((s.last_event_at ?? 0) > (r.session.last_event_at ?? 0)) r.session = s
  }
  return [...by.values()].sort((a, b) => (b.live > 0 ? 1 : 0) - (a.live > 0 ? 1 : 0) || (b.session.last_event_at ?? 0) - (a.session.last_event_at ?? 0))
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
export function pickPipeline(sessions: readonly SessionSummary[], want: { repo?: string; of?: string }, remembered = rememberedRepo()): PipelinePick {
  const repos = pipelineRepos(sessions)
  const of = want.of ? sessions.find((s) => s.session_id === want.of && s.kind !== 'shell') : undefined
  const root = want.repo || (of ? repoOf(of) : '') || remembered
  const repo = repos.find((r) => r.root === root) ?? (want.repo || of ? undefined : repos[0])
  if (!repo) return {}
  return { repo, session: of && repoOf(of) === repo.root ? of : repo.session }
}

export function rememberedRepo(): string {
  try { return localStorage.getItem(REPO_KEY) ?? '' } catch { return '' }
}

export function rememberRepo(root: string): void {
  try { localStorage.setItem(REPO_KEY, root) } catch { /* this page only */ }
}
