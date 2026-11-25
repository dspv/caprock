import { describe, expect, it } from 'vitest'
import type { CIJob, ReleaseCI, WorkRepo } from './api'
import type { BranchPR } from './branches'
import type { BoardCard, BoardRelease } from './prboard'
import { bumpBetween, checksRead, mainChecks, nextHint, plainVersion, prKind, raiseVersion, releaseBranchVersion, releaseFold, releasePRVersion, releaseStatus, releaseVersionOf, stageWords, stripStages, tagUnpublished, type BatchPR, type MainChecks, type ReleaseStatus, type ReleaseStatusInput } from './releasestatus'

const H = 3_600_000
const T = Date.UTC(2026, 9, 16, 12)
const pending = (kinds: Record<string, number>, count: number): WorkRepo['unreleased'] => ({ ref: 'origin/master', items: [], count, kinds })
const rel = (tag: string, at: number, assets?: number): BoardRelease => ({ tag, url: `https://github.com/o/r/releases/tag/${tag}`, published_at: at, prs: [], cost_usd: 0, sessions: 0, assets })
const pr = (number: number, title: string, state: BranchPR['state'] = 'open'): BranchPR => ({ number, title, state, url: `https://github.com/o/r/pull/${number}` })
const card = (number: number, ci: BoardCard['ci'], extra: Partial<BoardCard> = {}): BoardCard => ({ number, stage: ci === 'fail' ? 'fix' : 'open', ci, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] }, ...extra })
const job = (status: string): CIJob => ({ id: Math.random(), run_id: 1, name: 'j', status, labels: [], steps: [] })
const run = (tag: string, state: ReleaseCI['state'], jobs: CIJob[] = [], release?: ReleaseCI['release']): ReleaseCI =>
  ({ repo: 'o/r', tag, state, at: T, run: { id: 1, name: 'release', status: state === 'running' ? 'in_progress' : 'completed', jobs }, release })

const base = (over: Partial<ReleaseStatusInput> = {}): ReleaseStatusInput => ({
  lastTag: { name: 'v0.126.0', at: T - 5 * H }, unreleased: pending({ Added: 1, Fixed: 2 }, 3), merged: 3, prs: [], cards: [], releases: [rel('v0.126.0', T - 5 * H, 14)], ...over,
})
const states = (s: ReleaseStatus) => Object.fromEntries(s.stages.map((x) => [x.key, x.unknown ? 'unknown' : x.state]))

describe('reading release versions', () => {
  it('reads a release pull request’s title', () => {
    expect(releasePRVersion('chore(release): 0.126.0 (#724)')).toBe('0.126.0')
    expect(releasePRVersion('release: v1.2.3')).toBe('1.2.3')
    expect(releasePRVersion('feat: release notes for 0.1.0')).toBeUndefined()
  })
  it('says the bump between two versions', () => {
    expect(bumpBetween('v0.126.0', '0.127.0')).toBe('minor')
    expect(bumpBetween('0.126.0', '0.126.1')).toBe('patch')
    expect(bumpBetween('0.9.9', '1.0.0')).toBe('major')
    expect(plainVersion('v0.126.0')).toBe('0.126.0')
  })
})

describe('the release status’s stages', () => {
  it('with work merged and no release PR, is at the release PR stage of the predicted version', () => {
    const s = releaseStatus(base())
    expect(s.phase).toBe('pre')
    expect(s.version).toBe('0.127.0')
    expect(s.bump).toBe('minor')
    expect(s.why?.text).toMatch(/^minor · a feature since v0\.126\.0/)
    expect(s.current).toBe('pr')
    expect(states(s)).toEqual({ merged: 'done', pr: 'current', ci: 'todo', tag: 'todo', builds: 'todo', published: 'todo', site: 'unknown' })
    expect(s.stages.find((x) => x.key === 'merged')?.text).toBe('3 merged')
  })

  it('says patch when only fixes wait', () => {
    const s = releaseStatus(base({ unreleased: pending({ Fixed: 2 }, 2) }))
    expect(s.version).toBe('0.126.1')
    expect(s.why?.text).toMatch(/^patch · fixes only/)
  })

  it('takes the version from an open release PR, and is at its CI while it runs', () => {
    const s = releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')], cards: [card(730, 'running')] }))
    expect(s.version).toBe('0.127.0')
    expect(s.current).toBe('ci')
    expect(states(s)).toMatchObject({ merged: 'done', pr: 'done', ci: 'current' })
    expect(s.stages.find((x) => x.key === 'pr')?.text).toBe('#730')
    expect(s.stages.find((x) => x.key === 'ci')?.tone).toBe('pending')
  })

  it('marks the release PR’s red CI as failed', () => {
    const s = releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')], cards: [card(730, 'fail', { why: 'ci', failed: ['go (windows-latest)'] })] }))
    const ci = s.stages.find((x) => x.key === 'ci')!
    expect(ci.state).toBe('current')
    expect(ci.tone).toBe('fail')
    expect(ci.title).toMatch(/windows-latest/)
  })

  // Owner, 2026-11-26: an open release PR is where the release is until it merges.
  it('with the release PR green, is at the PR, waiting for it to merge', () => {
    const s = releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')], cards: [card(730, 'pass')] }))
    expect(s.current).toBe('pr')
    expect(states(s)).toMatchObject({ pr: 'current', ci: 'done', tag: 'todo' })
    expect(s.stages.find((x) => x.key === 'pr')?.title).toMatch(/waiting to merge/)
    expect(s.stages.find((x) => x.key === 'tag')?.title).toMatch(/#730 to merge/)
  })

  it('with the release PR’s checks not read, is at its CI, being read — never a later step', () => {
    const s = releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')] }))
    expect(s.current).toBe('ci')
    expect(states(s)).toMatchObject({ pr: 'done', ci: 'current', tag: 'todo' })
    expect(s.stages.find((x) => x.key === 'ci')?.title).toMatch(/^Reading #730’s checks/)
  })

  it('takes the release PR’s own checks read over the card, with the counts', () => {
    const read = { number: 730, state: 'running' as const, done: 6, total: 16 }
    const s = releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')], checks: read }))
    expect(s.current).toBe('ci')
    expect(s.pr).toEqual({ number: 730, merged: false, checks: read })
    expect(s.stages.find((x) => x.key === 'ci')).toMatchObject({ text: 'CI 6/16', tone: 'pending', title: '#730’s checks are running (6 of 16 checks finished).' })
    // Another pull request's read says nothing of this one.
    expect(releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')], checks: { ...read, number: 731 } })).pr?.checks).toBeUndefined()
    // The read wins over an older card state.
    expect(releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')], cards: [card(730, 'running')], checks: { ...read, state: 'pass', done: 16 } })).current).toBe('pr')
  })

  it('reads a pull request’s live checks as every CI view counts them', () => {
    const live = { state: 'pending' as const, passed: 1, failed: 1, pending: 2, items: [
      { name: 'lint', state: 'pass' as const }, { name: 'e2e', state: 'fail' as const }, { name: 'go (macos)', state: 'pending' as const }, { name: 'go (windows)', state: 'pending' as const }] }
    expect(checksRead(9, live)).toEqual({ number: 9, state: 'running', done: 2, total: 4, failed: ['e2e'] })
    expect(checksRead(9, { ...live, state: 'none', items: [] })).toEqual({ number: 9, state: 'none', done: 0, total: 0 })
    expect(checksRead(9, undefined)).toBeUndefined()
  })

  it('ignores a release PR for a version already tagged, and a closed one', () => {
    const s = releaseStatus(base({ prs: [pr(724, 'chore(release): 0.126.0', 'merged'), pr(729, 'chore(release): 0.127.0', 'closed')] }))
    expect(s.current).toBe('pr')
    expect(s.stages.find((x) => x.key === 'pr')?.text).toBe('release PR')
  })

  it('with the tag pushed and its run building, counts the files against the release before', () => {
    const s = releaseStatus(base({
      lastTag: { name: 'v0.127.0', at: T - H }, unreleased: pending({}, 0), merged: 0,
      prs: [pr(730, 'chore(release): 0.127.0', 'merged')],
      releases: [rel('v0.127.0', T - 0.5 * H, 6), rel('v0.126.0', T - 5 * H, 14)],
      run: run('v0.127.0', 'running', [job('completed'), job('in_progress')]),
    }))
    expect(s.phase).toBe('tagged')
    expect(s.version).toBe('0.127.0')
    expect(s.bump).toBe('minor')
    expect(s.current).toBe('builds')
    expect(states(s)).toEqual({ merged: 'done', pr: 'done', ci: 'done', tag: 'done', builds: 'current', published: 'done', site: 'unknown' })
    expect(s.stages.find((x) => x.key === 'builds')?.text).toBe('builds 6/14')
    expect(s.last?.tag).toBe('v0.126.0')
    expect(s.last?.assets).toBe(14)
  })

  // 2026-11-23: a released 0.191.0 drew its PR step dashed (not known)
  // because its release pull request was not among those listed. A tag says
  // it merged: done, without a number.
  it('counts the run’s jobs when no release is published yet, and draws an unlisted release PR of a tag done, without a number', () => {
    const s = releaseStatus(base({
      lastTag: { name: 'v0.127.0', at: T - H }, unreleased: pending({}, 0), merged: 0,
      run: run('v0.127.0', 'running', [job('completed'), job('completed'), job('queued')]),
    }))
    expect(s.stages.find((x) => x.key === 'builds')?.text).toBe('builds 2/3')
    expect(states(s)).toMatchObject({ pr: 'done', ci: 'done', tag: 'done', builds: 'current', published: 'todo' })
    expect(s.pr).toBeUndefined()
    const prStage = s.stages.find((x) => x.key === 'pr')!
    expect(prStage.text).toBe('release PR')
    expect(prStage.title).toContain('v0.127.0 is tagged, so its release pull request is merged')
    expect(stripStages(s).find((x) => x.key === 'pr')).toMatchObject({ state: 'done', tone: 'ok' })
    expect(stripStages(s).find((x) => x.key === 'pr')?.unknown).toBeUndefined()
  })

  it('finds a tagged version’s release pull request by its head branch when its title names no version', () => {
    const relPR: BranchPR = { ...pr(1041, 'Release', 'merged'), head: 'chore/release-0.127.0' }
    const s = releaseStatus(base({
      lastTag: { name: 'v0.127.0', at: T - H }, unreleased: pending({}, 0), merged: 0, prs: [relPR],
      run: run('v0.127.0', 'pass', [job('completed')], { url: 'u' }),
    }))
    expect(s.pr).toEqual({ number: 1041, merged: true })
    expect(s.stages.find((x) => x.key === 'pr')?.text).toBe('#1041')
  })

  it('reads a release branch’s version', () => {
    expect(releaseBranchVersion('chore/release-0.191.0')).toBe('0.191.0')
    expect(releaseBranchVersion('release/v1.2.3')).toBe('1.2.3')
    expect(releaseBranchVersion('feat/release-notes')).toBeUndefined()
    expect(releaseVersionOf({ title: 'chore(release): 0.191.0', head: 'x' })).toBe('0.191.0')
    expect(releaseVersionOf({ title: 'Ship it', head: 'chore/release-0.191.0' })).toBe('0.191.0')
  })

  it('marks a failed release run', () => {
    const s = releaseStatus(base({ lastTag: { name: 'v0.127.0', at: T - H }, unreleased: pending({}, 0), merged: 0, run: run('v0.127.0', 'fail') }))
    const b = s.stages.find((x) => x.key === 'builds')!
    expect(b.state).toBe('current')
    expect(b.tone).toBe('fail')
  })

  it('after the run passed and the release is published, moves on to the next release', () => {
    const s = releaseStatus(base({
      lastTag: { name: 'v0.127.0', at: T - H }, unreleased: pending({ Fixed: 1 }, 1), merged: 1,
      releases: [rel('v0.127.0', T - 0.5 * H, 14), rel('v0.126.0', T - 5 * H, 14)],
      run: run('v0.127.0', 'pass', [], { url: 'u' }),
    }))
    expect(s.phase).toBe('pre')
    expect(s.version).toBe('0.127.1')
    expect(s.last?.tag).toBe('v0.127.0')
  })

  it('with nothing waiting, says only the last release', () => {
    const s = releaseStatus(base({ unreleased: pending({}, 0), merged: 0 }))
    expect(s.phase).toBe('idle')
    expect(s.stages).toEqual([])
    expect(s.last).toMatchObject({ tag: 'v0.126.0', assets: 14 })
  })

  it('never names a version when the entries say no kind', () => {
    const s = releaseStatus(base({ unreleased: { ref: 'origin/master', items: [], count: 2 } }))
    expect(s.version).toBeUndefined()
    expect(s.why).toBeUndefined()
    expect(s.current).toBe('pr')
  })

  it('always leaves the site not known', () => {
    for (const s of [releaseStatus(base()), releaseStatus(base({ lastTag: { name: 'v0.127.0', at: T }, merged: 0, unreleased: pending({}, 0), run: run('v0.127.0', 'running') }))]) {
      const site = s.stages.find((x) => x.key === 'site')!
      expect(site.unknown).toBe(true)
      expect(site.state).toBe('todo')
    }
  })
})

// Owner, 2026-11-18, translated: "the folded version lacks the release
// status, and the status when unfolded is unclear". The approved lines, one
// per phase.
describe('the right panel’s folded Release line', () => {
  const fold = (s: ReleaseStatus, o: Partial<Parameters<typeof releaseFold>[1]> = {}) => releaseFold(s, { waiting: 0, now: T, ...o })

  it('says nothing is new since the last tag, grey', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), releases: [rel('v0.182.4', T - 30 * H, 23)], lastTag: { name: 'v0.182.4', at: T - 30 * H } }))
    expect(s.phase).toBe('idle')
    expect(fold(s, { lastTag: 'v0.182.4' })).toMatchObject({ kind: 'idle', text: 'Nothing new since v0.182.4', tone: 'idle' })
  })

  it('says a release just published is released, and how long ago, green', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - H }, releases: [rel('v0.183.0', T - 5 * 60_000, 23), rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'pass') }))
    expect(fold(s, { lastTag: 'v0.183.0' })).toMatchObject({ kind: 'out', text: '0.183.0 released · 5 min ago', tone: 'ok' })
    // An hour on, it is "nothing new" again.
    expect(fold(s, { lastTag: 'v0.183.0', now: T + 2 * H })).toMatchObject({ kind: 'idle', text: 'Nothing new since v0.183.0' })
  })

  // Owner, 2026-11-24, variant A: the release's agent cost beside it — only
  // when that release is listed and a cost above zero was recorded (rule 6).
  it('adds what agents spent on the release just out, only when it was recorded', () => {
    const out = rel('v0.183.0', T - 4 * 60_000, 23)
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - H }, releases: [out, rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'pass') }))
    const spent = { ...out, cost_usd: 17.249, prs: [1049, 1050, 1052], sessions: 2 }
    const f = fold(s, { releases: [spent] })
    expect(f).toMatchObject({ kind: 'out', text: '0.183.0 released · 4 min ago · $17.25' })
    expect(f.cost?.text).toBe('$17.25')
    expect(f.cost?.title).toMatch(/^\$17\.25 agents spent on 3 pull requests, 2 sessions\n/)
    expect(f.cost?.title).not.toMatch(/partial/)
    expect(f.title).toContain('$17.25 agents spent on 3 pull requests, 2 sessions')
    // One of each, and a partial count said so.
    expect(fold(s, { releases: [{ ...spent, prs: [1052], sessions: 1, partial: true }] }).cost?.title).toMatch(/^\$17\.25 agents spent on 1 pull request, 1 session\nIt may be partial/)
    // Matched by version whatever the tag's spelling; the batch's words after the cost.
    expect(fold(s, { releases: [{ ...spent, tag: '0.183.0' }], batch: { number: 960, ci: 'pass' } }).text).toBe('0.183.0 released · 4 min ago · $17.25 · PR #960 green')
    // Never a $0 for "not recorded", nor another release's cost, nor a cost with no release list.
    for (const releases of [[out], [{ ...spent, cost_usd: 0 }], [{ ...spent, tag: 'v0.182.4' }], undefined]) {
      const g = fold(s, { releases })
      expect(g.text).toBe('0.183.0 released · 4 min ago')
      expect(g.cost).toBeUndefined()
    }
  })

  // Owner, 2026-11-20, translated: "I stopped understanding what this means
  // … I must know the status exactly". Merged and no release PR: nothing runs.
  it('says a release ready and not started in grey, with the changes and the batch still open', () => {
    const s = releaseStatus(base({ lastTag: { name: 'v0.182.4', at: T - 5 * H }, unreleased: pending({ Added: 2, Fixed: 3 }, 5), releases: [rel('v0.182.4', T - 5 * H, 23)] }))
    expect(fold(s, { waiting: 5 })).toMatchObject({ kind: 'ready', text: 'Ready to release 0.183.0 · not started · 5 changes', tone: 'idle' })
    expect(fold(s, { waiting: 1 }).text).toBe('Ready to release 0.183.0 · not started · 1 change')
    expect(fold(s, { waiting: 5, batch: { number: 940, ci: 'pass', next: 'merge #940' } }).text).toBe('Ready to release 0.183.0 · not started · 5 changes · PR #940 green')
    expect(fold(s, { waiting: 5 }).title).toMatch(/^Nothing is running\. The changes are merged; v0\.183\.0 starts when someone opens its release pull request/)
  })

  // Owner, 2026-11-23: after a merge the line said *not started* while
  // master's checks ran; a release waits for them.
  it('says the default branch’s checks running or failed in place of not started', () => {
    const s = releaseStatus(base({ lastTag: { name: 'v0.190.0', at: T - 5 * H }, unreleased: pending({ Fixed: 1 }, 1), releases: [rel('v0.190.0', T - 5 * H, 23)] }))
    const running: MainChecks = { branch: 'master', state: 'running', done: 12, total: 17, failed: [], sha: 'a1f2189' }
    expect(fold(s, { waiting: 1, main: running })).toMatchObject({ kind: 'waiting', text: '0.190.1 · master checks running · 12 of 17 · 1 change', tone: 'waiting' })
    expect(fold(s, { waiting: 1, main: running }).title).toMatch(/master’s checks on a1f2189 are running \(12 of 17 jobs finished\)\. Nothing read says whether a release is queued\./)
    const failed: MainChecks = { branch: 'master', state: 'fail', done: 17, total: 17, failed: ['go (windows-latest)'] }
    expect(fold(s, { waiting: 1, main: failed })).toMatchObject({ kind: 'stopped', text: '0.190.1 · master checks failed · 1 change', tone: 'fail' })
    expect(fold(s, { waiting: 1, main: failed }).title).toMatch(/failed \(go \(windows-latest\)\)/)
  })

  it('reads the default branch’s checks only while they run or failed, and only of a commit after the newest merge', () => {
    const job = (name: string, status: string, conclusion?: string) => ({ id: 1, run_id: 1, name, status, conclusion, labels: [], steps: [] })
    const ci = (state: 'running' | 'fail' | 'pass', created: number, jobs: ReturnType<typeof job>[]) => ({ repo: 'o/r', head_sha: 'a1f2189d0000', branch: 'master', state, runs: [{ id: 1, name: 'ci', status: state === 'running' ? 'in_progress' : 'completed', created_at: created, jobs }], runner_ms: 0, by_os: [], at: T })
    expect(mainChecks(ci('running', T, [job('lint', 'completed', 'success'), job('go', 'in_progress')]), { since: T - H })).toEqual({ branch: 'master', state: 'running', done: 1, total: 2, failed: [], sha: 'a1f2189' })
    expect(mainChecks(ci('fail', T, [job('e2e', 'completed', 'failure')]))).toMatchObject({ state: 'fail', failed: ['e2e'] })
    expect(mainChecks(ci('pass', T, [job('lint', 'completed', 'success')]))).toBeUndefined()
    // Runs listed from before the newest merge are an older commit's.
    expect(mainChecks(ci('running', T - 2 * H, [job('go', 'in_progress')]), { since: T - H })).toBeUndefined()
    expect(mainChecks(undefined)).toBeUndefined()
  })

  it('says a release PR whose checks run as releasing, and red checks as stopped', () => {
    const input = { lastTag: { name: 'v0.182.4', at: T - 5 * H }, unreleased: pending({ Added: 1 }, 1), releases: [rel('v0.182.4', T - 5 * H, 23)], prs: [pr(942, 'chore(release): 0.183.0')] }
    const os: BoardCard['os'] = [{ os: 'linux', state: 'pass', checks: 3 }, { os: 'macos', state: 'running', checks: 3 }, { os: 'windows', state: 'running', checks: 3 }]
    const running = [card(942, 'running', { os })]
    expect(fold(releaseStatus(base({ ...input, cards: running })), { cards: running })).toMatchObject({ kind: 'releasing', text: 'Releasing 0.183.0 · checks 1 of 3 systems', tone: 'active' })
    expect(fold(releaseStatus(base({ ...input, cards: [card(942, 'running')] }))).text).toBe('Releasing 0.183.0 · checks running')
    expect(fold(releaseStatus(base({ ...input, cards: [card(942, 'fail')] })))).toMatchObject({ kind: 'stopped', text: 'Release 0.183.0 stopped · checks failed', tone: 'fail' })
    expect(fold(releaseStatus(base({ ...input, cards: [card(942, 'pass')] })))).toMatchObject({ kind: 'ready', text: '0.183.0 ready to merge · #942 checks passed', tone: 'idle' })
    // Its own checks read: named and counted (owner, 2026-11-26).
    expect(fold(releaseStatus(base({ ...input, checks: { number: 942, state: 'running', done: 6, total: 16 } }))).text).toBe('Releasing 0.183.0 · #942 checks running · 6 of 16')
    // Not read yet: being read, never *not read*.
    expect(fold(releaseStatus(base(input)))).toMatchObject({ kind: 'ready', text: '0.183.0 release PR open · #942 · reading checks…', tone: 'idle' })
  })

  it('says a tag building as releasing, with the files its release has of the last one’s; a failed build stopped', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.183.0', T - 120_000, 12), rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'running') }))
    expect(s.phase).toBe('tagged')
    expect(fold(s)).toMatchObject({ kind: 'releasing', text: 'Releasing 0.183.0 · building 12 of 23 files', tone: 'active' })
    // Read from the run's jobs while no release has files yet.
    const j = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'running', [job('completed'), job('in_progress'), job('queued')]) }))
    expect(fold(j).text).toBe('Releasing 0.183.0 · building 1 of 3 jobs')
    const failed = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'fail') }))
    expect(fold(failed)).toMatchObject({ kind: 'stopped', text: 'Release 0.183.0 stopped · build failed', tone: 'fail' })
  })

  it('says a tag no release published yet', () => {
    expect(tagUnpublished('v0.183.0', [rel('v0.182.4', T, 1)])).toBe(true)
    expect(tagUnpublished('v0.183.0', [rel('v0.183.0', T, 1)])).toBe(false)
    expect(tagUnpublished(undefined, [])).toBe(false)
  })
})

describe('the right panel’s stages strip', () => {
  it('names five stages, the release PR and its CI as one, the current one marked', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.182.4', T - 30 * H, 23)], prs: [pr(942, 'chore(release): 0.183.0', 'merged')], run: run('v0.183.0', 'running') }))
    const strip = stripStages(s)
    expect(strip.map((x) => x.text)).toEqual(['Merged', 'Release PR', 'Tagged', 'Building', 'Published'])
    expect(strip.map((x) => x.state)).toEqual(['done', 'done', 'done', 'current', 'todo'])
  })

  it('is at the release PR while its CI runs, red when it failed', () => {
    const input = { prs: [pr(942, 'chore(release): 0.127.0')] }
    const running = stripStages(releaseStatus(base({ ...input, cards: [card(942, 'running')] }))).find((x) => x.key === 'pr')!
    expect(running).toMatchObject({ state: 'current', tone: 'pending' })
    expect(running.title).toMatch(/checks are running/)
    expect(stripStages(releaseStatus(base({ ...input, cards: [card(942, 'fail')] }))).find((x) => x.key === 'pr')).toMatchObject({ state: 'current', tone: 'fail' })
  })

  // Owner, 2026-11-19: the strip is always drawn.
  it('draws the strip while idle too: the first stage current and dim; within the hour of a release, Published marked', () => {
    const idle = releaseStatus(base({ merged: 0, unreleased: pending({}, 0) }))
    const strip = stripStages(idle)
    expect(strip.map((x) => x.text)).toEqual(['Merged', 'Release PR', 'Tagged', 'Building', 'Published'])
    expect(strip.map((x) => x.state)).toEqual(['current', 'todo', 'todo', 'todo', 'todo'])
    expect(strip[0]!.tone).toBe('faint')
    const out = stripStages(idle, { out: true })
    expect(out.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'current'])
    expect(out[4]!.tone).toBe('ok')
  })

  // Coordinator, 2026-11-19: only the default branch's entries are merged;
  // with every entry on the open batch PR, the strip waits at Merged.
  it('counts only the default branch’s entries as merged', () => {
    const mixed: WorkRepo['unreleased'] = { ref: 'origin/master', items: ['a', 'b'], count: 2, kinds: { Fixed: 2 }, via: { number: 949, head: 'feat/batch', sha: 'abc' },
      entries: [{ text: 'a', kind: 'Fixed', source: 'master' }, { text: 'b', kind: 'Fixed', source: 'pr' }] }
    const s = releaseStatus(base({ merged: 0, unreleased: mixed, lastTag: { name: 'v0.183.0', at: T - 8 * H }, releases: [rel('v0.183.0', T - 8 * H, 23)] }))
    expect(s.stages[0]).toMatchObject({ key: 'merged', state: 'done', text: '1 entry' })
    expect(s.current).toBe('pr')
    // Every entry on the batch: Merged is where it is, in the strip too, as the folded line's "next: merge #949".
    const allPR = { ...mixed, entries: mixed.entries!.map((e) => ({ ...e, source: 'pr' as const })) }
    const w = releaseStatus(base({ merged: 0, unreleased: allPR, lastTag: { name: 'v0.183.0', at: T - 8 * H }, releases: [rel('v0.183.0', T - 8 * H, 23)] }))
    expect(stripStages(w).find((x) => x.state === 'current')?.key).toBe('merged')
    expect(releaseFold(w, { waiting: 2, now: T, batch: { number: 949, ci: 'pass', next: 'merge #949' } })).toMatchObject({ kind: 'waiting', text: 'Waiting for #949 to merge · 0.183.1 · 2 changes', tone: 'waiting' })
    expect(releaseFold(w, { waiting: 2, now: T, batch: { number: 949, ci: 'fail' } })).toMatchObject({ kind: 'stopped', text: 'Waiting for #949 to merge · CI red · 0.183.1 · 2 changes', tone: 'fail' })
    // A feature queued: the version it makes, as the unfolded heading says it.
    const next = nextHint(w, [{ number: 951, title: 'feat(ui): x' }])
    expect(releaseFold(w, { waiting: 2, now: T, batch: { number: 949, ci: 'pass' }, next })).toMatchObject({ text: 'Waiting for #949 to merge · 0.184.0 · 2 changes' })
  })

  // Owner, 2026-11-25: folded and unfolded name one number, the heading's.
  it('says the version the queued PRs make, and what it waits for, in place of not started', () => {
    const fold = (s: ReleaseStatus, o: Partial<Parameters<typeof releaseFold>[1]> = {}) => releaseFold(s, { waiting: 0, now: T, ...o })
    const s =releaseStatus(base({ merged: 1, unreleased: { ref: 'origin/master', items: ['a'], count: 1, kinds: { Fixed: 1 } }, lastTag: { name: 'v0.196.0', at: T - 8 * H }, releases: [rel('v0.196.0', T - 8 * H, 23)] }))
    expect(fold(s, { waiting: 1 })).toMatchObject({ kind: 'ready', text: 'Ready to release 0.196.1 · not started · 1 change' })
    // Nothing queued, or a fix on a patch: as before.
    expect(fold(s, { waiting: 1, next: nextHint(s, []) }).text).toBe('Ready to release 0.196.1 · not started · 1 change')
    expect(fold(s, { waiting: 1, next: nextHint(s, [{ number: 1080, title: 'fix: y' }]) }).text).toBe('Ready to release 0.196.1 · not started · 1 change')
    const one = fold(s, { waiting: 1, next: nextHint(s, [{ number: 1072, title: 'feat(app): x' }]) })
    expect(one).toMatchObject({ kind: 'ready', text: 'Ready to release 0.197.0 · waits for #1072', tone: 'idle' })
    expect(one.title).toMatch(/0\.196\.1 is what the default branch holds now \(patch\)\./)
    expect(fold(s, { waiting: 1, next: nextHint(s, [{ number: 1072, title: 'feat: x' }, { number: 1080, title: 'fix: y' }]) }).text).toBe('Ready to release 0.197.0 · waits for #1072, #1080')
    expect(fold(s, { waiting: 1, next: nextHint(s, [1, 2, 3].map((number) => ({ number, title: 'feat: x' }))) }).text).toBe('Ready to release 0.197.0 · waits for 3 PRs')
  })

  it('keeps Merged to come while the entries are only on the batch PR’s branch', () => {
    const onPR: WorkRepo['unreleased'] = { ref: 'origin/master', items: ['a', 'b'], count: 2, kinds: { Fixed: 2 }, via: { number: 949, head: 'feat/batch', sha: 'abc' },
      entries: [{ text: 'a', kind: 'Fixed', source: 'pr' }, { text: 'b', kind: 'Fixed', source: 'pr' }] }
    const s = releaseStatus(base({ merged: 0, unreleased: onPR, lastTag: { name: 'v0.183.0', at: T - 8 * H }, releases: [rel('v0.183.0', T - 8 * H, 23)] }))
    expect(s.version).toBe('0.183.1')
    expect(s.current).toBe('merged')
    expect(s.stages[0]!.title).toBe('2 changelog entries on #949’s branch, waiting for it to merge.')
  })
})

// Owner, 2026-11-26 (translated: "again a PR step that's punched out — not
// logical, not clear"): every stepper state is done, current (in the status's
// tone) or to come; the step it is at is never a later one than the release is.
describe('the stepper’s states', () => {
  const step = (over: Partial<ReleaseStatusInput>) => {
    const s = releaseStatus(base(over))
    const strip = stripStages(s)
    const w = stageWords(s, strip, { cards: over.cards, now: T })!
    return { states: strip.map((x) => x.state).join(' '), at: w.key, tone: w.tone, text: w.text }
  }
  const relPR = (extra: Partial<BranchPR> = {}) => ({ prs: [{ ...pr(1080, 'chore(release): 0.127.0'), ...extra }] })

  it('no release PR: at the PR, not started', () => {
    expect(step({})).toEqual({ states: 'done current todo todo todo', at: 'pr', tone: 'idle', text: 'Ready to release · not started' })
  })
  it('release PR open, checks running: at the PR, in progress, counted', () => {
    expect(step({ ...relPR(), checks: { number: 1080, state: 'running', done: 6, total: 16 } }))
      .toEqual({ states: 'done current todo todo todo', at: 'pr', tone: 'active', text: 'Releasing · #1080 checks running · 6 of 16' })
    expect(step({ ...relPR(), cards: [card(1080, 'running')] })).toMatchObject({ states: 'done current todo todo todo', tone: 'active', text: 'Releasing · checks running' })
  })
  it('release PR open, checks unknown: at the PR, being read — Tagged to come like the rest', () => {
    expect(step(relPR())).toEqual({ states: 'done current todo todo todo', at: 'pr', tone: 'idle', text: 'Release PR open · #1080 · reading checks…' })
    expect(stripStages(releaseStatus(base(relPR()))).some((x) => x.unknown)).toBe(false)
  })
  it('release PR open, checks failed: at the PR, stopped', () => {
    expect(step({ ...relPR(), checks: { number: 1080, state: 'fail', done: 16, total: 16, failed: ['e2e'] } })).toMatchObject({ states: 'done current todo todo todo', at: 'pr', tone: 'fail', text: 'Release stopped · checks failed' })
  })
  it('release PR open, a job given no machine: at the PR, waiting', () => {
    expect(step({ ...relPR(), cards: [card(1080, 'no_runner')] })).toEqual({ states: 'done current todo todo todo', at: 'pr', tone: 'waiting', text: 'Release PR open · #1080 · a job not run' })
  })
  it('release PR open, green: at the PR, waiting to merge', () => {
    expect(step({ ...relPR(), checks: { number: 1080, state: 'pass', done: 16, total: 16 } })).toEqual({ states: 'done current todo todo todo', at: 'pr', tone: 'idle', text: 'Ready to merge · #1080 checks passed' })
  })
  it('a draft release PR: at the PR', () => {
    expect(step(relPR({ draft: true }))).toMatchObject({ states: 'done current todo todo todo', at: 'pr', tone: 'idle', text: 'Ready to release · #1080 is a draft' })
  })
  it('release PR merged, not tagged: at Tagged', () => {
    expect(step(relPR({ state: 'merged' }))).toMatchObject({ states: 'done done current todo todo', at: 'tag', tone: 'idle' })
  })
})

// Owner, 2026-11-19, variant A: only the stage it is at is named, with its
// detail; 2026-11-20 (translated: "it must be really clear, I must know the
// status exactly"): the state first in plain words, in one colour language —
// grey nothing happening, blue in progress, amber waiting, red stopped, green done.
describe('the words beside the stage dots', () => {
  const words = (s: ReleaseStatus, o: { cards?: BoardCard[]; out?: boolean; batch?: BatchPR } = {}) => stageWords(s, stripStages(s, { out: o.out }), { ...o, now: T })

  it('merged, no release PR: ready to release, not started, grey', () => {
    expect(words(releaseStatus(base()))).toMatchObject({ key: 'pr', index: 2, name: 'Release PR', text: 'Ready to release · not started', tone: 'idle' })
  })

  it('every entry on the batch PR: waiting for it to merge, amber; red when its checks failed', () => {
    const onPR: WorkRepo['unreleased'] = { ref: 'origin/master', items: ['a'], count: 1, kinds: { Fixed: 1 }, via: { number: 949, head: 'feat/batch', sha: 'abc' }, entries: [{ text: 'a', kind: 'Fixed', source: 'pr' }] }
    const w = releaseStatus(base({ merged: 0, unreleased: onPR, lastTag: { name: 'v0.183.0', at: T - 8 * H }, releases: [rel('v0.183.0', T - 8 * H, 23)] }))
    expect(words(w)).toMatchObject({ key: 'merged', index: 1, text: 'Waiting for #949 to merge', tone: 'waiting' })
    // Once its state is read the number is followed by it, not *to merge*:
    // *Waiting for #949 · CI red* (owner, 2026-11-20); the folded line keeps *to merge*.
    expect(words(w, { batch: { number: 949, ci: 'fail', failed: ['e2e (headless shell)'] } })).toMatchObject({ text: 'Waiting for #949 · CI red', vlead: 'Waiting for #949 to merge', tone: 'fail', title: expect.stringMatching(/Failed: e2e \(headless shell\)\./) })
    expect(words(w, { batch: { number: 949, ci: 'running', state: { text: 'checks running' } } })).toMatchObject({ text: 'Waiting for #949 · checks running', tone: 'waiting' })
    expect(words(w, { batch: { number: 949, ci: 'pass', state: { text: 'needs a rebase', tone: 'danger' } } })).toMatchObject({ text: 'Waiting for #949 · needs a rebase', tone: 'fail' })
  })

  it('release PR checks running: releasing, blue, the systems counted and named on hover', () => {
    const input = { prs: [pr(952, 'chore(release): 0.127.0')] }
    const os: BoardCard['os'] = [{ os: 'linux', state: 'pass', checks: 3 }, { os: 'macos', state: 'running', checks: 3 }, { os: 'windows', state: 'running', checks: 3 }]
    const running = [card(952, 'running', { os })]
    // Owner, 2026-11-19: the count is of operating systems, said so, and named on hover.
    expect(words(releaseStatus(base({ ...input, cards: running })), { cards: running })).toMatchObject({ key: 'pr', index: 2, name: 'Release PR', text: 'Releasing · checks 1 of 3 systems', tone: 'active',
      title: 'Release pull request #952: 1 of 3 systems (macOS, Windows, Linux) passed; the rest are running.' })
    expect(words(releaseStatus(base({ ...input, cards: [card(952, 'running')] })))?.text).toBe('Releasing · checks running')
  })

  it('release PR checks red: release stopped, red, naming the system when known', () => {
    const input = { prs: [pr(952, 'chore(release): 0.127.0')] }
    expect(words(releaseStatus(base({ ...input, cards: [card(952, 'fail')] })))).toMatchObject({ text: 'Release stopped · checks failed', tone: 'fail' })
    const os: BoardCard['os'] = [{ os: 'linux', state: 'pass', checks: 3 }, { os: 'windows', state: 'fail', checks: 3 }]
    const red = [card(952, 'fail', { os })]
    expect(words(releaseStatus(base({ ...input, cards: red })), { cards: red })?.text).toBe('Release stopped · checks failed on Windows')
  })

  it('a draft release PR, a green one waiting to merge, a merged one not tagged: grey, nothing runs', () => {
    expect(words(releaseStatus(base({ prs: [{ ...pr(952, 'chore(release): 0.127.0'), draft: true }] })))).toMatchObject({ text: 'Ready to release · #952 is a draft', tone: 'idle' })
    expect(words(releaseStatus(base({ prs: [pr(952, 'chore(release): 0.127.0')], cards: [card(952, 'pass')] })))).toMatchObject({ key: 'pr', text: 'Ready to merge · #952 checks passed', tone: 'idle' })
    expect(words(releaseStatus(base({ prs: [pr(952, 'chore(release): 0.127.0', 'merged')] })))).toMatchObject({ key: 'tag', text: 'Not tagged yet · #952 merged', tone: 'idle' })
  })

  it('tagged and building: releasing, blue, with its files; a failed build stopped, red', () => {
    const s = (state: ReleaseCI['state']) => releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.183.0', T - 60_000, 12), rel('v0.182.4', T - 30 * H, 23)], prs: [pr(942, 'chore(release): 0.183.0', 'merged')], run: run('v0.183.0', state) }))
    expect(words(s('running'))).toMatchObject({ key: 'builds', index: 4, text: 'Releasing · building 12 of 23 files', tone: 'active' })
    expect(words(s('fail'))).toMatchObject({ text: 'Release stopped · build failed at 12 of 23 files', tone: 'fail' })
  })

  it('published only as a draft: release stopped, draft only, not public, red', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.127.0', at: T - 600_000 }, releases: [rel('v0.126.0', T - 5 * H, 14)], prs: [pr(952, 'chore(release): 0.127.0', 'merged')],
      run: run('v0.127.0', 'pass', [], { url: 'u', draft: true }) }))
    expect(words(s)).toMatchObject({ key: 'published', text: 'Release stopped · draft only, not public', tone: 'fail' })
  })

  it('published within the hour: released, with its age, green', () => {
    const idle = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), releases: [rel('v0.183.0', T - 5 * 60_000, 23)] }))
    expect(words(idle, { out: true })).toMatchObject({ key: 'published', index: 5, text: 'Released · 5 min ago', tone: 'ok' })
  })
})

// Owner, 2026-11-23, variant 2A: a kind label in place of *feat(app):*.
describe('a pull request title’s kind', () => {
  it('reads the Conventional Commits kind, its bump and the rest capitalised', () => {
    expect(prKind('feat(app): the menu bar panel shows itself')).toEqual({ label: 'feat', text: 'The menu bar panel shows itself', bump: 'minor' })
    expect(prKind('fix: the voice strip')).toEqual({ label: 'fix', text: 'The voice strip', bump: 'patch' })
    expect(prKind('chore(deps): bump github.com/klauspost/compress')).toEqual({ label: 'deps', text: 'Bump github.com/klauspost/compress', bump: 'patch' })
    expect(prKind('build(deps-dev): bump vite')).toMatchObject({ label: 'deps', bump: 'patch' })
    expect(prKind('perf(store): extend a session’s calls')).toMatchObject({ label: 'perf', bump: 'patch' })
    expect(prKind('feat(api)!: drop the old route')).toMatchObject({ label: 'feat', text: 'Drop the old route', bump: 'major' })
    expect(prKind('refactor: BREAKING the config file moves')).toMatchObject({ label: 'refactor', bump: 'major' })
  })

  it('says no kind for a title that opens with none, keeping its words', () => {
    expect(prKind('brain: agents → shared brain')).toEqual({ text: 'brain: agents → shared brain' })
    expect(prKind('input highlight')).toEqual({ text: 'input highlight' })
  })
})

// Owner, 2026-11-23, variant 1A: *0.189.2* while a feature waits in a PR.
describe('the version the open pull requests would make', () => {
  const pre = { phase: 'pre' as const, version: '0.189.2', bump: 'patch' as const }
  it('raises a version by a bigger bump only', () => {
    expect(raiseVersion('0.189.2', 'patch', 'minor')).toBe('0.190.0')
    expect(raiseVersion('0.190.0', 'minor', 'major')).toBe('1.0.0')
    expect(raiseVersion('0.189.2', 'patch', 'major')).toBe('1.0.0')
    expect(raiseVersion('0.190.0', 'minor', 'minor')).toBeUndefined()
    expect(raiseVersion('0.190.0', 'minor', 'patch')).toBeUndefined()
  })

  it('names the version and what waits when a feature PR would make it a minor', () => {
    const h = nextHint(pre, [
      { number: 1022, title: 'feat(app): menu bar panel' },
      { number: 1023, title: 'fix(app): voice strip' },
      { number: 1024, title: 'feat: subagents as one tree' },
      { number: 1017, title: 'chore(deps): bump compress' },
      { number: 1030, title: 'input highlight' },
    ])
    expect(h).toMatchObject({ version: '0.190.0', bump: 'minor', waits: 'waits for 4 PRs', sub: '2 features, 1 fix and 1 other waiting', numbers: [1022, 1023, 1024, 1017] })
    expect(h!.title).toMatch(/^0\.189\.2 is what the default branch holds now \(patch\)\./)
  })

  it('says one PR by its number, and keeps every number for the rows', () => {
    expect(nextHint(pre, [{ number: 7, title: 'feat: x' }])).toMatchObject({ waits: 'waits for #7', sub: '1 feature waiting' })
    const many = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: 'feat: x' }))
    expect(nextHint(pre, many)).toMatchObject({ waits: 'waits for 7 PRs', sub: '7 features waiting', numbers: [1, 2, 3, 4, 5, 6, 7] })
    // Two by number (a fix among them counts), three and up as a count.
    expect(nextHint(pre, [{ number: 1072, title: 'feat: x' }, { number: 1080, title: 'fix: y' }])).toMatchObject({ version: '0.190.0', waits: 'waits for #1072, #1080' })
    expect(nextHint(pre, many.slice(0, 3))).toMatchObject({ waits: 'waits for 3 PRs' })
    expect(nextHint({ ...pre, version: '0.190.0', bump: 'minor' }, [{ number: 8, title: 'fix!: y' }])).toMatchObject({ version: '1.0.0', bump: 'major', sub: '1 breaking change waiting' })
  })

  it('says nothing when the open PRs would not change the version, or nothing is predicted', () => {
    expect(nextHint(pre, [{ number: 1, title: 'fix: a' }, { number: 2, title: 'chore(deps): b' }])).toBeUndefined()
    expect(nextHint({ ...pre, version: '0.190.0', bump: 'minor' }, [{ number: 1, title: 'feat: a' }])).toBeUndefined()
    expect(nextHint(pre, [{ number: 1, title: 'a feature, no kind said' }])).toBeUndefined()
    expect(nextHint(pre, [])).toBeUndefined()
    expect(nextHint({ phase: 'pre' }, [{ number: 1, title: 'feat: a' }])).toBeUndefined()
    expect(nextHint({ ...pre, phase: 'tagged' }, [{ number: 1, title: 'feat: a' }])).toBeUndefined()
    expect(nextHint({ ...pre, pr: { number: 9, merged: false } }, [{ number: 1, title: 'feat: a' }])).toBeUndefined()
  })
})
