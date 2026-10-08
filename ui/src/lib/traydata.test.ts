import { describe, expect, it } from 'vitest'
import type { Permission, SessionSummary } from './api'
import { APPROVE_MAX_CHARS, buildPopover, canApprove, fmtElapsed } from './traydata'

const NOW = Date.parse('2026-10-06T12:00:00Z')

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 's', cwd: '/w/app', repo_root: '/w/app', project: 'app', model: 'claude-opus-5', started_at: NOW - 12 * 60_000, last_event_at: NOW,
    status: 'active', transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true,
    stats: { session_id: 's', turns: 1, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0.42 },
    activity: { phrase: 'Editing login.ts', at: '', health: 'working' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...p,
  } as SessionSummary
}

function perm(p: Partial<Permission> = {}): Permission {
  return { id: 'p1', tool: 'Bash', detail: 'npm test', since: '2026-10-06T11:59:00Z', ...p }
}

describe('canApprove', () => {
  it('offers Approve only when the whole request fits on one shown line', () => {
    expect(canApprove({ detail: 'npm test' })).toBe(true)
    expect(canApprove({ detail: '' })).toBe(false)
    expect(canApprove({ detail: 'rm -rf build\nnpm run deploy' })).toBe(false)
    expect(canApprove({ detail: 'x'.repeat(APPROVE_MAX_CHARS) })).toBe(true)
    expect(canApprove({ detail: 'x'.repeat(APPROVE_MAX_CHARS + 1) })).toBe(false)
    const p = { id: 'p', tool: 'Bash', detail: 'npm test', since: '' }
    expect(canApprove({ detail: 'npm test', waiting: [p, { ...p, id: 'q' }] })).toBe(false)
  })
})

describe('fmtElapsed', () => {
  it('reads at a glance', () => {
    expect(fmtElapsed(20_000)).toBe('now')
    expect(fmtElapsed(12 * 60_000)).toBe('12m')
    expect(fmtElapsed((3 * 60 + 4) * 60_000)).toBe('3h 4m')
    expect(fmtElapsed(53 * 3600_000)).toBe('2d 5h')
    expect(fmtElapsed(-5)).toBe('now')
  })
})

describe('buildPopover', () => {
  it('puts prompts first (oldest first), then ended turns, then what runs', () => {
    const m = buildPopover({
      now: NOW,
      sessions: [
        sess({ session_id: 'run', title: 'Running' }),
        sess({ session_id: 'turn', title: 'Your turn', activity: { phrase: '', at: '2026-10-06T11:50:00Z', health: 'waiting-on-you' } }),
        sess({ session_id: 'late', title: 'Asked late' }),
        sess({ session_id: 'early', title: 'Asked early' }),
        sess({ session_id: 'gone', status: 'ended' }),
        sess({ session_id: 'sh', kind: 'shell' }),
      ],
      permissions: new Map([
        ['late', perm({ since: '2026-10-06T11:59:00Z', detail: 'line one\nline two' })],
        ['early', perm({ since: '2026-10-06T11:00:00Z' })],
      ]),
    })
    expect(m.approvals.map((a) => a.session.session_id)).toEqual(['early', 'late'])
    expect(m.approvals.map((a) => a.canApprove)).toEqual([true, false])
    expect(m.waiting.map((r) => r.session.session_id)).toEqual(['turn'])
    expect(m.live.map((r) => r.session.session_id)).toEqual(['run'])
    expect(m.live[0]).toMatchObject({ project: 'app', phrase: 'Editing login.ts', elapsed: '12m', cost: 0.42 })
    expect(m.calm).toBe(false)
  })

  it('never offers a prompt of a session Caprock does not own', () => {
    const m = buildPopover({ now: NOW, sessions: [sess({ session_id: 'x', owned: false })], permissions: new Map([['x', perm()]]) })
    expect(m.approvals).toEqual([])
    expect(m.calm).toBe(true)
  })

  it('rounds plan windows as Now does and counts down to the reset', () => {
    const m = buildPopover({
      now: NOW,
      sessions: [],
      permissions: new Map(),
      summary: {
        cost_usd: 3.1,
        rate_limits: { five_hour: { used_percentage: 41.6, resets_at: (NOW + 99 * 60_000) / 1000 }, seven_day: { used_percentage: 12.4, resets_at: 1 } },
        codex_rate_limits: { five_hour: { used_percentage: 7.5, resets_at: (NOW + 30 * 60_000) / 1000 } },
      } as never,
    })
    expect(m.limits).toEqual([
      { agent: 'Claude', label: '5h', pct: 42, resetIn: '1 h 39 min', stale: false },
      { agent: 'Claude', label: '7d', pct: 12, resetIn: null, stale: true },
      { agent: 'Codex', label: '5h', pct: 8, resetIn: '30 min', stale: false },
    ])
    expect(m.today).toBe(3.1)
  })

  it('is calm with nothing waiting, and caps the running list', () => {
    const many = Array.from({ length: 11 }, (_, i) => sess({ session_id: `s${i}`, last_event_at: NOW - i }))
    const m = buildPopover({ now: NOW, sessions: many, permissions: new Map() })
    expect(m.calm).toBe(true)
    expect(m.live).toHaveLength(8)
    expect(m.moreLive).toBe(3)
    expect(m.live[0]!.session.session_id).toBe('s0')
  })
})
