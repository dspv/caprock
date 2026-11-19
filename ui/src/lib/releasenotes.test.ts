import { describe, expect, it } from 'vitest'
import type { WorkRepo } from './api'
import type { BranchPR } from './branches'
import type { BoardCard } from './prboard'
import { batchOf, groupNotes, notesHeading, notesOf, notInIt, plainItem, viaLine } from './releasenotes'
import type { PlanRow } from './releaseplan'
import { releaseStatus, type ReleaseStatusInput } from './releasestatus'

const H = 3_600_000
const T = Date.UTC(2026, 10, 19, 12)
const SPEND = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
const pr = (number: number, title: string, extra: Partial<BranchPR> = {}): BranchPR => ({ number, title, state: 'open', url: `https://github.com/o/r/pull/${number}`, ...extra })
const card = (number: number, extra: Partial<BoardCard>): BoardCard => ({ number, stage: 'open', spend: SPEND, ...extra })
const status = (over: Partial<ReleaseStatusInput>) => releaseStatus({ lastTag: { name: 'v0.183.0', at: T - 8 * H }, merged: 0, prs: [], releases: [{ tag: 'v0.183.0', published_at: T - 8 * H, prs: [], cost_usd: 0, sessions: 0 }], ...over })
const onBatch: WorkRepo['unreleased'] = {
  ref: 'origin/master', items: ['**ui:** a', '**ui:** b'], count: 2, kinds: { Changed: 1, Fixed: 1 }, via: { number: 949, head: 'feat/batch', sha: 'abc' },
  entries: [{ text: 'b fixed', kind: 'Fixed', source: 'pr' }, { text: 'a changed', kind: 'Changed', source: 'pr' }],
}
const repo = (over: Partial<WorkRepo> = {}): WorkRepo => ({ root: '/r', name: 'r', via_session: 's', live: 1, unreleased: onBatch, ...over })

describe('the release notes', () => {
  it('groups the entries by kind in Keep a Changelog order, the ones of no kind last', () => {
    const g = groupNotes([{ text: 'f1', kind: 'Fixed' }, { text: 'x' }, { text: 'a1', kind: 'added' }, { text: 'f2', kind: 'Fixed' }, { text: 'c1', kind: 'Changed' }])
    expect(g.map((x) => [x.kind, x.entries.map((e) => e.text)])).toEqual([['Added', ['a1']], ['Changed', ['c1']], ['Fixed', ['f1', 'f2']], ['Other', ['x']]])
  })

  it('reads an older daemon’s first lines in plain words', () => {
    expect(plainItem('**ui:** the *CI* line, `code` and [a link](https://x.example)')).toEqual({ text: 'the CI line, code and a link', scope: 'ui' })
  })

  it('predicts the version from the batch PR’s fragments and lists them while waiting', () => {
    const s = status({ unreleased: onBatch })
    const h = notesHeading(s, { name: 'v0.183.0', at: T - 8 * H }, T)
    expect(h).toMatchObject({ state: 'waiting', text: '0.183.1', why: { text: 'patch', title: expect.stringMatching(/^patch: fixes only\.\n/) }, age: 'last 8h ago' })
    expect(notesOf(repo(), h, s).map((e) => e.text)).toEqual(['b fixed', 'a changed'])
  })

  it('says nothing new, shipping, and out with the released section’s notes', () => {
    const idle = status({ unreleased: { ref: 'origin/master', items: [], count: 0 } })
    expect(notesHeading(idle, { name: 'v0.183.0', at: T - 8 * H }, T)).toMatchObject({ state: 'idle', text: 'Nothing new since v0.183.0', age: '8h ago' })
    const ship = status({ unreleased: onBatch, prs: [pr(950, 'chore(release): 0.183.1')] })
    const sh = notesHeading(ship, undefined, T)
    expect(sh.text).toBe('Shipping 0.183.1')
    const released = { version: '0.183.1', count: 1, entries: [{ text: 'shipped', kind: 'Fixed' }] }
    expect(notesOf(repo({ released }), sh, ship).map((e) => e.text)).toEqual(['shipped'])
    const out = status({ lastTag: { name: 'v0.183.1', at: T - 10 * 60_000 }, unreleased: { ref: 'origin/master', items: [], count: 0 },
      releases: [{ tag: 'v0.183.1', published_at: T - 5 * 60_000, prs: [], cost_usd: 0, sessions: 0 }] })
    const oh = notesHeading(out, { name: 'v0.183.1', at: T - 10 * 60_000 }, T)
    expect(oh).toMatchObject({ state: 'out', text: 'v0.183.1 out', age: '5 min ago' })
    expect(notesOf(repo({ released, unreleased: undefined }), oh, out).map((e) => e.text)).toEqual(['shipped'])
    // A released section of another version is not this release's.
    expect(notesOf(repo({ released: { ...released, version: '0.183.0' }, unreleased: undefined }), oh, out)).toEqual([])
  })

  it('picks the batch: the daemon’s via first, else the newest open one that is not a release PR', () => {
    const prs = [pr(948, 'fix: old'), pr(950, 'chore(release): 0.183.1'), pr(949, 'fix: batch', { created_at: T }), pr(947, 'merged', { state: 'merged' })]
    expect(batchOf(prs)?.number).toBe(949)
    expect(batchOf(prs, 948)?.number).toBe(948)
    expect(batchOf([pr(950, 'chore(release): 0.183.1')])).toBeUndefined()
  })

  it('says the via line’s checks and state, and the next step', () => {
    const p = pr(949, 'fix: batch')
    expect(viaLine(p, card(949, { stage: 'ready', ci: 'pass' }))).toMatchObject({ ci: { text: 'green', tone: 'ok' }, state: { text: 'ready to merge' }, next: 'merge #949' })
    expect(viaLine(p, card(949, { stage: 'fix', ci: 'fail', why: 'ci', failed: ['go (windows-latest)', 'lint'] }))).toMatchObject({ ci: { text: 'CI red' }, state: { text: 'fix: go (windows-latest) +1', tone: 'danger' }, next: 'fix CI on #949' })
    expect(viaLine(p, card(949, { ci: 'running' }))).toMatchObject({ ci: { text: 'CI running' }, next: 'wait for CI' })
    expect(viaLine(p, card(949, { stage: 'fix', ci: 'pass', why: 'conflict' }))).toMatchObject({ state: { text: 'needs a rebase' }, next: 'rebase #949' })
    expect(viaLine(p, card(949, { stage: 'ready', ci: 'pass', review: 'review_required' })).next).toBe('review #949')
    expect(viaLine({ ...p, labels: [{ name: 'landing: queued' }] }, card(949, { stage: 'ready', ci: 'pass' }))).toMatchObject({ state: { text: 'landing: queued' }, next: '#949 landing' })
    expect(viaLine(p, undefined)).toMatchObject({ ci: { text: 'CI not read' }, next: 'merge #949' })
  })

  it('folds what is not in it: branches with no PR and open PRs other than the batch and the release one', () => {
    const row = (key: string, section: PlanRow['section'], extra: Partial<PlanRow> = {}) => ({ key, section, title: key, ...extra }) as PlanRow
    const n = notInIt([row('b:a', 'branch'), row('b:old', 'branch', { older: true }), row('949', 'pr', { number: 949 }), row('948', 'pr', { number: 948 }),
      row('950', 'pr', { number: 950, title: 'chore(release): 0.183.1' }), row('630', 'merged', { number: 630 })], 949)
    expect(n.text).toBe('1 branch, no PR · 1 other PR')
    expect(n.prs.map((r) => r.number)).toEqual([948])
    expect(notInIt([], 949).text).toBeUndefined()
  })
})
