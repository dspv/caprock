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
  it('reads the newest stretch on the first arrow key, its tools for a screen reader, and the total again on blur', async () => {
    h.series = [
      { id: 1, ts: now - 50 * 60_000, cost_usd: 2, tools: [{ tool: 'Bash' }] },
      { id: 2, ts: now - 2 * 60_000, cost_usd: 0.5, tools: [{ tool: 'Bash' }, { tool: 'Edit' }] },
      { id: 3, ts: now - 60_000, cost_usd: 0.25, tools: [{ tool: 'Bash' }] },
    ]
    await act(async () => { render(<SpendOverTime sessionId="s1" events={[ev(2, 2 * 60_000, 0.5), ev(3, 60_000, 0.25)]} now={now} total={2.75} />) })
    const box = screen.getByRole('group', { name: /^Spend by .*, this session$/ })
    expect(box.className).not.toMatch(/\b(absolute|fixed)\b/)
    // At rest: the total, and no stretch read or singled out.
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$2.75')
    expect(box.querySelector('[data-spend-readout]')).toBeNull()
    expect(box.querySelector('rect[data-active]')).toBeNull()
    fireEvent.keyDown(box, { code: 'ArrowLeft', key: 'ArrowLeft' })
    const r = box.querySelector('[data-spend-readout]')!
    // The big figure is the stretch's cost; how many calls and which tools ride along for hover and screen readers.
    // (The last two calls share a five-minute bar unless a boundary falls between them.)
    expect(r.textContent).toMatch(/^\$0\.(75|25)$/)
    expect(r.getAttribute('aria-label')).toMatch(/\d+ calls? · Bash \d/)
    expect(box.querySelector('[data-spend-total]')).toBeNull()
    expect(box).toHaveTextContent('of $2.75')
    const before = r.textContent
    fireEvent.keyDown(box, { code: 'ArrowLeft', key: 'ArrowLeft' })
    expect(box.querySelector('[data-spend-readout]')!.textContent).not.toBe(before)
    fireEvent.blur(box)
    expect(box.querySelector('[data-spend-readout]')).toBeNull()
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$2.75')
  })

  it('puts the hovered bar’s cost in the big figure with a short date, and the total back on leave', () => {
    const step = 6 * 3_600_000
    const from = new Date(2026, 9, 11, 0).getTime()
    const bars = [10, 0, 287.12, 4].map((cost, i) => ({ start: from + i * step, end: from + (i + 1) * step, cost }))
    render(<SpendChart id="h" bars={bars} step={step} now={from + 3 * 86_400_000} total={1299.44} scope="this session" />)
    const box = screen.getByRole('group', { name: /^Spend by 6 h/ })
    const plot = box.querySelector('svg')!.parentElement!
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 56, right: 400, bottom: 56, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(plot, { clientX: 250, pointerType: 'mouse', buttons: 0 })
    expect(box.querySelector('[data-spend-readout]')).toHaveTextContent('$287.12')
    expect(box).toHaveTextContent('Sun 11 Oct · 12–18')
    expect(box).toHaveTextContent('of $1,299.44')
    expect([...box.querySelectorAll('rect')].findIndex((r) => r.hasAttribute('data-active'))).toBe(2)
    fireEvent.pointerLeave(plot, { pointerType: 'mouse' })
    expect(box.querySelector('[data-spend-readout]')).toBeNull()
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$1,299.44')
    expect(box.querySelector('rect[data-active]')).toBeNull()
  })

  it('draws a range’s bars with its total, steps to the newest stretch with spend, and says so when nothing was spent', () => {
    const day = 86_400_000
    const from = new Date(2026, 9, 6).getTime()
    const bars = [0, 3, 1.5, 0].map((cost, i) => ({ start: from + i * day, end: from + (i + 1) * day, cost }))
    const { unmount } = render(<SpendChart id="c" bars={bars} step={day} now={from + 10 * day} total={4.5} scope="7 days · all sessions" />)
    const box = screen.getByRole('group', { name: 'Spend by 1 day, 7 days · all sessions' })
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$4.50')
    expect(box.querySelector('[data-spend-readout]')).toBeNull()
    fireEvent.keyDown(box, { code: 'ArrowRight', key: 'ArrowRight' })
    expect(box.querySelector('[data-spend-readout]')).toHaveTextContent('$1.50')
    expect(box).toHaveTextContent('Thu 8 Oct')
    expect(box.querySelectorAll('rect')).toHaveLength(4)
    unmount()
    render(<SpendChart id="c" bars={bars.map((b) => ({ ...b, cost: 0 }))} step={day} now={from} total={0} scope="7 days · all sessions" />)
    expect(screen.getByText('Nothing spent, 7 days · all sessions.')).toBeInTheDocument()
    expect(document.querySelector('rect')).toBeNull()
  })
})
