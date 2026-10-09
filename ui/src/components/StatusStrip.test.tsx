/**
 * "v2 · 167×36" beside the version was, to the owner, incomprehensible junk
 * (2026-10-09, translated): the front terminal's protocol and size. They are
 * for debugging, so they live in the version's tooltip and nowhere on the bar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusStrip } from './StatusStrip'

afterEach(() => vi.unstubAllGlobals())

describe('the status strip', () => {
  it('keeps the terminal protocol and size off the bar and in the version tooltip', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<StatusStrip version="0.94.1" figures={false} pane={{ status: 'live', protocol: 'v2', cols: 167, rows: 36 }} />)
    const bar = container.querySelector('footer')!
    expect(bar.textContent).not.toMatch(/167×36|\bv2\b/)
    expect(screen.getByText('0.94.1')).toHaveAttribute('title', 'terminal protocol v2 · 167×36')
  })

  it('names the terminal state only while it is not live', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<StatusStrip version="0.94.1" figures={false} pane={{ status: 'reconnecting', protocol: 'v2', cols: 100, rows: 37 }} />)
    const bar = container.querySelector('footer')!
    expect(bar.textContent).toContain('reconnecting')
    expect(bar.textContent).not.toContain('100×37')
  })
})
