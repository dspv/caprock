/**
 * The session deck's CI cell, worked out from what GitHub Actions reported
 * (`GET /v1/sessions/{id}/ci`). Every time here is measured — GitHub's own
 * start and end stamps, or for a job still running, the clock minus its
 * start — and none is priced: runner minutes are shown per OS, never turned
 * into money with a multiplier we would have to invent (rule 6).
 */
import type { CIJob, CIRun, CIState, CIStep, ReleaseCI } from './api'
import type { PRCheck } from './github'

export type CITone = 'running' | 'queued' | 'pass' | 'fail' | 'skipped'

const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

/** What one job or step is now, in the five states the cell draws. */
export function ciTone(x: Pick<CIJob | CIStep, 'status' | 'conclusion'>): CITone {
  if (x.status === 'in_progress') return 'running'
  if (x.status !== 'completed') return 'queued'
  if (x.conclusion && FAILED.has(x.conclusion)) return 'fail'
  if (x.conclusion === 'success') return 'pass'
  return 'skipped' // skipped, cancelled, neutral, stale
}

/** How long a job or step took, or has been running; undefined before it started. */
export function ciElapsed(x: Pick<CIJob | CIStep, 'status' | 'started_at' | 'completed_at' | 'duration_ms'>, now: number): number | undefined {
  if (x.status === 'completed') return x.duration_ms ?? (x.started_at && x.completed_at ? Math.max(0, x.completed_at - x.started_at) : undefined)
  if (x.status === 'in_progress' && x.started_at) return Math.max(0, now - x.started_at)
  return undefined
}

/** The runner time so far: the finished jobs' sum from the daemon plus every running job's time on the clock. */
export function runnerTime(ci: CIState, now: number): number {
  let ms = ci.runner_ms
  for (const r of ci.runs) for (const j of r.jobs) if (j.status === 'in_progress' && j.started_at) ms += Math.max(0, now - j.started_at)
  return ms
}

/** Whether any run or job is still to finish: the cell then ticks and asks sooner. */
export function ciActive(ci: CIState | undefined): boolean {
  return !!ci && ci.state === 'running'
}

/** The step a job failed at, else the step it is on now. */
export function keyStep(job: CIJob): CIStep | undefined {
  return job.steps.find((s) => ciTone(s) === 'fail') ?? job.steps.find((s) => s.status === 'in_progress')
}

/** A duration as the cell shows it: 42s, 3m 07s, 1h 02m. */
export function fmtRun(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const OS_NAME: Record<string, string> = { linux: 'Linux', windows: 'Windows', macos: 'macOS', 'self-hosted': 'self-hosted', other: 'other' }

/** The runner minutes per OS, the largest first: "Linux 9m 10s · Windows 5m 22s". */
export function byOSLine(ci: CIState): string {
  return ci.by_os.map((o) => `${OS_NAME[o.os] ?? o.os} ${fmtRun(o.ms)}`).join(' · ')
}

/** The short OS tag drawn on a job row. */
export function osTag(os: string | undefined): string {
  switch (os) {
    case 'linux': return 'linux'
    case 'windows': return 'win'
    case 'macos': return 'mac'
    case 'self-hosted': return 'self'
    default: return ''
  }
}

/** How many log lines an Investigate message carries, and the most it may weigh (the queue takes 16 KiB). */
export const INVESTIGATE_LINES = 40
const INVESTIGATE_MAX_BYTES = 12 * 1024

/**
 * The message the CI cell's Investigate button queues into the session: the
 * PR, the failing workflow, job and step, the job's link, the end of its log
 * and what to do. The log is cut from the top so the error at its end stays.
 */
export function investigateMessage(o: {
  pr?: { number: number; title?: string; url: string }
  /** What failed when it is not a PR: "the release build of v1.2.0", "main". */
  where?: { text: string; url?: string }
  workflow?: string
  job: { name: string; html_url?: string }
  step?: string
  lines?: string[]
}): string {
  const head = [
    o.pr ? `CI failed on PR #${o.pr.number}${o.pr.title ? ` "${o.pr.title}"` : ''} (${o.pr.url}).`
      : `CI failed on ${o.where?.text ?? 'this repository'}${o.where?.url ? ` (${o.where.url})` : ''}.`,
    [o.workflow && `Workflow: ${o.workflow}`, `job: ${o.job.name}`, o.step && `step: ${o.step}`].filter(Boolean).join(' · '),
    o.job.html_url ? `Job: ${o.job.html_url}` : '',
  ].filter(Boolean).join('\n')
  const tail = o.pr ? 'Investigate why this CI step failed and fix it; push to the same branch.' : 'Investigate why this CI step failed and fix it.'
  let lines = (o.lines ?? []).slice(-INVESTIGATE_LINES)
  const bytes = (s: string) => new TextEncoder().encode(s).length
  const build = () => (lines.length ? `${head}\n\nThe end of its log:\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\n${tail}` : `${head}\n\n${tail}`)
  let msg = build()
  while (lines.length && bytes(msg) > INVESTIGATE_MAX_BYTES) {
    lines = lines.slice(1)
    msg = build()
  }
  return msg
}

/** The CI cell's three views: the session's PR, the repository's release build, its default branch. */
export type CIView = 'pr' | 'release' | 'main'
export const CI_VIEWS: CIView[] = ['pr', 'release', 'main']
const CI_VIEW_KEY = 'caprock.deck.ciView'

/** The view this viewer chose last; 'pr' when none was kept or storage is not there. */
export function readCIView(): CIView {
  try {
    const v = localStorage.getItem(CI_VIEW_KEY)
    if (v === 'pr' || v === 'release' || v === 'main') return v
  } catch { /* private window, blocked storage */ }
  return 'pr'
}

export function saveCIView(v: CIView): void {
  try { localStorage.setItem(CI_VIEW_KEY, v) } catch { /* kept for this page only */ }
}

/** Whole minutes, at least 1: "about 6 min". */
function mins(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000))
}

/** How long a release run has run, on the reader's clock from GitHub's start stamp. */
export function releaseElapsed(rel: ReleaseCI, now: number): number | undefined {
  const start = rel.run?.started_at || rel.run?.created_at
  return start ? Math.max(0, now - start) : undefined
}

/**
 * What is left of a running release build, from the median of the last
 * successful runs (`estimate`): undefined with no estimate. `over` when it
 * already ran longer than the median.
 */
export function releaseLeft(rel: ReleaseCI, now: number): { ms: number; over: boolean } | undefined {
  const el = releaseElapsed(rel, now)
  if (rel.state !== 'running' || !rel.estimate || el === undefined) return undefined
  const left = rel.estimate.median_ms - el
  return { ms: Math.max(0, left), over: left <= 0 }
}

/** "about 6 min left (estimate from the last 5 runs)", always labelled as an estimate; '' without one. */
export function releaseEstimateText(rel: ReleaseCI, now: number): string {
  const left = releaseLeft(rel, now)
  if (!left || !rel.estimate) return ''
  const from = `estimate from the last ${rel.estimate.runs} runs`
  if (left.over) return `longer than usual: these took about ${mins(rel.estimate.median_ms)} min (${from})`
  return `about ${mins(left.ms)} min left (${from})`
}

/** The deck's chip while a release builds: "Release v0.109.1 · ~6 min"; '' when none runs. */
export function releaseChip(rel: ReleaseCI | undefined, now: number): string {
  if (!rel || rel.state !== 'running') return ''
  const name = `Release${rel.tag ? ` ${rel.tag}` : ''}`
  const left = releaseLeft(rel, now)
  if (left) return left.over ? `${name} · over the usual` : `${name} · ~${mins(left.ms)} min`
  const el = releaseElapsed(rel, now)
  return el === undefined ? name : `${name} · ${fmtRun(el)}`
}

/** "just now", "3 min ago", "2 h ago", "4 d ago". */
export function ago(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}

/** A finished release build in a line: "v0.109.1 · published 3 min ago ✓", or when and how it ended. */
export function releaseDoneText(rel: ReleaseCI, now: number): string {
  const tag = rel.tag ?? rel.run?.name ?? 'release'
  if (rel.state === 'pass') {
    if (rel.release?.published_at && !rel.release.draft) return `${tag} · published ${ago(now - rel.release.published_at)} ✓`
    const end = rel.run?.updated_at
    return `${tag} · ${rel.release?.draft ? 'draft, built' : 'built'}${end ? ` ${ago(now - end)}` : ''} ✓`
  }
  if (rel.state === 'fail') {
    const end = rel.run?.updated_at
    return `${tag} · failed${end ? ` ${ago(now - end)}` : ''} ✗`
  }
  return tag
}

/**
 * One circle of a mini pipeline (GitLab's pipeline indicator): a job, or a
 * PR's check. `group` is the workflow; circles of one group are joined by a
 * line, groups are set apart. GitHub's API does not report a job's `needs`,
 * so within a workflow the jobs stand in the order they started, the ones
 * not started yet last.
 */
export interface PipeNode {
  key: string
  name: string
  tone: CITone
  /** How long it took, or has been running; absent before it started. */
  ms?: number
  /** The Actions job, when it is one: a click opens it in the CI cell. */
  jobId?: number
  url?: string
  group?: string
}

const TONE_WORD: Record<CITone, string> = { pass: 'passed', fail: 'failed', running: 'running', queued: 'queued', skipped: 'skipped or cancelled' }

/** What a circle's tooltip says: "test (windows) · failed · 3m 07s". */
export function nodeTitle(n: PipeNode): string {
  return [n.name, TONE_WORD[n.tone], n.ms !== undefined ? fmtRun(n.ms) : ''].filter(Boolean).join(' · ')
}

function startOrder<T>(xs: T[], start: (x: T) => number | undefined): T[] {
  return xs.map((x, i) => ({ x, i, s: start(x) || Infinity })).sort((a, b) => a.s - b.s || a.i - b.i).map((e) => e.x)
}

/** The circles of workflow runs: each run's jobs in the order they started. */
export function jobNodes(runs: CIRun[], now: number): PipeNode[] {
  return runs.flatMap((run) => startOrder(run.jobs, (j) => j.started_at).map((j) => ({
    key: `j${j.id}`, name: j.name, tone: ciTone(j), ms: ciElapsed(j, now), jobId: j.id, url: j.html_url, group: `r${run.id}`,
  })))
}

/** The circles of a PR's checks, in the order they started; a pending one runs once its run says so. */
export function checkNodes(items: PRCheck[], now: number): PipeNode[] {
  return startOrder(items, (c) => c.started_at).map((c, i) => {
    const tone: CITone = c.state === 'pass' ? 'pass' : c.state === 'fail' ? 'fail' : c.state === 'skipped' ? 'skipped'
      : c.status === 'in_progress' ? 'running' : 'queued'
    const ms = c.started_at ? Math.max(0, (c.completed_at || (tone === 'running' ? now : 0)) - c.started_at) : undefined
    return { key: `c${i}:${c.name}`, name: c.name, tone, ms: ms && ms > 0 ? ms : undefined, jobId: c.job_id || undefined, url: c.url }
  })
}
