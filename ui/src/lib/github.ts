/**
 * GitHub (F14, WP-19): the typed client for .ai/03-contracts.md § GitHub, the
 * live store of the pull requests the daemon follows, and the words the
 * interface uses for their state. The daemon holds the token and makes every
 * call; nothing here ever sees it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError, deviceToken, errText } from './api'
import { live } from './live'

/** A GitHub failure, as the daemon says it: `error` is the whole sentence. */
export interface GitHubError {
  kind: string
  status?: number
  doing: string
  message: string
  retry_at?: number
  needs?: string[]
  at: number
}

export interface GitHubUser { login: string; name?: string; avatar_url?: string; html_url?: string }
export interface GitHubRate { resource: string; limit: number; remaining: number; reset_at: number; used: number }

export interface GitHubDevice {
  state: 'pending' | 'done' | 'denied' | 'expired' | 'error'
  user_code?: string
  verification_uri?: string
  expires_at?: number
  interval?: number
  error?: GitHubError
}

export type GitHubSource = 'gh' | 'token' | 'oauth'

export interface GitHubStatus {
  connected: boolean
  source?: GitHubSource
  user?: GitHubUser
  scopes: string[]
  scopes_known: boolean
  token_kind?: string
  checked_at?: number
  sources: { gh: boolean; stored: boolean; store: 'keychain' | 'file' | ''; store_note?: string; oauth: boolean; client?: string }
  health: { last_ok_at?: number; error?: GitHubError; rate?: GitHubRate; paused_until?: number }
  device?: GitHubDevice
  notify: boolean
  tracked: number
}

export interface GitHubOwner { login: string; avatar_url?: string; org: boolean }

export interface GitHubRepo {
  full_name: string
  name: string
  owner: string
  private: boolean
  fork: boolean
  archived: boolean
  description?: string
  clone_url: string
  ssh_url: string
  html_url: string
  default_branch?: string
  pushed_at?: string
}

export interface RepoPage { repos: GitHubRepo[]; page: number; next: boolean; search?: boolean }

export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped'

export interface PRCheck { name: string; state: CheckState; url?: string }
export interface PRReview { user: string; state: 'approved' | 'changes_requested' | 'commented' | 'dismissed'; at?: number }

export interface PullRequest {
  project_id: number
  worktree: string
  branch: string
  repo: string
  number: number
  url: string
  title: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  base: string
  head_sha: string
  mergeable: boolean | null
  mergeable_state?: string
  review: '' | 'approved' | 'changes_requested' | 'review_required' | 'commented'
  reviews: PRReview[]
  checks: { state: 'pass' | 'fail' | 'pending' | 'none'; passed: number; failed: number; pending: number; items: PRCheck[] }
  at: number
  error?: GitHubError
}

export interface PRDraft { title: string; body: string; commits: string[] }

export interface WorktreeGitHub {
  connected: boolean
  repo: { owner: string; name: string; full_name: string; html_url: string } | null
  reason?: 'no_remote' | 'not_github' | 'detached' | 'default_branch'
  branch: string
  base: string
  remote?: string
  published: boolean
  ahead: number
  pr: PullRequest | null
  draft?: PRDraft
  primed: boolean
}

export interface CreatePRResult {
  pr: PullRequest
  pushed: boolean
  push?: { remote?: string; branch?: string; upstream_set?: boolean; output?: string }
}

export interface CreateRepoResult {
  repo: GitHubRepo
  remote: string
  remote_url: string
  pushed: boolean
  push_error?: { error: string; kind: string; output?: string }
}

async function send<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') h['Content-Type'] = 'application/json'
  const t = deviceToken()
  if (t) h['X-Caprock-Device'] = t
  const res = await fetch(path, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) })
  if (!res.ok) {
    let b: unknown
    try { b = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, b)
  }
  return (await res.json()) as T
}

function wt(projectId: string | number, worktree: string, sub = ''): string {
  const q = worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''
  return `/v1/projects/${encodeURIComponent(String(projectId))}/github${sub}${q}`
}

export const githubApi = {
  status: () => send<GitHubStatus>('/v1/github', 'GET'),
  connect: (source: 'gh' | 'token', token?: string) => send<GitHubStatus>('/v1/github/connect', 'POST', { source, token }),
  disconnect: () => send<GitHubStatus>('/v1/github', 'DELETE'),
  setNotify: (notify: boolean) => send<GitHubStatus>('/v1/github', 'PATCH', { notify }),
  startDevice: () => send<{ device: GitHubDevice }>('/v1/github/device', 'POST').then((r) => r.device),
  device: () => send<{ device: GitHubDevice | null }>('/v1/github/device', 'GET').then((r) => r.device),
  cancelDevice: () => send<{ device: null }>('/v1/github/device', 'DELETE'),
  owners: () => send<{ owners: GitHubOwner[] }>('/v1/github/owners', 'GET').then((r) => r.owners),
  repos: (owner: string, q: string, page: number) => {
    const p = new URLSearchParams()
    if (owner) p.set('owner', owner)
    if (q) p.set('q', q)
    p.set('page', String(page))
    return send<RepoPage>(`/v1/github/repos?${p.toString()}`, 'GET')
  },
  prs: () => send<{ prs: PullRequest[] }>('/v1/github/prs', 'GET').then((r) => r.prs),
  worktree: (projectId: string | number, worktree: string) => send<WorktreeGitHub>(wt(projectId, worktree), 'GET'),
  refresh: (projectId: string | number, worktree: string) => send<WorktreeGitHub>(wt(projectId, worktree, '/refresh'), 'POST'),
  createPR: (projectId: string | number, worktree: string, req: { title: string; body: string; base?: string; draft: boolean }) =>
    send<CreatePRResult>(wt(projectId, worktree, '/pr'), 'POST', req),
  createRepo: (projectId: string | number, req: { name: string; owner?: string; private: boolean; description?: string; protocol: 'https' | 'ssh'; push: boolean }) =>
    send<CreateRepoResult>(`/v1/projects/${encodeURIComponent(String(projectId))}/github/repo`, 'POST', req),
}

/** The sentence to show for a failure: the daemon's `error` (what was being done, and what GitHub said). */
export function githubErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 404 && !(e.body as { kind?: string } | undefined)?.kind) {
    const b = e.body as { error?: string } | undefined
    if (!b?.error || b.error.startsWith('no such endpoint')) return 'This Caprock daemon has no GitHub integration; update it.'
  }
  return errText(e)
}

/** The pull request a 409 "already open" answer carries. */
export function existingPR(e: unknown): PullRequest | undefined {
  if (e instanceof ApiError && e.status === 409) return (e.body as { pr?: PullRequest } | undefined)?.pr
  return undefined
}

// ── The followed pull requests, kept current by `github` frames ────────────

export type GitHubFrame =
  | { kind: 'pr'; pr: PullRequest }
  | { kind: 'pr_gone'; project_id: number; worktree: string }
  | { kind: 'account'; account: GitHubStatus }

export function prKey(projectId: string | number, worktree: string): string {
  return `${projectId}/${worktree}`
}

/** Every followed pull request by worktree, and the connection; one copy for every screen. */
class PRStore {
  private prs = new Map<string, PullRequest>()
  private account: GitHubStatus | null = null
  private listeners = new Set<() => void>()
  private started = false
  private version = 0

  start(): void {
    if (this.started) return
    this.started = true
    live.start()
    live.onFrame((f) => {
      if (f.type === 'github') this.apply(f.data as GitHubFrame)
      else if (f.type === 'reset' || f.type === 'hello') void this.load()
    })
    void this.load()
  }

  async load(): Promise<void> {
    try {
      const prs = await githubApi.prs()
      this.prs = new Map(prs.map((p) => [prKey(p.project_id, p.worktree), p]))
      this.emit()
    } catch { /* an older daemon, or not reachable: nothing to show */ }
  }

  apply(f: GitHubFrame): void {
    if (f.kind === 'pr') this.prs.set(prKey(f.pr.project_id, f.pr.worktree), f.pr)
    else if (f.kind === 'pr_gone') this.prs.delete(prKey(f.project_id, f.worktree))
    else if (f.kind === 'account') {
      this.account = f.account
      if (!f.account.connected) this.prs.clear()
    }
    this.emit()
  }

  get(key: string): PullRequest | undefined { return this.prs.get(key) }
  accountFrame(): GitHubStatus | null { return this.account }
  snapshot = (): number => this.version

  subscribe = (fn: () => void): (() => void) => {
    this.start()
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private emit(): void {
    this.version += 1
    for (const fn of this.listeners) fn()
  }
}

export const prStore = new PRStore()

/** The followed pull request of a worktree, live. */
export function usePR(projectId: string | number | undefined, worktree: string): PullRequest | undefined {
  useSyncExternalStore(prStore.subscribe, prStore.snapshot, prStore.snapshot)
  return projectId === undefined ? undefined : prStore.get(prKey(projectId, worktree))
}

/** The connection's status, read once and kept current by `account` frames. */
export function useGitHubStatus(): { status?: GitHubStatus; error?: string; reload: () => void; set: (s: GitHubStatus) => void } {
  const [status, setStatus] = useState<GitHubStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [n, setN] = useState(0)
  const version = useSyncExternalStore(prStore.subscribe, prStore.snapshot, prStore.snapshot)
  useEffect(() => {
    let alive = true
    githubApi.status().then((s) => { if (alive) { setStatus(s); setError(undefined) } }).catch((e: unknown) => { if (alive) setError(githubErrorText(e)) })
    return () => { alive = false }
  }, [n])
  useEffect(() => {
    const a = prStore.accountFrame()
    if (a) setStatus(a)
  }, [version])
  return { status, error, reload: () => setN((x) => x + 1), set: setStatus }
}

// ── Words ───────────────────────────────────────────────────────────────

/** The source as a person names it. */
export function sourceLabel(s?: GitHubSource): string {
  if (s === 'gh') return 'your GitHub CLI login'
  if (s === 'oauth') return 'Sign in with GitHub'
  if (s === 'token') return 'a token you pasted'
  return ''
}

/** "3 min ago", "just now", "2 h ago". */
export function agoText(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

/** The local time of day for a unix-ms time, "14:05". */
export function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** One line for the checks: "2 of 3 checks passed · lint failed". */
export function checksText(c: PullRequest['checks']): string {
  const total = c.items.length
  if (total === 0) return 'no checks'
  if (c.state === 'fail') {
    const failed = c.items.filter((i) => i.state === 'fail').map((i) => i.name)
    return `${failed.slice(0, 2).join(', ')}${failed.length > 2 ? ` +${failed.length - 2}` : ''} failed`
  }
  if (c.state === 'pending') return `${c.pending} of ${total} checks running`
  return total === 1 ? 'check passed' : `all ${total} checks passed`
}

/** The review state in words, or '' when nothing to say. */
export function reviewText(r: PullRequest['review']): string {
  switch (r) {
    case 'approved': return 'approved'
    case 'changes_requested': return 'changes requested'
    case 'review_required': return 'review requested'
    case 'commented': return 'commented'
    default: return ''
  }
}

/** Whether it can be merged, in words. */
export function mergeText(pr: PullRequest): string {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.draft) return 'draft'
  if (pr.mergeable === null) return 'checking mergeability'
  if (!pr.mergeable || pr.mergeable_state === 'dirty') return 'has conflicts'
  switch (pr.mergeable_state) {
    case 'clean': return 'ready to merge'
    case 'blocked': return 'blocked by branch rules'
    case 'behind': return 'behind its base'
    case 'unstable': return 'mergeable, checks not green'
    default: return 'mergeable'
  }
}

/** The tone a pull request's dot is drawn in. */
export type PRTone = 'ok' | 'fail' | 'pending' | 'merged' | 'closed' | 'none'

export function prTone(pr: PullRequest): PRTone {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.checks.state === 'fail' || pr.review === 'changes_requested') return 'fail'
  if (pr.checks.state === 'pending') return 'pending'
  if (pr.checks.state === 'pass') return 'ok'
  return 'none'
}

/** A short title for the sidebar's dot: "#12 · build failed · approved". */
export function prSummary(pr: PullRequest): string {
  const parts = [`#${pr.number} ${pr.title}`]
  if (pr.state !== 'open') parts.push(pr.state)
  else {
    parts.push(checksText(pr.checks))
    const r = reviewText(pr.review)
    if (r) parts.push(r)
    parts.push(mergeText(pr))
  }
  if (pr.error) parts.push(`last read failed: ${pr.error.message}`)
  return parts.join(' · ')
}
