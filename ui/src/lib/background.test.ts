// A session whose turn ended while background subagents still work wants
// nothing from anyone: the daemon narrates it as working with `background`.
// These pin what the sidebar, ⌘J, the cockpit and the header make of it.
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { backgroundAgents, backgroundLabel, cockpitState } from './cockpit'
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

const background = sess({ session_id: 'bg', live_subagents: 1, activity: { phrase: 'background agents working · 1', at: new Date().toISOString(), health: 'working', background: 1 } })
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
    expect(backgroundLabel(2)).toBe('Background agents working · 2')
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
