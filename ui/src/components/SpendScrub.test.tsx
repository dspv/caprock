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
    expect(box.querySelector('[data-spend-pace]')).toHaveTextContent(/ avg$/)
    expect(box.querySelector('[data-spend-pace]')!.getAttribute('title')).toMatch(/the average$/)
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
    const plot = box.querySelector('[data-spend-plot]')!
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 56, right: 400, bottom: 56, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(plot, { clientX: 250, pointerType: 'mouse', buttons: 0 })
    expect(box.querySelector('[data-spend-readout]')).toHaveTextContent('$287.12')
    expect(box).toHaveTextContent('Sun 11 Oct · 12–18')
    // Against the average of the stretches that spent: (10 + 287.12 + 4) / 3 = 100.37.
    expect(box.querySelector('[data-spend-pace]')).toHaveTextContent('2.9× avg')
    expect(box.querySelector('[data-pace-label]')).toHaveTextContent('avg $100.37')
    expect([...box.querySelectorAll('rect')].findIndex((r) => r.hasAttribute('data-active'))).toBe(2)
    fireEvent.pointerLeave(plot, { pointerType: 'mouse' })
    expect(box.querySelector('[data-spend-readout]')).toBeNull()
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$1,299.44')
    expect(box.querySelector('rect[data-active]')).toBeNull()
  })

  it('keeps every row of the chart the same box with and without hover, so nothing above or below the bars moves', () => {
    // jsdom lays nothing out, so the heights are held by the classes: the top
    // line is a fixed 18px (not a minimum) in an 11px font with an 18px line
    // box, and every text on it sets that 18px line box itself or inherits it.
    // A ▾ wrapper that inherited the panel's 16px font stood the line 23px
    // tall at rest against 19px under the pointer: a 4px jump (2026-10-14).
    const step = 6 * 3_600_000
    const from = new Date(2026, 9, 7, 6).getTime()
    const bars = [4.76, 52.03, 0, 28.65, 1.91].map((cost, i) => ({ start: from + i * step, end: from + (i + 1) * step, cost }))
    const chooser = <span className="shrink-0"><button type="button" className="text-[12px] leading-[16px]">cost ▾</button></span>
    render(<SpendChart id="j" bars={bars} step={step} now={from + 7 * 86_400_000} total={1709.12} scope="this session" chooser={chooser} />)
    const box = screen.getByRole('group', { name: /^Spend by 6 h/ })
    const plot = box.querySelector('[data-spend-plot]')!
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 56, right: 500, bottom: 56, x: 0, y: 0, toJSON: () => ({}) })
    const rows = () => [...box.children].map((c) => `${c.tagName}.${c.className}|${(c as HTMLElement).style.height}`)
    const top = () => box.querySelector('[data-spend-top]')!
    const steady = (el: Element) => {
      expect(el.className).toMatch(/(^| )h-\[18px\]( |$)/)
      expect(el.className).not.toMatch(/min-h-/)
      expect(el.className).toMatch(/(^| )leading-\[18px\]( |$)/)
      expect(el.className).toMatch(/(^| )items-baseline( |$)/)
      // Each text on the line has an 18px line box, its own or the line's.
      for (const c of el.children) {
        if (/\btext-\[/.test(c.className)) expect(c.className).toMatch(/leading-\[18px\]/)
        else expect(c.className).not.toMatch(/\b(leading|text)-/)
      }
    }
    const atRest = rows()
    expect(atRest).toHaveLength(3)
    steady(top())
    const label = box.querySelector('[data-pace-label]')!.getAttribute('style')
    // The first bar, the second, an empty one and the last.
    for (const x of [10, 150, 250, 490]) {
      fireEvent.pointerMove(plot, { clientX: x, pointerType: 'mouse', buttons: 0 })
      expect(box.querySelector('[data-spend-readout]')).not.toBeNull()
      expect(rows()).toEqual(atRest)
      steady(top())
      expect(box.querySelector('[data-pace-label]')!.getAttribute('style')).toBe(label)
    }
    fireEvent.pointerLeave(plot, { pointerType: 'mouse' })
    expect(rows()).toEqual(atRest)
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
  it('draws burn rate per active hour against the usual, with no bar for an idle stretch, and says how far each is from it', () => {
    const step = 3_600_000
    const from = new Date(2026, 9, 12, 9).getTime()
    // $4.14 in one active hour, nothing, a thin hour with spend but no active hour, then $12/h: in the top fifth of the viewer's own hours.
    const bars = [
      { cost: 4.14, activeHours: 1, activeCost: 4.14 },
      { cost: 0, activeHours: 0, activeCost: 0 },
      { cost: 3, activeHours: 0, activeCost: 0 },
      { cost: 24, activeHours: 2, activeCost: 24 },
    ].map((b, i) => ({ start: from + i * step, end: from + (i + 1) * step, ...b }))
    const SHAPE = [0.003, 0.03, 0.08, 0.22, 0.56, 1, 1.65, 2.6, 3.7, 6, 22.7]
    const usual = { days: 30, burn: { n: 362, q: SHAPE.map((k) => k * 3), mean: 3 } }
    render(<SpendChart id="b" bars={bars} step={step} now={from} total={28.14 / 3} scope="this session" metric="burn" usual={usual} />)
    const box = screen.getByRole('group', { name: /^Burn rate by 1 h, this session$/ })
    expect(box).toHaveAttribute('data-pace', 'usual')
    expect(box.querySelector('[data-spend-total]')).toHaveTextContent('$9.38/h')
    expect(box.querySelector('[data-pace-label]')).toHaveTextContent('usual $3.00/h')
    expect(box.querySelector('[data-pace-line]')).not.toBeNull()
    const rects = [...box.querySelectorAll('rect')]
    // Idle and thin stretches have no rate: a faint stub, not a $0/h bar.
    expect(rects.map((r) => r.getAttribute('data-pace'))).toEqual(['above', null, null, 'high'])
    expect(rects[1]!.getAttribute('height')).toBe('1')
    expect(rects[2]!.getAttribute('height')).toBe('1')
    expect(rects[3]!.getAttribute('class')).toBe('fill-warn')
    expect(rects[0]!.getAttribute('class')).toBe('fill-accent')
    const plot = box.querySelector('[data-spend-plot]')!
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 56, right: 400, bottom: 56, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(plot, { clientX: 50, pointerType: 'mouse', buttons: 0 })
    expect(box.querySelector('[data-spend-readout]')).toHaveTextContent('$4.14/h')
    // Short on the line, beside the date; the whole sentence on hover and for a screen reader.
    expect(box.querySelector('[data-spend-pace]')).toHaveTextContent('38% above usual')
    expect(box.querySelector('[data-spend-pace]')).toHaveAttribute('title', '38% above your usual')
    expect(box.querySelector('[data-spend-readout]')!.getAttribute('aria-label')).toMatch(/\$4\.14\/h · 38% above your usual · 1 active hour/)
    fireEvent.pointerMove(plot, { clientX: 250, pointerType: 'mouse', buttons: 0 })
    expect(box.querySelector('[data-spend-readout]')).toHaveTextContent('—')
    expect(box).toHaveTextContent('no active hour')
    fireEvent.pointerMove(plot, { clientX: 350, pointerType: 'mouse', buttons: 0 })
    expect(box.querySelector('[data-spend-pace]')).toHaveTextContent('4.0× usual')
    expect(box.querySelector('[data-spend-pace]')).toHaveClass('text-warn')
  })

  it('says why there is no burn rate to draw when no hour was active', () => {
    const step = 3_600_000
    const bars = [0, 1].map((i) => ({ start: i * step, end: (i + 1) * step, cost: 1, activeHours: 0, activeCost: 0 }))
    render(<SpendChart id="e" bars={bars} step={step} now={0} scope="this session" metric="burn" />)
    expect(screen.getByText('No active hour this session (five or more calls in one hour): no rate to draw.')).toBeInTheDocument()
  })
})
