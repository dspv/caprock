import { describe, expect, it } from 'vitest'
import { buildTrayView, waitingOnApproval } from './tray'
import type { InboxItem } from './sidebar'
import type { SessionSummary, Summary } from './api'
import { fmtUSD } from './format'

const now = Date.UTC(2026, 9, 5, 12, 0, 0)
const inSec = (h: number) => Math.round((now + h * 3600_000) / 1000)

function item(id: string, reason: InboxItem['reason'], title = 'fix login'): InboxItem {
  return { session: { session_id: id } as SessionSummary, projectId: 'p', projectName: 'api', reason, title, since: now }
}

const summary = {
  cost_usd: 12.345,
  rate_limits: { five_hour: { used_percentage: 41.6, resets_at: inSec(2) }, seven_day: { used_percentage: 18, resets_at: inSec(72) } },
  codex_rate_limits: { five_hour: { used_percentage: 7, resets_at: inSec(1) } },
} as unknown as Summary

describe('buildTrayView', () => {
  it('shows the dashboard’s figures: rounded plan windows, today’s spend', () => {
    const v = buildTrayView({ summary, inbox: [], conn: 'open', now })
    expect(v.lines[0]).toMatch(/^Claude 5h {2}42% · resets /)
    expect(v.lines[1]).toMatch(/^Claude 7d {2}18% · resets /)
    expect(v.lines[2]).toMatch(/^Codex 5h {2}7%/)
    expect(v.lines).toContain(`Today  ${fmtUSD(12.345)}`)
    expect(v.title).toBe('42%')
    expect(v.waiting).toEqual([])
  })

  it('lists only sessions waiting for approval, each with its id for the click', () => {
    const v = buildTrayView({ summary, inbox: [item('a', 'permission'), item('b', 'waiting'), item('c', 'permission', 'deploy')], conn: 'open', now })
    expect(v.waiting).toEqual([{ id: 'a', label: 'api · fix login' }, { id: 'c', label: 'api · deploy' }])
    expect(v.title).toBe('42% · 2 waiting')
    expect(v.tooltip).toContain('2 waiting')
  })

  it('says when the numbers may be stale, and drops a stale reset clock', () => {
    const stale = { ...summary, rate_limits: { five_hour: { used_percentage: 50, resets_at: inSec(-1) } } } as unknown as Summary
    const v = buildTrayView({ summary: stale, inbox: [], conn: 'closed', now })
    expect(v.lines[0]).toBe('Claude 5h  50%')
    expect(v.lines).toContain('Daemon unreachable — reconnecting')
  })

  it('shows loading before the first summary', () => {
    expect(buildTrayView({ inbox: [], conn: 'connecting', now }).lines[0]).toBe('Loading…')
  })
})

describe('waitingOnApproval', () => {
  it('is empty when nothing waits, so the badge clears', () => {
    expect(waitingOnApproval([item('b', 'waiting')])).toHaveLength(0)
  })
})
