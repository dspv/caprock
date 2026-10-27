/**
 * The Pipeline's share card is anonymous unless the person asks: a board full
 * of identifying strings draws a card, a post and a caption with none of
 * them, and Show repo name adds the repository's name and nothing else.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asBoard, type PRBoard } from '@/lib/prboard'
import { ANON_REPO, paintPipelineCard, pipelineCardData, pipelineFilename, pipelinePostText, type Paint } from './PipelineShareCard'

const REPO = 'acme-corp/secret-payments'
const SECRETS = [REPO, 'acme-corp', 'secret-payments', 'Leak the SECRET pricing page', 'jane-secret-dev', 'feat/secret-branch',
  'v9.9.9-codename-falcon', 'Codename Falcon', '/Users/jane/secret', 'Jane’s refactor session']

function fixture(): PRBoard {
  const day = (i: number) => `2026-10-${String(i + 2).padStart(2, '0')}`
  const series = (f: (i: number) => number) => Array.from({ length: 14 }, (_, i) => ({ day: day(i), value: f(i), n: 1 }))
  return asBoard({
    default_branch: 'feat/secret-branch',
    cards: [{ number: 7, stage: 'fix', title: SECRETS[3], author: SECRETS[4], head: SECRETS[5], session_title: SECRETS[9], cwd: SECRETS[8],
      spend: { cost_usd: 3, sessions: 1, live: 0, agents: ['claude'] } }],
    releases: [{ tag: SECRETS[6], name: SECRETS[7], url: `https://github.com/${REPO}/releases`, published_at: 1, prs: [7], cost_usd: 3, sessions: 1 }],
    flow: {
      counts: { draft: 1, open: 2, fix: 1, ready: 3, merged: 0, released: 0 }, days: 14, merged: 41,
      ci_median_ms: 441_000, ttm_median_ms: 3 * 3600_000, ttm_count: 41, release_lag_median_ms: 86_400_000, release_lag_count: 9, cost_usd: 123.45,
      series: { flight: series((i) => i % 5), throughput: series((i) => i), ci: series(() => 441_000), ttm: series(() => 3600_000), lag: series(() => 1), cost: series((i) => i * 2) },
    },
  })!
}

/** Every word the painter draws. */
function words(board: PRBoard, show: boolean): string {
  const out: string[] = []
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: 'round', textAlign: 'left',
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, fill() {}, arc() {},
    measureText: (s: string) => ({ width: s.length * 6 }) as TextMetrics,
    fillText: (s: string) => { out.push(s) },
  } as unknown as Paint
  paintPipelineCard(g, pipelineCardData(board, REPO, show, new Date(2026, 9, 15)), 'dark')
  return out.join('\n')
}

describe('the Pipeline card', () => {
  it('names no repository, title, branch, author, release or path by default', () => {
    const board = fixture()
    const d = pipelineCardData(board, REPO, false, new Date(2026, 9, 15))
    const all = [words(board, false), pipelinePostText(d), pipelineFilename(d)].join('\n')
    for (const s of SECRETS) expect(all).not.toContain(s)
    expect(all).toContain(ANON_REPO)
    expect(all).toContain('caprock.dev')
  })

  it('adds the repository’s name, and only it, when Show repo name is ticked', () => {
    const board = fixture()
    const drawn = words(board, true)
    const text = pipelinePostText(pipelineCardData(board, REPO, true))
    for (const t of [drawn, text]) {
      expect(t).toContain(REPO)
      for (const s of SECRETS.slice(3)) expect(t).not.toContain(s)
    }
  })

  it('draws the eight figures as the page shows them, the window and the cost caveat', () => {
    const drawn = words(fixture(), false)
    for (const s of ['IN FLIGHT', 'NEEDS A FIX', 'READY', 'THROUGHPUT · 14D', 'CI MEDIAN', 'OPENED → MERGED', 'MERGED → RELEASED', 'AGENT COST',
      '2.9/day', '7m 21s', '$123.45', 'at API list price — not a bill', 'PIPELINE · LAST 14 DAYS', '2 OCT – 15 OCT 2026']) {
      expect(drawn).toContain(s)
    }
  })

  it('writes the post from figures that have a value', () => {
    expect(pipelinePostText(pipelineCardData(fixture(), REPO, false)))
      .toBe('a GitHub repo this fortnight: 2.9 PRs/day, CI median 7m 21s, opened → merged in 3h — via caprock.dev')
  })
})

// ------------------------------------------------------------- the sheet

const telegram = vi.fn()
const telegramPhoto = vi.fn(async (_png: string, _caption: string) => ({ sent: true }))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: {
    telegram: () => telegram(), telegramPhoto: (png: string, caption: string) => telegramPhoto(png, caption),
    shareCard: (png: string) => shareCard(png),
  },
}))
// caprock.dev unreachable unless a test says otherwise (ADR-086): the sheet falls back to the paste.
const shareCard = vi.fn(async (_png: string): Promise<unknown> => { throw new Error('offline') })
vi.mock('./PipelineShareCard', async (orig) => ({
  ...(await orig<typeof import('./PipelineShareCard')>()),
  drawPipelineCard: vi.fn(async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })),
}))

import { PipelineShareDialog } from './PipelineShare'

const write = vi.fn(async () => {})
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:card')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, Blob>) {} })
  Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
  write.mockClear()
  telegramPhoto.mockClear()
  telegram.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// The words are folded away behind Edit post text until asked for.
const words$ = () => {
  if (!screen.queryByLabelText('The words to post with the card')) fireEvent.click(screen.getByRole('button', { name: 'Edit post text' }))
  return (screen.getByLabelText('The words to post with the card') as HTMLTextAreaElement).value
}

describe('the Pipeline share sheet', () => {
  it('opens anonymous, says so, and the name follows the tick into the words', async () => {
    telegram.mockResolvedValue({ bot_set: false, chat_set: false, polling: false })
    render(<PipelineShareDialog board={fixture()} repo={REPO} onClose={() => {}} />)
    await screen.findByAltText("The Pipeline's figures, as they will be shared")
    const tick = screen.getByRole('checkbox') as HTMLInputElement
    expect(tick.checked).toBe(false)
    expect(words$()).not.toContain(REPO)
    expect(words$()).toMatch(/^a GitHub repo /)
    fireEvent.click(tick)
    expect(words$()).toMatch(new RegExp(`^${REPO} `))
    fireEvent.click(tick)
    expect(words$()).not.toContain(REPO)
  })

  it('without a paired chat, Send to my Telegram is Set up Telegram — and Telegram is still a choice', async () => {
    telegram.mockResolvedValue({ bot_set: true, chat_set: false, polling: false })
    render(<PipelineShareDialog board={fixture()} repo={REPO} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Set up Telegram' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send to my Telegram' })).toBeNull()
  })

  it('shows Telegram even when the bridge cannot be read at all', async () => {
    telegram.mockRejectedValue(new Error('down'))
    render(<PipelineShareDialog board={fixture()} repo={REPO} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Set up Telegram' })).toBeTruthy()
  })

  it('Send to my Telegram sends the card with the anonymous words as the caption', async () => {
    telegram.mockResolvedValue({ bot_set: true, chat_set: true, chat_name: 'Me', polling: false })
    render(<PipelineShareDialog board={fixture()} repo={REPO} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send to my Telegram' }))
    await waitFor(() => expect(telegramPhoto).toHaveBeenCalledTimes(1))
    const [png, caption] = telegramPhoto.mock.calls[0]!
    expect(png).toBe(btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)))
    expect(caption).not.toContain(REPO)
    expect(caption).toContain(ANON_REPO)
    expect(await screen.findByText('Sent to your Telegram (Me).')).toBeTruthy()
  })

  // It only copied the card and opened a chat picker; Copy image does the
  // copying (owner, 2026-10-25: the sheet was visual chaos).
  it('has no separate send-to-someone button', async () => {
    telegram.mockResolvedValue({ bot_set: false, chat_set: false, polling: false })
    render(<PipelineShareDialog board={fixture()} repo={REPO} onClose={() => {}} />)
    await screen.findByAltText("The Pipeline's figures, as they will be shared")
    expect(screen.queryByRole('button', { name: /someone/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy image' })).toBeTruthy()
  })

  it('posts to LinkedIn with the uploaded card’s link appended to the words', async () => {
    telegram.mockResolvedValue({ bot_set: false, chat_set: false, polling: false })
    shareCard.mockResolvedValueOnce({ id: 'p1', url: 'https://caprock.dev/c/p1', bytes: 4, at: 1 })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<PipelineShareDialog board={fixture()} repo={REPO} onClose={() => {}} />)
    await screen.findByAltText("The Pipeline's figures, as they will be shared")
    fireEvent.click(screen.getByRole('button', { name: 'Post to LinkedIn' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(new URL(open.mock.calls[0]![0] as string).searchParams.get('text')).toBe(`${words$()} https://caprock.dev/c/p1`)
    expect(write).not.toHaveBeenCalled()
    expect(await screen.findByText(/Post it: LinkedIn shows this card from the link/)).toBeTruthy()
  })

  it('posts to LinkedIn with the words, the card on the clipboard, when the upload fails', async () => {
    telegram.mockResolvedValue({ bot_set: false, chat_set: false, polling: false })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<PipelineShareDialog board={fixture()} repo={REPO} onClose={() => {}} />)
    await screen.findByAltText("The Pipeline's figures, as they will be shared")
    fireEvent.click(screen.getByRole('button', { name: 'Post to LinkedIn' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(new URL(open.mock.calls[0]![0] as string).searchParams.get('text')).toBe(words$())
    expect(await screen.findByText(/In the LinkedIn post, click the text and press (⌘V|Ctrl\+V): the card appears\./)).toBeTruthy()
  })
})
