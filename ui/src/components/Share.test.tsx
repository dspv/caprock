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
      shareCard: (png: string) => cards.share(png),
      removeSharedCard: (id: string) => cards.remove(id),
    },
  }
})
// caprock.dev as the daemon reports it (POST /v1/share/card, ADR-086): the
// upload is never real in a test.
const cards = vi.hoisted(() => ({
  share: (() => Promise.resolve({ id: 'abc123', url: 'https://caprock.dev/c/abc123', bytes: 3, at: 1 })) as (png: string) => Promise<unknown>,
  remove: (() => Promise.resolve({ removed: true })) as (id: string) => Promise<unknown>,
}))
vi.mock('@/lib/cardimage', () => ({ renderCardPNG: vi.fn(async () => new Blob(['png'], { type: 'image/png' })) }))

import { ShareCard, ShareDialog, xIntent } from './Share'
import { ApiError } from '@/lib/api'
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
  shared.length = 0
  removed.length = 0
  cards.share = async (png) => { shared.push(png); return { id: 'abc123', url: 'https://caprock.dev/c/abc123', bytes: 3, at: 1 } }
  cards.remove = async (id) => { removed.push(id); return { removed: true } }
})
const shared: string[] = []
const removed: string[] = []
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

  // The chosen card goes up to caprock.dev and the post links to it, so the
  // link's preview is that card and nothing is pasted (owner, 2026-10-27).
  it('posts to X with the words and the uploaded card’s link, nothing on the clipboard', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Post to X' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const url = new URL(String(open.mock.calls[0]![0]))
    expect(url.searchParams.get('text')).toMatch(/^My agents shipped 48 PRs this week\./)
    expect(url.searchParams.get('text')).toMatch(/Claude Code, tracked on my own machine with Caprock/)
    expect(url.searchParams.get('url')).toBe('https://caprock.dev/c/abc123')
    // The exact PNG the sheet drew, base64 ('png' is cG5n).
    expect(shared).toEqual(['cG5n'])
    expect(write).not.toHaveBeenCalled()
    expect(await screen.findByText(/Post it: X shows this card from the link\. Nothing to paste\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'caprock.dev/c/abc123' })).toHaveAttribute('href', 'https://caprock.dev/c/abc123')
  })

  it('appends the link to the Threads text', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Post to Threads' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const url = new URL(String(open.mock.calls[0]![0]))
    expect(url.origin + url.pathname).toBe('https://www.threads.com/intent/post')
    expect(url.searchParams.get('text')).toMatch(/Caprock — free and open source\. https:\/\/caprock\.dev\/c\/abc123$/)
  })

  it('removes the shared picture from the box after posting, and says the site may keep its copy', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Post to Threads' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the shared picture' }))
    expect(await screen.findByText('Removed from caprock.dev. Threads may keep the preview it already fetched.')).toBeTruthy()
    expect(removed).toEqual(['abc123'])
  })

  // The owner shares his week on X and Threads (2026-10-25): with no upload,
  // today's way — the chosen card on the clipboard and the steps to paste it.
  it('falls back to the clipboard and the paste steps when the upload fails, and says so in one line', async () => {
    cards.share = async () => { throw new ApiError(429, '429 Too Many Requests', { error: 'caprock.dev asked to wait' }) }
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await card()
    fireEvent.click(screen.getByRole('button', { name: 'Post to Threads' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const url = new URL(String(open.mock.calls[0]![0]))
    expect(url.searchParams.get('text')).toMatch(/Caprock/)
    expect(url.searchParams.get('text')).not.toMatch(/https?:/)
    expect(write).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/In the Threads post, click the text and press (⌘V|Ctrl\+V): the card appears\./)).toBeTruthy()
    expect(screen.getByText('The upload to caprock.dev failed (too many pictures shared just now), so paste the card into the post instead.')).toBeTruthy()
  })

  it('never uploads from Copy image, Save image or Share…', async () => {
    const nav = navigator as unknown as Record<string, unknown>
    const origShare = nav.share
    const origCan = nav.canShare
    nav.canShare = () => true
    nav.share = async () => {}
    try {
      render(<ShareDialog onClose={() => {}} />)
      await card()
      fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
      fireEvent.click(screen.getByRole('button', { name: 'Save image' }))
      await screen.findByText('Saved to your downloads.')
      fireEvent.click(screen.getByRole('button', { name: /^share…$/i }))
      await waitFor(() => expect(screen.getByRole('button', { name: /^share…$/i })).not.toBeDisabled())
      expect(shared).toEqual([])
    } finally {
      nav.share = origShare
      nav.canShare = origCan
    }
  })

  it('names the upload on the buttons that make it', async () => {
    render(<ShareDialog onClose={() => {}} />)
    await card()
    expect(screen.getByRole('button', { name: 'Post to X' }).getAttribute('title')).toMatch(/^Uploads this picture to caprock\.dev so the post shows it/)
    expect(screen.getByRole('button', { name: 'Copy image' }).getAttribute('title')).not.toMatch(/caprock\.dev/)
  })

  it('keeps the paste on a paired device: the upload is the machine’s', async () => {
    localStorage.setItem('caprock.device.token', 'tok')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ShareDialog onClose={() => {}} />)
    await card()
    expect(screen.getByRole('button', { name: 'Post to X' }).getAttribute('title')).toMatch(/paste it into the post/)
    fireEvent.click(screen.getByRole('button', { name: 'Post to X' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(shared).toEqual([])
    expect(write).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/upload to caprock\.dev failed/)).toBeNull()
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
    expect(within(dialog).getByText('Totals only, no names or paths. Drawn on your machine; only X, Threads and LinkedIn upload it, to caprock.dev.')).toBeTruthy()
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

  it('puts no link and no dollars into the post text', () => {
    const url = new URL(xIntent('7d'))
    // No link of the words' own: the only link a post carries is the
    // uploaded card's, whose preview is the card; caprock.dev's home page
    // would bring the site's preview in its place.
    expect(url.searchParams.get('url')).toBeNull()
    expect(url.searchParams.get('text')).not.toMatch(/\$|https?:/)
  })
})

describe('the share button', () => {
  it('opens the sheet and says the same thing whatever the figures are', async () => {
    render(<ShareCard />)
    fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})
