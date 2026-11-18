import { describe, expect, it } from 'vitest'
import type { CIJob, ReleaseCI, WorkRepo } from './api'
import type { BranchPR } from './branches'
import type { BoardCard, BoardRelease } from './prboard'
import { bumpBetween, plainVersion, releaseFold, releasePRVersion, releaseStatus, stripStages, tagUnpublished, type ReleaseStatus, type ReleaseStatusInput } from './releasestatus'

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

  it('with the release PR green, waits for the tag', () => {
    const s = releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')], cards: [card(730, 'pass')] }))
    expect(s.current).toBe('tag')
    expect(s.stages.find((x) => x.key === 'tag')?.title).toMatch(/#730 to merge/)
  })

  it('says CI not known when the release PR’s checks were not read', () => {
    const s = releaseStatus(base({ prs: [pr(730, 'chore(release): 0.127.0')] }))
    // Unknown is neutral, never invented: the first knowable stage after it is current.
    expect(states(s).ci).toBe('unknown')
    expect(s.current).toBe('tag')
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

  it('counts the run’s jobs when no release is published yet, and leaves an unseen release PR not known', () => {
    const s = releaseStatus(base({
      lastTag: { name: 'v0.127.0', at: T - H }, unreleased: pending({}, 0), merged: 0,
      run: run('v0.127.0', 'running', [job('completed'), job('completed'), job('queued')]),
    }))
    expect(s.stages.find((x) => x.key === 'builds')?.text).toBe('builds 2/3')
    expect(states(s)).toMatchObject({ pr: 'unknown', ci: 'unknown', tag: 'done', builds: 'current', published: 'todo' })
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

  it('says nothing is new since the last tag', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), releases: [rel('v0.182.4', T - 30 * H, 23)], lastTag: { name: 'v0.182.4', at: T - 30 * H } }))
    expect(s.phase).toBe('idle')
    expect(fold(s, { lastTag: 'v0.182.4' })).toMatchObject({ kind: 'idle', text: 'Nothing new since v0.182.4' })
  })

  it('says a release just published is out, and how long ago', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - H }, releases: [rel('v0.183.0', T - 5 * 60_000, 23), rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'pass') }))
    expect(fold(s, { lastTag: 'v0.183.0' })).toMatchObject({ kind: 'out', text: 'v0.183.0 out · 5 min ago', tone: 'ok' })
    // An hour on, it is "nothing new" again.
    expect(fold(s, { lastTag: 'v0.183.0', now: T + 2 * H })).toMatchObject({ kind: 'idle', text: 'Nothing new since v0.183.0' })
  })

  it('counts the changes waiting and names the open batch PR with its checks', () => {
    const s = releaseStatus(base({ lastTag: { name: 'v0.182.4', at: T - 5 * H }, unreleased: pending({ Added: 2, Fixed: 3 }, 5), releases: [rel('v0.182.4', T - 5 * H, 23)] }))
    expect(fold(s, { waiting: 5, batch: { number: 940, ci: 'pass' } })).toMatchObject({ kind: 'waiting', text: '0.183.0 · 5 changes waiting · PR #940 green' })
    expect(fold(s, { waiting: 5, batch: { number: 940, ci: 'fail' } })).toMatchObject({ text: '0.183.0 · 5 changes waiting · PR #940 CI red', tone: 'fail' })
    expect(fold(s, { waiting: 1 }).text).toBe('0.183.0 · 1 change waiting')
  })

  it('names the release PR and its CI', () => {
    const input = { lastTag: { name: 'v0.182.4', at: T - 5 * H }, unreleased: pending({ Added: 1 }, 1), releases: [rel('v0.182.4', T - 5 * H, 23)], prs: [pr(942, 'chore(release): 0.183.0')] }
    expect(fold(releaseStatus(base({ ...input, cards: [card(942, 'running')] }))).text).toBe('0.183.0 · release PR #942 · CI running')
    expect(fold(releaseStatus(base({ ...input, cards: [card(942, 'fail')] })))).toMatchObject({ text: '0.183.0 · release PR #942 · CI red', tone: 'fail' })
    expect(fold(releaseStatus(base({ ...input, cards: [card(942, 'pass')] }))).text).toBe('0.183.0 · release PR #942 · CI green')
  })

  it('says a tag is building, with the files its release has of the last one’s', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.183.0', T - 120_000, 12), rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'running') }))
    expect(s.phase).toBe('tagged')
    expect(fold(s)).toMatchObject({ kind: 'building', text: '0.183.0 · building · 12 of 23 files' })
    // Read from the run's jobs while no release has files yet.
    const j = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'running', [job('completed'), job('in_progress'), job('queued')]) }))
    expect(fold(j).text).toBe('0.183.0 · building · 1 of 3 jobs')
    const failed = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.182.4', T - 30 * H, 23)], run: run('v0.183.0', 'fail') }))
    expect(fold(failed)).toMatchObject({ kind: 'failed', text: '0.183.0 · build failed', tone: 'fail' })
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

  it('draws nothing while idle', () => {
    expect(stripStages(releaseStatus(base({ merged: 0, unreleased: pending({}, 0) })))).toEqual([])
  })
})
