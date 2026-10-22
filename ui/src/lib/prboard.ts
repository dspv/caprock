/**
 * The Pipeline page's Board (components/PRBoard.tsx, .ai/21-app.md § Pipeline
 * tab): the pull requests by the stage they are in, the releases they shipped
 * in, and the flow between. The daemon decides each card's stage
 * (internal/api/prboard.go); this file names the stages, reads the answer
 * defensively and says the figures in words. Pure.
 *
 * "Agent cost" is what Caprock recorded agents spending on a pull request at
 * API list price — never a bill (rule 6).
 */
import type { BranchPR } from './branches'

export type Stage = 'draft' | 'open' | 'fix' | 'ready' | 'merged' | 'released'

/** What Caprock recorded of agent work for one pull request (store.PRSpend). */
export interface PRSpend {
  cost_usd: number
  sessions: number
  /** Sessions still running on it. */
  live: number
  agents: string[]
  /** How the cost came: the sessions on its head branch, and those cut at their pull requests. */
  by_branch?: number
  by_slice?: number
}

export interface BoardCard {
  number: number
  stage: Stage
  /** Since when it is in the stage (unix ms). */
  stage_at?: number
  ci?: 'running' | 'fail' | 'pass' | 'none'
  why?: 'ci' | 'conflict' | 'changes_requested'
  /** With `why` ci: the failed checks' names (or workflows'), at most three; absent from an older daemon. */
  failed?: string[]
  /** Its checks by the OS their names say ("go (windows-latest)"), linux, macos, windows in that order; absent without a live read or when no check names an OS. */
  os?: BoardOS[]
  /** How long its head commit's checks took, first start to last finish, once all are done (ms). */
  ci_ms?: number
  review?: string
  release?: string
  spend: PRSpend
  /** Its checks are from an earlier read: not re-confirmed this time. */
  stale?: boolean
}

/** One OS's checks on a pull request's head commit (internal/api/prboard.go BoardOS). */
export interface BoardOS {
  os: 'linux' | 'macos' | 'windows'
  /** fail when any failed, else running while any is unfinished, else pass. */
  state: 'pass' | 'fail' | 'running'
  /** While running: the earliest start of its unfinished checks (unix ms). */
  since?: number
  checks: number
}

export interface BoardRelease {
  tag: string
  name?: string
  url?: string
  published_at: number
  prerelease?: boolean
  /** How many files are uploaded to it; absent from an older daemon. */
  assets?: number
  /** Pull requests merged into the default branch after the release before it, up to this one. */
  prs: number[]
  cost_usd: number
  sessions: number
  /** The listed pull requests may not reach back to the release before it. */
  partial?: boolean
}

export interface BoardFlow {
  counts: Record<Stage, number>
  days: number
  merged: number
  ttm_median_ms?: number
  ttm_count: number
  /** Merged → released: an estimate, the release matched by time. */
  release_lag_median_ms?: number
  release_lag_count: number
  /** Release → release: the median gap between published releases, and how many gaps it is of. */
  release_gap_median_ms?: number
  release_gap_count?: number
  ci_median_ms?: number
  cost_usd: number
  /** Each figure day by day over the window, keyed by the figure (flight,
   *  throughput, ci, ttm, lag, cost); absent from an older daemon. */
  series?: Partial<Record<SeriesKey, FlowPoint[]>>
}

/** The figures that have a day-by-day series (internal/api/prboardseries.go). */
export type SeriesKey = 'flight' | 'throughput' | 'ci' | 'ttm' | 'lag' | 'cost'
const SERIES_KEYS: readonly SeriesKey[] = ['flight', 'throughput', 'ci', 'ttm', 'lag', 'cost']

/** One local day of a figure's series. */
export interface FlowPoint {
  /** "2026-10-14", the daemon's local calendar day. */
  day: string
  /** The day's figure; absent on a day with no sample for a median: a gap, not a zero. */
  value?: number
  /** How many samples it rests on. */
  n: number
  /** A running total's value up to the clock time it is now (throughput, cost). */
  by_now?: number
}

const fin = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The series as the tiles read them: an odd point is a gap, an odd series none. */
function asSeries(v: unknown): Partial<Record<SeriesKey, FlowPoint[]>> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Partial<Record<SeriesKey, FlowPoint[]>> = {}
  for (const k of SERIES_KEYS) {
    const pts = (v as Record<string, unknown>)[k]
    if (!Array.isArray(pts)) continue
    out[k] = pts.filter((p): p is FlowPoint => !!p && typeof p === 'object' && typeof (p as FlowPoint).day === 'string')
      .map((p) => ({ day: p.day, value: fin(p.value), n: fin(p.n) ?? 0, by_now: fin(p.by_now) }))
  }
  return out
}

export interface PRBoard {
  cards: BoardCard[]
  releases: BoardRelease[]
  flow: BoardFlow
  default_branch?: string
  /** How merged work ships here (`ShipsBy`); absent from an older daemon or when a read failed. */
  ships_by?: ShipsBy
}

/**
 * How merged work ships in a repository (internal/api/prboard.go shipsBy):
 * `release` when a published release or a version tag is dated within the
 * last 180 days; `merge` when neither is and both were read — a site
 * deployed on every merge, where merged is the last step. Absent: it cannot
 * be said, and a merge claims no release wait (lib/journey releaseNote).
 */
export type ShipsBy = 'release' | 'merge'

export const STAGES: { key: Stage; label: string; note: string }[] = [
  { key: 'draft', label: 'Draft', note: 'Opened as a draft: not ready for review' },
  { key: 'open', label: 'CI running', note: 'Open, its checks running (or not read yet)' },
  { key: 'fix', label: 'Needs a fix', note: 'A red check, a merge conflict or changes requested' },
  { key: 'ready', label: 'Ready', note: 'Checks green, or none: waiting for a review or a merge' },
  { key: 'merged', label: 'Merged', note: 'Merged, in no published release yet' },
  { key: 'released', label: 'Released', note: 'In a published release: the first one published after the merge' },
]

const STAGE_KEYS = new Set<string>(STAGES.map((s) => s.key))

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function asSpend(v: unknown): PRSpend {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<PRSpend>
  return { cost_usd: num(o.cost_usd), sessions: num(o.sessions), live: num(o.live), agents: Array.isArray(o.agents) ? o.agents.filter((a) => typeof a === 'string') : [], by_branch: num(o.by_branch), by_slice: num(o.by_slice) }
}

/** The answer as the board reads it: an older daemon (no board) or an odd answer is no board, never a crash. */
export function asBoard(v: unknown): PRBoard | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Partial<PRBoard>
  if (!Array.isArray(o.cards)) return undefined
  const f = (o.flow ?? {}) as Partial<BoardFlow>
  const counts = {} as Record<Stage, number>
  for (const s of STAGES) counts[s.key] = num((f.counts as Record<string, unknown> | undefined)?.[s.key])
  return {
    default_branch: typeof o.default_branch === 'string' ? o.default_branch : undefined,
    ships_by: o.ships_by === 'release' || o.ships_by === 'merge' ? o.ships_by : undefined,
    cards: o.cards.filter((c) => c && typeof c === 'object' && STAGE_KEYS.has((c as BoardCard).stage)).map((c) => ({ ...c, spend: asSpend(c.spend) })),
    releases: (Array.isArray(o.releases) ? o.releases : []).filter((r) => r && typeof r === 'object' && typeof r.tag === 'string')
      .map((r) => ({ ...r, prs: Array.isArray(r.prs) ? r.prs : [], cost_usd: num(r.cost_usd), sessions: num(r.sessions), published_at: num(r.published_at), assets: fin(r.assets) })),
    flow: {
      counts, days: num(f.days) || 14, merged: num(f.merged), ttm_median_ms: f.ttm_median_ms || undefined, ttm_count: num(f.ttm_count),
      release_lag_median_ms: f.release_lag_median_ms || undefined, release_lag_count: num(f.release_lag_count),
      release_gap_median_ms: f.release_gap_median_ms || undefined, release_gap_count: num(f.release_gap_count), ci_median_ms: f.ci_median_ms || undefined, cost_usd: num(f.cost_usd),
      series: asSeries(f.series),
    },
  }
}

export interface BoardItem extends BoardCard {
  pr?: BranchPR
}

/** The board's columns in stage order, each card joined with its pull request (title, author, link). */
export function boardColumns(board: PRBoard, prs: BranchPR[]): { stage: (typeof STAGES)[number]; cards: BoardItem[] }[] {
  const byNum = new Map(prs.map((p) => [p.number, p]))
  return STAGES.map((stage) => ({ stage, cards: board.cards.filter((c) => c.stage === stage.key).map((c) => ({ ...c, pr: byNum.get(c.number) })) }))
}

export type ChipTone = 'ok' | 'fail' | 'pending' | 'muted' | 'faint' | 'merged'

/** A card's CI chip: what its head commit's checks say. */
export function ciChip(c: Pick<BoardCard, 'ci' | 'stage' | 'why'>): { text: string; tone: ChipTone; title: string } | undefined {
  if (c.stage === 'merged' || c.stage === 'released') return undefined
  // A draft whose checks were not read says nothing: it is not waiting on them.
  if (c.stage === 'draft' && !c.ci) return undefined
  if (c.why === 'conflict') return { text: 'conflict', tone: 'fail', title: 'GitHub says it conflicts with its base branch' }
  if (c.why === 'changes_requested') return { text: 'changes requested', tone: 'fail', title: 'A reviewer asked for changes' }
  switch (c.ci) {
    case 'running': return { text: 'CI running', tone: 'pending', title: 'Its head commit’s checks are running' }
    case 'fail': return { text: 'CI red', tone: 'fail', title: 'A check on its head commit failed' }
    case 'pass': return { text: 'CI green', tone: 'ok', title: 'Every check on its head commit passed' }
    case 'none': return { text: 'no checks', tone: 'muted', title: 'No check ran on its head commit' }
  }
  return { text: 'CI not read', tone: 'faint', title: 'Its checks were not read: only the newest open pull requests’ are' }
}

/** The agent cost as a card says it; nothing when no session was recorded on it. */
export function costText(s: PRSpend): string {
  if (s.sessions === 0) return ''
  if (s.cost_usd > 0 && s.cost_usd < 0.01) return '<$0.01'
  if (s.cost_usd >= 1000) return `$${(s.cost_usd / 1000).toFixed(1)}k`
  if (s.cost_usd >= 100) return `$${Math.round(s.cost_usd)}`
  return `$${s.cost_usd.toFixed(2)}`
}

export const AGENT_COST_NOTE = 'Agent cost: what Caprock recorded agents spending on it, at API list price, not a bill. The sessions on its branch count whole; a session that worked on several pull requests is cut at each one’s opening (else its last touch), its fix-ups going to the newest.'

/** The tooltip under a card's cost: how many sessions, which agents, and how the cost is counted. */
export function costTitle(s: PRSpend): string {
  if (s.sessions === 0) return 'No Caprock session was recorded on it: no agent cost'
  const who = `${s.sessions} session${s.sessions === 1 ? '' : 's'}${s.agents.length ? ` (${s.agents.join(', ')})` : ''}`
  const live = s.live > 0 ? `, ${s.live} running now` : ''
  return `$${s.cost_usd.toFixed(2)} from ${who}${live}\n${AGENT_COST_NOTE}`
}

/** Merges a day over the window: "1.4/day", "0.1/day". */
export function perDay(merged: number, days: number): string {
  if (days <= 0) return ''
  const v = merged / days
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}/day`
}

/** One or two letters for an avatar that did not load. */
export function initials(login: string): string {
  const parts = login.replace(/\[bot\]$/i, '').split(/[-_.\s]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return (parts[0] ?? '?').slice(0, 2).toUpperCase()
}

/** How many rows each list of the Most expensive panel shows. */
export const TOP_SHOWN = 5

/** One row of the Most expensive panel's pull requests: a card joined with its title and link. */
export interface TopPR {
  number: number
  title?: string
  url?: string
  stage: Stage
  spend: PRSpend
}

/**
 * The board's pull requests by recorded agent cost, dearest first, at most
 * `n` (owner, 2026-10-23, translated: "TOP-5 most expensive pull requests").
 * The cards are the board's own — open ones and merges in its window, from
 * the newest listed — so this ranks only what the board holds, never all
 * time. One with no session or no cost is left out; a tie goes to more
 * sessions, then the newer number.
 */
export function topPRs(board: PRBoard, prs: BranchPR[], n = TOP_SHOWN): TopPR[] {
  const byNum = new Map(prs.map((p) => [p.number, p]))
  return board.cards
    .filter((c) => c.spend.sessions > 0 && c.spend.cost_usd > 0)
    .sort((a, b) => b.spend.cost_usd - a.spend.cost_usd || b.spend.sessions - a.spend.sessions || b.number - a.number)
    .slice(0, Math.max(0, n))
    .map((c) => { const p = byNum.get(c.number); return { number: c.number, title: p?.title, url: p?.url, stage: c.stage, spend: c.spend } })
}

/**
 * The board's releases (its newest published ones) by the recorded agent
 * cost of the merges they shipped, dearest first, at most `n`. One with no
 * cost or no session is left out; a tie goes to more pull requests, then the
 * newer release.
 */
export function topReleases(board: PRBoard, n = TOP_SHOWN): BoardRelease[] {
  return board.releases
    .filter((r) => r.sessions > 0 && r.cost_usd > 0)
    .sort((a, b) => b.cost_usd - a.cost_usd || b.prs.length - a.prs.length || b.published_at - a.published_at)
    .slice(0, Math.max(0, n))
}

/** How many cards a column shows before "+N more": the done columns grow all day. */
export const COLUMN_SHOWN = 8
