import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SubagentSavingNote } from './SubagentSavingNote'

describe('SubagentSavingNote', () => {
  it('says it is an estimate at list prices, with both figures', () => {
    render(<SubagentSavingNote saving={{ models: ['Opus 5.5', 'Sonnet 5.5'], cost_usd: 75, haiku_usd: 15, haiku: 'Haiku 5.5' }} />)
    const note = screen.getByRole('note').textContent ?? ''
    expect(note).toContain('Subagents this week cost $75.00 on Opus 5.5 and Sonnet 5.5')
    expect(note).toContain('on Haiku 5.5 about $15.00')
    expect(note).toMatch(/estimate at list prices/)
  })
})
