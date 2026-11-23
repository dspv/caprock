import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { GapDash, GapMark } from './GapMark'
import { gapSentence } from '@/lib/gaps'

const WHY = "Cursor CLI doesn't save token counts on this computer"
const SAID = "Cursor CLI doesn't save token counts on this computer, so there is nothing for Caprock to show."

describe('the gap mark', () => {
  it('says the agent is why, in a full sentence', () => {
    expect(gapSentence(WHY)).toBe(SAID)
    expect(gapSentence(`${WHY}.`)).toBe(SAID)
  })

  it('is a focusable button named by the sentence, quiet until asked', () => {
    render(<GapMark why={WHY} />)
    const mark = screen.getByRole('button', { name: SAID })
    expect(mark).toHaveAttribute('data-gap-mark')
    expect(mark.className).toContain('text-fg-faint')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows the sentence on a mouse hover and puts it away on leaving', () => {
    render(<GapMark why={WHY} />)
    const mark = screen.getByRole('button', { name: SAID })
    fireEvent.pointerOver(mark, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip')).toHaveTextContent(SAID)
    expect(mark).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    fireEvent.pointerOut(mark, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows it on keyboard focus, and Escape puts it away', () => {
    render(<GapMark why={WHY} />)
    const mark = screen.getByRole('button', { name: SAID })
    act(() => mark.focus())
    expect(screen.getByRole('tooltip')).toHaveTextContent(SAID)
    fireEvent.keyDown(mark, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.blur(mark)
  })

  it('opens on a tap with no hover, and a tap elsewhere closes it', () => {
    const row = vi.fn()
    render(<div onClick={row}><a href="#/session/x"><GapMark why={WHY} /></a><p>elsewhere</p></div>)
    const mark = screen.getByRole('button', { name: SAID })
    // A tap: a touch pointer enters (no hover), then the click.
    fireEvent.pointerOver(mark, { pointerType: 'touch' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    const click = fireEvent.click(mark)
    expect(screen.getByRole('tooltip')).toHaveTextContent(SAID)
    expect(mark).toHaveAttribute('aria-expanded', 'true')
    // The row it sits in does not open, and the card it sits in is not followed.
    expect(row).not.toHaveBeenCalled()
    expect(click).toBe(false)
    fireEvent.pointerDown(screen.getByText('elsewhere'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('draws the card in the window, never past its edges', () => {
    const was = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 })
    render(<GapMark why={WHY} />)
    const mark = screen.getByRole('button', { name: SAID })
    mark.getBoundingClientRect = () => ({ left: 290, right: 301, top: 10, bottom: 21, width: 11, height: 11, x: 290, y: 10, toJSON: () => ({}) })
    fireEvent.click(mark)
    const card = screen.getByRole('tooltip')
    const left = parseFloat(card.style.left), width = parseFloat(card.style.width)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + width).toBeLessThanOrEqual(292)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: was })
  })

  it('is the glyph alone, hidden, inside a control', () => {
    render(<button type="button">Tokens —<GapMark why={WHY} decorative /></button>)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.querySelector('[data-gap-mark="decorative"]')).toHaveAttribute('aria-hidden')
  })

  it('draws a dash with its sentence and the mark after it', () => {
    render(<GapDash why={WHY} />)
    const dash = document.querySelector('[data-gap-dash]')!
    expect(dash).toHaveTextContent('—')
    expect(screen.getByText('—')).toHaveAttribute('title', SAID)
    expect(screen.getByRole('button', { name: SAID })).toBeInTheDocument()
  })
})
