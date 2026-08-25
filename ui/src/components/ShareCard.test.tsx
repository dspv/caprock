/**
 * The card leaves the machine by design — someone posts it — so what it says
 * has to survive a stranger reading it without context. Two rules matter: the
 * caveat travels with the figure (Rule 6), and nothing identifying travels at
 * all.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ShareCard } from './ShareCard'
import type { History } from '@/lib/api'

const data = vi.hoisted(() => ({ value: undefined as unknown }))
const drawn = vi.hoisted(() => ({ text: [] as string[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, history: async () => data.value } }
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
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillRect: vi.fn(),
    fillText: vi.fn((s: string) => drawn.text.push(s)),
    set fillStyle(_v: string) {},
    set font(_v: string) {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.toBlob = vi.fn()
}

describe('ShareCard', () => {
  it('carries the caveat with the figure', async () => {
    data.value = history()
    stubCanvas()
    render(<ShareCard />)
    ;(await screen.findByRole('button', { name: /share/i })).click()

    const all = drawn.text.join(' ')
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

    const all = drawn.text.join(' ')
    expect(all).not.toMatch(/\//) // no paths
    expect(all).toContain('caprock.dev')
  })

  it('offers nothing on a machine that has captured nothing', async () => {
    data.value = history({ sessions: 0, cost_usd: 0, turns: 0, days: 0 })
    const { container } = render(<ShareCard />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})

describe('ShareCard milestones', () => {
  it('calls out a round number that was just passed', async () => {
    data.value = history({ cost_usd: 10_400 })
    render(<ShareCard />)
    expect(await screen.findByRole('button', { name: /just passed \$10,000/i })).toBeTruthy()
  })

  it('goes quiet once the milestone is well behind', async () => {
    // $18,000 is past $10,000 but nowhere near $25,000 — the moment has gone,
    // and a button still announcing it is noise rather than an invitation.
    data.value = history({ cost_usd: 18_000 })
    render(<ShareCard />)
    expect(await screen.findByRole('button', { name: /^share these numbers$/i })).toBeTruthy()
  })
})
