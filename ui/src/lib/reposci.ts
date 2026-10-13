/**
 * The Now screen's CI/CD section (components/CICDPanel.tsx, .ai/04-ui.md
 * § CI/CD on Now): the answer of GET /v1/repos/ci, read defensively, and its
 * figures in words. Pure.
 */
import type { RepoStats } from './api'

export interface StuckRun {
  id: number
  name: string
  branch?: string
  /** GitHub's: in_progress, else waiting for a runner (queued, waiting, pending, requested). */
  status: string
  url?: string
  since: number
  median_ms?: number
}

export interface GitHubStatus {
  /** none | minor | major | critical, the status page's own. */
  indicator: string
  description: string
  components: { name: string; status: string }[]
  incidents: { name: string; impact?: string; status?: string; url?: string }[]
  at: number
  error?: string
}

export interface RepoCIPR {
  number: number
  title?: string
  url: string
  state: string
  draft?: boolean
  author?: string
  author_avatar?: string
  cost_usd: number
  sessions: number
  live: number
}

export interface RepoCIAuthor {
  login: string
  avatar?: string
  prs: number
  merged: number
  cost_usd: number
}

export interface RepoCIRow {
  project_id: number
  name: string
  repo: string
  live: number
  ci?: RepoStats['ci']
  days?: string[]
  stuck: StuckRun[]
  open: number
  merged_7d: number
  top_prs: RepoCIPR[]
  authors: RepoCIAuthor[]
  release?: { tag: string; name?: string; url?: string; published_at: number; prerelease?: boolean }
  error?: { message: string; kind?: string }
}

export interface ReposCI {
  github_connected: boolean
  status?: GitHubStatus
  repos: RepoCIRow[]
  fetched_at?: number
  refreshing?: boolean
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The answer as the section reads it: an older daemon (404) or an odd answer is no rows, never a crash of Now. */
export function asReposCI(v: unknown): ReposCI {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<ReposCI>
  return {
    github_connected: o.github_connected === true,
    status: o.status && typeof o.status === 'object' ? { ...o.status, components: arr(o.status.components), incidents: arr(o.status.incidents) } : undefined,
    fetched_at: o.fetched_at,
    repos: arr<RepoCIRow>(o.repos).filter((r) => r && typeof r === 'object' && typeof r.repo === 'string').map((r) => ({
      ...r, live: num(r.live), open: num(r.open), merged_7d: num(r.merged_7d),
      stuck: arr(r.stuck), top_prs: arr(r.top_prs), authors: arr(r.authors), days: arr(r.days),
    })),
  }
}

/** GitHub's status as a word and a tone; nothing to say while it is fine and nothing is degraded. */
export function statusLine(s: GitHubStatus | undefined): { text: string; tone: 'ok' | 'warn' | 'fail' | 'faint'; title: string } | undefined {
  if (!s) return undefined
  if (s.error && !s.indicator) return { text: 'GitHub status not read', tone: 'faint', title: `githubstatus.com: ${s.error}` }
  const bad = s.components.filter((c) => c.status !== 'operational')
  const lines = [
    s.description,
    ...bad.map((c) => `${c.name}: ${c.status.replace(/_/g, ' ')}`),
    ...s.incidents.map((i) => `Incident: ${i.name}${i.status ? ` (${i.status})` : ''}`),
    'From githubstatus.com, read at most every 5 minutes',
  ]
  const tone = s.indicator === 'major' || s.indicator === 'critical' ? 'fail' : s.indicator === 'minor' || bad.length > 0 || s.incidents.length > 0 ? 'warn' : 'ok'
  const text = tone === 'ok' ? 'GitHub operational' : bad.length > 0 ? `GitHub: ${bad.map((c) => c.name).slice(0, 2).join(', ')} ${bad[0]!.status === 'major_outage' ? 'down' : 'degraded'}` : `GitHub: ${s.description}`
  return { text, tone, title: lines.filter(Boolean).join('\n') }
}

/** Red runs as a share: "6.4%", "12%"; undefined with no finished run. */
export function redPct(ci: RepoStats['ci'] | undefined): string | undefined {
  if (!ci || ci.runs <= 0) return undefined
  const p = (ci.red / ci.runs) * 100
  return p > 0 && p < 10 ? `${p.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(p)}%`
}

/** A stuck run in words: "ci on feat/x running 41m, median 9m"; "release queued 22m". */
export function stuckText(r: StuckRun, now: number, span: (ms: number) => string): string {
  const took = span(Math.max(0, now - r.since))
  const where = r.branch ? ` on ${r.branch}` : ''
  if (r.status === 'in_progress') return `${r.name}${where} running ${took}${r.median_ms ? `, median ${span(r.median_ms)}` : ''}`
  return `${r.name}${where} waiting for a runner ${took}`
}

/** The distinct GitHub owners of the rows, for one Actions usage read each. */
export function owners(rows: RepoCIRow[]): string[] {
  return [...new Set(rows.map((r) => r.repo.split('/')[0] ?? '').filter(Boolean))]
}
