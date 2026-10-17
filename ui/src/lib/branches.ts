/**
 * The session deck's Branches view (owner, 2026-10-12, translated: "seeing
 * branches with statistics would also be interesting"): the branches of the
 * session's repository from `GET /v1/sessions/{id}/branches` — local git for
 * the commits, one cached GitHub list for the pull requests, one indexed
 * query for what Caprock's sessions cost on each. Worded here; the daemon
 * orders them (the current one first, then by last activity) and marks the
 * stale ones.
 */
import type { PRDot } from './ci'
import { fmtCost } from './runnercost'
import type { PullRequest } from './github'
import type { DeckFresh } from './api'

/** A branch's pull request (`github.BranchPR`). */
export interface BranchPR {
  number: number
  url: string
  title?: string
  state: 'open' | 'closed' | 'merged'
  draft?: boolean
  base?: string
  head_sha?: string
  /** GitHub's stamps (unix ms): the Pipeline page's merges per day and time to merge. */
  created_at?: number
  merged_at?: number
  /** The head branch, and who opened it as GitHub names them (the avatar on avatars.githubusercontent.com). */
  head?: string
  author?: string
  author_avatar?: string
  /** Its GitHub labels, at most six: the Pipeline row's chips. */
  labels?: { name: string; color?: string }[]
}

/** One row (`api.SessionBranch`). */
export interface SessionBranch {
  name: string
  current?: boolean
  default?: boolean
  local: boolean
  remote: boolean
  ahead?: number
  behind?: number
  committed_ms: number
  author?: string
  sha?: string
  /** Its last commit's subject line; absent from an older daemon. */
  subject?: string
  pr?: BranchPR
  /** An open PR as the PRs view reads it, with its checks. */
  live?: PullRequest
  cost_usd: number
  sessions: number
  agents: string[]
  session_at?: number
  activity_at: number
  stale?: boolean
  /** Its changes are already on the default branch by content (a squash merge, a batch); checked only for a branch ahead of it, of the last 14 days, with no open PR. */
  landed?: boolean
}

/** GET /v1/sessions/{id}/branches. */
export interface SessionBranches extends DeckFresh {
  connected: boolean
  repo?: string
  reason?: 'no_repo'
  default?: string
  base?: string
  current?: string
  branches: SessionBranch[]
  error?: { message: string }
}

/** How many rows show before "Show all". */
export const BRANCHES_SHOWN = 15

/** The rows drawn: the first BRANCHES_SHOWN unless all were asked for. */
export function shownBranches(bs: SessionBranch[], all: boolean): SessionBranch[] {
  return all ? bs : bs.slice(0, BRANCHES_SHOWN)
}

/** Ahead and behind the default branch: "↑2 ↓1", "↑3", "even"; '' when not counted or it is the default. */
export function aheadBehind(b: SessionBranch): { text: string; title: string } {
  if (b.default || b.ahead === undefined || b.behind === undefined) return { text: '', title: '' }
  const base = 'the default branch'
  if (b.ahead === 0 && b.behind === 0) return { text: 'even', title: `Level with ${base}` }
  const text = [b.ahead > 0 ? `↑${b.ahead}` : '', b.behind > 0 ? `↓${b.behind}` : ''].filter(Boolean).join(' ')
  return { text, title: `${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead of ${base}, ${b.behind} behind` }
}

/** A short age: "now", "5m", "2h", "3d", "4mo". */
export function shortAge(ms: number): string {
  if (ms < 60_000) return 'now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  if (ms < 60 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d`
  return `${Math.floor(ms / (30 * 86_400_000))}mo`
}

/** The last commit: "2h · Ada" (age and author apart, so the author can give way), its tooltip the full time and author. */
export function lastCommit(b: SessionBranch, now: number): { text: string; age: string; author: string; title: string } {
  if (!b.committed_ms) return { text: '', age: '', author: '', title: '' }
  const age = shortAge(Math.max(0, now - b.committed_ms))
  const author = b.author ?? ''
  return { text: author ? `${age} · ${author}` : age, age, author, title: `Last commit ${new Date(b.committed_ms).toLocaleString()}${author ? ` by ${author}` : ''}` }
}

/** What Caprock's sessions on it cost: "$4.50 · 3 sessions"; '' when none worked on it. */
export function branchSpend(b: SessionBranch): { text: string; cost: string; count: string; title: string } {
  if (!b.sessions) return { text: '', cost: '', count: '', title: 'No Caprock session recorded on this branch' }
  const n = `${b.sessions} session${b.sessions === 1 ? '' : 's'}`
  return {
    text: `${fmtCost(b.cost_usd)} · ${n}`,
    cost: fmtCost(b.cost_usd),
    count: n,
    title: `${n} recorded on ${b.name} (${b.agents.join(', ') || 'claude'}), ${fmtCost(b.cost_usd)} at API list price — on a subscription an API-price equivalent, not money out of pocket`,
  }
}

/** The dot of a branch's PR. */
export function branchPRDot(p: BranchPR): PRDot {
  return p.state === 'open' ? (p.draft ? 'draft' : 'open') : p.state
}

/** The stale mark's tooltip. */
export const STALE_TITLE = 'Stale: no commit in 30 days and no open pull request'
