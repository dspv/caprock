/**
 * The lifetime line states a money figure on the screen people keep open, so
 * the honesty rules that govern every other cost surface apply here: the basis
 * is named beside the number, and nothing is claimed before anything has been
 * captured.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LifetimeStrip } from './Lifetime'
import type { History, Settings } from '@/lib/api'

const totals = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, history: async () => totals.value } }
})

const history = (over: Partial<History['totals']>): History =>
  ({
    totals: {
      sessions: 129, owned_sessions: 0, turns: 72310, tool_calls: 81587,
      files_touched: 2467, cost_usd: 10745.61, avg_session_sec: 116432, days: 58,
      ...over,
    },
    tools: [
      { tool: 'Bash', count: 40839 },
      { tool: 'Read', count: 11693 },
    ],
    summary: {
      models: [
        { model: 'claude-opus-5', tokens: 8_240_000_000, turns: 1, cost_usd: 5398.7 },
        { model: 'claude-opus-4-8', tokens: 6_360_000_000, turns: 1, cost_usd: 3843.76 },
      ],
      projects: [],
    },
  }) as unknown as History

const plan = (kind: Settings['plan_kind']): Settings =>
  ({ update_checks: false, plan_kind: kind, plan_label: 'Max 20×', plan_usd_per_month: 200 })

describe('LifetimeStrip', () => {
  it('leads with the total and says what the figure is', async () => {
    totals.value = history({})
    render(<LifetimeStrip plan={plan('flat')} />)
    expect(await screen.findByText('$10,745.61')).toBeTruthy()
    // The same caveat the Cost screen carries: a flat plan means this is what
    // the usage would cost through the API, not an amount anyone was billed.
    expect(document.body.textContent).toMatch(/not a bill/i)
  })

  it('renders nothing before anything has been captured', async () => {
    totals.value = history({ sessions: 0, cost_usd: 0, days: 0, turns: 0 })
    const { container } = render(<LifetimeStrip plan={plan('flat')} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })

  it('leaves out sessions-per-day when it would read as less than one', async () => {
    // 20 sessions over 58 days is 0.34 — "0.3 sessions a day" is a sentence
    // nobody says, and the figure adds nothing at that scale.
    totals.value = history({ sessions: 20, days: 58 })
    render(<LifetimeStrip plan={plan('flat')} />)
    await screen.findByText('20')
    expect(screen.queryByText(/sessions a day/)).toBeNull()
  })

  it('does not hawk the paid limit on an ordinary day', async () => {
    totals.value = history({})
    render(<LifetimeStrip plan={plan('flat')} />)
    await screen.findByText('$10,745.61')
    // The offer belongs to the days that argue for it. A permanent link is
    // wallpaper: read once, ignored after, and faintly grubby on a tool
    // someone installed for its own sake.
    expect(screen.queryByText(/set a limit/i)).toBeNull()
    // And no price anywhere: quoting a figure inside the dashboard turns a
    // tool someone installed into a storefront.
    expect(document.body.textContent).not.toMatch(/\$\d+\s*\/\s*(mo|month)/i)
  })
})
