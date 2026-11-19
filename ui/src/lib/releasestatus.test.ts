import { describe, expect, it } from 'vitest'
import type { CIJob, ReleaseCI, WorkRepo } from './api'
import type { BranchPR } from './branches'
import type { BoardCard, BoardRelease } from './prboard'
import { bumpBetween, plainVersion, releaseFold, releasePRVersion, releaseStatus, stageWords, stripStages, tagUnpublished, type ReleaseStatus, type ReleaseStatusInput } from './releasestatus'

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

  // Owner, 2026-11-19: variant B's next step in the folded line.
  it('counts the changes waiting and says the next step: the batch PR’s, its red CI, or a release PR', () => {
    const s = releaseStatus(base({ lastTag: { name: 'v0.182.4', at: T - 5 * H }, unreleased: pending({ Added: 2, Fixed: 3 }, 5), releases: [rel('v0.182.4', T - 5 * H, 23)] }))
    expect(fold(s, { waiting: 5, batch: { number: 940, ci: 'pass', next: 'merge #940' } })).toMatchObject({ kind: 'waiting', text: '0.183.0 · 5 changes · next: merge #940' })
    expect(fold(s, { waiting: 5, batch: { number: 940, ci: 'running', next: 'wait for CI' } }).text).toBe('0.183.0 · 5 changes · next: wait for CI')
    expect(fold(s, { waiting: 5, batch: { number: 940, ci: 'fail', next: 'fix CI on #940' } })).toMatchObject({ text: '0.183.0 · 5 changes · batch CI red', tone: 'fail' })
    expect(fold(s, { waiting: 5, batch: { number: 940 } }).text).toBe('0.183.0 · 5 changes · next: merge #940')
    expect(fold(s, { waiting: 1 }).text).toBe('0.183.0 · 1 change · next: release PR')
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
    expect(releaseFold(w, { waiting: 2, now: T, batch: { number: 949, ci: 'pass', next: 'merge #949' } }).text).toBe('0.183.1 · 2 changes · next: merge #949')
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

// Owner, 2026-11-19, variant A: only the stage it is at is named, with its detail.
describe('the words beside the stage dots', () => {
  const words = (s: ReleaseStatus, o: { cards?: BoardCard[]; out?: boolean } = {}) => stageWords(s, stripStages(s, { out: o.out }), { ...o, now: T })
  it('names the release PR with its draft, its CI per OS, or its red CI', () => {
    const input = { prs: [pr(952, 'chore(release): 0.127.0')] }
    const os: BoardCard['os'] = [{ os: 'linux', state: 'pass', checks: 3 }, { os: 'macos', state: 'running', checks: 3 }, { os: 'windows', state: 'running', checks: 3 }]
    const running = [card(952, 'running', { os })]
    // Owner, 2026-11-19: the count is of operating systems, said so, and named on hover.
    expect(words(releaseStatus(base({ ...input, cards: running })), { cards: running })).toMatchObject({ key: 'pr', index: 2, name: 'Release PR', text: 'Release PR #952 · CI 1/3 systems', tone: 'pending',
      title: '1 of 3 systems (macOS, Windows, Linux) passed; the rest are running.' })
    expect(words(releaseStatus(base({ ...input, cards: [card(952, 'running')] })))?.title).toBeUndefined()
    expect(words(releaseStatus(base({ ...input, cards: [card(952, 'running')] })))?.text).toBe('Release PR #952 · CI running')
    expect(words(releaseStatus(base({ ...input, cards: [card(952, 'fail')] })))).toMatchObject({ text: 'Release PR #952 · CI red', tone: 'fail' })
    expect(words(releaseStatus(base({ prs: [{ ...pr(952, 'chore(release): 0.127.0'), draft: true }] })))?.text).toBe('Release PR #952 · draft')
  })

  it('says a release PR not opened yet', () => {
    expect(words(releaseStatus(base()))).toMatchObject({ key: 'pr', text: 'Release PR · not opened yet' })
  })

  it('names a draft GitHub release as not public', () => {
    const s = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.127.0', at: T - 600_000 }, releases: [rel('v0.126.0', T - 5 * H, 14)], prs: [pr(952, 'chore(release): 0.127.0', 'merged')],
      run: run('v0.127.0', 'pass', [], { url: 'u', draft: true }) }))
    expect(words(s)).toMatchObject({ key: 'published', text: 'Published · draft only, not public' })
  })

  it('names Tagged while a green release PR waits to merge, and once merged the tag it waits for', () => {
    expect(words(releaseStatus(base({ prs: [pr(952, 'chore(release): 0.127.0')], cards: [card(952, 'pass')] })))?.text).toBe('Tagged · waiting: merge #952')
    expect(words(releaseStatus(base({ prs: [pr(952, 'chore(release): 0.127.0', 'merged')] })))?.text).toBe('Tagged · waiting for v0.127.0')
  })

  it('names Building with its files, red when the build failed', () => {
    const s = (state: ReleaseCI['state']) => releaseStatus(base({ merged: 0, unreleased: pending({}, 0), lastTag: { name: 'v0.183.0', at: T - 600_000 }, releases: [rel('v0.183.0', T - 60_000, 12), rel('v0.182.4', T - 30 * H, 23)], prs: [pr(942, 'chore(release): 0.183.0', 'merged')], run: run('v0.183.0', state) }))
    expect(words(s('running'))).toMatchObject({ key: 'builds', index: 4, text: 'Building · 12 of 23 files', tone: 'pending' })
    expect(words(s('fail'))).toMatchObject({ text: 'Building · failed at 12 of 23 files', tone: 'fail' })
  })

  it('names Merged without the batch’s number (its via line says it), and Published with its age within the hour', () => {
    const onPR: WorkRepo['unreleased'] = { ref: 'origin/master', items: ['a'], count: 1, kinds: { Fixed: 1 }, via: { number: 949, head: 'feat/batch', sha: 'abc' }, entries: [{ text: 'a', kind: 'Fixed', source: 'pr' }] }
    const w = releaseStatus(base({ merged: 0, unreleased: onPR, lastTag: { name: 'v0.183.0', at: T - 8 * H }, releases: [rel('v0.183.0', T - 8 * H, 23)] }))
    expect(words(w)).toMatchObject({ key: 'merged', index: 1, text: 'Merged · waiting to merge' })
    const idle = releaseStatus(base({ merged: 0, unreleased: pending({}, 0), releases: [rel('v0.183.0', T - 5 * 60_000, 23)] }))
    expect(words(idle, { out: true })).toMatchObject({ key: 'published', index: 5, text: 'Published · 5 min ago', tone: 'ok' })
  })
})
