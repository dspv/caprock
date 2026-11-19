/**
 * The bars previously answered only through a native `title` tooltip, which
 * arrives after a browser delay and detached from the chart — long enough that
 * a user hovers, sees nothing, and concludes the chart is dead. These pin the
 * immediate feedback that replaced it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BAR_WIDTH, BarChart, BarReadout, type Bar } from './BarChart'

const bars: Bar[] = [
  { day: '2026-08-18', cost: 10, tokens: 1_000_000, sessions: 2 },
  { day: '2026-08-19', cost: 40, tokens: 4_000_000, sessions: 5 },
  { day: '2026-08-20', cost: 0, tokens: 0, sessions: 1 },
]

describe('BarChart', () => {
  it('reports the day under the cursor as soon as it is hovered', () => {
    const onActive = vi.fn()
    render(<BarChart bars={bars} active={null} onActive={onActive} />)
    fireEvent.mouseEnter(screen.getByLabelText(/2026-08-19/))
    expect(onActive).toHaveBeenCalledWith('2026-08-19')
  })

  it('answers keyboard users too, not only a mouse', () => {
    const onActive = vi.fn()
    render(<BarChart bars={bars} active={null} onActive={onActive} />)
    fireEvent.focus(screen.getByLabelText(/2026-08-18/))
    expect(onActive).toHaveBeenCalledWith('2026-08-18')
  })

  it('keeps a zero-cost day visible rather than collapsing it to nothing', () => {
    const { container } = render(<BarChart bars={bars} active={null} onActive={vi.fn()} />)
    const heights = [...container.querySelectorAll('.rounded-t-sm')].map(
      (el) => parseInt((el as HTMLElement).style.height, 10),
    )
    expect(Math.min(...heights)).toBeGreaterThan(0)
  })

  it('draws a long history: the gap between bars shrinks with them', () => {
    // Lifetime's "all" over 585 days drew an empty panel: a fixed 3px flex gap
    // between every bar outgrew the panel and squeezed each bar to zero width.
    const many: Bar[] = Array.from({ length: 600 }, (_, i) => ({
      day: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), cost: 1 + (i % 7), tokens: 1,
    }))
    const { container } = render(<BarChart bars={many} active={null} onActive={vi.fn()} axis />)
    const row = container.firstElementChild as HTMLElement
    expect(row.className).not.toMatch(/\bgap-/)
    const els = [...container.querySelectorAll('.rounded-t-sm')] as HTMLElement[]
    expect(els).toHaveLength(600)
    // Never a fixed width or the full slot: a share of the slot, floored.
    expect(BAR_WIDTH).toMatch(/^max\(60%, /)
    for (const el of els) expect(el.style.width).toMatch(/^max\(60%, /)
  })

  it('scales bars against the largest day', () => {
    const { container } = render(<BarChart bars={bars} active={null} onActive={vi.fn()} height={112} />)
    const els = [...container.querySelectorAll('.rounded-t-sm')] as HTMLElement[]
    const tallest = parseInt(els[1]!.style.height, 10) // the 40-cost day
    const quarter = parseInt(els[0]!.style.height, 10) // the 10-cost day
    expect(tallest).toBeGreaterThan(quarter * 3)
  })
})

describe('BarReadout', () => {
  it('shows the total when nothing is hovered', () => {
    render(<BarReadout bars={bars} active={null} total={50} />)
    expect(screen.getByText('$50.00')).toBeTruthy()
  })

  it('shows that day’s figures while a bar is active', () => {
    render(<BarReadout bars={bars} active="2026-08-19" total={50} />)
    expect(screen.getByTitle('2026-08-19').textContent).toMatch(/^Wed 19 Aug · /)
    expect(screen.getByText('$40.00')).toBeTruthy()
    expect(screen.getByText('5 sessions')).toBeTruthy()
  })

  it('does not say "1 sessions"', () => {
    render(<BarReadout bars={bars} active="2026-08-20" total={50} />)
    expect(screen.getByText('1 session')).toBeTruthy()
  })

  it('falls back to the total if the active day is not in the data', () => {
    render(<BarReadout bars={bars} active="1999-01-01" total={50} />)
    expect(screen.getByText('$50.00')).toBeTruthy()
  })
})

describe('BarChart survives bad data', () => {
  it('one NaN cost does not blank the entire chart', () => {
    // Math.max returns NaN if any input is NaN, so every bar height became NaN
    // and React dropped the style — the whole 30-day chart vanished while the
    // header still showed a total. One absent cost_usd in a rollup does it.
    const bad: Bar[] = [
      { day: '2026-08-18', cost: 10, tokens: 1000 },
      { day: '2026-08-19', cost: NaN, tokens: 0 },
      { day: '2026-08-20', cost: 5, tokens: 500 },
    ]
    const { container } = render(<BarChart bars={bad} active={null} onActive={vi.fn()} />)
    const heights = [...container.querySelectorAll('.rounded-t-sm')].map(
      (el) => (el as HTMLElement).style.height,
    )
    expect(heights.every((h) => h !== '' && !h.includes('NaN'))).toBe(true)
  })
})

describe('the day readout', () => {
  it('names the weekday and how long ago', async () => {
    const { dayName, daysAgo } = await import('./BarChart')
    expect(dayName('2026-08-07')).toBe('Fri 7 Aug')
    const noon = new Date(2026, 9, 11, 15).getTime()
    expect(daysAgo('2026-10-11', noon)).toBe('today')
    expect(daysAgo('2026-10-10', noon)).toBe('yesterday')
    expect(daysAgo('2026-08-07', noon)).toBe('65 days ago')
  })
})
