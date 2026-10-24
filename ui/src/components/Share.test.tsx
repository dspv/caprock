/**
 * The share sheet: one card, the same headline figures in landscape and
 * portrait, on screen before any button is pressed; two rows of ways out,
 * each doing what its label says; one line about what leaves the machine.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const plan = vi.hoisted(() => ({ kind: '' as string, label: '', usd: 0 }))
const asked = vi.hoisted(() => ({ periods: [] as string[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      // One week per period, so a card for the wrong period shows.
      weekFor: async (period: string) => {
        asked.periods.push(period)
        return {
          period, start: '2026-10-19', end: '2026-10-25', partial: true, from_ms: 0, to_ms: 0,
          days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${19 + i}`, prs_opened: i, cost_usd: 200, active: true })),
          sessions: 556, scheduled_sessions: 480, active_days: 7, turns: 9000, cost_usd: 1540, models: [],
          prs_opened: 54, prs_merged: period === 'today' ? 2 : 48, prs_source: 'github', merges_unresolved: 0,
          commits: 120, files_edited: 300, lines_added: 9000, lines_removed: 100, ci_wait_ms: 0, tool_ms: 0,
          cost_per_merged_pr: 21.5,
          agents: [{ agent: 'claude', subagent: false, turns: 9000, cost_usd: 1540, sessions: 556 }],
          estimates: ['lines_added', 'lines_removed', 'cost_per_merged_pr'],
        }
      },
      settings: async () => ({ plan_kind: plan.kind, plan_label: plan.label, plan_usd_per_month: plan.usd }),
      telegram: async () => ({ bot_set: false, chat_set: false, polling: false }),
      history: async () => ({ totals: { sessions: 10, cost_usd: 100, days: 3 } }),
    },
  }
})
vi.mock('@/lib/cardimage', () => ({ renderCardPNG: vi.fn(async () => new Blob(['png'], { type: 'image/png' })) }))

import { ShareCard, ShareDialog, xIntent } from './Share'
import { resetShareCache } from '@/lib/sharecache'

const write = vi.fn(async () => {})

beforeEach(() => {
  plan.kind = ''; plan.label = ''; plan.usd = 0
  asked.periods = []
  resetShareCache()
  localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:card')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, Blob>) {} })
  Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
  write.mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const card = () => screen.findByRole('img', { name: /PRs merged/ })

describe('ShareDialog', () => {
  it('shows one card for the period, with no style switch', async () => {
    render(<ShareDialog onClose={() => {}} />)
    const c = await card()
    expect(c.textContent).toContain('48')
    expect(c.textContent).toContain('PRs merged')
    expect(c.textContent).toContain('≈$22')
    expect(c.textContent).toContain('PRs from GitHub')
    expect(c.textContent).toContain('556 hand-run sessions')
    for (const label of ['today', 'this week', 'this month', 'all time']) expect(screen.getByRole('button', { name: label })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'this week' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /^figures$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^story$/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'today' }))
    await waitFor(() => expect(screen.getByRole('img', { name: /PRs merged/ }).textContent).toContain('2PRs merged'))
  })

  it('says the same headline figures in landscape and portrait', async () => {
    plan.kind = 'flat'; plan.label = 'Max'; plan.usd = 200
    render(<ShareDialog onClose={() => {}} />)
    await waitFor(async () => expect((await card()).textContent).toContain('33×'))
    const heads = () => [...document.querySelectorAll('.wk-fig')].map((n) => n.textContent)
    const land = heads()
    expect(land).toEqual(['33×', '48'])
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }))
    await waitFor(() => expect(document.querySelector('.wk-port')).not.toBeNull())
    expect(heads()).toEqual(land)
    expect(document.querySelector('.wk-port')!.textContent).toContain('the $200/mo Max plan, at API list prices')
  })

  it('opens on the period it was asked for', async () => {
    render(<ShareDialog onClose={() => {}} initialPeriod="all" />)
    await card()
    expect(screen.getByRole('button', { name: 'all time' })).toHaveAttribute('aria-pressed', 'true')
    expect(asked.periods).toEqual(['all'])
  })

  it('copies the image to the clipboard and says so beside the buttons', async () => {
    render(<ShareDialog onClose={() => {}} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Copied — paste it anywhere.')).toBeTruthy()
  })

  it('posts to X with words and the site, and the card on the clipboard', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Post to X' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open.mock.calls[0]![0]).toBe(xIntent('7d'))
    expect(write).toHaveBeenCalledTimes(1)
  })

  // The owner shares his week on X and Threads (2026-10-25).
  it('posts to Threads with the words and the site, and the card on the clipboard', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Post to Threads' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const url = new URL(String(open.mock.calls[0]![0]))
    expect(url.origin + url.pathname).toBe('https://www.threads.com/intent/post')
    expect(url.searchParams.get('text')).toMatch(/Caprock.*https:\/\/caprock\.dev$/)
    expect(write).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Threads is open — paste the card in.')).toBeTruthy()
  })

  it('offers my Telegram (or its setup) among the destinations, and no copy-only Telegram button', async () => {
    render(<ShareDialog onClose={() => {}} />)
    await card()
    expect(await screen.findByRole('button', { name: 'Set up Telegram' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Post to LinkedIn' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /someone/i })).toBeNull()
  })

  it('folds the post text away until asked for', async () => {
    render(<ShareDialog onClose={() => {}} />)
    await card()
    expect(screen.queryByLabelText('The words to post with the card')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit post text' }))
    expect((screen.getByLabelText('The words to post with the card') as HTMLTextAreaElement).value).toMatch(/Caprock/)
  })

  it('says what leaves the machine in one line, and nothing twice', async () => {
    render(<ShareDialog onClose={() => {}} />)
    const c = await card()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Totals only, no names or paths. Drawn on your machine, uploaded nowhere.')).toBeTruthy()
    // "not a bill" is on the card itself, not repeated under it.
    const outside = (dialog.textContent ?? '').replace(c.textContent ?? '', '')
    expect(outside).not.toMatch(/not a bill/)
    expect(outside).not.toMatch(/1200×630/)
  })

  it('hands the native share the file alone, never a file plus a caption', async () => {
    const shared: unknown[] = []
    const nav = navigator as unknown as Record<string, unknown>
    const origShare = nav.share
    const origCan = nav.canShare
    nav.canShare = () => true
    nav.share = async (payload: unknown) => { shared.push(payload) }
    try {
      render(<ShareDialog onClose={() => {}} />)
      await card()
      fireEvent.click(screen.getByRole('button', { name: /^share…$/i }))
      await waitFor(() => expect(shared.length).toBe(1))
      const payload = shared[0] as { files?: unknown[]; text?: string }
      expect(payload.files?.length).toBe(1)
      expect(payload.text).toBeUndefined()
    } finally {
      nav.share = origShare
      nav.canShare = origCan
    }
  })

  it('puts no figure into the post text — the card carries them with their caveat', () => {
    const url = new URL(xIntent('7d'))
    expect(url.searchParams.get('url')).toBe('https://caprock.dev')
    expect(url.searchParams.get('text')).not.toMatch(/\d/)
  })
})

describe('the share button', () => {
  it('opens the sheet and says the same thing whatever the figures are', async () => {
    render(<ShareCard />)
    fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})
