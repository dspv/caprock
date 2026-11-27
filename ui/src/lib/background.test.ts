// A session whose turn ended while background subagents still work wants
// nothing from anyone: the daemon narrates it as working with `background`.
// These pin what the sidebar, ⌘J, the cockpit and the header make of it.
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { backgroundAgents, backgroundCounts, backgroundLabel, backgroundShort, backgroundTasks, backgroundWait, cockpitState, phoneHealth } from './cockpit'
import { atPrompt } from './sessionJump'
import { sessionPlace } from './projects'
import { buildSidebar, dotOf } from './sidebar'

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 's', cwd: '/r', project: 'r', model: '', started_at: 0, last_event_at: Date.now(), status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true,
    stats: { session_id: 's', turns: 0, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    activity: { phrase: '', at: new Date().toISOString(), health: 'working' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...p,
  } as SessionSummary
}

const background = sess({ session_id: 'bg', live_subagents: 1, activity: { phrase: 'waiting on background work · 1 agent', at: new Date().toISOString(), health: 'working', background: 1 } })
const waiting = sess({ session_id: 'w', activity: { phrase: 'waiting for you', at: new Date(Date.now() - 60_000).toISOString(), health: 'waiting-on-you' } })

describe('a session working in the background', () => {
  it('is working, not waiting: no waiting dot, not in the inbox ⌘J walks', () => {
    expect(dotOf(background, false)).toBe('working')
    expect(cockpitState(background, false)).toBe('working')
    const m = buildSidebar({ projects: [], sessions: [background, waiting], permissions: new Set(), costs: new Map(), openSessions: new Set() })
    expect(m.inbox.map((i) => i.session.session_id)).toEqual(['w'])
  })

  it('still waits on a permission prompt', () => {
    expect(dotOf(background, true)).toBe('waiting')
    expect(cockpitState(background, true)).toBe('waiting')
    const m = buildSidebar({ projects: [], sessions: [background], permissions: new Set(['bg']), costs: new Map(), openSessions: new Set() })
    expect(m.inbox.map((i) => [i.session.session_id, i.reason])).toEqual([['bg', 'permission']])
  })

  it('counts its agents only while the session lives', () => {
    expect(backgroundAgents(background)).toBe(1)
    expect(backgroundAgents({ ...background, status: 'ended' })).toBe(0)
    expect(backgroundAgents(waiting)).toBe(0)
    expect(backgroundLabel({ agents: 2, shells: 0, monitors: 0 })).toBe('Waiting on background work · 2 agents')
    expect(backgroundLabel({ agents: 1, shells: 1, monitors: 0 })).toBe('Waiting on background work · 1 agent, 1 shell')
    expect(backgroundLabel({ agents: 0, shells: 2, monitors: 1 })).toBe('Waiting on background work · 2 shells, 1 monitor')
  })
})

// Owner, 2026-11-24: Now said Done while a background release script ran.
describe('a session waiting on background commands', () => {
  const shell = sess({
    session_id: 'sh', activity: { phrase: 'waiting on background work · 1 shell, 1 monitor', at: new Date().toISOString(), health: 'working', background_tasks: 2 },
    background_work: [
      { kind: 'shell', id: 'b1', description: 'Release', started_at: 1 },
      { kind: 'monitor', id: 'm1', command: 'tail -F log', started_at: 2 },
    ],
  })
  it('counts them by kind while the session lives, and is not at its prompt', () => {
    expect(backgroundTasks(shell)).toBe(2)
    expect(backgroundTasks({ ...shell, status: 'ended' })).toBe(0)
    expect(backgroundCounts(shell)).toEqual({ agents: 0, shells: 1, monitors: 1 })
    expect(backgroundCounts({ ...shell, background_work: undefined })).toEqual({ agents: 0, shells: 2, monitors: 0 })
    expect(backgroundLabel(backgroundCounts(shell))).toBe('Waiting on background work · 1 shell, 1 monitor')
    expect(atPrompt(shell)).toBe(false)
    expect(cockpitState(shell, false)).toBe('working')
  })
})

describe('where a session runs', () => {
  it('names the project, and the branch only when it is not the default', () => {
    expect(sessionPlace(sess({ cwd: '/u/caprock', git_branch: 'master', project: 'caprock' }), { name: 'caprock', default_branch: 'master' }))
      .toEqual({ project: 'caprock', branch: '', path: '/u/caprock' })
    expect(sessionPlace(sess({ cwd: '/u/caprock/wt', git_branch: 'feat/x', project: 'caprock' }), { name: 'Caprock app', default_branch: 'master' }))
      .toEqual({ project: 'Caprock app', branch: 'feat/x', path: '/u/caprock/wt' })
    // Git did not say: main and master are taken as the default.
    expect(sessionPlace(sess({ cwd: '/u/x', repo_root: '/u/x', project: '', git_branch: 'main' })).project).toBe('x')
    expect(sessionPlace(sess({ cwd: '/u/x', git_branch: 'main' })).branch).toBe('')
    expect(sessionPlace(sess({ cwd: '/u/x', git_branch: 'HEAD' })).branch).toBe('')
  })
})

// Owner, 2026-11-27 (translated): "on the phone I see the session status
// 'done'" — its turn had ended, and it waited on a background subagent.
describe('a session waiting on background work, on a phone', () => {
  const at = new Date().toISOString()
  const agent = sess({ session_id: 'pa', activity: { phrase: 'done', at, health: 'done', background: 1 } })
  const work = sess({ session_id: 'pw', activity: { phrase: 'idle', at, health: 'idle', background_tasks: 1 }, background_work: [{ kind: 'monitor', id: 'm', command: 'tail -F x', started_at: 1 }] })
  it('reads as working with its work named short, whatever health the turn left', () => {
    expect(backgroundWait(agent)).toEqual({ agents: 1, shells: 0, monitors: 0 })
    expect(phoneHealth(agent)).toBe('working')
    expect(backgroundShort(backgroundWait(agent)!)).toBe('Background · 1 agent')
    expect(phoneHealth(work)).toBe('working')
    expect(backgroundShort(backgroundWait(work)!)).toBe('Background · 1 monitor')
    expect(phoneHealth(background)).toBe('working')
    expect(backgroundShort({ agents: 2, shells: 1, monitors: 0 })).toBe('Background · 2 agents, 1 shell')
  })
  it('leaves what outranks it, nothing in the background, and an ended session alone', () => {
    for (const health of ['waiting-on-you', 'looping', 'error'] as const) {
      const s = sess({ activity: { phrase: '', at, health, background: 1 } })
      expect(backgroundWait(s)).toBeNull()
      expect(phoneHealth(s)).toBe(health)
    }
    const done = sess({ activity: { phrase: 'done', at, health: 'done' } })
    expect(backgroundWait(done)).toBeNull()
    expect(phoneHealth(done)).toBe('done')
    expect(backgroundWait({ ...agent, status: 'ended' })).toBeNull()
    expect(phoneHealth({ ...agent, status: 'ended' })).toBe('ended')
  })
})
