/**
 * The card leaves the machine by design — someone posts it — so what it says
 * has to survive a stranger reading it without context. Two rules matter: the
 * caveat travels with the figure (Rule 6), and nothing identifying travels at
 * all.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cardFilename, collectCardData, drawShareCard, heroOf, mixOf, PERIOD_LABEL, type CardData } from './ShareCard'
import { ShareCard } from './Share'
import type { History } from '@/lib/api'
import { resetShareCache } from '@/lib/sharecache'

// The dialog keeps the last figures per period, in memory and in
// localStorage; every test starts from a dialog that has never drawn.
beforeEach(() => {
  plan.kind = ''; plan.label = ''; plan.usd = 0
  agents.rows = [{ agent: 'claude', subagent: false, turns: 40, cost_usd: 12, sessions: 2 }]
  resetShareCache()
  try { localStorage.clear() } catch { /* jsdom always has it */ }
})

const data = vi.hoisted(() => ({ value: undefined as unknown }))
const drawn = vi.hoisted(() => ({ text: [] as string[] }))
const calls = vi.hoisted(() => ({ n: 0, summary: 0, ranges: [] as string[] }))
/** What /v1/settings says about the plan, and which agents /v1/glance reports. */
const plan = vi.hoisted(() => ({ kind: '' as string, label: '', usd: 0 }))
const agents = vi.hoisted(() => ({ rows: [{ agent: 'claude', subagent: false, turns: 40, cost_usd: 12, sessions: 2 }] as unknown[] }))

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
      // The Story card's figures: one per period, so a card for the wrong
      // period shows in its headline.
      weekFor: async (period: string) => ({
        period, start: '2026-10-04', end: '2026-10-04', partial: true, from_ms: 0, to_ms: 0,
        days: [{ day: '2026-10-04', prs_opened: 3, cost_usd: 12, active: true }],
        sessions: 2, active_days: 1, turns: 40, cost_usd: 12, models: [],
        prs_opened: 3, prs_merged: period === 'today' ? 2 : 5, merges_unresolved: 0, commits: 4, files_edited: 3,
        lines_added: 100, lines_removed: 0, ci_wait_ms: 0, tool_ms: 0,
        agents: [{ agent: 'claude', subagent: false, turns: 40, cost_usd: 12, sessions: 2 }], estimates: [],
      }),
      glance: async () => ({ agents: agents.rows, display: {} }),
      settings: async () => ({ plan_kind: plan.kind, plan_label: plan.label, plan_usd_per_month: plan.usd }),
      // Answers per range, with a distinct cost each. Ignoring the argument
      // here is what once let the card draw a month's figures under a week's
      // heading without any test noticing.
      summary: async (range: string) => {
        calls.summary++
        calls.ranges.push(range)
        return { ...summary, cost_usd: RANGE_COST[range] ?? summary.cost_usd } as never
      },
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
    lineTo: vi.fn(),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set globalAlpha(_v: number) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  // Must call back, or every await on drawShareCard hangs to the timeout.
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(new Blob()))
  // jsdom has no object URLs. Vitest's stand-in reads jsdom's private Blob
  // internals, which jsdom 30 renamed, so every preview threw an unhandled
  // rejection after its test had passed.
  URL.createObjectURL = vi.fn(() => 'blob:card')
  URL.revokeObjectURL = vi.fn()
}

describe('ShareCard', () => {
  it('says one figure big, with the caveat', async () => {
    stubCanvas()
    await drawShareCard(await collectCardData('7d'))

    const all = drawn.text.join(' ')
    // The week's figure, in whole dollars at this size, is the hero.
    expect(drawn.text).toContain('$22.00')
    expect(all).toContain('of Claude Code this week')
    // A dollar figure posted without this reads as a bill someone paid.
    expect(all).toMatch(/not a bill/i)
    expect(all).toMatch(/API list prices/)
  })

  it('carries two or three facts, not sixteen', async () => {
    stubCanvas()
    await drawShareCard(await collectCardData('7d'))
    const all = drawn.text.join(' ')
    expect(all).toContain('sessions')
    expect(all).toContain('tokens')
    expect(all).toContain('99%')
    expect(all).toContain('cache hit')
    // The dense card's tiles and breakdowns are gone.
    expect(all).not.toMatch(/WHERE THE MONEY WENT|PER 1M TOKENS|A DAY/)
  })

  it('asks the reader what theirs is', async () => {
    // The loop this product grows by is: see somebody's figure, want your
    // own, install, post yours. A question, not a command: an install line on
    // a picture is an advertisement and reads as one.
    stubCanvas()
    await drawShareCard(await collectCardData('7d'))
    const all = drawn.text.join(' ')
    expect(all).toMatch(/what's yours/i)
    expect(all).toContain('caprock.dev')
    expect(all).not.toMatch(/brew install/i)
  })

  it('says the multiple of a flat plan over a week or a month, and only there', async () => {
    plan.kind = 'flat'; plan.label = 'Max'; plan.usd = 200
    stubCanvas()
    // $22 against a week of $200/mo is 0.8× — too small to say; the dollars stay.
    await drawShareCard(await collectCardData('7d'))
    expect(drawn.text.join(' ')).not.toMatch(/\d×/)

    const week: CardData = { period: '7d', takenAt: new Date(2026, 9, 10), cost: 1539, sessions: 42, tokens: 9e8, cacheHitPct: 98, agents: [{ agent: 'claude', cost: 1539, turns: 900 }], plan: { kind: 'flat', label: 'Max', usdPerMonth: 200 } }
    // $200 a month is $46.67 a week; $1,539 is 33 of those.
    expect(heroOf(week)).toEqual({ figure: '33×', line: 'my $200/mo Max plan', sub: '$1,539 of Claude Code this week at API list prices — not a bill' })
    // A day's share of a monthly fee is not a thing anyone pays, and the
    // lifetime of a subscription is not something Caprock knows.
    expect(heroOf({ ...week, period: 'today' }).figure).toBe('$1,539')
    expect(heroOf({ ...week, period: 'all' }).figure).toBe('$1,539')
    // Billed per token: the dollars are close to the bill, no multiple.
    expect(heroOf({ ...week, plan: { kind: 'metered', label: 'API', usdPerMonth: 0 } }).figure).toBe('$1,539')
    // Never "saved".
    expect(JSON.stringify(heroOf(week))).not.toMatch(/sav/i)
  })

  it('shows which agents did the work, by their marks and shares', async () => {
    agents.rows = [
      { agent: 'claude', subagent: false, turns: 40, cost_usd: 60, sessions: 2 },
      { agent: 'claude', subagent: true, turns: 10, cost_usd: 20, sessions: 2 },
      { agent: 'codex', subagent: false, turns: 30, cost_usd: 20, sessions: 1 },
    ]
    stubCanvas()
    const d = await collectCardData('7d')
    // Subagents fold into the agent that ran them.
    expect(mixOf(d)).toEqual([{ agent: 'claude', name: 'Claude Code', pct: 80 }, { agent: 'codex', name: 'Codex', pct: 20 }])
    await drawShareCard(d)
    const all = drawn.text.join(' ')
    expect(all).toContain('Claude Code')
    expect(all).toContain('Codex')
    expect(all).toContain('80%')
    // Two agents: the line names both.
    expect(all).toContain('of Claude Code and Codex this week')
  })

  it('puts no project or session names on an image meant to be posted', async () => {
    stubCanvas()
    await drawShareCard(await collectCardData('30d'))
    const all = drawn.text.join(' ')
    // Anything with a path separator would be a repository, a directory or a
    // file — none of which belong on an image somebody is about to post.
    expect(all).not.toMatch(/\//)
    expect(all).toContain('caprock.dev')
  })

  it('says when it was taken', async () => {
    // The card lives in a feed for weeks; without a date a reader cannot tell
    // whether the figure is current or a year old.
    stubCanvas()
    await drawShareCard(await collectCardData('7d'))
    expect(drawn.text.join(' ')).toContain(String(new Date().getFullYear()))
  })

  it('says how many days an all-time figure covers', async () => {
    data.value = history({ days: 59 })
    stubCanvas()
    await drawShareCard(await collectCardData('all'))
    const all = drawn.text.join(' ')
    expect(all).toContain('$10,846')
    expect(all).toContain('59 ACTIVE DAYS')
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
 * Milestones moved to the ShareMoment toast, which knows about occasions this button has
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
 * the wrong reason. Every press reads the week's summary exactly once, so
 * that is the honest place to count presses that got through.
 */
describe('the share dialog', () => {
  it('starts one draw however fast the button is pressed', async () => {
    stubCanvas()
    data.value = history()
    render(<ShareCard />)
    const open = await screen.findByRole('button', { name: /share these numbers/i })
    const before = calls.summary
    fireEvent.click(open)
    const save = await screen.findByRole('button', { name: /save image/i })
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.click(save)
    await screen.findByText(/saved to your downloads/i)
    // The preview's reading and the save share one round of requests: the
    // save waits for the reading already in flight rather than starting its
    // own, and the guarded button starts one save, not three.
    expect(calls.summary - before).toBe(1)
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
    fireEvent.click(await screen.findByRole('button', { name: /^share…$/i }))
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
  it('names the stretch, so a card out of context still says what it is', () => {
    expect(PERIOD_LABEL['7d']).toBe('this week')
    expect(PERIOD_LABEL['30d']).toBe('this month')
    expect(PERIOD_LABEL.today).toBe('today')
    expect(PERIOD_LABEL.all).toBe('all time')
  })

  it('carries the choice into the data, not only into the dialog', async () => {
    // A picker that does not reach the drawing is a control that lies.
    expect((await collectCardData('7d')).period).toBe('7d')
    expect((await collectCardData()).period).toBe('7d')
  })

  it('reads only the period it is about, and draws that period\'s figure', async () => {
    calls.ranges = []
    stubCanvas()
    await drawShareCard(await collectCardData('today'))
    expect(calls.ranges).toEqual(['today'])
    // $11 is the today fixture; $22 the week's, $33 the month's.
    expect(drawn.text).toContain('$11.00')
    expect(drawn.text.some((t) => t.includes('$22') || t.includes('$33'))).toBe(false)
  })
})

/**
 * The preview has to change when the period does.
 *
 * It did not, and the cause was a tidy-looking cleanup: the effect revoked its
 * blob URL on teardown, so changing period revoked the URL the <img> was still
 * pointing at. A revoked blob leaves the already-decoded bitmap on screen, so
 * every period drew a correct new card that nobody ever saw. The owner reported
 * it as "the previews don't change when you switch tabs".
 *
 * jsdom cannot draw, so the canvas is stubbed to yield a distinguishable blob
 * per call — the assertion is about which URL the <img> ends up with, and
 * whether the one it is showing has been revoked.
 */
describe('the preview image', () => {
  const stubCanvas = () => {
    let n = 0
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
    const origCtx = proto.getContext
    const origBlob = proto.toBlob
    proto.getContext = () =>
      new Proxy({}, {
        get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      })
    proto.toBlob = (cb: (b: Blob) => void) => {
      n += 1
      cb(new Blob([`card-${n}`], { type: 'image/png' }))
    }
    return () => { proto.getContext = origCtx; proto.toBlob = origBlob }
  }

  it('draws a new image for each period, and keeps the one on screen usable', async () => {
    const restore = stubCanvas()
    const made: string[] = []
    const revoked: string[] = []
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    let id = 0
    const order: string[] = []
    URL.createObjectURL = () => {
      id += 1
      const u = `blob:card-${id}`
      made.push(u)
      order.push(`create:${u}`)
      return u
    }
    URL.revokeObjectURL = (u: string) => { revoked.push(u); order.push(`revoke:${u}`) }
    try {
      data.value = history()
      render(<ShareCard />)
      fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))

      const img = await screen.findByAltText(/as they will be shared/i)
      const first = img.getAttribute('src')
      expect(first).toBeTruthy()
      // Guard the guard: if the canvas stub is not taking effect, no blob is
      // ever created and every assertion below is vacuously true.
      expect(made.length).toBe(1)

      fireEvent.click(screen.getByRole('button', { name: /^this month$/i }))
      await waitFor(() => {
        expect(screen.getByAltText(/as they will be shared/i).getAttribute('src')).not.toBe(first)
      })
      const second = screen.getByAltText(/as they will be shared/i).getAttribute('src')

      // The bug, stated as ordering rather than as appearance. jsdom keeps
      // rendering a revoked blob exactly as a real browser does, so "is it
      // still visible" cannot be asserted here — what can is *when* the old
      // URL was released. Revoking it before its replacement existed is the
      // defect: that is the window in which the <img> points at a dead URL and
      // the browser keeps showing the previous bitmap.
      const releasedFirst = revoked.indexOf(first!)
      const madeSecond = made.indexOf(second!)
      expect(releasedFirst).toBeGreaterThanOrEqual(0) // released, not leaked
      expect(madeSecond).toBeGreaterThanOrEqual(0)
      expect(order.indexOf(`revoke:${first}`)).toBeGreaterThan(order.indexOf(`create:${second}`))
      // And the one on screen is still live.
      expect(revoked).not.toContain(second)
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
      restore()
    }
  })
})

/**
 * "drawing…" has to be a state that ends.
 *
 * `paintCard` used to run outside the try in `drawShareCard`, so anything it
 * threw on rejected the promise, killed the caller's async function with no
 * catch, and left the dialog saying "drawing…" for good — indistinguishable
 * from a slow draw. A card that cannot be drawn has to say so.
 */
describe('a draw that cannot finish', () => {
  it('says so rather than showing "drawing…" for ever', async () => {
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
    const orig = proto.getContext
    // A context that blows up mid-paint, which is the shape of the bug.
    proto.getContext = () =>
      new Proxy({}, {
        get: (_t, k) => {
          if (k === 'measureText') return () => ({ width: 10 })
          return () => { throw new Error('paint failed') }
        },
      })
    try {
      data.value = history()
      render(<ShareCard />)
      fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))
      await waitFor(() => {
        expect(screen.getByText(/could not draw the card/i)).toBeTruthy()
      })
      expect(screen.queryByText(/^drawing…$/)).toBeNull()
    } finally {
      proto.getContext = orig
    }
  })
})

describe('the story card', () => {
  it('draws the Week card for the chosen period, in its words, and remembers the style', async () => {
    stubCanvas()
    data.value = history()
    render(<ShareCard />)
    fireEvent.click(await screen.findByRole('button', { name: /share these numbers/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^story$/i }))
    await screen.findByText(/this week\./)
    expect(document.body.textContent).toContain('My agents shipped 5 PRs this week.')
    fireEvent.click(screen.getByRole('button', { name: /^today$/i }))
    await waitFor(() => expect(document.body.textContent).toContain('My agents shipped 2 PRs today.'))
    expect(localStorage.getItem('caprock-share-style')).toBe('story')
    // Landscape and portrait, as on the Week screen.
    fireEvent.click(screen.getByRole('button', { name: /^portrait$/i }))
    expect(screen.getByText(/1080×1350 PNG/)).toBeTruthy()
  })
})
