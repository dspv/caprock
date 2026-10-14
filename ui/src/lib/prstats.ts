/**
 * The words and shapes of the Pipeline page (components/PRsCITab.tsx,
 * .ai/21-app.md § Pipeline page): the job × runner grid, the list's rows in
 * each scope, and the figures said as text. Pure: the tab draws, this
 * decides. Every figure is GitHub's or counted from GitHub's stamps; one that
 * is not reported, or would rest on fewer than two values, is left out.
 */
import type { CIJob, CIRun, RepoStats, SessionPRLive } from './api'
import type { BranchPR } from './branches'
import { ciTone, fmtRun } from './ci'

/** The OS a runner is, as a column of the grid. */
export type GridOS = 'linux' | 'macos' | 'windows' | 'other'
export const GRID_OS_LABEL: Record<GridOS, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows', other: 'Other' }
const GRID_ORDER: GridOS[] = ['linux', 'macos', 'windows', 'other']

/** A matrix job's OS in its name: "go (windows-latest)", "test (macos-14)". */
const OS_SUFFIX = /\s*\((?:ubuntu|linux|macos|mac|windows|win)[^()]*\)\s*$/i

/** The job's name without its matrix OS: "go (windows-latest)" → "go". */
export function jobFamily(name: string): string {
  return name.replace(OS_SUFFIX, '') || name
}

function gridOS(job: CIJob): GridOS {
  const os = job.os ?? ''
  return os === 'linux' || os === 'macos' || os === 'windows' ? os : 'other'
}

/** The job × runner grid: a row per job (its OS taken out of the name), a column per OS the jobs ran on. */
export interface JobGrid {
  families: string[]
  oses: GridOS[]
  cell: (family: string, os: GridOS) => CIJob | undefined
}

/** Every job of the runs but the skipped ones, laid out by name and OS; the first of a pair wins. */
export function jobGrid(runs: CIRun[]): JobGrid {
  const families: string[] = []
  const seen = new Set<GridOS>()
  const cells = new Map<string, CIJob>()
  for (const r of runs) {
    for (const j of r.jobs) {
      if (ciTone(j) === 'skipped' && j.conclusion === 'skipped') continue
      const f = jobFamily(j.name)
      const os = gridOS(j)
      if (!families.includes(f)) families.push(f)
      seen.add(os)
      const k = `${f}\u0000${os}`
      if (!cells.has(k)) cells.set(k, j)
    }
  }
  return { families, oses: GRID_ORDER.filter((o) => seen.has(o)), cell: (f, os) => cells.get(`${f}\u0000${os}`) }
}

/** A job's time set against its median: "+18%", coloured past +20% and below −10%. */
export function vsMedianText(ms: number | undefined, median: number | undefined): { text: string; tone: 'warn' | 'ok' | 'muted' } | undefined {
  if (!ms || !median) return undefined
  const p = Math.round(((ms - median) / median) * 100)
  return { text: `${p > 0 ? '+' : ''}${p}%`, tone: p > 20 ? 'warn' : p < -10 ? 'ok' : 'muted' }
}

/** A span of minutes or more, short: "8m", "2h 10m", "3d 4h". */
export function spanText(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** A share as a percentage with one decimal under ten: "6.4%", "12%". */
export function pctText(part: number, whole: number): string {
  if (whole <= 0) return ''
  const p = (part / whole) * 100
  return p > 0 && p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

/** The stats strip's figures, said as text; each absent when GitHub's answer does not hold it. */
export interface StatsWords {
  merged: { total: number; last7: number; today: number }
  ttm?: { text: string; title: string }
  ttmNote: string
  ci?: { name: string; text: string; note: string }
  red?: { text: string; note: string; title: string }
}

export function statsWords(st: RepoStats): StatsWords {
  const days = st.days.length
  const out: StatsWords = {
    merged: { total: sum(st.merged), last7: sum(st.merged.slice(-7)), today: st.merged.at(-1) ?? 0 },
    ttmNote: st.ttm_count >= 2 ? `median of ${st.ttm_count} merged, opened → merged` : st.ttm_count === 1 ? 'one merge: no median yet' : `nothing merged in ${days} days`,
  }
  if (st.ttm_median_ms && st.ttm_count >= 2) {
    out.ttm = { text: spanText(st.ttm_median_ms), title: `The median time from opened to merged of the ${st.ttm_count} pull requests merged in the last ${days} days, from GitHub's stamps. Counted from the repository's ${st.prs_listed} most recently updated pull requests.` }
  }
  const w = st.ci.workflows[0]
  if (w && w.median_ms) out.ci = { name: w.name, text: fmtRun(w.median_ms), note: `median of ${w.median_runs} successful runs` }
  if (st.ci.runs > 0) {
    const reach = st.ci.oldest ? new Date(st.ci.oldest).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
    out.red = {
      text: pctText(st.ci.red, st.ci.runs),
      note: `${st.ci.red} of ${st.ci.runs} runs · ${st.ci.reruns} re-run${st.ci.reruns === 1 ? '' : 's'}`,
      title: `Runs that failed, timed out or could not start, of those that passed or failed; cancelled and skipped runs are neither. From the repository's newest ${st.ci.listed} runs${reach ? `, which reach back to ${reach}` : ''}.`,
    }
  }
  return out
}

/** A row of the tab's list, whatever scope it came from. */
export interface TabPR {
  number: number
  url: string
  title: string
  state: 'open' | 'closed' | 'merged'
  draft?: boolean
  created_at?: number
  merged_at?: number
  /** One of this session's own, with what GitHub said of it. */
  mine?: SessionPRLive
}

export type TabScope = 'session' | 'repo' | 'open'
export const SCOPE_LABEL: Record<TabScope, string> = { session: 'This session', repo: 'Repository', open: 'Open' }

/** The list in a scope: the session's own (open first), the repository's newest updated, or every open one of both. */
export function tabRows(scope: TabScope, session: SessionPRLive[], repo: BranchPR[]): TabPR[] {
  const mine = new Map(session.map((p) => [p.number, p]))
  const fromSession = (p: SessionPRLive): TabPR => ({
    number: p.number, url: p.live?.url || p.url, title: p.live?.title || p.title || `#${p.number}`,
    state: p.live?.state ?? (p.merged_at ? 'merged' : p.closed_at ? 'closed' : 'open'), draft: p.live?.draft,
    created_at: p.live?.created_at ?? p.opened_at, merged_at: p.live?.merged_at ?? p.merged_at, mine: p,
  })
  const fromRepo = (p: BranchPR): TabPR => ({
    number: p.number, url: p.url, title: p.title || `#${p.number}`, state: p.state, draft: p.draft, created_at: p.created_at, merged_at: p.merged_at, mine: mine.get(p.number),
  })
  if (scope === 'session') {
    const rows = session.map(fromSession)
    const i = rows.findIndex((r) => r.state === 'open')
    return i > 0 ? [rows[i]!, ...rows.slice(0, i), ...rows.slice(i + 1)] : rows
  }
  const repoRows = repo.map(fromRepo)
  const listed = new Set(repoRows.map((r) => r.number))
  // The session's own that the repository's newest 50 left out still show.
  const extra = session.filter((p) => !listed.has(p.number)).map(fromSession)
  const all = [...repoRows, ...extra]
  return scope === 'open' ? all.filter((r) => r.state === 'open') : all
}

/** The pull request to show first: the session's open one, else the first listed. */
export function firstPick(rows: TabPR[], session: SessionPRLive[]): number | undefined {
  const open = session.find((p) => (p.live ? p.live.state === 'open' : !p.merged_at && !p.closed_at))
  if (open && rows.some((r) => r.number === open.number)) return open.number
  return rows[0]?.number
}
