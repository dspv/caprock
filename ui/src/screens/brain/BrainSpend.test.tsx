import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({ spend: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, brainSpend: m.spend } }
})

import type { BrainAutoStatus, BrainSpend as Spend } from '@/lib/api'
import { dayName } from '@/components/BarChart'
import { BrainSpend, catchUpLine, gridLabel, RETAG_ROW, retagLine, rowShares, spendShare, spendStacks, spendTop, TOP_ROWS } from './BrainSpend'

const auto = (over: Partial<BrainAutoStatus> = {}): BrainAutoStatus => ({
  chosen: true, on: true, enabled: true, claude_found: true, model: 'haiku', daily_tokens: 300_000, spent: 84_000, running: false, pending: 0, recent: [], ...over,
})
const days = (n = 14): Spend['days'] => Array.from({ length: n }, (_, i) => ({
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
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-brain-spend-more]')!)
    const rows = Array.from(document.querySelectorAll('[data-brain-spend-projects] tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent))
    expect(rows).toEqual([['acme-api', '12', '60.0k', '', '31'], [RETAG_ROW, '3', '30.0k', '', '120'], ['No project', '2', '24.0k', '', '3']])
    expect(RETAG_ROW).toBe('Keywords for older memories')
    expect(document.querySelectorAll('[data-brain-spend-retag]')).toHaveLength(1)
  })

  it('opens the last 14 days: the Dashboard’s figures, a bar a day against the limit, the top projects, every project one click on', async () => {
    m.spend.mockResolvedValue(spend())
    render(<BrainSpend auto={auto()} />)
    const toggle = document.querySelector<HTMLButtonElement>('[data-brain-spend-toggle]')!
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('[data-brain-spend-detail]')).toBeNull()
    await screen.findByText(/of all your Claude tokens today/)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('heading', { name: 'Last 14 days' })).toBeVisible()
    // The figures, in the Dashboard's Stat tiles.
    const fig = (name: string) => document.querySelector(`[data-stat="brain-spend-${name}"]`)!.textContent
    // 0 + 10k + … + 120k, and today's 84k: 864k over the 14 days.
    expect(fig('tokens')).toBe('Tokens, 14 days864.0k61.7k a day on average')
    expect(fig('cost')).toContain('$0.14')
    expect(fig('today')).toBe('Today84.0kof 300k a day · 28%')
    expect(fig('reads')).toBe('Reads9134 memories kept')
    expect(document.querySelectorAll('[data-brain-spend-day]')).toHaveLength(14)
    expect(document.querySelector('[data-brain-spend-limit]')!.textContent).toBe('limit 300k')
    // The top: the leader's share large, a row each, no rest to fold.
    const top = document.querySelector('[data-brain-spend-top]')!
    expect(top.textContent).toContain('71%acme-api of the tokens')
    expect(document.querySelector('[data-brain-spend-more]')!.textContent).toContain('Reads and memories per project')
    expect(document.querySelector('[data-brain-spend-projects]')).toBeNull()
    fireEvent.click(document.querySelector('[data-brain-spend-more]')!)
    const rows = Array.from(document.querySelectorAll('[data-brain-spend-project]')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent))
    expect(rows).toEqual([['acme-api', '12', '60.0k', '', '31'], ['No project', '2', '24.0k', '', '3']])
    // An older daemon lists no parts: plain bars, no swatches, the row bars still drawn.
    expect(document.querySelector('[data-brain-spend-chart]')).toHaveAttribute('data-brain-spend-chart', 'plain')
    expect(document.querySelectorAll('[data-brain-spend-seg]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-brain-spend-swatch]')).toHaveLength(0)
    expect(Array.from(document.querySelectorAll('[data-brain-spend-rowbar]')).map((b) => b.getAttribute('data-brain-spend-rowbar'))).toEqual(['1.000', '0.400'])
  })

  it('stacks each day by project, with the same colours before the names and a tooltip per segment', async () => {
    const d = days()
    const part = (project: string, tokens: number, retag?: boolean) => ({ project, tokens, ...(retag ? { retag } : {}) })
    // Over 14 days: acme-api 500k, web 300k, docs 100k, tiny 2k, re-tag 50k.
    d.forEach((x) => { x.tokens = 0; x.projects = [] })
    d[10]!.projects = [part('acme-api', 200_000), part('web', 100_000), part('tiny', 2_000)]
    d[10]!.tokens = 302_000
    d[11]!.projects = [] // a day with nothing read
    d[12]!.projects = [part('acme-api', 300_000), part('web', 200_000), part('docs', 100_000), part('', 50_000, true)]
    d[12]!.tokens = 650_000
    m.spend.mockResolvedValue(spend({ days: d, projects: [
      { project: 'acme-api', reads: 9, tokens: 500_000, cost_usd: 0.5, memories: 40 },
      { project: 'web', reads: 5, tokens: 300_000, cost_usd: 0.3, memories: 20 },
      { project: 'docs', reads: 2, tokens: 100_000, cost_usd: 0.1, memories: 5 },
      { project: '', retag: true, reads: 1, tokens: 50_000, cost_usd: 0.05, memories: 30 },
      { project: 'tiny', reads: 1, tokens: 2_000, cost_usd: 0.002, memories: 1 },
    ] }))
    render(<BrainSpend auto={auto()} />)
    await screen.findByText(/of all your Claude tokens today/)
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-brain-spend-toggle]')!)
    // The top five wear the bars' colours; the tail past them is one line.
    expect(document.querySelector('[data-brain-spend-top]')!.textContent).toContain('52%acme-api of the tokens')
    expect(document.querySelector('[data-brain-spend-more]')!.textContent).toBe('›Reads and memories per project')
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-brain-spend-more]')!)
    expect(document.querySelector('[data-brain-spend-overdays]')!.textContent).toBe('2 days over the limit')
    expect(document.querySelector('[data-brain-spend-chart]')).toHaveAttribute('data-brain-spend-chart', 'stacked')
    const segs = (day: string) => Array.from(document.querySelectorAll(`[data-brain-spend-day="${day}"] [data-brain-spend-seg]`)).map((s) => s.getAttribute('data-brain-spend-seg'))
    expect(segs(d[12]!.day)).toEqual(['acme-api', 'web', 'docs', 'other'])
    expect(segs(d[10]!.day)).toEqual(['acme-api', 'web', 'other'])
    expect(segs(d[11]!.day)).toEqual([])
    // Over the 300k limit: a marker over the stack, the colours kept.
    expect(document.querySelectorAll('[data-brain-spend-overmark]')).toHaveLength(2)
    expect(document.querySelector(`[data-brain-spend-day="${d[12]!.day}"]`)!.getAttribute('aria-label')).toContain('over the daily limit')
    // The swatches: the top three their slot, the tail and the re-tag row Other.
    expect(Array.from(document.querySelectorAll('[data-brain-spend-swatch]')).map((s) => s.getAttribute('data-brain-spend-swatch'))).toEqual(['0', '1', '2', '-1', '-1'])
    expect(document.querySelector<HTMLElement>('[data-brain-spend-swatch="0"]')!.style.background).toBe('var(--spend-1)')
    fireEvent.mouseEnter(document.querySelector(`[data-brain-spend-day="${d[12]!.day}"] [data-brain-spend-seg="web"]`)!)
    expect(document.querySelector('[data-brain-spend-tip]')!.textContent).toBe(`web · ${dayName(d[12]!.day)} · 200k tokens`)
    fireEvent.mouseEnter(document.querySelector(`[data-brain-spend-day="${d[12]!.day}"] [data-brain-spend-seg="other"]`)!)
    expect(document.querySelector('[data-brain-spend-tip]')!.textContent).toBe(`Other · ${dayName(d[12]!.day)} · 50k tokens`)
    // The focus reads the whole day, top part first.
    fireEvent.focus(document.querySelector(`[data-brain-spend-day="${d[10]!.day}"]`)!)
    expect(Array.from(document.querySelector('[data-brain-spend-tip]')!.children).map((c) => c.textContent)).toEqual([
      `${dayName(d[10]!.day)}: 302.0k tokens, 10 reads, over the daily limit`, 'Other · 2k', 'web · 100k', 'acme-api · 200k',
    ])
  })
})

describe('grouping the days into stacks', () => {
  const day = (projects?: { project: string; retag?: boolean; tokens: number }[]) => ({ day: '2026-10-01', start: 0, tokens: 0, cost_usd: 0, reads: 0, projects })

  it('keeps the three largest over the window in a stable order, the rest one Other on top', () => {
    const s = spendStacks([
      day([{ project: 'b', tokens: 10 }, { project: 'a', tokens: 5 }, { project: 'e', tokens: 1 }]),
      day([{ project: 'c', tokens: 30 }, { project: 'a', tokens: 20 }, { project: 'd', tokens: 2 }, { project: '', retag: true, tokens: 99 }]),
    ])!
    expect(s.top).toEqual(['c', 'a', 'b'])
    // The largest at the bottom every day, whatever led that day.
    expect(s.days[0]).toEqual([{ key: 'a', slot: 1, tokens: 5 }, { key: 'b', slot: 2, tokens: 10 }, { key: '', slot: -1, tokens: 1 }])
    expect(s.days[1]).toEqual([{ key: 'c', slot: 0, tokens: 30 }, { key: 'a', slot: 1, tokens: 20 }, { key: '', slot: -1, tokens: 101 }])
  })

  it('breaks a tie by name, so the colours never swap between reads', () => {
    const a = spendStacks([day([{ project: 'zeta', tokens: 7 }, { project: 'alpha', tokens: 7 }, { project: 'mid', tokens: 7 }, { project: 'beta', tokens: 7 }])])!
    const b = spendStacks([day([{ project: 'beta', tokens: 7 }, { project: 'mid', tokens: 7 }, { project: 'alpha', tokens: 7 }, { project: 'zeta', tokens: 7 }])])!
    expect(a.top).toEqual(['alpha', 'beta', 'mid'])
    expect(b.top).toEqual(a.top)
  })

  it('keeps "No project" as a project, the re-tag batches never, and empty days empty', () => {
    const s = spendStacks([day([]), day([{ project: '', tokens: 4 }, { project: '', retag: true, tokens: 40 }, { project: 'x', tokens: 0 }])])!
    expect(s.top).toEqual([''])
    expect(s.days[0]).toEqual([])
    expect(s.days[1]).toEqual([{ key: '', slot: 0, tokens: 4 }, { key: '', slot: -1, tokens: 40 }])
  })

  it('is null for an older daemon that lists no parts, or no days', () => {
    expect(spendStacks([day(undefined), day([])])).toBeNull()
    expect(spendStacks([])).toBeNull()
  })

  it('sizes the row bars against the largest row', () => {
    expect(rowShares([{ tokens: 1_093_000 }, { tokens: 849_000 }, { tokens: 0 }, { tokens: 1 }])).toEqual([1, 849_000 / 1_093_000, 0, 1 / 1_093_000])
    expect(rowShares([{ tokens: 0 }])).toEqual([0])
    expect(rowShares([])).toEqual([])
  })

  it('names the top five by tokens in the bars’ colours, the rest summed, shares of the whole window', () => {
    const p = (project: string, tokens: number, retag?: boolean) => ({ project, tokens, reads: 1, cost_usd: 0, memories: 0, ...(retag ? { retag } : {}) })
    const projects = [p('f', 50), p('a', 400), p('b', 200), p('', 30, true), p('c', 150), p('d', 100), p('e', 60), p('z', 0)]
    const stacks = spendStacks([{ day: '2026-10-01', start: 0, tokens: 0, cost_usd: 0, reads: 0, projects }])
    const t = spendTop(projects, stacks)
    expect(TOP_ROWS).toBe(5)
    expect(t.total).toBe(990)
    expect(t.rows.map((r) => [r.key, r.label, r.color])).toEqual([
      ['a', 'a', 'var(--spend-1)'], ['b', 'b', 'var(--spend-2)'], ['c', 'c', 'var(--spend-3)'],
      ['d', 'd', 'var(--spend-other)'], ['e', 'e', 'var(--spend-other)'],
    ])
    expect(t.rest).toEqual({ count: 2, tokens: 80 })
    // Without the daemon's parts no colour is the project's own.
    expect(spendTop(projects, null).rows[0]!.color).toBeUndefined()
    expect(spendTop([], null)).toEqual({ rows: [], total: 0, rest: { count: 0, tokens: 0 } })
  })

  it('fills the top’s whole bar to 100%, the projects past the five in grey, and folds them into one line', async () => {
    const p = (project: string, tokens: number) => ({ project, reads: 1, tokens, cost_usd: 0, memories: 0 })
    m.spend.mockResolvedValue(spend({ projects: [p('a', 400), p('b', 200), p('c', 150), p('d', 100), p('e', 60), p('f', 50), p('g', 40)] }))
    render(<BrainSpend auto={auto()} />)
    await screen.findByText(/of all your Claude tokens today/)
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-brain-spend-toggle]')!)
    const rest = document.querySelector<HTMLElement>('[data-brain-spend-top] [data-share-rest]')!
    // 90 of 1,000 tokens.
    expect(rest.style.width).toBe('9%')
    expect(rest.style.background).toBe('var(--spend-other)')
    expect(document.querySelector('[data-brain-spend-more]')!.textContent).toBe('›and 2 more · 90 · 9%')
  })

  it('labels the ruler short', () => {
    expect([gridLabel(200_000), gridLabel(1_000_000), gridLabel(1_500_000), gridLabel(500)]).toEqual(['200k', '1M', '1.5M', '500'])
  })

  it('warns once the limit is reached', () => {
    m.spend.mockResolvedValue(spend())
    render(<BrainSpend auto={auto({ spent: 300_000 })} />)
    expect(document.querySelector('[data-brain-spend-bar] > div')!.className).toContain('bg-warn')
  })
})
