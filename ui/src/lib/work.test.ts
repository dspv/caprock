import { describe, expect, it } from 'vitest'
import type { SessionCIStats } from './api'
import { buildWork, cadence, ciVsUsual, gapText, groupOf, headline, laneOf, MIN_GAPS, MIN_LAG_COUNT, newestPR, pipelineHref, prStage, releaseLag, repoState, statsRepos, todoSteps, turnLeft, type WorkItem } from './work'
import { NOW, session, statsFixture, workFixture } from './work.fixture'
import { parseHash } from './router'

const MIN = 60_000
const stats = () => new Map<string, SessionCIStats | undefined>([['/w/caprock', statsFixture()]])
const row = (items: WorkItem[], key: string) => items.find((it) => it.key === key || it.pr?.number === Number(key))

describe('the Work board’s rows', () => {
  const b = buildWork(workFixture(), stats(), NOW)

  it('puts each piece of work in its lane: ready and merged are the next release; drafts, CI and red are in review', () => {
    expect(groupOf(b.items, 'release').map((it) => it.pr?.number)).toEqual([629, 630, 633])
    expect(groupOf(b.items, 'review').map((it) => it.pr?.number)).toEqual([631])
    expect(groupOf(b.items, 'released').map((it) => it.pr?.number)).toEqual([625])
    expect(groupOf(b.items, 'work').map((it) => it.title)).toEqual(['Pipeline in Dashboard'])
    expect(groupOf(b.items, 'planned').map((it) => it.title)).toEqual(['Then add the Kanban view', 'Work: list screen'])
    // Furthest along first: merged, longest waiting first, then ready.
    // The Kanban keeps a ready one in review and merged ones in their own column.
    expect(laneOf(b.items, 'review').map((it) => it.pr?.number)).toEqual([631, 633])
    expect(laneOf(b.items, 'merged').map((it) => it.pr?.number)).toEqual([629, 630])
    // Closed unmerged and done tasks are not work on its way.
    expect(row(b.items, '620')).toBeUndefined()
    expect(b.items.some((it) => it.title === 'Old thing')).toBe(false)
  })

  it('fills the bar to the stage, red at CI when it failed or conflicts', () => {
    expect(row(b.items, '631')).toMatchObject({ stage: 'ci', fill: 3, running: true, red: false, word: 'CI running' })
    expect(row(b.items, '633')).toMatchObject({ fill: 3, word: 'ready' })
    expect(row(b.items, '630')).toMatchObject({ fill: 4, word: 'merged' })
    expect(row(b.items, '625')).toMatchObject({ fill: 5, word: 'in v0.117.4' })
    expect(row(b.items, 's:s2')).toMatchObject({ fill: 1, word: 'agent' })
    expect(prStage({ stage: 'fix', why: 'ci' }, 'open')).toMatchObject({ fill: 3, red: true, word: 'CI red' })
    expect(prStage({ stage: 'fix', why: 'conflict' }, 'open')).toMatchObject({ red: true, word: 'conflict' })
    expect(prStage({ stage: 'draft' }, 'open')).toMatchObject({ fill: 2, word: 'draft', group: 'review' })
  })

  it('attaches a session to its newest pull request, else its branch’s; one with neither is its own row', () => {
    expect(row(b.items, '631')!.sessions.map((s) => s.session_id)).toEqual(['s1'])
    expect(row(b.items, '633')!.sessions.map((s) => s.session_id)).toEqual(['s4'])
    expect(row(b.items, '629')!.sessions).toEqual([])
    expect(row(b.items, 's:s2')!.sessions.map((s) => s.session_id)).toEqual(['s2'])
    expect(newestPR([{ number: 9, url: '', opened_at: 5 }, { number: 3, url: '', opened_at: 7 }])?.number).toBe(3)
  })

  it('attaches a session with no recorded pull request by its branch, never on the default branch', () => {
    const w = workFixture()
    w.sessions = [session('d', { branch: 'feat/input-hl', on_default: true }), session('b', { branch: 'feat/input-hl' })]
    const items = buildWork(w, stats(), NOW).items
    expect(row(items, '633')!.sessions.map((s) => s.session_id)).toEqual(['b'])
    expect(row(items, 's:d')).toMatchObject({ kind: 'session', branch: undefined })
  })

  it('makes a row from the session’s record when the repository’s pull requests were not read', () => {
    const items = buildWork(workFixture(), new Map(), NOW).items
    expect(row(items, '631')).toMatchObject({ kind: 'pr', fill: 2, word: 'PR open', title: 'folder search' })
    expect(row(items, '631')!.sessions.map((s) => s.session_id)).toEqual(['s1'])
  })

  it('keeps one row per repository and branch, and one per pull request whatever number of sessions', () => {
    const st = statsFixture()
    // A second pull request from the same branch, merged earlier: the open one is the row.
    st.prs.push({ number: 600, url: '', title: 'older', state: 'merged', head: 'feat/folder-search', merged_at: NOW - 900 * MIN })
    st.board!.cards.push({ number: 600, stage: 'merged', stage_at: NOW - 900 * MIN, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } })
    const w = workFixture()
    w.sessions.push(session('s5', { branch: 'feat/folder-search' }))
    const items = buildWork(w, new Map([['/w/caprock', st]]), NOW).items
    expect(items.filter((it) => it.branch === 'feat/folder-search').map((it) => it.pr?.number)).toEqual([631])
    expect(row(items, '631')!.sessions.map((s) => s.session_id)).toEqual(['s1', 's5'])
    expect(row(items, '600')).toBeUndefined()
  })

  it('puts rows that need you first, then working ones, and folds sessions idle over 30 minutes', () => {
    expect(b.items[0]).toMatchObject({ key: 's:s2', needsYou: true })
    expect(b.items[1]).toMatchObject({ working: true })
    expect(b.idle.map((it) => it.key)).toEqual(['s:s3'])
    expect(b.counts).toEqual({ live: 4, building: 1, onPRs: 2, needsYou: 1 })
    expect(headline(b.counts)).toBe('4 agents live · 1 building · 2 on open PRs · 1 needs you')
  })

  it('costs a pull request by its card, a session row by its sessions, at list price', () => {
    expect(row(b.items, '631')!.costUsd).toBe(5.1)
    expect(row(b.items, 's:s2')!.costUsd).toBe(2.5)
    expect(row(b.items, 'Work: list screen')).toBeUndefined()
    expect(b.items.find((it) => it.key === 't:t1')!.costUsd).toBeUndefined()
  })
})

describe('the estimates, each only with its basis', () => {
  const s = workFixture().sessions[0]!
  const flow = statsFixture().board!.flow

  it('says a turn’s range with its basis, and nothing without one', () => {
    expect(turnLeft(s, 0)).toEqual({ text: 'turn 1–4 min left (rough)', title: expect.stringContaining('last 12 turns in caprock') })
    expect(turnLeft({ ...s, estimate: undefined }, 0)).toBeUndefined()
    expect(turnLeft({ ...s, state: 'at_prompt' }, 0)).toBeUndefined()
    // Past its range: no number rather than a wrong one.
    expect(turnLeft(s, 5 * MIN)).toBeUndefined()
  })

  it('says CI against the usual only with a median', () => {
    expect(ciVsUsual({ ci: 'running', stage_at: NOW - 6 * MIN }, flow, NOW)?.text).toBe('CI running 6m · usually 11m')
    expect(ciVsUsual({ ci: 'running', stage_at: NOW - 6 * MIN }, { ...flow, ci_median_ms: undefined }, NOW)).toBeUndefined()
    expect(ciVsUsual({ ci: 'pass' }, flow, NOW)).toBeUndefined()
  })

  it('says merge → release only with enough merges behind it', () => {
    expect(releaseLag('merged', flow)?.text).toBe('usually released in ~2h')
    expect(releaseLag('merged', { ...flow, release_lag_count: MIN_LAG_COUNT - 1 })).toBeUndefined()
    expect(releaseLag('ci', flow)).toBeUndefined()
  })

  it('says the agent’s steps only when it keeps a list', () => {
    expect(todoSteps(s)?.text).toBe('3 of 7 steps')
    expect(todoSteps({ todo: undefined })).toBeUndefined()
    expect(todoSteps({ todo: { done: 0, total: 0 } })).toBeUndefined()
  })

  it('says the release cadence, the usual gap only with enough gaps', () => {
    const r = workFixture().repos[0]!
    expect(cadence(r, flow, NOW)?.text).toBe('2h 05m since v0.117.4 · usual gap 2h 40m (median of 9)')
    const few = { tags: { last: r.tags!.last, gap_median_ms: 160 * MIN, gaps: MIN_GAPS - 1 } }
    expect(cadence(few, undefined, NOW)?.text).toBe('2h 05m since v0.117.4')
    // The Pipeline's gap stands in when the tags were too few.
    expect(cadence(few, flow, NOW)?.text).toContain('median of 9')
    expect(cadence({}, undefined, NOW)).toBeUndefined()
    expect(gapText(45 * MIN)).toBe('45m')
    expect(gapText(3 * 24 * 60 * MIN + 4 * 60 * MIN)).toBe('3d 4h')
  })

  it('never says a clock time, a completion time or a merge countdown', () => {
    const b = buildWork(workFixture(), stats(), NOW)
    const words = [
      ...b.items.flatMap((it) => it.sessions.map((x) => turnLeft(x, 0)?.text ?? '')),
      ...b.items.map((it) => ciVsUsual(it.card, flow, NOW)?.text ?? ''),
      ...b.items.map((it) => releaseLag(it.stage, flow)?.text ?? ''),
      cadence(workFixture().repos[0]!, flow, NOW)!.text,
    ].join('\n')
    expect(words).not.toMatch(/\d{1,2}:\d{2}|done by|done at|merges in|merged in|ships at|next release (at|in)/i)
  })
})

describe('the repositories', () => {
  it('reads the Pipeline answers of four at most, those with an agent running first', () => {
    const r = (name: string, live: number) => ({ root: `/w/${name}`, name, via_session: name, live })
    expect(statsRepos([r('a', 0), r('b', 2), r('c', 0), r('d', 1), r('e', 1)]).map((x) => x.name)).toEqual(['b', 'd', 'e', 'a'])
  })

  it('says plainly when GitHub is off or the repository is not on it', () => {
    expect(repoState({}, undefined)).toMatch(/Not on GitHub/)
    expect(repoState({ remote: 'a/b' }, { connected: false, prs: [] })).toMatch(/GitHub is not connected/)
    expect(repoState({ remote: 'a/b' }, { connected: true, prs: [] })).toBeUndefined()
  })

  it('opens a pull request in the Pipeline at its repository', () => {
    const h = pipelineHref('/w/my app', 631)
    expect(h).toBe('#/pipeline?repo=%2Fw%2Fmy+app&pr=631')
    expect(parseHash(h)).toEqual({ name: 'pipeline', repo: '/w/my app', pr: 631 })
  })
})
