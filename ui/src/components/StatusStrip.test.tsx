/**
 * "v2 · 167×36" beside the version was, to the owner, incomprehensible junk
 * (2026-10-09, translated): the front terminal's protocol and size. They are
 * for debugging, so they live in the version's tooltip and nowhere on the bar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  // Service things only (owner, 2026-10-23): the session's model, context,
  // next-call price and cost live in the cockpit, and today's spend with them.
  it('carries no session figures and no spend', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const session = {
      session_id: 's1',
      model_display: 'Opus 5.5',
      context: { tokens: 84_000, window: 200_000, pct: 42, next_call_usd: 0.12 },
      stats: { cost_usd: 3.4 },
    } as unknown as Parameters<typeof StatusStrip>[0]['session']
    const { container } = render(<StatusStrip version="0.94.1" session={session} summary={{ cost_usd: 12.5 } as Parameters<typeof StatusStrip>[0]['summary']} />)
    expect(container.querySelector('[data-session-figures]')).toBeNull()
    const text = container.textContent ?? ''
    expect(text).not.toContain('Opus 5.5')
    expect(text).not.toContain('$3.40')
    expect(text).not.toContain('$12.50')
    expect(text).not.toContain('Today')
  })

  it('names the terminal state only while it is not live', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<StatusStrip version="0.94.1" figures={false} pane={{ status: 'reconnecting', protocol: 'v2', cols: 100, rows: 37 }} />)
    const bar = container.querySelector('footer')!
    expect(bar.textContent).toContain('reconnecting')
    expect(bar.textContent).not.toContain('100×37')
  })

  describe('Premium on the strip', () => {
    const premium = (active: boolean) => vi.fn((url: string) => {
      if (url !== '/v1/premium') return new Promise(() => {})
      const body = { yearly: { url: 'https://example.test/buy', charged_usd: 30, per_month_usd: 2.5, period: 'year' }, license: active ? { active: true, expires_at: '2027-10-17T00:00:00Z' } : { active: false, reason: 'no key' } }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })
    const summary = (pct: number) => ({ cost_usd: 1, rate_limits: { five_hour: { used_percentage: pct } } }) as unknown as Parameters<typeof StatusStrip>[0]['summary']

    it('carries the way to buy, and offers the window stop only while a window is close', async () => {
      vi.stubGlobal('fetch', premium(false))
      const { container, rerender } = render(<StatusStrip version="0.94.1" summary={summary(40)} />)
      expect(await screen.findByRole('button', { name: 'Premium' })).toBeInTheDocument()
      expect(container.querySelector('[data-window-hint]')).toBeNull()
      rerender(<StatusStrip version="0.94.1" summary={summary(75)} />)
      expect(await screen.findByText('pause before the limit')).toBeInTheDocument()
    })

    it('says Premium, the plan in its title, and offers nothing, once Premium is on', async () => {
      vi.stubGlobal('fetch', premium(true))
      const { container } = render(<StatusStrip version="0.94.1" summary={summary(95)} />)
      await waitFor(() => expect(container.querySelector('[data-premium-chip]')?.textContent).toBe('Premium'))
      expect(container.querySelector('[data-premium-chip]')?.getAttribute('title')).toMatch(/yearly/)
      expect(screen.queryByRole('button', { name: 'Premium' })).toBeNull()
      expect(container.querySelector('[data-window-hint]')).toBeNull()
    })
  })
})
