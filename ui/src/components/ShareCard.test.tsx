/**
 * The card leaves the machine by design — someone posts it — so what it says
 * has to survive a stranger reading it without context. Two rules matter: the
 * caveat travels with the figure (Rule 6), and nothing identifying travels at
 * all.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ShareCard, cardFilename } from './ShareCard'
import type { History } from '@/lib/api'

const data = vi.hoisted(() => ({ value: undefined as unknown }))
const drawn = vi.hoisted(() => ({ text: [] as string[] }))

const summary = vi.hoisted(() => ({
  cost_usd: 1234.5, sessions: 3, tokens_in: 1e6, tokens_out: 2e6,
  cache_read: 9e9, cache_write: 1e8,
  savings: { hit_rate: 0.99 },
  models: [{ model: 'claude-opus-5', cost_usd: 900 }],
  work: [{ kind: 'command', cost_usd: 700 }],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      history: async () => data.value,
      summary: async () => summary as never,
    },
  }
})

const history = (over: Partial<History['totals']> = {}): History =>
  ({
    totals: {
      sessions: 129, owned_sessions: 0, turns: 72510, tool_calls: 81587,
      files_touched: 2467, cost_usd: 10845.61, avg_session_sec: 116432, days: 59,
      ...over,
    },
    tools: [],
    summary: { models: [], projects: [] },
  }) as unknown as History

/** jsdom has no canvas; record what would have been drawn instead. */
function stubCanvas() {
  drawn.text = []
  // Enough of a 2D context for the card to draw: panels are rounded rects,
  // which need the path methods, and a missing one stops the paint silently
  // after the heading.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillRect: vi.fn(),
    fillText: vi.fn((s: string) => drawn.text.push(s)),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    // The heading measures its own text to place the domain and date, so a
    // stub without this stops the paint at the first word.
    measureText: vi.fn((t: string) => ({ width: t.length * 16 })),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set globalAlpha(_v: number) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.toBlob = vi.fn()
}

describe('ShareCard', () => {
  it('carries the caveat with the figure', async () => {
    data.value = history()
    stubCanvas()
    render(<ShareCard />)
    ;(await screen.findByRole('button', { name: /share/i })).click()
    await waitFor(() => expect(drawn.text.length).toBeGreaterThan(0))

    const all = drawn.text.join(' ')
    // The all-time figure, which is the one the card leads its tiles with.
    expect(all).toContain('$10,845.61')
    // A dollar figure posted without this reads as a bill someone paid.
    expect(all).toMatch(/not a bill/i)
    expect(all).toMatch(/not money saved/i)
  })

  it('states no multiple, which it cannot compute from these figures', async () => {
    data.value = history()
    stubCanvas()
    render(<ShareCard />)
    ;(await screen.findByRole('button', { name: /share/i })).click()
    await waitFor(() => expect(drawn.text.length).toBeGreaterThan(0))

    // The endpoint reports active days, not the window's calendar span, so a
    // multiple built here divided 59 days of plan into 95 days of usage and
    // printed 27.6x where every other surface said 17.1x.
    expect(drawn.text.join(' ')).not.toMatch(/\d+(\.\d+)?×/)
  })

  it('puts no project or session names on an image meant to be posted', async () => {
    data.value = history()
    stubCanvas()
    render(<ShareCard />)
    ;(await screen.findByRole('button', { name: /share/i })).click()
    await waitFor(() => expect(drawn.text.length).toBeGreaterThan(0))

    const all = drawn.text.join(' ')
    // Model ids are the only names on the card now, and they are public
    // product names. Anything with a path separator in it would be a
    // repository, a directory, or a file — none of which belong on an image
    // somebody is about to post.
    expect(all).not.toMatch(/\//)
    expect(all).toContain('caprock.dev')
  })

  it('strips the vendor prefix a gateway puts in a model id', async () => {
    // OpenRouter reports `minimax/minimax-m3`. A slash on this card would be
    // indistinguishable from a repository path to anyone reading it, and the
    // leak check above is what makes that a rule rather than a preference.
    summary.models = [{ model: 'minimax/minimax-m3', cost_usd: 900 }]
    data.value = history()
    stubCanvas()
    render(<ShareCard />)
    ;(await screen.findByRole('button', { name: /share/i })).click()
    await waitFor(() => expect(drawn.text.length).toBeGreaterThan(0))

    const all = drawn.text.join(' ')
    expect(all).not.toMatch(/\//)
    expect(all).toContain('minimax-m3')
    summary.models = [{ model: 'claude-opus-5', cost_usd: 900 }]
  })

  it('says when it was taken', async () => {
    // The card lives in a feed for weeks. Without a date, a reader cannot tell
    // whether "$11,278 all time" is current or a year old, and the figures
    // stop meaning anything the moment that is in doubt.
    data.value = history()
    stubCanvas()
    render(<ShareCard />)
    ;(await screen.findByRole('button', { name: /share/i })).click()
    await waitFor(() => expect(drawn.text.length).toBeGreaterThan(0))

    const year = String(new Date().getFullYear())
    expect(drawn.text.join(' ')).toContain(year)
  })

  it('offers nothing on a machine that has captured nothing', async () => {
    data.value = history({ sessions: 0, cost_usd: 0, turns: 0, days: 0 })
    const { container } = render(<ShareCard />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})

describe('cardFilename', () => {
  it('carries the date, so repeated saves are tellable apart', () => {
    // Without it a person who draws two of these has `caprock.png` and
    // `caprock (1).png` and no way to know which month is which — while the
    // card itself carries a date, so the file would be contradicting its own
    // contents.
    expect(cardFilename(new Date(2026, 7, 27))).toBe('caprock-2026-08-27.png')
  })

  it('pads single digits, so names sort', () => {
    expect(cardFilename(new Date(2026, 0, 5))).toBe('caprock-2026-01-05.png')
  })
})

/**
 * Milestones moved to ShareNudge, which knows about occasions this button has
 * no business judging — and a control that renames itself is one people stop
 * recognising. What matters here is that the button is always the same button.
 */
describe('the share button', () => {
  it('says the same thing whatever the figures are', async () => {
    for (const cost of [10_400, 18_000, 12.5]) {
      data.value = history({ cost_usd: cost })
      const { unmount } = render(<ShareCard />)
      expect(await screen.findByRole('button', { name: /share these numbers/i })).toBeTruthy()
      unmount()
    }
  })
})
