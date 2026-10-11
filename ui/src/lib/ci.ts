/**
 * The session deck's CI cell, worked out from what GitHub Actions reported
 * (`GET /v1/sessions/{id}/ci`). Every time here is measured — GitHub's own
 * start and end stamps, or for a job still running, the clock minus its
 * start. Money is the daemon's: each finished job priced from the versioned
 * runner rate table, worded in lib/runnercost.ts — never a multiplier made
 * up here (rule 6).
 */
import type { CIBaseline, CIJob, CIRun, CIState, CIStep, ReleaseCI, SessionPRLive } from './api'
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

/** The cell's four views: the session's PRs, the repository's branches, its release build, its default branch. */
export type CIView = 'pr' | 'branches' | 'release' | 'main'
export const CI_VIEWS: CIView[] = ['pr', 'branches', 'release', 'main']
const CI_VIEW_KEY = 'caprock.deck.ciView'

/** The view this viewer chose last; 'pr' when none was kept or storage is not there. */
export function readCIView(): CIView {
  try {
    const v = localStorage.getItem(CI_VIEW_KEY)
    if (v === 'pr' || v === 'branches' || v === 'release' || v === 'main') return v
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

/**
 * The session's pull requests in the deck's order (owner, 2026-10-12): the
 * open one — the newest open, the one the session is on — first, then the
 * others as the daemon lists them, newest first.
 */
export function orderPRs<T extends SessionPRLive>(prs: T[]): T[] {
  const i = prs.findIndex((p) => (p.live ? p.live.state === 'open' : !p.merged_at && !p.closed_at))
  if (i <= 0) return prs
  return [prs[i]!, ...prs.slice(0, i), ...prs.slice(i + 1)]
}

/** A pull request's state, as its dot draws it. */
export type PRDot = 'open' | 'draft' | 'merged' | 'closed'
export function prDotState(p: SessionPRLive): PRDot {
  if (p.live) return p.live.state === 'open' ? (p.live.draft ? 'draft' : 'open') : p.live.state
  return p.merged_at ? 'merged' : p.closed_at ? 'closed' : 'open'
}

/** How a word in a PR row is coloured. */
export type PRWordTone = 'ok' | 'fail' | 'pending' | 'muted' | 'faint'
export interface PRWords { text: string; tone: PRWordTone; title?: string; strong?: boolean }

/** How long after a PR was opened an empty check list still means "not started yet" rather than "no CI here". */
export const CI_START_GRACE_MS = 10 * 60_000

/**
 * A PR's CI in words: "✓ passed", "✗ failed at test (windows) +1",
 * "running · 3/5 · 4m 10s" (the time since its first check started,
 * measured), "CI not started" for ten minutes after it opened with no check
 * reported — GitHub often has not registered them yet — and "no checks"
 * after that. Without GitHub, what the session recorded.
 */
export function prVerdict(p: SessionPRLive, now: number, runs?: CIRun[]): PRWords {
  const pr = p.live
  if (!pr) {
    if (p.error) return { text: 'not read', tone: 'faint', title: `GitHub was not read: ${p.error.message}` }
    return { text: prDotState(p), tone: 'muted' }
  }
  const c = pr.checks
  const total = c.items.length
  if (c.state === 'fail') {
    const failed = c.items.filter((i) => i.state === 'fail')
    const more = failed.length > 1 ? ` +${failed.length - 1}` : ''
    return { text: `✗ failed at ${failed[0]?.name ?? 'a check'}${more}`, tone: 'fail', strong: true, title: `Failed: ${failed.map((i) => i.name).join(', ') || 'a check'}` }
  }
  if (c.state === 'pending') {
    const starts = c.items.map((i) => i.started_at).filter((t): t is number => !!t)
    const el = starts.length ? now - Math.min(...starts) : undefined
    const done = total - c.pending
    const vs = runs && slowestVsMedian(runs, now)
    const left = vs && vs.kind === 'left' ? ` · ${vs.text}` : ''
    return { text: `running · ${done}/${total}${el && el > 0 ? ` · ${fmtRun(el)}` : ''}${left}`, tone: 'pending', title: `${done} of ${total} checks finished${el && el > 0 ? `; the first started ${fmtRun(el)} ago` : ''}${vs ? `\n${vs.title}` : ''}` }
  }
  if (c.state === 'pass') {
    // The wall-clock time from the first check's start to the last one's end, and against the median when the runs were read.
    const starts = c.items.map((i) => i.started_at).filter((t): t is number => !!t)
    const ends = c.items.map((i) => i.completed_at).filter((t): t is number => !!t)
    const vs = runs && slowestVsMedian(runs, now)
    // The run the median is of, when there is one; else the checks' own span.
    const ms = vs?.kind === 'delta' && vs.ms ? vs.ms : starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0
    const passed = `${total} check${total === 1 ? '' : 's'} passed`
    if (ms <= 0) return { text: '✓ passed', tone: 'ok', strong: true, title: passed }
    return { text: `✓ ${fmtRun(ms)}${vs && vs.kind === 'delta' ? ` · ${vs.text}` : ''}`, tone: 'ok', strong: true, title: `${passed} in ${fmtRun(ms)}${vs ? `\n${vs.title}` : ''}` }
  }
  const since = p.opened_at || p.last_at
  if (pr.state === 'open' && since && now - since < CI_START_GRACE_MS) {
    return { text: 'CI not started', tone: 'faint', title: 'GitHub has not reported any checks for this PR yet — they usually appear within a minute of a push' }
  }
  return { text: 'no checks', tone: 'faint', title: 'No CI workflow ran on this PR' }
}

/** An open PR's review, when GitHub reported one: approved, changes requested, review required. */
export function prReviewText(p: SessionPRLive): PRWords | undefined {
  const pr = p.live
  if (!pr || pr.state !== 'open') return undefined
  if (pr.review === 'approved') return { text: 'approved', tone: 'ok' }
  if (pr.review === 'changes_requested') return { text: 'changes requested', tone: 'fail' }
  if (pr.review === 'review_required') return { text: 'review required', tone: 'muted' }
  return undefined
}

/** An open PR that GitHub says cannot merge: a conflict. Unknown says nothing. */
export function prMergeText(p: SessionPRLive): PRWords | undefined {
  const pr = p.live
  if (!pr || pr.state !== 'open' || pr.mergeable !== false) return undefined
  return { text: 'conflict', tone: 'fail', title: `GitHub says it cannot be merged as it is${pr.mergeable_state ? ` (${pr.mergeable_state})` : ''}: it conflicts with ${pr.base || 'its base'}` }
}

/** A PR's age in a few characters — "now", "5m", "2h", "3d" — since it was merged, closed or opened. */
export function prAge(p: SessionPRLive, now: number): { text: string; title: string } {
  const at = p.merged_at ?? p.closed_at ?? p.opened_at ?? p.last_at
  const verb = p.merged_at ? 'merged' : p.closed_at ? 'closed' : p.opened_at ? 'opened' : 'last seen'
  if (!at) return { text: '', title: '' }
  const ms = Math.max(0, now - at)
  const text = ms < 60_000 ? 'now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`
  return { text, title: `${verb[0]!.toUpperCase()}${verb.slice(1)} ${ago(ms)}` }
}

/** How a time against its median is coloured: slower by more than a fifth amber, faster by a tenth green. */
export type DeltaTone = 'warn' | 'ok' | 'muted'
export interface VsMedian { kind: 'delta' | 'left' | 'over'; text: string; tone: DeltaTone; title: string; /** The time compared. */ ms?: number }

/** Where the median comes from, said in every tooltip. */
export function baselineBasis(b: CIBaseline): string {
  return `the median of the last ${b.runs} successful runs`
}

/** A signed whole percent with a real minus: "+18%", "−6%". */
export function pct(n: number): string {
  return n >= 0 ? `+${n}%` : `\u2212${-n}%`
}

/**
 * A finished time against its median (owner, 2026-10-12, translated: "the
 * execution time plus an estimate relative to the average — plus or minus
 * percent"): "+18%". Undefined without a median of at least two runs: no
 * invented number (rule 6).
 */
export function vsMedian(ms: number | undefined, b: CIBaseline | undefined): VsMedian | undefined {
  if (!b || b.runs < 2 || b.median_ms <= 0 || !ms || ms <= 0) return undefined
  const d = Math.round(((ms - b.median_ms) / b.median_ms) * 100)
  return { kind: 'delta', ms, text: pct(d), tone: d > 20 ? 'warn' : d < -10 ? 'ok' : 'muted', title: `${fmtRun(ms)} against a median of ${fmtRun(b.median_ms)}: ${baselineBasis(b)}` }
}

/** Minutes left, rounded: "≈ 3m left", "≈ <1m left". */
function leftText(ms: number): string {
  return ms < 60_000 ? '≈ <1m left' : `≈ ${Math.round(ms / 60_000)}m left`
}

/**
 * A running time against its median: "≈ 3m left" while under it, "+12% over
 * median" once past it. Undefined without a median of at least two runs.
 */
export function runningVsMedian(elapsed: number | undefined, b: CIBaseline | undefined): VsMedian | undefined {
  if (!b || b.runs < 2 || b.median_ms <= 0 || elapsed === undefined || elapsed < 0) return undefined
  const basis = `median ${fmtRun(b.median_ms)}: ${baselineBasis(b)}`
  if (elapsed < b.median_ms) return { kind: 'left', text: leftText(b.median_ms - elapsed), tone: 'muted', title: `${leftText(b.median_ms - elapsed)} (${basis}); an estimate` }
  const d = Math.round(((elapsed - b.median_ms) / b.median_ms) * 100)
  return { kind: 'over', text: `${pct(d)} over median`, tone: d > 20 ? 'warn' : 'muted', title: `${fmtRun(elapsed)} so far against a ${basis}` }
}

/** A run's wall-clock time: started to last updated once done, started to now while it runs. */
export function runSpan(run: CIRun, now: number): number | undefined {
  const start = run.started_at || run.created_at
  if (!start) return undefined
  if (run.status === 'completed') return run.updated_at && run.updated_at > start ? run.updated_at - start : undefined
  return Math.max(0, now - start)
}

/** A run's time against its workflow's median, finished or running. */
export function runVsMedian(run: CIRun, now: number): VsMedian | undefined {
  const ms = runSpan(run, now)
  if (run.status === 'completed') return run.conclusion === 'success' ? vsMedian(ms, run.baseline) : undefined
  return runningVsMedian(ms, run.baseline)
}

/** A job's time against the median of its name, finished (and passed) or running. */
export function jobVsMedian(job: CIJob, now: number): VsMedian | undefined {
  if (job.status === 'completed') return job.conclusion === 'success' ? vsMedian(job.duration_ms, job.baseline) : undefined
  if (job.status !== 'in_progress') return undefined
  return runningVsMedian(ciElapsed(job, now), job.baseline)
}

/** The PR's slowest run against its median: what decides when the CI is done. */
export function slowestVsMedian(runs: CIRun[], now: number): VsMedian | undefined {
  let best: CIRun | undefined
  let bestMs = -1
  for (const r of runs) {
    const ms = runSpan(r, now) ?? 0
    if (r.baseline && ms > bestMs) { best = r; bestMs = ms }
  }
  return best ? runVsMedian(best, now) : undefined
}
