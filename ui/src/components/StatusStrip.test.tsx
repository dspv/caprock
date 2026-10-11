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
    expect(screen.getByText('0.94.1').closest('button')).toHaveAttribute('title', 'Version and updates\nterminal protocol v2 · 167×36')
  })

  it('shows the figures of the session in front: model, context, next call, cost', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const session = {
      model_display: 'Opus 5.5',
      context: { tokens: 84_000, window: 200_000, pct: 42, next_call_usd: 0.12 },
      stats: { cost_usd: 3.4 },
    } as unknown as Parameters<typeof StatusStrip>[0]['session']
    const { container } = render(<StatusStrip version="0.94.1" figures={false} session={session} />)
    const text = container.querySelector('[data-session-figures]')!.textContent
    expect(text).toContain('Opus 5.5')
    expect(text).toContain('42%')
    expect(text).toContain('$0.12')
    expect(text).toContain('$3.40')
  })

  it('names the terminal state only while it is not live', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<StatusStrip version="0.94.1" figures={false} pane={{ status: 'reconnecting', protocol: 'v2', cols: 100, rows: 37 }} />)
    const bar = container.querySelector('footer')!
    expect(bar.textContent).toContain('reconnecting')
    expect(bar.textContent).not.toContain('100×37')
  })
})
