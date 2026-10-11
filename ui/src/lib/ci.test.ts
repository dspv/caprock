import { describe, expect, it } from 'vitest'
import type { CIState } from './api'
import { byOSLine, ciElapsed, ciTone, fmtRun, investigateMessage, keyStep, runnerTime } from './ci'

describe('the Investigate message', () => {
  it('names the PR, workflow, job and step, links the job, carries the log’s last 40 lines and says what to do', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    const m = investigateMessage({ pr: { number: 428, title: 'Add CI', url: 'https://github.com/a/b/pull/428' }, workflow: 'CI',
      job: { name: 'test (macos-14)', html_url: 'https://github.com/a/b/actions/runs/7/job/71' }, step: 'go test', lines })
    expect(m).toContain('CI failed on PR #428 "Add CI" (https://github.com/a/b/pull/428).')
    expect(m).toContain('Workflow: CI · job: test (macos-14) · step: go test')
    expect(m).toContain('Job: https://github.com/a/b/actions/runs/7/job/71')
    expect(m).toContain('line 59')
    expect(m).toContain('line 20\n')
    expect(m).not.toContain('line 19\n')
    expect(m.endsWith('Investigate why this CI step failed and fix it; push to the same branch.')).toBe(true)
  })

  it('stays under the queue’s limit, keeping the end of the log', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `${i} ${'x'.repeat(398)}`)
    const m = investigateMessage({ pr: { number: 1, url: 'u' }, job: { name: 'j' }, lines })
    expect(new TextEncoder().encode(m).length).toBeLessThanOrEqual(12 * 1024)
    expect(m).toContain('39 xxx')
  })
})

describe('the deck’s CI arithmetic', () => {
  it('reads a state from GitHub’s status and conclusion', () => {
    expect(ciTone({ status: 'in_progress' })).toBe('running')
    expect(ciTone({ status: 'queued' })).toBe('queued')
    expect(ciTone({ status: 'completed', conclusion: 'success' })).toBe('pass')
    expect(ciTone({ status: 'completed', conclusion: 'timed_out' })).toBe('fail')
    expect(ciTone({ status: 'completed', conclusion: 'cancelled' })).toBe('skipped')
  })

  it('times what finished from GitHub and what runs on the clock; nothing before it started', () => {
    expect(ciElapsed({ status: 'completed', duration_ms: 4_000 }, 0)).toBe(4_000)
    expect(ciElapsed({ status: 'in_progress', started_at: 1_000 }, 61_000)).toBe(60_000)
    expect(ciElapsed({ status: 'queued' }, 61_000)).toBeUndefined()
  })

  it('sums the runner time with the running jobs, and splits it per OS without a price', () => {
    const ci = { runner_ms: 90_000, by_os: [{ os: 'windows', ms: 60_000 }, { os: 'linux', ms: 30_000 }], runs: [{ jobs: [
      { status: 'completed', started_at: 1, steps: [] }, { status: 'in_progress', started_at: 10_000, steps: [] },
    ] }] } as unknown as CIState
    expect(runnerTime(ci, 40_000)).toBe(120_000)
    expect(byOSLine(ci)).toBe('Windows 1m 00s · Linux 30s')
    expect(byOSLine(ci)).not.toMatch(/\$/)
  })

  it('names the failed step, else the running one', () => {
    const job = { steps: [{ number: 1, name: 'a', status: 'completed', conclusion: 'success' }, { number: 2, name: 'b', status: 'completed', conclusion: 'failure' }] }
    expect(keyStep(job as never)?.name).toBe('b')
  })

  it('formats durations compactly', () => {
    expect(fmtRun(42_000)).toBe('42s')
    expect(fmtRun(187_000)).toBe('3m 07s')
    expect(fmtRun(3_720_000)).toBe('1h 02m')
    expect(fmtRun(undefined)).toBe('')
  })
})
