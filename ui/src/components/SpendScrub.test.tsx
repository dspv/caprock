import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '@/lib/api'

const now = Date.now()
const h = vi.hoisted(() => ({ series: [] as unknown[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, sessionCalls: async () => h.series } }
})

import { SpendChart, SpendOverTime } from './SpendScrub'

const ev = (id: number, ago: number, cost: number): Event => ({ id, ts: new Date(now - ago).toISOString(), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: cost } as Event)

describe('the spend by time', () => {
  it('says what the latest stretch cost and which tools, and moves with the arrow keys', async () => {
    h.series = [
      { id: 1, ts: now - 50 * 60_000, cost_usd: 2, tools: [{ tool: 'Bash' }] },
      { id: 2, ts: now - 2 * 60_000, cost_usd: 0.5, tools: [{ tool: 'Bash' }, { tool: 'Edit' }] },
      { id: 3, ts: now - 60_000, cost_usd: 0.25, tools: [{ tool: 'Bash' }] },
    ]
    await act(async () => { render(<SpendOverTime sessionId="s1" events={[ev(2, 2 * 60_000, 0.5), ev(3, 60_000, 0.25)]} now={now} total={2.75} />) })
    const box = screen.getByRole('group', { name: /^Spend by .*, this session$/ })
    expect(box.className).not.toMatch(/\b(absolute|fixed)\b/)
    const r = box.querySelector('[data-spend-readout]')!
    // The line says when and what it cost; how many calls and which tools ride along for hover and screen readers.
    // (The last two calls share a five-minute bar unless a boundary falls between them.)
    expect(r.textContent).toMatch(/\$0\.(75|25)$/)
    expect(r.getAttribute('aria-label')).toMatch(/\d+ calls? · Bash \d/)
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$2.75')
    const before = r.textContent
    fireEvent.keyDown(box, { code: 'ArrowLeft', key: 'ArrowLeft' })
    expect(box.querySelector('[data-spend-readout]')!.textContent).not.toBe(before)
  })

  it('draws a range’s bars with its total, reads the newest stretch with spend, and says so when nothing was spent', () => {
    const day = 86_400_000
    const from = new Date(2026, 9, 6).getTime()
    const bars = [0, 3, 1.5, 0].map((cost, i) => ({ start: from + i * day, end: from + (i + 1) * day, cost }))
    const { unmount } = render(<SpendChart id="c" bars={bars} step={day} now={from + 10 * day} total={4.5} scope="7 days · all sessions" />)
    const box = screen.getByRole('group', { name: 'Spend by 1 day, 7 days · all sessions' })
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$4.50')
    expect(box.querySelector('[data-spend-readout]')).toHaveTextContent('Thu 8 Oct · $1.50')
    expect(box.querySelectorAll('rect')).toHaveLength(4)
    unmount()
    render(<SpendChart id="c" bars={bars.map((b) => ({ ...b, cost: 0 }))} step={day} now={from} total={0} scope="7 days · all sessions" />)
    expect(screen.getByText('Nothing spent, 7 days · all sessions.')).toBeInTheDocument()
    expect(document.querySelector('rect')).toBeNull()
  })
})
