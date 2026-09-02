import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DayGrid } from './DayGrid'

const bar = (day: string, cost: number) => ({ day, cost, tokens: 0, sessions: 0 })

// Every cell in the grid, in the order it is laid out, as "day" or "" for the
// blanks that lead the first row. The columns are the panel's whole claim, so
// the position of a cell is the thing worth asserting.
function cells(): string[] {
  const grid = document.querySelector('.grid')!
  return [...grid.children]
    .slice(7) // the weekday header row
    .map((el) => (el.tagName === 'BUTTON' ? (el.getAttribute('aria-label') ?? '').split(':')[0] ?? '' : ''))
}

describe('DayGrid', () => {
  it('puts a day in its own weekday column even when days are missing', () => {
    // A week worked Monday to Friday, then a weekend off, then Monday again.
    // The server sends no row at all for a day nobody worked, so laying the
    // rows out in sequence used to slide the second Monday into Saturday's
    // column — and from there every column is the wrong weekday.
    render(
      <DayGrid
        bars={[
          bar('2026-08-17', 10), // Monday
          bar('2026-08-18', 12),
          bar('2026-08-19', 8),
          bar('2026-08-20', 9),
          bar('2026-08-21', 11), // Friday
          bar('2026-08-24', 7), // Monday, after a weekend with no rows
        ]}
        active={null}
        onActive={vi.fn()}
      />,
    )

    const laid = cells()
    // 2026-08-17 is a Monday, so no blanks lead the first row.
    expect(laid.slice(0, 7)).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22', // filled: nobody worked
      '2026-08-23', // filled
    ])
    // The second Monday opens the next row, under the first Monday.
    expect(laid[7]).toBe('2026-08-24')
  })

  it('leads the first row with blanks so the first day sits under its weekday', () => {
    render(<DayGrid bars={[bar('2026-08-19', 5)]} active={null} onActive={vi.fn()} />)
    // Wednesday: two blanks for Monday and Tuesday.
    expect(cells().slice(0, 3)).toEqual(['', '', '2026-08-19'])
  })

  it('shows a day with no spend as a day, not as a hole', () => {
    render(
      <DayGrid
        bars={[bar('2026-08-17', 10), bar('2026-08-19', 4)]}
        active={null}
        onActive={vi.fn()}
      />,
    )
    // The unworked Tuesday is a cell you can hover and read as $0.00, which is
    // the honest answer — not an absence that shifts everything after it.
    expect(screen.getByLabelText('2026-08-18: $0.00')).toBeTruthy()
  })

  it('survives a single day, and a cost that is not a number', () => {
    render(
      <DayGrid
        bars={[{ day: '2026-08-17', cost: NaN as number, tokens: 0, sessions: 0 }]}
        active={null}
        onActive={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('2026-08-17: $0.00')).toBeTruthy()
  })
})
