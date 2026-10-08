import { describe, expect, it } from 'vitest'
import type { SessionSummary, Summary } from './api'
import type { Project } from './projects'
import { buildSidebar, STALE_MS } from './sidebar'
import { buildToday, windowTone } from './today'

const now = Date.parse('2026-10-08T12:00:00Z')

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 's', cwd: '/a', project: 'a', model: '', started_at: 0, last_event_at: now, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true,
    activity: { phrase: '', at: '', health: 'working' },
    ...p,
  } as SessionSummary
}

const projects: Project[] = [
  { id: 'a', root: '/a', name: 'a', kind: 'repo' },
  { id: 'b', root: '/b', name: 'b', kind: 'repo' },
]

const model = buildSidebar({
  projects,
  sessions: [
    sess({ session_id: 'w1', cwd: '/a' }),
    sess({ session_id: 'idle', cwd: '/a', activity: { phrase: '', at: '', health: 'idle' } }),
    sess({ session_id: 'wait', cwd: '/b', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'waiting-on-you' } }),
    sess({ session_id: 'old', cwd: '/b', activity: { phrase: '', at: new Date(now - STALE_MS - 60_000).toISOString(), health: 'waiting-on-you' } }),
    sess({ session_id: 'sh', cwd: '/a', kind: 'shell' }),
    sess({ session_id: 'gone', cwd: '/a', status: 'ended' }),
  ],
  permissions: new Set(),
  costs: new Map(),
  openSessions: new Set(),
  now,
})

const summary = (extra: Partial<Summary> = {}): Summary => ({ cost_usd: 12.5, ...extra }) as Summary

describe('the Today strip', () => {
  it('counts live agents (shells and ended sessions left out), the working ones, and what waits now', () => {
    const t = buildToday(model, summary(), now)
    expect(t.agents).toBe(4)
    expect(t.working).toBe(1)
    // The one put down more than STALE_MS ago is not waiting on you.
    expect(t.waiting).toBe(1)
    expect(t.spend).toBe(12.5)
    // Per project, too: the row's running count.
    expect(model.projects.map((n) => [n.project.id, n.agents, n.working])).toEqual([['a', 2, 1], ['b', 2, 0]])
  })

  it('leaves the spend unknown until the summary answers, never zero', () => {
    expect(buildToday(model, undefined, now).spend).toBeUndefined()
    expect(buildToday(model, summary({ cost_usd: 0 }), now).spend).toBe(0)
  })

  it("reads Claude's plan windows with their reset, and none without a plan", () => {
    const t = buildToday(model, summary({
      rate_limits: {
        five_hour: { used_percentage: 61.6, resets_at: (now + 2 * 3600_000) / 1000 },
        seven_day: { used_percentage: 12, resets_at: (now - 1000) / 1000 },
      },
    }), now)
    expect(t.windows.map((w) => [w.label, w.pct, w.tone, w.stale])).toEqual([['5h', 62, 'warn', false], ['7d', 12, 'accent', true]])
    expect(t.windows[0]!.resetMs).toBe(now + 2 * 3600_000)
    // A reset already past is a stale sample, not a clock.
    expect(t.windows[1]!.resetMs).toBeUndefined()
    expect(buildToday(model, summary(), now).windows).toEqual([])
    // Codex's windows belong to Codex: the strip shows Claude's.
    expect(buildToday(model, summary({ codex_rate_limits: { five_hour: { used_percentage: 50, resets_at: 0 } } }), now).windows).toEqual([])
  })

  it("takes the cockpit's thresholds for the bar's tone", () => {
    expect([0, 59, 60, 85, 86].map(windowTone)).toEqual(['accent', 'accent', 'warn', 'warn', 'danger'])
  })
})
