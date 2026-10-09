/**
 * The product-led surfaces' rules (lib/nudges.ts): who is eligible, how long a
 * dismissal lasts, and that only one offer is ever on screen.
 */
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { capNudge, limitNudge, pickNudge, resetNudgeSlots, starEligible, teamEligible, useNudgeSlot, type NudgeId } from './nudges'
import { hydratePrompts, isDue, markAnswered, resetPrompts } from './prompts'
import { findMoment } from './shareprompt'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-10-07T12:00:00Z') // a Wednesday

beforeEach(() => { resetPrompts(); resetNudgeSlots() })

describe('star strip eligibility', () => {
  it('waits for real use: three days and ten sessions', () => {
    expect(starEligible(undefined)).toBe(false)
    expect(starEligible({ days: 1, sessions: 40 })).toBe(false)
    expect(starEligible({ days: 3, sessions: 9 })).toBe(false)
    expect(starEligible({ days: 3, sessions: 10 })).toBe(true)
  })

  it('"I starred it" is final; the cross is a month', () => {
    markAnswered('star-done', T0)
    expect(isDue('star-done', T0 + 3650 * DAY)).toBe(false)
    markAnswered('star-dismissed', T0)
    expect(isDue('star-dismissed', T0 + 29 * DAY)).toBe(false)
    expect(isDue('star-dismissed', T0 + 30 * DAY)).toBe(true)
  })
})

describe('snooze', () => {
  it('Premium nudges come back after two weeks, the team card after a month', () => {
    markAnswered('premium-limit', T0)
    markAnswered('premium-cap', T0)
    markAnswered('teams-nudge', T0)
    expect(isDue('premium-limit', T0 + 13 * DAY)).toBe(false)
    expect(isDue('premium-cap', T0 + 14 * DAY)).toBe(true)
    expect(isDue('teams-nudge', T0 + 29 * DAY)).toBe(false)
    expect(isDue('teams-nudge', T0 + 30 * DAY)).toBe(true)
  })

  it('takes the later answer from the daemon and ignores unknown ids', () => {
    markAnswered('star-dismissed', T0)
    hydratePrompts({ 'star-dismissed': T0 - DAY, 'star-done': T0, 'not-a-prompt': T0 })
    expect(isDue('star-done', T0 + 1000 * DAY)).toBe(false)
    expect(isDue('star-dismissed', T0 + 29 * DAY)).toBe(false)
  })
})

describe('premium rules', () => {
  it('a plan window at 80% or more, the fuller one named', () => {
    expect(limitNudge(undefined)).toBeNull()
    expect(limitNudge({ five_hour: { used_percentage: 79, resets_at: 0 } })).toBeNull()
    expect(limitNudge({ five_hour: { used_percentage: 81, resets_at: 0 }, seven_day: { used_percentage: 92, resets_at: 0 } }))
      .toEqual({ name: 'weekly', pct: 92 })
  })

  it("a daily cap only in the top quarter of the machine's own days", () => {
    const past = Array.from({ length: 8 }, (_, i) => ({ day: `2026-09-0${i + 1}`, cost_usd: (i + 1) * 10 }))
    expect(capNudge(past.slice(0, 7), '2026-10-07', 500)).toBe(false) // too few days to judge
    expect(capNudge(past, '2026-10-07', 0)).toBe(false)
    expect(capNudge(past, '2026-10-07', 60)).toBe(false)
    expect(capNudge(past, '2026-10-07', 70)).toBe(true)
  })
})

describe('team detection', () => {
  it('needs a second person committing', () => {
    expect(teamEligible(undefined)).toBe(false)
    expect(teamEligible({ authors: 1 })).toBe(false)
    expect(teamEligible({ authors: 2 })).toBe(true)
  })
})

describe('share moment', () => {
  const totals = { sessions: 40, owned_sessions: 0, turns: 0, tool_calls: 0, files_touched: 0, cost_usd: 300, avg_session_sec: 0, days: 20 }
  const week = { sessions: 12, cost_usd: 84.5, savings: { hit_rate: 0.5 } }
  it('says nothing midweek without a milestone, or on an empty week', () => {
    expect(findMoment(T0, week, { totals, daily: [] })).toBeNull()
    expect(findMoment(T0 + 5 * DAY, { ...week, sessions: 0 }, { totals, daily: [] })).toBeNull()
  })
  it('speaks on a Monday, in the reader\'s own figures', () => {
    const m = findMoment(T0 + 5 * DAY, week, { totals, daily: [] })
    expect(m?.line).toBe('Another week done. Your week with Claude Code: 12 sessions, $84.50 at API price — share the card?')
  })
  it('names a milestone: 100 sessions, 95% cache hits', () => {
    expect(findMoment(T0, week, { totals: { ...totals, sessions: 104 }, daily: [] })?.kind).toBe('sessions')
    expect(findMoment(T0, { ...week, savings: { hit_rate: 0.96 } }, { totals, daily: [] })?.line).toMatch(/^96% cache hits this week\./)
  })
})

describe('one offer at a time', () => {
  it('picks the highest priority, then the first registered', () => {
    expect(pickNudge([])).toBeNull()
    expect(pickNudge([
      { key: 'a', id: 'star', order: 0 },
      { key: 'b', id: 'premium-limit', order: 1 },
      { key: 'c', id: 'teams-nudge', order: 2 },
    ])).toBe('b')
    expect(pickNudge([
      { key: 'a', id: 'premium-hint', order: 3 },
      { key: 'b', id: 'premium-hint', order: 1 },
    ])).toBe('b')
  })

  function Offer({ id, on = true }: { id: NudgeId; on?: boolean }) {
    return useNudgeSlot(id, on) ? <p>{id}</p> : null
  }

  it('renders only the winner, and the next one once it goes', () => {
    const view = render(<><Offer id="star" /><Offer id="teams-nudge" /></>)
    expect(screen.queryByText('teams-nudge')).not.toBeNull()
    expect(screen.queryByText('star')).toBeNull()
    act(() => { view.rerender(<><Offer id="star" /><Offer id="teams-nudge" on={false} /></>) })
    expect(screen.queryByText('star')).not.toBeNull()
  })

  it('a dismissed offer gives the slot back', () => {
    function Dismissable() {
      const [gone, setGone] = useState(false)
      return useNudgeSlot('premium-cap', !gone) ? <button onClick={() => setGone(true)}>cap</button> : null
    }
    render(<><Dismissable /><Offer id="star" /></>)
    expect(screen.queryByText('star')).toBeNull()
    fireEvent.click(screen.getByText('cap'))
    expect(screen.queryByText('star')).not.toBeNull()
  })
})
