import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RateSpan, RepoAgents, TeamDay } from '@/lib/api'
import { AgentsCard, TeamChart } from './AgentFigures'

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

function Both({ ag = a }: { ag?: RepoAgents }) {
  const [open, setOpen] = useState(false)
  return <><AgentsCard cost={465.65} costHint="on these PRs · list price" a={ag} open={open} onToggle={() => setOpen((o) => !o)} />{open && <TeamChart a={ag} onClose={() => setOpen(false)} />}</>
}

describe('the Pipeline’s Agents card', () => {
  it('shows the cost big and the rate, the team now and its peak as one muted line', () => {
    const { container } = render(<Both />)
    expect(container.querySelector('[data-stat="agents"]')).toHaveTextContent('$465.65')
    expect(container.querySelector('[data-agent-rate]')).toHaveTextContent('$6.08/h')
    expect(container.querySelector('[data-team-toggle]')).toHaveTextContent('5 now · peak 7')
    // Hover: the list-price label and the old tiles' explanations stay reachable.
    expect(container.querySelector('[data-stat-hint]')).toHaveTextContent(/at API list price · estimate/)
    expect(container.querySelector('[data-stat-hint]')).toHaveTextContent(/1\.45M tok\/h · 3\.00M in 24h/)
  })
  it('opens and closes the team chart from “now”', () => {
    const { container } = render(<Both />)
    expect(container.querySelector('[data-team-chart]')).toBeNull()
    fireEvent.click(container.querySelector('[data-team-toggle]')!)
    expect(container.querySelectorAll('[data-team-day]').length).toBe(31)
    fireEvent.click(screen.getByLabelText('Close the agent team chart'))
    expect(container.querySelector('[data-team-chart]')).toBeNull()
  })
  it('keeps the cost alone while the agent figures are not read', () => {
    const { container } = render(<AgentsCard cost={3} costHint="x" open={false} onToggle={() => {}} />)
    expect(container.querySelector('[data-stat="agents"]')).toHaveTextContent('$3.00')
    expect(container.querySelector('[data-team-toggle]')).toBeNull()
  })
})
