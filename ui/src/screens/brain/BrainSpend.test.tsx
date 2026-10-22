import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({ spend: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, brainSpend: m.spend } }
})

import type { BrainAutoStatus, BrainSpend as Spend } from '@/lib/api'
import { BrainSpend, catchUpLine, RETAG_ROW, retagLine, spendShare } from './BrainSpend'

const auto = (over: Partial<BrainAutoStatus> = {}): BrainAutoStatus => ({
  chosen: true, on: true, enabled: true, claude_found: true, model: 'haiku', daily_tokens: 300_000, spent: 84_000, running: false, pending: 0, recent: [], ...over,
})
const days = (n = 14) => Array.from({ length: n }, (_, i) => ({
  day: `2026-10-${String(9 + i).padStart(2, '0')}`, start: 0, tokens: i === n - 1 ? 84_000 : i * 10_000, cost_usd: 0.01, reads: i,
}))
const spend = (over: Partial<Spend> = {}): Spend => ({
  days: days(), daily_tokens: 300_000, spent_24h: 84_000, claude_tokens_24h: 2_716_000,
  projects: [{ project: 'acme-api', reads: 12, tokens: 60_000, cost_usd: 0.06, memories: 31 }, { project: '', reads: 2, tokens: 24_000, cost_usd: 0.02, memories: 3 }],
  ...over,
})

describe('what Second Brain spends', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('says today’s tokens of the limit, with a thin bar and the share of all Claude tokens', async () => {
    m.spend.mockResolvedValue(spend())
    render(<BrainSpend auto={auto()} />)
    expect(document.querySelector('[data-brain-spend-line]')!.textContent).toBe('Today 84k of 300k tokens')
    expect(screen.getByRole('progressbar', { name: 'Tokens used of the daily limit' })).toHaveAttribute('aria-valuenow', '28')
    // 84k of 2,716k + 84k = 2,800k.
    expect(await screen.findByText('3% of all your Claude tokens today')).toBeVisible()
    expect(m.spend).toHaveBeenCalledWith(14)
  })

  it('hides the chip when no Claude tokens were recorded, or before the figures are in', async () => {
    m.spend.mockResolvedValue(spend({ claude_tokens_24h: 0 }))
    render(<BrainSpend auto={auto()} />)
    await waitFor(() => expect(m.spend).toHaveBeenCalled())
    await Promise.resolve()
    expect(document.querySelector('[data-brain-spend-share]')).toBeNull()
    expect(spendShare(null)).toBeNull()
    expect(spendShare({ spent_24h: 0, claude_tokens_24h: 0 })).toBeNull()
    expect(spendShare({ spent_24h: 10, claude_tokens_24h: 100_000 })).toBe('<1%')
    expect(spendShare({ spent_24h: 0, claude_tokens_24h: 100 })).toBe('0%')
  })

  it('shows the catch-up line only while one runs', async () => {
    m.spend.mockResolvedValue(spend())
    const { rerender } = render(<BrainSpend auto={auto()} />)
    expect(document.querySelector('[data-brain-spend-catchup]')).toBeNull()
    rerender(<BrainSpend auto={auto({ catch_up: { kind: 'skipped', done: 12, total: 40, days_left: 3 } })} />)
    expect(document.querySelector('[data-brain-spend-catchup]')!.textContent).toBe('Catching up on skipped text: 12 / 40 reads, about 3 days left')
    rerender(<BrainSpend auto={auto({ catch_up: { kind: 'skipped', done: 40, total: 40 } })} />)
    expect(document.querySelector('[data-brain-spend-catchup]')).toBeNull()
    expect(catchUpLine({ kind: 'backfill', done: 0, total: 200, truncated: true, days_left: 1 })).toBe('Catching up on earlier sessions: 0 / 200+ reads, about 1 day left')
    expect(catchUpLine({ kind: 'backfill', done: 1, total: 5 })).toBe('Catching up on earlier sessions: 1 / 5 reads')
  })

  it('says the re-tag on the second line while no catch-up has one, and gives way to a catch-up', () => {
    m.spend.mockResolvedValue(spend())
    const { rerender } = render(<BrainSpend auto={auto({ catch_up: null, retag: { done: 40, total: 120 } })} />)
    expect(document.querySelector('[data-brain-spend-catchup]')!.textContent).toBe('Adding keywords to older memories: 40 / 120')
    rerender(<BrainSpend auto={auto({ catch_up: { kind: 'skipped', done: 1, total: 4 }, retag: { done: 40, total: 120 } })} />)
    expect(document.querySelector('[data-brain-spend-catchup]')!.textContent).toBe('Catching up on skipped text: 1 / 4 reads')
    rerender(<BrainSpend auto={auto({ catch_up: null, retag: { done: 120, total: 120 } })} />)
    expect(document.querySelector('[data-brain-spend-catchup]')).toBeNull()
    expect(retagLine(undefined)).toBeNull()
    expect(retagLine({ done: 0, total: 7 })).toBe('Adding keywords to older memories: 0 / 7')
  })

  it('shows the re-tag batches as one labelled row, never as a project', async () => {
    m.spend.mockResolvedValue(spend({ projects: [
      { project: 'acme-api', reads: 12, tokens: 60_000, cost_usd: 0.06, memories: 31 },
      { project: '', retag: true, reads: 3, tokens: 30_000, cost_usd: 0.03, memories: 120 },
      { project: '', reads: 2, tokens: 24_000, cost_usd: 0.02, memories: 3 },
    ] }))
    render(<BrainSpend auto={auto()} />)
    await screen.findByText(/of all your Claude tokens today/)
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-brain-spend-toggle]')!)
    const rows = Array.from(document.querySelectorAll('[data-brain-spend-projects] tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent))
    expect(rows).toEqual([['acme-api', '12', '60k', '31'], [RETAG_ROW, '3', '30k', '120'], ['No project', '2', '24k', '3']])
    expect(RETAG_ROW).toBe('Keywords for older memories')
    expect(document.querySelectorAll('[data-brain-spend-retag]')).toHaveLength(1)
  })

  it('opens the last 14 days: a bar a day against the limit, and reads, tokens and memories per project', async () => {
    m.spend.mockResolvedValue(spend())
    render(<BrainSpend auto={auto()} />)
    const toggle = document.querySelector<HTMLButtonElement>('[data-brain-spend-toggle]')!
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('[data-brain-spend-detail]')).toBeNull()
    await screen.findByText(/of all your Claude tokens today/)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('heading', { name: 'Last 14 days' })).toBeVisible()
    expect(document.querySelectorAll('[data-brain-spend-day]')).toHaveLength(14)
    expect(document.querySelector('[data-brain-spend-limit]')!.textContent).toBe('limit 300k')
    const rows = Array.from(document.querySelectorAll('[data-brain-spend-project]')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent))
    expect(rows).toEqual([['acme-api', '12', '60k', '31'], ['No project', '2', '24k', '3']])
    expect(document.querySelector('[data-brain-spend-cost]')!.textContent).toBe('$0.14 at API list price')
  })

  it('warns once the limit is reached', () => {
    m.spend.mockResolvedValue(spend())
    render(<BrainSpend auto={auto({ spent: 300_000 })} />)
    expect(document.querySelector('[data-brain-spend-bar] > div')!.className).toContain('bg-warn')
  })
})
