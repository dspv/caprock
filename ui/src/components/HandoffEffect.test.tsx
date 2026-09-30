import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { HandoffEffect } from './HandoffEffect'

const g = (reached: number, min: number, calls: number) => ({ sessions: reached + 1, reached, median_min: min, median_calls: calls })

it('says nothing while nobody is measuring', () => {
  const { container } = render(<HandoffEffect />)
  expect(container.textContent).toBe('')
})

it('counts toward the comparison instead of showing a number too early', () => {
  render(<HandoffEffect holdout={25} served={g(6, 9, 12)} withheld={g(2, 20, 30)} />)
  expect(screen.getByText(/Measuring: 6 with it and 2 without/)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/9\.0 min/)
})

it('compares the two groups once each has enough sessions', () => {
  render(<HandoffEffect holdout={25} served={g(6, 9, 12)} withheld={g(5, 20, 30)} />)
  expect(screen.getByText('9.0 min')).toBeTruthy()
  expect(screen.getByText('20.0 min')).toBeTruthy()
  expect(screen.getByText(/30 tool calls · 5 sessions/)).toBeTruthy()
})
