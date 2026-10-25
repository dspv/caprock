/**
 * The product-led surfaces' rules (lib/nudges.ts): who is eligible, how long a
 * dismissal lasts, and that only one offer is ever on screen.
 */
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { capNudge, limitNudge, pickNudge, resetNudgeSlots, starEligible, teamEligible, useNudgeSlot, type NudgeId } from './nudges'
import { hydratePrompts, isDue, markAnswered, resetPrompts } from './prompts'
import { findMoment, weekClosedAt, weekClosedDue } from './shareprompt'

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
  const days = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, prs_opened: 0, cost_usd: 0, active: true }))
  const week = { sessions: 12, cost_usd: 84.5, prs_merged: 3, days }
  // Local times, so the rule is the reader's Sunday evening wherever the test runs.
  const sundayEve = new Date(2026, 9, 25, 19, 0).getTime() // Sun 25 Oct 19:00
  const closed = new Date(2026, 9, 25, 18, 0).getTime()
  const wednesday = new Date(2026, 9, 21, 12, 0).getTime()
  it('closes the week on Sunday at 18:00 local', () => {
    expect(weekClosedAt(sundayEve)).toBe(closed)
    expect(weekClosedAt(new Date(2026, 9, 25, 17, 59).getTime())).toBe(new Date(2026, 9, 18, 18, 0).getTime())
    expect(weekClosedAt(new Date(2026, 9, 27, 9, 0).getTime())).toBe(closed)
  })
  it('offers the closed week once: Sunday evening or the first open after, until answered', () => {
    expect(weekClosedDue(sundayEve, undefined)).toBe(true)
    expect(weekClosedDue(new Date(2026, 9, 26, 8, 0).getTime(), undefined)).toBe(true) // Monday morning, first open
    expect(weekClosedDue(sundayEve, closed - 1)).toBe(true) // answered before the close: a milestone, not this week
    expect(weekClosedDue(sundayEve + 60_000, sundayEve)).toBe(false) // answered this week: once
    expect(weekClosedDue(wednesday, undefined)).toBe(false) // midweek: not about a closed week
    // Answered last Sunday: due again this Sunday, though fewer than seven days passed.
    expect(weekClosedDue(sundayEve, new Date(2026, 9, 18, 21, 0).getTime())).toBe(true)
  })
  it('says nothing midweek without a milestone, or on an empty week', () => {
    expect(findMoment(wednesday, week, { totals, daily: [] })).toBeNull()
    expect(findMoment(sundayEve, { ...week, sessions: 0 }, { totals, daily: [] })).toBeNull()
  })
  it('speaks when the week closes, in the card\'s own figures', () => {
    const m = findMoment(sundayEve, week, { totals, daily: [] })
    expect(m).toEqual({ kind: 'week-closed', line: 'Your week is done. $84.50 at API price this week · 3 PRs merged' })
    // A flat plan with a price: the multiple, as on the card.
    const max = { kind: 'flat' as const, label: 'Max', usdPerMonth: 200 }
    expect(findMoment(sundayEve, { ...week, cost_usd: 1540 }, { totals, daily: [] }, max)?.line)
      .toBe('Your week is done. 33× your plan this week · 3 PRs merged')
    // Not due (answered already): the milestones only.
    expect(findMoment(sundayEve, week, { totals, daily: [] }, undefined, 0, { weekly: false, milestones: true })).toBeNull()
  })
  it('a closed week with nothing merged is not an occasion', () => {
    expect(findMoment(sundayEve, { ...week, prs_merged: 0 }, { totals, daily: [] })).toBeNull()
  })
  it('names a milestone: 100 sessions, 95% cache hits', () => {
    expect(findMoment(wednesday, week, { totals: { ...totals, sessions: 104 }, daily: [] })?.kind).toBe('sessions')
    expect(findMoment(wednesday, week, { totals, daily: [] }, undefined, 0.96)?.line).toMatch(/^96% cache hits\. \$84\.50/)
    // A milestone snoozed by an answer this week stays quiet.
    expect(findMoment(wednesday, week, { totals: { ...totals, sessions: 104 }, daily: [] }, undefined, 0, { weekly: false, milestones: false })).toBeNull()
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
