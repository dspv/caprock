import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RateSpan, RepoAgents, TeamDay } from '@/lib/api'
import { CostHourStat, TeamChart, TeamStat } from './AgentFigures'

const span = (p: Partial<RateSpan> = {}): RateSpan => ({ cost_usd: 0, active_hours: 0, active_cost_usd: 0, tokens: 0, active_tokens: 0, wall_hours: 0, ...p })
const team = (n: number): TeamDay[] => Array.from({ length: n }, (_, i) => ({
  day: `2026-10-${String(i + 1).padStart(2, '0')}`, sessions: 1, subagents: i % 4, peak: 2, by_kind: { claude: { sessions: 1, subagents: i % 4 } },
}))
const a: RepoAgents = {
  days: 14,
  rate: {
    last24: span({ cost_usd: 13, active_hours: 2, active_cost_usd: 12.15, tokens: 3_000_000, active_tokens: 2_900_000, wall_hours: 2 }),
    usual: span({ cost_usd: 100, active_hours: 20, active_cost_usd: 90, days: 9 }),
    series: Array.from({ length: 15 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, ...span({ active_hours: 2, active_cost_usd: 9 + i }) })),
  },
  team: { now: { sessions: 2, subagents: 3 }, peak_today: 7, series: team(31) },
}

function Both() {
  const [open, setOpen] = useState(false)
  return <><CostHourStat a={a} /><TeamStat a={a} open={open} onToggle={() => setOpen((o) => !o)} />{open && <TeamChart a={a} onClose={() => setOpen(false)} />}</>
}

describe('the Pipeline’s agent figures', () => {
  it('shows the cost of an agent-hour, its caption and the list-price label', () => {
    render(<CostHourStat a={a} />)
    expect(screen.getByText('$6.08')).toBeTruthy()
    expect(screen.getByText('▲ 35% vs 14-day avg')).toBeTruthy()
    expect(screen.getAllByText(/at API list price · estimate/).length).toBeGreaterThan(0)
    expect(screen.getByText(/1\.45M tok\/h · 3\.00M in 24h/)).toBeTruthy()
  })
  it('opens and closes the team chart from the team tile', () => {
    const { container } = render(<Both />)
    expect(screen.getByText('2 + 3 sub · peak 7 today')).toBeTruthy()
    expect(container.querySelector('[data-team-chart]')).toBeNull()
    fireEvent.click(container.querySelector('[data-team-toggle]')!)
    expect(container.querySelectorAll('[data-team-day]').length).toBe(31)
    fireEvent.click(screen.getByLabelText('Close the agent team chart'))
    expect(container.querySelector('[data-team-chart]')).toBeNull()
  })
  it('says not enough history without a usual', () => {
    render(<CostHourStat a={{ ...a, rate: { ...a.rate, usual: undefined } }} />)
    expect(screen.getByText('not enough history')).toBeTruthy()
  })
})
