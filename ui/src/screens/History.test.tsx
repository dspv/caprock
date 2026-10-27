import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { History } from '@/lib/api'
import { calendarDays, HistoryScreen, lifetimeFigures } from './History'
import { clearShared } from '@/lib/refresh'

const data = vi.hoisted(() => ({ value: undefined as unknown, status: {} as unknown }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, history: async () => data.value, status: async () => data.status } }
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

describe('calendar days', () => {
  const now = new Date(2026, 9, 20, 15).getTime()
  const bar = (day: string, cost: number) => ({ day, cost, tokens: 10 })

  it('draws a day without work as an empty bar, through today', () => {
    const out = calendarDays([bar('2026-09-29', 1), bar('2026-10-02', 2), bar('2026-10-17', 3)], Infinity, now)
    expect(out[0]!.day).toBe('2026-09-29')
    expect(out.slice(-1)[0]!.day).toBe('2026-10-20')
    expect(out).toHaveLength(22)
    expect(out[1]).toEqual({ day: '2026-09-30', cost: 0, tokens: 0 })
    expect(out.filter((b) => b.cost > 0).map((b) => b.day)).toEqual(['2026-09-29', '2026-10-02', '2026-10-17'])
  })

  it('covers the whole window and only it', () => {
    const out = calendarDays([bar('2026-09-01', 1), bar('2026-10-15', 2)], 7, now)
    expect(out.map((b) => b.day)).toEqual(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'])
  })

  it('is empty when the window holds no work', () => {
    expect(calendarDays([], Infinity, now)).toEqual([])
    expect(calendarDays([bar('2026-09-01', 1)], 30, now)).toEqual([])
  })
})

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

  it('says in one line that older history is still loading, only while it is', async () => {
    data.value = hist()
    data.status = { events_move: { moved: 400, total: 1000 } }
    const { unmount } = render(<HistoryScreen />)
    expect(await screen.findByText(/Older history is still loading/)).toBeTruthy()
    expect(screen.getByText('40%')).toBeTruthy()
    unmount()
    data.status = {}
    clearShared()
    render(<HistoryScreen />)
    await screen.findByText('$15k')
    expect(screen.queryByText(/Older history is still loading/)).toBeNull()
  })

  it('leads with the money and switches the breakdowns to tables', async () => {
    data.value = hist()
    localStorage.clear()
    render(<HistoryScreen />)
    // Headlines short, the exact sum on hover (owner, 2026-10-11).
    expect((await screen.findByText('$15k')).getAttribute('title')).toBe('$15,000.00')
    expect(screen.getAllByText('$150').length).toBeGreaterThan(0)
    expect(screen.getByText(/over 100 active days/)).toBeTruthy()
    expect(screen.getByRole('img', { name: /cost by project: caprock/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^numbers$/i }))
    expect(screen.queryByRole('img', { name: /cost by model/i })).toBeNull()
    expect(screen.getAllByText('claude-opus-5').length).toBeGreaterThan(0)
    expect(localStorage.getItem('caprock-lifetime-view')).toBe('numbers')
  })
})
