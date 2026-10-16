import { describe, expect, it } from 'vitest'
import type { CIJob, ReleaseCI, WorkRepo } from './api'
import type { BranchPR } from './branches'
import type { BoardCard, BoardRelease } from './prboard'
import { bumpBetween, plainVersion, releasePRVersion, releaseStatus, type ReleaseStatus, type ReleaseStatusInput } from './releasestatus'

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
