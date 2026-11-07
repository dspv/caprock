import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Summary } from '@/lib/api'
import { CostAcrossPanel, CostScopeToggle } from './CostAcross'

const here = {
  sessions: 4, turns: 30, tokens_in: 1000, tokens_out: 500, cache_read: 0, cache_write: 0, cost_usd: 41.2, pricing_version: '2026-11-01',
  machines: [
    { id: 'mini', name: 'Mac mini', status: 'online', cost_usd: 63.75, sessions: 7, tokens: 2_000_000, turns: 90, pricing_version: '2026-10-20' },
    { id: 'vm', name: 'Linux VM', status: 'offline', error: 'the computer is offline' },
  ],
  all: { cost_usd: 104.95, tokens: 2_001_500, sessions: 11, turns: 120, answered: 2, of: 3 },
} as unknown as Summary

describe('CostAcrossPanel', () => {
  it('sums what answered, names what did not, never as $0', () => {
    render(<CostAcrossPanel summary={here} range="30d" />)
    const table = screen.getByTestId('cost-across')
    expect(table.textContent).toContain('$41.20')
    expect(table.textContent).toContain('Mac mini')
    expect(table.textContent).toContain('$63.75')
    expect(table.textContent).toContain('table 2026-10-20')
    expect(table.textContent).toContain('Linux VM — offline, not counted')
    expect(table.textContent).toContain('Total (2 of 3)')
    expect(table.textContent).toContain('$104.95')
    expect(table.textContent).not.toContain('$0.00')
    expect(screen.getByText(/leaves out Linux VM/).textContent).toContain('unknown here, not $0')
  })

  it('says nothing is missing when every computer answered', () => {
    const full = { ...here, machines: [here.machines![0]], all: { ...here.all!, answered: 2, of: 2 } } as Summary
    render(<CostAcrossPanel summary={full} range="7d" />)
    expect(screen.queryByText(/leaves out/)).toBeNull()
    expect(screen.getByTestId('cost-across').textContent).toContain('Total (2 of 2)')
  })
})

describe('CostScopeToggle', () => {
  it('switches between this computer and all of them', () => {
    const onChange = vi.fn()
    render(<CostScopeToggle scope="this" onChange={onChange} />)
    const all = screen.getByRole('button', { name: 'All computers' })
    expect(all.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(all)
    expect(onChange).toHaveBeenCalledWith('all')
  })
})
