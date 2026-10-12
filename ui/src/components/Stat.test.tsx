import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Stat, statFit } from './ui'

describe('a Stat figure', () => {
  it('shrinks a long text figure to its tile, never past its own step', () => {
    // "$127,930.10" is 11 mono characters: 6.6em across, so 100cqi / 6.6.
    expect(statFit('$127,930.10', 'hero')?.fontSize).toBe('max(12px, min(34px, calc(100cqi / 6.60)))')
    expect(statFit('$8.14/h')?.fontSize).toBe('max(12px, min(28px, calc(100cqi / 4.20)))')
    expect(statFit(1234, 'compact')?.fontSize).toBe('max(12px, min(22px, calc(100cqi / 2.40)))')
  })

  it('leaves a figure that is not plain text at its fixed step', () => {
    expect(statFit(<span>97%</span>)).toBeUndefined()
    expect(statFit('')).toBeUndefined()
  })

  it('is a size container, keeps the figure on one line and lets the caption wrap', () => {
    const { container } = render(<Stat label="Worth at API list" value="$12,793.46" sub="at API list price · not a bill" size="hero" />)
    const tile = container.firstElementChild as HTMLElement
    expect(tile.className).toContain('@container')
    const [, figure, caption] = Array.from(tile.children) as HTMLElement[]
    expect(figure!.className).toContain('whitespace-nowrap')
    expect(figure!.style.fontSize).toContain('cqi')
    expect(caption!.className).not.toContain('truncate')
    expect(caption!.className).toContain('[overflow-wrap:anywhere]')
  })
})
