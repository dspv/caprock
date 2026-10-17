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
  /** Its sessions charged only in part: each also worked on other pull requests and was cut between them. */
  shared?: number
  tokens_in?: number
  tokens_out?: number
  cache_read?: number
  cache_write?: number
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
  /** When GitHub last answered its pull request list (unix ms): with error, the row draws on that older read. */
  read_at?: number
  /** Its newest session's last event, or when it was listed if later (Unix ms). */
  last_active?: number
  /** Listed only because older repositories were asked. */
  older?: boolean
  /** GitHub's figures are being read (the daemon's quick answer). */
  pending?: boolean
  /** GitHub did not answer in time; asked again on the next refresh. */
  slow?: boolean
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

/** A listed GitHub repository the section does not read: no recent activity, hidden here, or past the bound. */
export interface RepoCIQuiet {
  project_id: number
  name: string
  repo: string
  last_active?: number
  why: 'older' | 'hidden' | 'more' | string
}

export interface ReposCI {
  github_connected: boolean
  status?: GitHubStatus
  repos: RepoCIRow[]
  quiet: RepoCIQuiet[]
  recent_days?: number
  fetched_at?: number
  refreshing?: boolean
  /** Why the daemon's newest composition failed: the answer is the one before it. */
  refresh_error?: string
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
    refreshing: o.refreshing === true,
    refresh_error: typeof o.refresh_error === 'string' ? o.refresh_error : undefined,
    recent_days: num(o.recent_days) || 14,
    quiet: arr<RepoCIQuiet>(o.quiet).filter((q) => q && typeof q === 'object' && typeof q.repo === 'string'),
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

/** Repositories hidden from the CI/CD section by hand (owner/name, lower case): this browser's, as hidden projects are. */
export const HIDDEN_REPOS_KEY = 'caprock.app.cicd-hidden-repos'

export function loadHiddenRepos(get: (k: string) => string | null = (k) => localStorage.getItem(k)): Set<string> {
  try {
    const v = JSON.parse(get(HIDDEN_REPOS_KEY) ?? 'null') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : [])
  } catch {
    return new Set()
  }
}

export function saveHiddenRepos(ids: ReadonlySet<string>): void {
  try { localStorage.setItem(HIDDEN_REPOS_KEY, JSON.stringify([...ids].sort())) } catch { /* not kept */ }
}

/** GitHub's refusal of a row in a calm line: a timeout or no connection is retried, so it says so. */
export function rowErrorText(r: Pick<RepoCIRow, 'error' | 'slow'>): string | undefined {
  if (!r.error) return undefined
  if (r.slow) return 'GitHub didn’t answer in time — retrying'
  if (r.error.kind === 'network') return 'GitHub not reachable — retrying'
  if (r.error.kind === 'rate_limit') return 'GitHub’s rate limit — retrying later'
  return r.error.message
}

/** One line for the section when every row was refused the same calm way; undefined otherwise (each row says its own). */
export function sectionErrorText(rows: RepoCIRow[]): string | undefined {
  if (rows.length < 2) return undefined
  const words = rows.map((r) => (r.error && (r.slow || r.error.kind === 'network' || r.error.kind === 'rate_limit') ? rowErrorText(r) : undefined))
  return words[0] && words.every((w) => w === words[0]) ? words[0] : undefined
}

/** The folded line under the rows: "3 older repositories · 1 hidden"; empty when there is nothing quiet. */
export function quietText(quiet: RepoCIQuiet[], days: number): { text: string; title: string; older: number; hidden: number } | undefined {
  if (quiet.length === 0) return undefined
  const n = (why: string) => quiet.filter((q) => q.why === why).length
  const older = n('older') + n('more')
  const hidden = n('hidden')
  const parts = [
    older > 0 ? `${older} older repositor${older === 1 ? 'y' : 'ies'}` : '',
    hidden > 0 ? `${hidden} hidden` : '',
  ].filter(Boolean)
  return {
    older,
    hidden,
    text: parts.join(' · '),
    title: `Listed repositories without a session in the last ${days} days, or hidden here, are not read from GitHub until shown`,
  }
}

/** A token count in compact units: "412.3M", "18.4k", "950". */
export function compactTokens(n: number): string {
  const a = Math.abs(n)
  const one = (v: number) => v.toFixed(1).replace(/\.0$/, '')
  if (a >= 1e9) return `${one(n / 1e9)}B`
  if (a >= 1e6) return `${one(n / 1e6)}M`
  if (a >= 1e3) return `${one(n / 1e3)}k`
  return String(Math.round(n))
}

/** A pull request's tokens: the total and its split, or undefined when none were recorded. */
export function prTokens(p: RepoCIPR): { text: string; title: string } | undefined {
  const parts = [num(p.tokens_in), num(p.tokens_out), num(p.cache_read), num(p.cache_write)] as const
  const total = parts[0] + parts[1] + parts[2] + parts[3]
  if (total <= 0) return undefined
  return {
    text: `${compactTokens(total)} tok`,
    title: `${total.toLocaleString()} tokens: input ${compactTokens(parts[0])} · output ${compactTokens(parts[1])} · cache read ${compactTokens(parts[2])} · cache write ${compactTokens(parts[3])}`,
  }
}

/** Why a pull request's cost is only part of a session, in words; undefined when every session counts whole. */
export function sharedTitle(p: RepoCIPR): string | undefined {
  const n = num(p.shared)
  if (n <= 0) return undefined
  return `${n === 1 ? 'A session' : `${n} sessions`} charged here also worked on other pull requests: ${n === 1 ? 'it is' : 'each is'} cut at each one it worked on (when it opened it, else when it last touched it), and this one is charged the part since the one before it — the newest also everything after.`
}

/**
 * A new answer over the last one: a row still being read (`pending`) keeps
 * the figures the last answer had for its repository, and GitHub's status
 * stays until a new one comes, so showing older repositories or hiding one
 * does not blank the rows already drawn while the daemon reads GitHub.
 */
export function keepWhileReading(prev: ReposCI | undefined, next: ReposCI): ReposCI {
  if (!prev) return next
  const had = new Map(prev.repos.filter((r) => !r.pending).map((r) => [r.repo, r]))
  return {
    ...next,
    status: next.status ?? (next.refreshing ? prev.status : undefined),
    repos: next.repos.map((r) => {
      const h = r.pending ? had.get(r.repo) : undefined
      return h ? { ...h, live: r.live, last_active: r.last_active, older: r.older } : r
    }),
  }
}
