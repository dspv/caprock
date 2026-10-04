import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { History } from '@/lib/api'
import { HistoryScreen, lifetimeFigures } from './History'

const data = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, history: async () => data.value } }
})

const hist = (): History =>
  ({
    range: 'all',
    totals: { sessions: 200, owned_sessions: 3, turns: 100_000, tool_calls: 120_000, files_touched: 900, cost_usd: 15_000, avg_session_sec: 3600, days: 100 },
    tools: [
      { tool: 'Bash', count: 57_000 }, { tool: 'exec', count: 13_000 }, { tool: 'Read', count: 12_500 },
      { tool: 'Edit', count: 8_000 }, { tool: 'WebFetch', count: 6_800 }, { tool: 'WebSearch', count: 4_000 },
      { tool: 'Write', count: 2_500 }, { tool: 'Agent', count: 900 },
    ],
    daily: [],
    savings: { hit_rate: 0.98, cut_pct: 88 },
    summary: {
      models: [
        { model: 'claude-opus-5', tokens: 1, cost_usd: 8_000 }, { model: 'claude-opus-4-8', tokens: 1, cost_usd: 4_000 },
        { model: 'claude-fable-5', tokens: 1, cost_usd: 900 }, { model: 'gpt-5.6-sol', tokens: 1, cost_usd: 500 },
        { model: 'claude-opus-5-5', tokens: 1, cost_usd: 500 }, { model: 'gpt-6-luna', tokens: 1, cost_usd: 100 },
        { model: 'gpt-6-astra', tokens: 1, cost_usd: 50 },
      ],
      projects: [
        { project: 'caprock', tokens: 1, cost_usd: 9_000 }, { project: 'caprock-web', tokens: 1, cost_usd: 3_000 },
        { project: 'planet101', tokens: 1, cost_usd: 1_500 },
      ],
    },
  }) as unknown as History

describe('lifetime figures', () => {
  it('derives per day and per session exactly, and groups the tail as other', () => {
    const f = lifetimeFigures(hist())
    expect(f.perDay).toBe(150)
    expect(f.perSession).toBe(75)
    // Six tools by name, the seventh and eighth as one "other".
    expect(f.tools).toHaveLength(7)
    expect(f.tools[6]).toMatchObject({ label: 'other', value: 3_400 })
    expect(f.models.slice(-1)[0]).toMatchObject({ label: 'other', value: 150 })
    expect(f.toolTotal).toBe(hist().tools.reduce((a, t) => a + t.count, 0))
  })

  it('claims nothing per day or per session before anything was spent', () => {
    const h = hist()
    h.totals.cost_usd = 0
    expect(lifetimeFigures(h).perDay).toBeUndefined()
    expect(lifetimeFigures(undefined).perSession).toBeUndefined()
  })

  it('leads with the money and switches the breakdowns to tables', async () => {
    data.value = hist()
    localStorage.clear()
    render(<HistoryScreen />)
    expect(await screen.findByText('$15,000.00')).toBeTruthy()
    expect(screen.getAllByText('$150.00').length).toBeGreaterThan(0)
    expect(screen.getByText(/over 100 active days/)).toBeTruthy()
    expect(screen.getByRole('img', { name: /cost by project: caprock/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^numbers$/i }))
    expect(screen.queryByRole('img', { name: /cost by model/i })).toBeNull()
    expect(screen.getAllByText('claude-opus-5').length).toBeGreaterThan(0)
    expect(localStorage.getItem('caprock-lifetime-view')).toBe('numbers')
  })
})
