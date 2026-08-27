/**
 * The figure was already on screen; what is new is the word beside it. So what
 * matters is that the word appears, that it is the right one, and that it
 * stays quiet when there is nothing to describe.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CacheStat } from './CacheStat'

describe('CacheStat', () => {
  it('reads a high rate as outstanding, beside the figure', () => {
    render(<CacheStat hitRate={0.994} cutPct={89} measured />)
    expect(screen.getByText(/99%/)).toBeTruthy()
    expect(screen.getByText('outstanding')).toBeTruthy()
    // The sub-line is what the rate bought, and it stays.
    expect(screen.getByText(/89% input cost cut/)).toBeTruthy()
  })

  it('says low without calling it bad', () => {
    // A short session has little to reuse; a low rate is a fact about the
    // work, not a fault to be told off for.
    render(<CacheStat hitRate={0.42} cutPct={30} measured />)
    expect(screen.getByText('low')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/bad|poor|warning/i)
  })

  it('says nothing on a machine that has measured nothing', () => {
    // 0% on a fresh install is not a low cache rate — it is no data, and
    // labelling it reads as a fault before the product has done anything.
    render(<CacheStat hitRate={0} cutPct={0} measured />)
    expect(screen.queryByText('low')).toBeNull()
    expect(screen.queryByText('outstanding')).toBeNull()
  })

  it('shows a dash rather than a level before anything is measured', () => {
    render(<CacheStat hitRate={undefined} cutPct={undefined} measured={false} />)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('ok')).toBeNull()
  })

  it('leaves the middle band uncoloured', () => {
    // Colour means something on this dashboard. An ordinary reading is not
    // something, and colouring it would make the palette meaningless.
    const { container } = render(<CacheStat hitRate={0.9} cutPct={70} measured />)
    const word = screen.getByText('ok')
    expect(word.className).not.toMatch(/text-ok|text-warn|text-danger/)
    expect(container.querySelector('.text-warn')).toBeNull()
  })
})
