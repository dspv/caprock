import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SubagentSavingNote, savingPercent } from './SubagentSavingNote'
import { defaultSubagentModel, rememberedSubagentModel } from '@/lib/subagentModel'

const saving = { models: ['Opus 5.5', 'Sonnet 5.5'], cost_usd: 973.86, haiku_usd: 37.33, haiku: 'Haiku 4.5' }

describe('SubagentSavingNote', () => {
  beforeEach(() => localStorage.clear())

  it('says the three figures big, as an estimate, from the figures the daemon sent', () => {
    render(<SubagentSavingNote saving={saving} />)
    const note = screen.getByRole('note', { name: 'Subagents this week' }).textContent ?? ''
    expect(note).toContain('$974')
    expect(note).toContain('what they cost, on Opus 5.5 and Sonnet 5.5')
    expect(note).toContain('≈$37')
    expect(note).toContain('same work on Haiku 4.5')
    expect(note).toContain('−96%')
    expect(note).toContain('≈ estimate: same tokens at list prices. Haiku is not right for every task.')
    expect(screen.getByTitle('Subagents this week cost $973.86 on Opus 5.5 and Sonnet 5.5.')).toBeTruthy()
  })

  it('leaves the arrow and the saving out when Haiku would not be cheaper', () => {
    render(<SubagentSavingNote saving={{ ...saving, haiku_usd: 973.86 }} />)
    const note = screen.getByRole('note').textContent ?? ''
    expect(note).toContain('$974')
    expect(note).not.toContain('→')
    expect(note).not.toContain('%')
  })

  it('rounds the saving to whole percent', () => {
    expect(savingPercent(saving)).toBe(96)
    expect(savingPercent({ ...saving, cost_usd: 0 })).toBe(0)
    expect(savingPercent({ ...saving, haiku_usd: 1000 })).toBe(0)
  })

  it('turns Haiku subagents on for new agents, shows it on, and turns it off again', () => {
    render(<SubagentSavingNote saving={saving} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start new agents with Haiku subagents' }))
    expect(defaultSubagentModel()).toBe('haiku')
    expect(rememberedSubagentModel('p1')).toBe('haiku')
    const on = screen.getByRole('button', { name: 'New agents use Haiku subagents ✓' })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(on)
    expect(defaultSubagentModel()).toBe('')
  })

  it('opens already on when the default is Haiku', () => {
    localStorage.setItem('caprock.subagentmodel-default', 'haiku')
    render(<SubagentSavingNote saving={saving} />)
    expect(screen.getByRole('button', { name: 'New agents use Haiku subagents ✓' })).toBeTruthy()
  })
})
