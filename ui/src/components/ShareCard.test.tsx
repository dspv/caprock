/**
 * The card leaves the machine by design — someone posts it — so what it says
 * has to survive a stranger reading it without context. Two rules matter: the
 * caveat travels with the figure (Rule 6), and nothing identifying travels at
 * all.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { cardFilename, collectCardData, drawShareCard, PERIOD_LABEL } from './ShareCard'
import { ShareCard } from './Share'
import type { History } from '@/lib/api'

const data = vi.hoisted(() => ({ value: undefined as unknown }))
const drawn = vi.hoisted(() => ({ text: [] as string[] }))
const calls = vi.hoisted(() => ({ n: 0 }))

/** A distinct cost per range, so a card drawing the wrong one is visible. */
const RANGE_COST = vi.hoisted(() => ({ today: 11, '7d': 22, '30d': 33 }) as Record<string, number>)

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
      history: async () => { calls.n++; return data.value },
      // Answers per range. Ignoring the argument here is what let the card
      // draw a month's breakdown under a week's heading without any test
      // noticing: every range returned the same object.
      // Answers per range. Ignoring the argument here is what let the card
      // draw a month's breakdown under a week's heading without any test
      // noticing: every range returned the same object. The model ids come
      // from the fixture, so a test that sets one still sees it.
      summary: async (range: string) => ({
        ...summary,
        models: summary.models.map((m) => ({ ...m, cost_usd: RANGE_COST[range] ?? m.cost_usd })),
        work: summary.work.map((w) => ({ ...w, cost_usd: RANGE_COST[range] ?? w.cost_usd })),
      }) as never,
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
  // Must call back, or every await on drawShareCard hangs to the timeout.
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(new Blob()))
}

describe('ShareCard', () => {
  it('carries the caveat with the figure', async () => {
    data.value = history()
    stubCanvas()
    await drawShareCard(await collectCardData())

    const all = drawn.text.join(' ')
    // The all-time figure, which is the one the card leads its tiles with.
    expect(all).toContain('$10,845.61')
    // A dollar figure posted without this reads as a bill someone paid.
    expect(all).toMatch(/not a bill/i)
    expect(all).toMatch(/not money saved/i)
  })

  it('asks the reader what theirs is', async () => {
    // The loop this product grows by is: see somebody's figure, want your
    // own, install, post yours. The card carried a number and a domain and
    // started none of it — a reader saw someone else's total with no reason
    // to think it was a thing they could do too.
    data.value = history()
    stubCanvas()
    await drawShareCard(await collectCardData())

    const all = drawn.text.join(' ')
    expect(all).toMatch(/what's yours/i)
    // A question, not a command: an install line on a picture is an
    // advertisement and reads as one. The domain in the heading is where
    // someone who wonders goes to find out.
    expect(all).not.toMatch(/brew install/i)
  })

  it('states no multiple, which it cannot compute from these figures', async () => {
    data.value = history()
    stubCanvas()
    await drawShareCard(await collectCardData())

    // The endpoint reports active days, not the window's calendar span, so a
    // multiple built here divided 59 days of plan into 95 days of usage and
    // printed 27.6x where every other surface said 17.1x.
    expect(drawn.text.join(' ')).not.toMatch(/\d+(\.\d+)?×/)
  })

  it('puts no project or session names on an image meant to be posted', async () => {
    data.value = history()
    stubCanvas()
    await drawShareCard(await collectCardData())

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
    await drawShareCard(await collectCardData())

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
    await drawShareCard(await collectCardData())

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

/**
 * One press, one card.
 *
 * The dialog had a single `busy` flag doing two jobs: labelling the button
 * "drawing…" and disabling it. Clearing it early — so the label would stop
 * lying while the OS share sheet sat open — also re-enabled the button
 * underneath that sheet, and the owner got two images out of one share.
 *
 * Counted at the API rather than at the canvas: jsdom has no 2d context, so
 * drawing bails before it ever reaches `toBlob` and a canvas-level counter
 * stays at zero no matter how many times the button is pressed — green for
 * the wrong reason. Every press calls `history` exactly once, so that is the
 * honest place to count presses that got through.
 */
describe('the share dialog', () => {
  it('starts one draw however fast the button is pressed', async () => {
    data.value = history()
    calls.n = 0
    render(<ShareCard />)
    fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))
    // The mounted button itself fetches history once; count only from here.
    const before = calls.n
    const save = await screen.findByRole('button', { name: /save the image/i })
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.click(save)
    await waitFor(() => expect(calls.n).toBeGreaterThan(before))
    // One press = one build(), and build() makes exactly two history calls
    // (the card's own collection plus the caption's totals). Three presses
    // through an unguarded button would be six.
    expect(calls.n - before).toBe(2)
  })
})

/**
 * The native share sends the picture and nothing else. Pairing `files` with
 * `text` let the receiving app decide what two payloads mean, and the macOS
 * share sheet's Copy resolved it as two items — the owner got the card twice.
 */
describe('the native share', () => {
  it('hands over the file alone, never a file plus a caption', async () => {
    data.value = history()
    const shared: unknown[] = []
    const nav = navigator as unknown as Record<string, unknown>
    const origShare = nav.share
    const origCan = nav.canShare
    nav.canShare = () => true
    nav.share = async (payload: unknown) => { shared.push(payload) }

    render(<ShareCard />)
    fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))
    fireEvent.click(await screen.findByRole('button', { name: /send it somewhere/i }))
    await waitFor(() => expect(shared.length).toBe(1))

    const payload = shared[0] as { files?: unknown[]; text?: string }
    expect(payload.files?.length).toBe(1)
    expect(payload.text).toBeUndefined()

    nav.share = origShare
    nav.canShare = origCan
  })
})

/**
 * The privacy claims survive a rewrite.
 *
 * They are the reason someone is willing to post the card at all, and they sit
 * in the one part of this dialog that gets reworded whenever the copy is
 * tightened — which is exactly how the card's "not a bill" caveat was lost
 * once already.
 */
describe('the share dialog’s guarantees', () => {
  it('still says what does and does not leave the machine', async () => {
    data.value = history()
    render(<ShareCard />)
    fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/totals only/i)
    expect(dialog.textContent).toMatch(/no names/i)
    expect(dialog.textContent).toMatch(/nothing claude wrote/i)
    expect(dialog.textContent).toMatch(/uploaded nowhere/i)
  })
})

/**
 * The picker was removed once, on the reasoning that a card showing today, the
 * week, the month and all time at once made choosing redundant. It does not:
 * somebody sharing a working week does not want their lifetime total to be the
 * headline, and a card that answers four questions answers none of them
 * loudly.
 */
describe('the period a card is about', () => {
  it('names the stretch in the heading, so a card out of context still says what it is', () => {
    // "My stats on caprock.dev" beside four periods is a shrug. "My week on
    // caprock.dev" is a claim.
    expect(PERIOD_LABEL['7d']).toBe('this week')
    expect(PERIOD_LABEL['30d']).toBe('this month')
    expect(PERIOD_LABEL.today).toBe('today')
    expect(PERIOD_LABEL.all).toBe('all time')
  })

  it('carries the choice into the data, not only into the dialog', async () => {
    // A picker that does not reach the drawing is a control that lies.
    const d = await collectCardData('7d')
    expect(d.period).toBe('7d')
  })

  it('defaults to all time when nobody chose', async () => {
    const d = await collectCardData()
    expect(d.period).toBe('all')
  })

  it('still gathers every period, whichever one is chosen', async () => {
    // The other figures are context, not competition: a week means nothing
    // without knowing whether it was a normal one.
    const d = await collectCardData('today')
    expect(d.week).toBeDefined()
    expect(d.month).toBeDefined()
    expect(d.allTime).toBeDefined()
  })
})

describe('the card is about the period it names', () => {
  // A card headed "My week on Caprock" carried the last thirty days' models
  // and work under it: `collectCardData` fetched four ranges and then read the
  // breakdowns out of the 30-day one whatever was chosen. On this machine that
  // was five models and $5,473 of Opus against the one model and $1,936 that
  // the week actually ran — the heading naming one stretch, the chart drawing
  // another.
  it('draws the chosen period\'s breakdown, not always the month\'s', async () => {
    stubCanvas()
    await drawShareCard(await collectCardData('today'))
    // $11 is the today fixture; $33 is the month's.
    expect(drawn.text.some((t) => t.includes('$11'))).toBe(true)
    expect(drawn.text.some((t) => t.includes('$33'))).toBe(false)

    stubCanvas()
    await drawShareCard(await collectCardData('7d'))
    expect(drawn.text.some((t) => t.includes('$22'))).toBe(true)
    expect(drawn.text.some((t) => t.includes('$33'))).toBe(false)
  })

  it('says so when an all-time card shows the month, because there is no all-time split', async () => {
    stubCanvas()
    await drawShareCard(await collectCardData('all'))
    expect(drawn.text.some((t) => t.includes('LAST 30 DAYS'))).toBe(true)
  })

  it('leaves the heading unqualified when the breakdown is the period asked for', async () => {
    stubCanvas()
    await drawShareCard(await collectCardData('7d'))
    expect(drawn.text.some((t) => t.includes('LAST 30 DAYS'))).toBe(false)
  })
})
