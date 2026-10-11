import { describe, expect, it, vi } from 'vitest'
import type { CIState, ReleaseCI } from './api'
import { ago, byOSLine, ciElapsed, ciTone, fmtRun, investigateMessage, keyStep, readCIView, releaseChip, releaseDoneText, releaseEstimateText, runnerTime, saveCIView } from './ci'

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

describe('the release build', () => {
  const t = 1_800_000_000_000
  const running = (estimate?: ReleaseCI['estimate']): ReleaseCI => ({ repo: 'a/b', tag: 'v1.2.0', state: 'running', at: t, estimate,
    run: { id: 1, name: 'Release', status: 'in_progress', started_at: t - 5 * 60_000, jobs: [] } })

  it('says what is left as an estimate from the last runs’ median', () => {
    expect(releaseEstimateText(running({ median_ms: 15 * 60_000, runs: 7 }), t)).toBe('about 10 min left (estimate from the last 7 runs)')
    expect(releaseChip(running({ median_ms: 15 * 60_000, runs: 7 }), t)).toBe('Release v1.2.0 · ~10 min')
    expect(releaseEstimateText(running({ median_ms: 4 * 60_000, runs: 3 }), t)).toBe('longer than usual: these took about 4 min (estimate from the last 3 runs)')
    expect(releaseChip(running({ median_ms: 4 * 60_000, runs: 3 }), t)).toBe('Release v1.2.0 · over the usual')
  })

  it('makes up no estimate without past runs: the chip shows the time so far', () => {
    expect(releaseEstimateText(running(), t)).toBe('')
    expect(releaseChip(running(), t)).toBe('Release v1.2.0 · 5m 00s')
    expect(releaseChip(undefined, t)).toBe('')
    expect(releaseChip({ ...running(), state: 'pass' }, t)).toBe('')
  })

  it('says when a finished build was published, or that it failed', () => {
    const run = { id: 1, name: 'Release', status: 'completed', updated_at: t - 7 * 60_000, jobs: [] }
    expect(releaseDoneText({ repo: 'a/b', tag: 'v0.109.1', state: 'pass', at: t, run, release: { url: 'u', published_at: t - 3 * 60_000 } }, t)).toBe('v0.109.1 · published 3 min ago ✓')
    expect(releaseDoneText({ repo: 'a/b', tag: 'v0.109.1', state: 'pass', at: t, run }, t)).toBe('v0.109.1 · built 7 min ago ✓')
    expect(releaseDoneText({ repo: 'a/b', tag: 'v0.109.1', state: 'fail', at: t, run }, t)).toBe('v0.109.1 · failed 7 min ago ✗')
    expect(ago(30_000)).toBe('just now')
    expect(ago(2 * 3_600_000)).toBe('2 h ago')
  })

  it('names the release in an Investigate message', () => {
    const m = investigateMessage({ where: { text: 'the release build of v1.2.0', url: 'https://github.com/a/b/actions/runs/1' }, job: { name: 'goreleaser' } })
    expect(m).toContain('CI failed on the release build of v1.2.0 (https://github.com/a/b/actions/runs/1).')
    expect(m.endsWith('Investigate why this CI step failed and fix it.')).toBe(true)
  })
})

describe('the CI view kept per viewer', () => {
  it('remembers the choice, and falls back to PR when storage throws', () => {
    localStorage.clear()
    expect(readCIView()).toBe('pr')
    saveCIView('main')
    expect(readCIView()).toBe('main')
    localStorage.setItem('caprock.deck.ciView', 'nonsense')
    expect(readCIView()).toBe('pr')
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readCIView()).toBe('pr')
    expect(() => saveCIView('release')).not.toThrow()
    get.mockRestore()
    set.mockRestore()
    localStorage.clear()
  })
})
