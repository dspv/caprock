/**
 * The session deck's CI cell, worked out from what GitHub Actions reported
 * (`GET /v1/sessions/{id}/ci`). Every time here is measured — GitHub's own
 * start and end stamps, or for a job still running, the clock minus its
 * start — and none is priced: runner minutes are shown per OS, never turned
 * into money with a multiplier we would have to invent (rule 6).
 */
import type { CIJob, CIState, CIStep } from './api'

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
  pr: { number: number; title?: string; url: string }
  workflow?: string
  job: { name: string; html_url?: string }
  step?: string
  lines?: string[]
}): string {
  const head = [
    `CI failed on PR #${o.pr.number}${o.pr.title ? ` "${o.pr.title}"` : ''} (${o.pr.url}).`,
    [o.workflow && `Workflow: ${o.workflow}`, `job: ${o.job.name}`, o.step && `step: ${o.step}`].filter(Boolean).join(' · '),
    o.job.html_url ? `Job: ${o.job.html_url}` : '',
  ].filter(Boolean).join('\n')
  const tail = 'Investigate why this CI step failed and fix it; push to the same branch.'
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
