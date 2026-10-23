import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { asBoard, flowCost, type PRBoard } from '@/lib/prboard'
import { pipelineRows } from '@/lib/journey'
import { FlowCards, flowFigures } from './PRBoard'
import { AgentsCard } from './AgentFigures'

const spend = (cost_usd: number, sessions = 1) => ({ cost_usd, sessions, live: 0, agents: ['claude'] })

// The owner's caprock-ops (2026-10-24): it syncs straight to master and tags
// nothing; one pull request, #796, closed without a merge, $29.89 of agent work.
const opsBoard = (closedSpend = spend(29.89)): PRBoard => asBoard({
  cards: [], releases: [], ships_by: 'merge',
  closed: [{ number: 796, closed_at: 1, spend: closedSpend }],
  flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, release_gap_count: 0, cost_usd: closedSpend.cost_usd, series: {} },
})!

function Flow({ board }: { board: PRBoard }) {
  return <FlowCards board={board} onBucket={() => {}} preview={() => null}
    agents={(trend) => <AgentsCard cost={flowCost(board)} costHint="note" noCost="No agent cost recorded on a pull request in 14 days" trend={trend} open={false} onToggle={() => {}} />} />
}

describe('the Flow row of a repository with no merge', () => {
  it('says "–" for speed, never 0.0/day beside a breakdown of dashes, and says why', () => {
    const { container } = render(<Flow board={opsBoard()} />)
    const speed = container.querySelector('[data-stat="speed"]')!
    expect(speed).not.toHaveTextContent('0.0/day')
    expect(speed.querySelector('[data-speed-none]')).toHaveTextContent('–')
    expect(speed.querySelector('[data-stat-hint]')).toHaveTextContent('No pull request merged in 14 days')
    expect(flowFigures(opsBoard()).find((f) => f.key === 'throughput')).toMatchObject({ value: '–', sub: 'none merged in 14 days' })
  })
  it('counts a closed pull request’s agent work in the 14 days, the same figure the list says on its row', () => {
    const board = opsBoard()
    const { container } = render(<Flow board={board} />)
    expect(container.querySelector('[data-stat="agents"]')).toHaveTextContent('$29.89')
    const [row] = pipelineRows([{ number: 796, url: '', title: 'fix(pricing): price a gateway’s free model at $0 instead of unknown', state: 'closed' }], board, [])
    expect(row!.card).toBeUndefined()
    expect(row!.spend?.cost_usd).toBe(29.89)
  })
  it('says "–" with why, not $0.00, when no agent cost was recorded on any pull request', () => {
    const board = opsBoard(spend(0, 0))
    expect(flowCost(board)).toBeUndefined()
    const { container } = render(<Flow board={board} />)
    const agents = container.querySelector('[data-stat="agents"]')!
    expect(agents).not.toHaveTextContent('$0.00')
    expect(agents.querySelector('[data-agents-none]')).toHaveTextContent('–')
    expect(agents.querySelector('[data-stat-hint]')).toHaveTextContent('No agent cost recorded on a pull request in 14 days')
    expect(flowFigures(board).find((f) => f.key === 'cost')).toMatchObject({ value: '–' })
  })
  it('keeps a measured $0.00: a recorded session on a free model cost nothing', () => {
    expect(flowCost(opsBoard(spend(0, 1)))).toBe(0)
  })
})
