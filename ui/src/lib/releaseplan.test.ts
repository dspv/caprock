import { describe, expect, it } from 'vitest'
import type { WorkRepo } from './api'
import { ageText, BLOCKS, bumpOf, landingOf, nextVersion, osDots, parseVersion, planEmpty, planForRepo, releasePlan, rowOf } from './releaseplan'
import type { BoardCard } from './prboard'
import { buildWork, type WorkItem } from './work'
import { NOW, session, statsFixture, workFixture } from './work.fixture'

const MIN = 60_000
const pending = (kinds: Record<string, number> | undefined, count: number): WorkRepo['unreleased'] => ({ ref: 'origin/master', items: [], count, kinds })

// Owner, 2026-10-15: "a feature is a minor release, fixes are patches".
describe('the next version, by the pending changes', () => {
  it('reads a tag as x.y.z, with or without a v', () => {
    expect(parseVersion('v0.119.0')?.v).toEqual([0, 119, 0])
    expect(parseVersion('1.2.3')?.v).toEqual([1, 2, 3])
    expect(parseVersion('nightly')).toBeUndefined()
  })

  it('makes any Added entry the next minor', () => {
    const v = nextVersion('v0.119.0', pending({ Added: 1, Fixed: 4 }, 5))
    expect(v?.version).toBe('0.120.0')
    expect(v?.bump).toBe('minor')
    expect(v?.title).toMatch(/^Next version, by the pending changes/)
    expect(v?.title).toContain('since v0.119.0')
  })

  it('makes fixes alone the next patch', () => {
    expect(nextVersion('v0.119.0', pending({ Fixed: 3 }, 3))?.version).toBe('0.119.1')
    expect(nextVersion('v0.119.3', pending({ Fixed: 1, Changed: 1 }, 2))?.version).toBe('0.119.4')
  })

  it('says no heading with nothing pending, and no number when the rule cannot say', () => {
    expect(nextVersion('v0.119.0', undefined)).toBeUndefined()
    expect(nextVersion('v0.119.0', pending({}, 0))).toBeUndefined()
    // Entries of no kind: a feature cannot be ruled out.
    expect(bumpOf(pending({ Fixed: 1 }, 2))).toBeUndefined()
    expect(nextVersion('v0.119.0', pending({ Fixed: 1 }, 2))?.version).toBeUndefined()
    // An older daemon, no kinds at all.
    expect(nextVersion('v0.119.0', pending(undefined, 2))?.title).toMatch(/No number/)
    // No tag to count from, or one that is not a version.
    expect(nextVersion(undefined, pending({ Added: 1 }, 1))?.version).toBeUndefined()
    expect(nextVersion('nightly', pending({ Added: 1 }, 1))?.title).toMatch(/not a x\.y\.z/)
  })
})

describe('a row’s bar and word', () => {
  const pr = (p: Partial<WorkItem>): WorkItem => ({
    key: 'k', kind: 'pr', title: 't', sessions: [], stage: 'ci', fill: 3, red: false, running: false, word: 'CI running', lane: 'review', group: 'review', needsYou: false, working: false, pr: { number: 7, url: 'u' }, ...p,
  })

  it('fills two blocks per step: agent 2, CI 6, merged 8', () => {
    expect(rowOf(pr({ kind: 'session', stage: 'agent', fill: 1, word: 'agent', pr: undefined })).filled).toBe(2)
    expect(rowOf(pr({})).filled).toBe(6)
    expect(rowOf(pr({ stage: 'merged', fill: 4, word: 'merged' })).filled).toBe(8)
    expect(BLOCKS).toBe(10)
  })

  it('says what a row waits for from what the board read, nothing it did not', () => {
    const card = (c: Partial<BoardCard>): BoardCard => ({ number: 7, stage: 'open', spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] }, ...c })
    const wait = (p: Partial<WorkItem>, labels?: { name: string }[]) => rowOf(pr(p), labels, { now: NOW }).wait
    expect(wait({ card: card({ stage: 'fix', why: 'conflict' }), red: true })).toMatchObject({ text: 'needs a rebase', tone: 'danger' })
    expect(wait({ card: card({ stage: 'fix', why: 'ci', failed: ['go (windows-latest)', 'ui'] }), red: true })).toMatchObject({ text: 'fix: go (windows-latest) +1', tone: 'danger' })
    expect(wait({ card: card({ stage: 'fix', why: 'ci' }), red: true })?.text).toBe('a fix: CI red')
    expect(wait({ card: card({ stage: 'fix', why: 'changes_requested' }), red: true })?.text).toBe('requested changes')
    expect(wait({ card: card({ stage: 'ready', ci: 'pass', review: 'review_required' }) })?.text).toBe('a review')
    expect(wait({ card: card({ stage: 'open', ci: 'running', stage_at: NOW - 3 * MIN }), running: true })?.text).toBe('CI · 3m')
    expect(wait({ stage: 'pr', fill: 2, word: 'draft', card: card({ stage: 'draft' }) })?.text).toBe('marked ready')
    expect(wait({}, [{ name: 'landing: needs a hand merge' }])).toMatchObject({ text: 'your merge', tone: 'warn' })
    expect(wait({}, [{ name: 'landing: queued' }])?.text).toBe('its turn to land')
    // An open pull request whose checks were not read says nothing.
    expect(wait({ stage: 'pr', fill: 2, word: 'PR open' })).toBeUndefined()
    // An agent row: the person's turn, or the agent's own steps.
    expect(wait({ kind: 'session', stage: 'agent', fill: 1, word: 'agent', pr: undefined, sessions: [session('a', { state: 'question' })] })).toMatchObject({ text: 'your answer', tone: 'warn' })
    expect(wait({ kind: 'session', stage: 'agent', fill: 1, word: 'agent', pr: undefined, sessions: [session('a', { todo: { done: 3, total: 7 } })] })?.text).toBe('the agent · 3 of 7 steps')
    expect(wait({ kind: 'session', stage: 'agent', fill: 1, word: 'agent', pr: undefined, sessions: [session('a', { state: 'at_prompt' })] })?.text).toBe('your next prompt')
  })

  it('says the age since opened at one unit, and CI per OS only when a check names one', () => {
    expect([ageText(30_000), ageText(45 * MIN), ageText(19 * 60 * MIN + 5 * MIN), ageText(3 * 24 * 60 * MIN)]).toEqual(['now', '45m', '19h', '3d'])
    expect(rowOf(pr({ startedAt: NOW - 19 * 60 * MIN }), undefined, { now: NOW }).age?.text).toBe('19h')
    expect(rowOf(pr({ startedAt: NOW - MIN }), undefined, {}).age).toBeUndefined()
    expect(osDots(undefined)).toBeUndefined()
    expect(osDots([{ os: 'windows', state: 'fail', checks: 1 }, { os: 'macos', state: 'pass', checks: 2 }])?.map((d) => d.label)).toEqual(['macOS', 'Windows'])
    // A merged row's checks are history: no dots.
    expect(rowOf(pr({ stage: 'merged', fill: 4, word: 'merged', card: { number: 7, stage: 'merged', os: [{ os: 'linux', state: 'pass', checks: 1 }], spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } } })).ci).toBeUndefined()
  })

  it('says the CI time against the usual, and the agent cost only where it was recorded', () => {
    const flow = { ci_median_ms: 10 * MIN, days: 14, release_lag_count: 0 }
    const card = (c: Partial<BoardCard>): BoardCard => ({ number: 7, stage: 'ready', spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] }, ...c })
    expect(rowOf(pr({ card: card({ ci: 'pass', ci_ms: 9 * MIN }) }), undefined, { now: NOW, flow }).ciTime).toMatchObject({ text: '9m -10%' })
    expect(rowOf(pr({ card: card({ ci: 'pass', ci_ms: 9 * MIN }) }), undefined, { now: NOW }).ciTime?.text).toBe('9m')
    expect(rowOf(pr({ card: card({ ci: 'pass' }) }), undefined, { now: NOW, flow }).ciTime).toBeUndefined()
    expect(rowOf(pr({ stage: 'merged', fill: 4, word: 'merged', card: card({ stage: 'merged', ci_ms: MIN }) })).ciTime).toBeUndefined()
    expect(rowOf(pr({})).cost).toMatchObject({ text: '—', known: false })
    expect(rowOf(pr({ costUsd: 3.2, card: card({ spend: { cost_usd: 3.2, sessions: 3, live: 0, agents: [] } }) })).cost).toMatchObject({ text: '$3.20', known: true })
  })

  it('keeps the board’s red step', () => {
    expect(rowOf(pr({ red: true, word: 'conflict' }))).toMatchObject({ red: true, word: 'conflict' })
  })

  it('says a landing-queue label as the stage word, red for CI red, amber for a hand merge', () => {
    expect(landingOf([{ name: 'bug' }])).toBeUndefined()
    expect(rowOf(pr({}), [{ name: 'landing: queued' }])).toMatchObject({ word: 'landing: queued', red: false, warn: false })
    expect(rowOf(pr({}), [{ name: 'landing: updating' }]).word).toBe('landing: updating')
    expect(rowOf(pr({}), [{ name: 'landing: CI red' }])).toMatchObject({ word: 'landing: CI red', red: true, warn: false })
    expect(rowOf(pr({}), [{ name: 'landing: needs a hand merge' }])).toMatchObject({ word: 'landing: needs a hand merge', red: false, warn: true })
    // A session row has no labels to read.
    expect(rowOf(pr({ kind: 'session' }), [{ name: 'landing: queued' }]).word).toBe('CI running')
  })
})

describe('one repository’s plan', () => {
  it('lists merged since the last tag, open pull requests and agents with none; drafts and idle agents later', () => {
    const work = workFixture()
    work.repos[0]!.unreleased = pending({ Added: 2, Fixed: 3 }, 5)
    const stats = statsFixture()
    stats.prs!.push({ number: 640, url: 'u', title: 'a draft', state: 'open', draft: true, head: 'feat/draft', created_at: NOW - 10 * MIN })
    stats.board!.cards.push({ number: 640, stage: 'draft', spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } })
    stats.prs!.find((p) => p.number === 633)!.labels = [{ name: 'landing: queued' }]
    work.sessions.push(session('s9', { name: 'Release plan', branch: 'feat/release-plan', state: 'at_prompt', worked_at: NOW - 90 * MIN, started_at: NOW - 120 * MIN }))
    const board = buildWork(work, new Map([['/w/caprock', stats]]), NOW)
    const plan = releasePlan({ root: '/w/caprock', repo: work.repos[0], stats, items: board.items, idle: board.idle, now: NOW })
    expect(plan.next?.version).toBe('0.118.0')
    const nums = plan.rows.map((r) => r.number ?? r.word)
    // #630 merged after v0.117.4; #629 merged before it is in that tag; #625 released.
    expect(nums).toContain(630)
    expect(nums).not.toContain(629)
    expect(nums).not.toContain(625)
    // Furthest along first: merged, then the ready and running ones, then the agent with no PR.
    expect(plan.rows[0]).toMatchObject({ number: 630, word: 'merged', filled: 8 })
    expect(plan.rows.find((r) => r.number === 633)?.word).toBe('landing: queued')
    expect(plan.rows.at(-1)).toMatchObject({ stage: 'agent', filled: 2, word: 'agent' })
    expect(plan.later.map((g) => g.key)).toEqual(['drafts', 'idle'])
    expect(plan.later[0]!.rows[0]).toMatchObject({ number: 640, word: 'draft' })
    expect(plan.later[1]!.rows[0]).toMatchObject({ title: 'Release plan', word: 'idle' })
    expect(plan.since?.text).toBe('1 merged since v0.117.4 · 2h 05m ago · usual gap 2h 40m (median of 9)')
    // Another repository's rows are not this one's.
    const site = releasePlan({ root: '/w/site', repo: work.repos[1], items: board.items, idle: board.idle, now: NOW })
    expect(site.rows.every((r) => r.number === undefined)).toBe(true)
  })

  it('builds from one Pipeline answer alone, with no version and no agents, when the Work answer is not read', () => {
    const plan = planForRepo(undefined, '/w/caprock', statsFixture(), NOW)
    expect(plan.next).toBeUndefined()
    expect(plan.rows.map((r) => r.number)).toEqual([629, 630, 631, 633])
    expect(plan.rows.every((r) => r.stage !== 'agent')).toBe(true)
  })

  it('is empty with nothing on its way', () => {
    expect(planEmpty(planForRepo(undefined, '/w/none', undefined, NOW))).toBe(true)
  })
})
