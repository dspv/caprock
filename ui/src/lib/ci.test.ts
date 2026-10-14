import { describe, expect, it, vi } from 'vitest'
import type { CIJob, CIRun, CIState, ReleaseCI, SessionPRLive } from './api'
import { checksSentence, nameOS, osRollup, nodeBaseName, prChecks, shortRun, jobVsMedian, runningVsMedian, runVsMedian, slowestVsMedian, vsMedian, ago, byOSLine, orderPRs, prAge, prDotState, prMergeText, prReviewText, prVerdict, ciElapsed, ciTone, fmtRun, investigateMessage, keyStep, readCIView, releaseChip, releaseDoneText, releaseEstimateText, runnerTime, saveCIView } from './ci'

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

describe('the deck’s pull requests', () => {
  const now = 1_800_000_000_000
  const pr = (n: number, live?: object, p: object = {}) => ({ session_id: 's', number: n, url: `u/${n}`, last_at: now,
    ...(live ? { live: { number: n, url: `u/${n}`, title: '', state: 'open', draft: false, review: '', reviews: [], base: 'main', mergeable: null,
      checks: { state: 'none', passed: 0, failed: 0, pending: 0, items: [] }, ...live } } : {}), ...p }) as unknown as SessionPRLive

  it('puts the open one first and keeps the rest newest first', () => {
    const list = [pr(3, { state: 'merged' }), pr(4, {}), pr(2, { state: 'closed' }), pr(1, {})]
    expect(orderPRs(list).map((p) => p.number)).toEqual([4, 3, 2, 1])
    // Without GitHub, what the session recorded decides.
    expect(orderPRs([pr(3, undefined, { merged_at: now }), pr(2)]).map((p) => p.number)).toEqual([2, 3])
    expect(orderPRs([pr(5, {}), pr(4, {})]).map((p) => p.number)).toEqual([5, 4])
  })

  it('says the CI in words', () => {
    const checks = (state: string, items: object[], pending = 0) => ({ checks: { state, passed: 0, failed: 0, pending, items } })
    expect(prVerdict(pr(1, checks('pass', [{ name: 'a', state: 'pass' }])), now).text).toBe('✓ passed')
    expect(prVerdict(pr(1, checks('fail', [{ name: 'lint', state: 'pass' }, { name: 'test (windows)', state: 'fail' }, { name: 'smoke', state: 'fail' }])), now).text).toBe('✗ failed at test (windows) +1')
    expect(prVerdict(pr(1, checks('pending', [{ name: 'a', state: 'pass' }, { name: 'b', state: 'pending', started_at: now - 250_000 }, { name: 'c', state: 'pending' }], 2)), now).text).toBe('running · 1/3 · 4m 10s')
    expect(prVerdict(pr(1, checks('pending', [{ name: 'b', state: 'pending' }], 1)), now).text).toBe('running · 0/1')
    expect(prVerdict(pr(1, {}, { opened_at: now - 60_000 }), now).text).toBe('CI not started')
    expect(prVerdict(pr(1, {}, { opened_at: now - 3_600_000 }), now).text).toBe('no checks')
    expect(prVerdict(pr(1, undefined, { merged_at: now }), now).text).toBe('merged')
  })

  it('says the review and a conflict only for an open PR, and its state and age', () => {
    expect(prReviewText(pr(1, { review: 'approved' }))?.text).toBe('approved')
    expect(prReviewText(pr(1, { review: 'changes_requested' }))?.text).toBe('changes requested')
    expect(prReviewText(pr(1, { review: 'review_required' }))?.text).toBe('review required')
    expect(prReviewText(pr(1, { review: 'approved', state: 'merged' }))).toBeUndefined()
    expect(prMergeText(pr(1, { mergeable: false, mergeable_state: 'dirty' }))?.text).toBe('conflict')
    expect(prMergeText(pr(1, { mergeable: null }))).toBeUndefined()
    expect(prDotState(pr(1, { draft: true }))).toBe('draft')
    expect(prDotState(pr(1, { state: 'merged' }))).toBe('merged')
    expect(prAge(pr(1, {}, { opened_at: now - 2 * 3_600_000 }), now)).toEqual({ text: '2h', title: 'Opened 2 h ago' })
    expect(prAge(pr(1, {}, { merged_at: now - 30_000 }), now).text).toBe('now')
  })
})

describe('a CI time against its median', () => {
  const now = 1_800_000_000_000
  const b = (m: number, runs = 5) => ({ median_ms: m, runs })

  it('says a finished time in signed percent, coloured past a fifth slower or a tenth faster', () => {
    expect(vsMedian(285_000, b(240_000))).toMatchObject({ text: '+19%', tone: 'muted' })
    expect(vsMedian(300_000, b(240_000))).toMatchObject({ text: '+25%', tone: 'warn' })
    expect(vsMedian(517_000, b(550_000))).toMatchObject({ text: '\u22126%', tone: 'muted' })
    expect(vsMedian(450_000, b(550_000))).toMatchObject({ text: '\u221218%', tone: 'ok' })
    expect(vsMedian(285_000, b(240_000))!.title).toMatch(/median of the last 5 successful runs/)
  })

  it('says nothing with fewer than two past runs, or no time', () => {
    expect(vsMedian(285_000, b(240_000, 1))).toBeUndefined()
    expect(vsMedian(285_000, undefined)).toBeUndefined()
    expect(vsMedian(undefined, b(240_000))).toBeUndefined()
    expect(runningVsMedian(60_000, b(240_000, 1))).toBeUndefined()
  })

  it('says the time left while under the median, and how far over once past it', () => {
    expect(runningVsMedian(280_000, b(460_000))).toMatchObject({ kind: 'left', text: '≈ 3m left' })
    expect(runningVsMedian(280_000, b(460_000))!.title).toMatch(/median 7m 40s/)
    expect(runningVsMedian(450_000, b(460_000))!.text).toBe('≈ <1m left')
    expect(runningVsMedian(515_200, b(460_000))).toMatchObject({ kind: 'over', text: '+12% over median', tone: 'muted' })
  })

  it('compares a passed job and a whole run, never a failed one', () => {
    const job = (p: Partial<CIJob>) => ({ id: 1, run_id: 1, name: 'test', status: 'completed', conclusion: 'success', labels: [], steps: [], duration_ms: 285_000, baseline: b(240_000), ...p }) as CIJob
    expect(jobVsMedian(job({}), now)!.text).toBe('+19%')
    expect(jobVsMedian(job({ conclusion: 'failure' }), now)).toBeUndefined()
    expect(jobVsMedian(job({ status: 'in_progress', duration_ms: undefined, started_at: now - 60_000 }), now)!.text).toBe('≈ 3m left')
    const run = (p: Partial<CIRun>) => ({ id: 1, name: 'CI', status: 'completed', conclusion: 'success', started_at: now - 600_000, updated_at: now - 50_000, jobs: [], baseline: b(585_000), ...p }) as CIRun
    expect(runVsMedian(run({}), now)!.text).toBe('\u22126%')
    // The slowest run with a median decides the PR's.
    expect(slowestVsMedian([run({ id: 2, started_at: now - 60_000, baseline: b(30_000) }), run({})], now)!.text).toBe('\u22126%')
    expect(slowestVsMedian([run({ baseline: undefined })], now)).toBeUndefined()
  })

  it('puts the run time and its delta on a passed PR whose runs were read', () => {
    const p = { session_id: 's', number: 1, url: 'u', last_at: now, live: { number: 1, url: 'u', title: '', state: 'merged', draft: false, review: '', reviews: [], base: 'main', mergeable: null,
      checks: { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{ name: 'a', state: 'pass', started_at: now - 600_000, completed_at: now - 60_000 }] } } } as unknown as SessionPRLive
    expect(prVerdict(p, now).text).toBe('✓ 9m 00s')
    const runs = [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', started_at: now - 600_000, updated_at: now - 50_000, jobs: [], baseline: b(585_000) }] as unknown as CIRun[]
    expect(prVerdict(p, now, runs).text).toBe('✓ 9m 10s · \u22126%')
  })
})

describe('a PR’s checks in one short group', () => {
  const t0 = 1_000_000
  const at = t0 + 10 * 60_000
  const ok = (name: string) => ({ name, state: 'pass' as const, status: 'completed', started_at: t0, completed_at: t0 + 6 * 60_000 })
  const pr = (items: object[]) => ({ live: { checks: { items } } }) as never

  it('says nothing while GitHub reported no check: the words say why', () => {
    expect(prChecks(pr([]), at)).toBeUndefined()
    expect(prChecks({}, at)).toBeUndefined()
  })

  it('collapses all green to one count with the time', () => {
    const s = prChecks(pr(Array.from({ length: 12 }, (_, i) => ok(`job ${i}`))), at)!
    expect(s).toMatchObject({ green: true, done: true, ms: 6 * 60_000, counts: { total: 12, pass: 12, fail: 0 } })
    expect(checksSentence(s)).toBe('All 12 checks passed')
  })

  it('puts a failure first, names its OS and the step it failed at once its run was read', () => {
    const items = [ok('lint'), { name: 'go (windows)', state: 'fail', status: 'completed', started_at: t0, completed_at: t0 + 60_000, job_id: 7 }]
    const runs = [{ id: 1, name: 'CI', status: 'completed', conclusion: 'failure', jobs: [
      { id: 7, run_id: 1, name: 'go (windows)', status: 'completed', conclusion: 'failure', os: 'windows', labels: [],
        steps: [{ number: 1, name: 'checkout', status: 'completed', conclusion: 'success' }, { number: 2, name: 'go test', status: 'completed', conclusion: 'failure' }] },
    ] }] as unknown as CIRun[]
    const s = prChecks(pr(items), at, runs)!
    expect(s.green).toBe(false)
    expect(s.counts).toMatchObject({ pass: 1, fail: 1 })
    expect(s.nodes[0]).toMatchObject({ name: 'go (windows)', tone: 'fail', os: 'windows', step: 'go test' })
    expect(nodeBaseName(s.nodes[0]!)).toBe('go')
    expect(checksSentence(s)).toBe('2 checks: 1 failed, 1 passed')
  })

  it('counts running and queued apart, the time since the first started', () => {
    const s = prChecks(pr([ok('lint'), { name: 'test', state: 'pending', status: 'in_progress', started_at: t0 }, { name: 'e2e', state: 'pending' }]), at)!
    expect(s).toMatchObject({ done: false, green: false, ms: 10 * 60_000, counts: { pass: 1, running: 1, queued: 1 } })
    expect(s.nodes.map((n) => n.tone)).toEqual(['running', 'queued', 'pass'])
    expect(checksSentence(s)).toBe('3 checks: 1 running, 1 queued, 1 passed')
  })

  it('keeps skipped and cancelled checks out of the passed count, counted apart', () => {
    const s = prChecks(pr([ok('lint'), { name: 'deploy', state: 'skipped', status: 'completed' }]), at)!
    expect(s).toMatchObject({ green: true, counts: { pass: 1, skipped: 1 } })
    expect(s.nodes.map((n) => n.tone)).toEqual(['pass', 'skipped'])
    expect(checksSentence(s)).toBe('All 1 check passed, 1 skipped')
  })

  it('reads the OS from a check’s name, and keeps a name whose brackets say more', () => {
    expect(nameOS('go (windows-latest)')).toBe('windows')
    expect(nameOS('test (macos-14)')).toBe('macos')
    expect(nameOS('test (ubuntu-latest, 1.22)')).toBe('linux')
    expect(nameOS('lint')).toBeUndefined()
    expect(nodeBaseName({ key: 'k', name: 'test (ubuntu-latest, 1.22)', tone: 'pass', os: 'linux' })).toBe('test (ubuntu-latest, 1.22)')
    expect(nodeBaseName({ key: 'k', name: 'go (windows-latest)', tone: 'pass', os: 'windows' })).toBe('go')
  })

  it('words a row’s time to the minute', () => {
    expect([shortRun(42_000), shortRun(6 * 60_000 + 9_000), shortRun(62 * 60_000), shortRun(undefined)]).toEqual(['42s', '6m', '1h 02m', ''])
  })
})

describe('checks by runner OS', () => {
  it('takes each OS’s worst state, its count and its longest time, Linux first', () => {
    const n = (key: string, os: string | undefined, tone: 'pass' | 'fail' | 'running' | 'queued' | 'skipped', ms?: number) => ({ key, name: key, os, tone, ms })
    const r = osRollup([n('a', 'windows', 'running', 90_000), n('b', 'linux', 'pass', 108_000), n('c', 'linux', 'pass', 30_000), n('d', 'macos', 'fail', 200_000), n('e', 'macos', 'pass'), n('f', undefined, 'pass'), n('g', 'windows', 'skipped')])
    expect(r.map((x) => [x.os, x.tone, x.counts.total, x.ms])).toEqual([['linux', 'pass', 2, 108_000], ['macos', 'fail', 2, 200_000], ['windows', 'running', 2, 90_000]])
    expect(osRollup([n('f', undefined, 'pass')])).toEqual([])
  })
})
