/**
 * The offer survey (ADR-062): the show rules per offer, nothing sent unless
 * Send is pressed, and exactly what was chosen when it is.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferStrip, OFFER_DISCLOSURE, OFFER_THANKS } from './OfferStrip'
import { INCLUDED_LINE, PREORDER_LINE } from './SecondBrainModal'
import { api } from '@/lib/api'
import { isDue, markAnswered, resetPrompts } from '@/lib/prompts'
import { resetNudgeSlots } from '@/lib/nudges'
import {
  currentDraw, drawnVariant, forcedOffer, markOfferAnswered, markShown, offerById,
  offerForToday, resetPendingDraw, SECOND_BRAIN_BUILT, SECOND_BRAIN_DATE,
} from '@/lib/offer'

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000
const USED = { days: 5 }
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)))

function given(days: number, licensed = false) {
  vi.spyOn(api, 'history').mockResolvedValue({ totals: { days, sessions: days * 3 } } as unknown as Awaited<ReturnType<typeof api.history>>)
  vi.spyOn(api, 'premium').mockResolvedValue({
    license: { active: licensed },
    yearly: { url: 'https://buy.example/y', charged_usd: 30 },
    lifetime: { url: 'https://buy.example/l', charged_usd: 100 },
  } as unknown as Awaited<ReturnType<typeof api.premium>>)
  return vi.spyOn(api, 'sendOffer').mockResolvedValue({ status: 'sent' })
}

// Second Brain is built, so the shipped sale never shows (SECOND_BRAIN_BUILT
// sets its until to 0; the first describe checks that). The rest of this file
// tests the strip as it ran before: the sale back on its dated until.
const sale = offerById('second-brain')
const shipped = sale.until
beforeAll(() => { sale.until = SECOND_BRAIN_DATE })
afterAll(() => { sale.until = shipped })

describe('once Second Brain is built', () => {
  it('the pre-order sale is retired, whatever the date', () => {
    expect(SECOND_BRAIN_BUILT).toBe(true)
    expect(shipped).toBe(0)
    sale.until = shipped
    try {
      expect(offerForToday(USED, NOW)?.id).toBe('local-models')
      expect(offerForToday(USED, SECOND_BRAIN_DATE - DAY)?.id).not.toBe('second-brain')
    } finally {
      sale.until = SECOND_BRAIN_DATE
    }
  })
})

beforeEach(() => {
  resetPrompts(); resetNudgeSlots(); resetPendingDraw(); vi.restoreAllMocks()
  history.replaceState(null, '', '/')
})

describe('the draw', () => {
  it('is kept only once its card is shown, and never redrawn', () => {
    expect(currentDraw(() => 0.9)).toBe('youtube')
    expect(drawnVariant()).toBe(null)
    markShown(offerById('youtube'), NOW)
    expect(drawnVariant()).toBe('youtube')
    resetPendingDraw()
    expect(currentDraw(() => 0.1)).toBe('youtube')
  })

  it('draws both variants', () => {
    expect(currentDraw(() => 0.1)).toBe('ads')
    resetPendingDraw()
    expect(currentDraw(() => 0.6)).toBe('youtube')
  })

  it('keeps the earlier draw when two windows drew at once', () => {
    markAnswered('offer-variant-youtube', NOW)
    markAnswered('offer-variant-ads', NOW + 5)
    expect(drawnVariant()).toBe('youtube')
  })
})

describe('show rules', () => {
  it('waits for two days of use', () => {
    expect(offerForToday(undefined, NOW)).toBe(null)
    expect(offerForToday({ days: 1 }, NOW)).toBe(null)
    expect(offerForToday({ days: 2 }, NOW)?.id).toBe('second-brain')
  })

  it('second brain and local models twice each on different days, the drawn one once, one offer a day', () => {
    const order: string[] = []
    for (let d = 0; d < 8; d++) {
      const t = NOW + d * DAY
      const o = offerForToday(USED, t, () => 0.1)
      order.push(o?.id ?? '-')
      if (!o) continue
      markShown(o, t)
      // A reload the same day keeps the same offer; another one never joins it.
      expect(offerForToday(USED, t + 60_000, () => 0.1)?.id).toBe(o.id)
    }
    expect(order).toEqual(['second-brain', 'second-brain', 'local-models', 'local-models', 'ads', '-', '-', '-'])
  })

  it('never shows the other half of the pair', () => {
    markAnswered('offer-second-brain-no', NOW)
    markAnswered('offer-local-models-no', NOW)
    markShown(offerById('youtube'), NOW)
    expect(offerForToday(USED, NOW + DAY, () => 0.1)).toBe(null)
  })

  it('an answer is final', () => {
    markOfferAnswered(offerById('second-brain'), 'sent', NOW)
    expect(offerForToday(USED, NOW + 10 * DAY, () => 0.1)?.id).toBe('local-models')
    markOfferAnswered(offerById('local-models'), 'no', NOW)
    expect(offerForToday(USED, NOW + 10 * DAY, () => 0.1)?.id).toBe('ads')
    markOfferAnswered(offerById('ads'), 'no', NOW)
    expect(offerForToday(USED, NOW + 10 * DAY, () => 0.1)).toBe(null)
  })

  it('takes only known offers from the address', () => {
    expect(forcedOffer('?offer=ads')?.id).toBe('ads')
    expect(forcedOffer('?offer=second-brain')?.id).toBe('second-brain')
    expect(forcedOffer('?offer=local-models')?.id).toBe('local-models')
    expect(forcedOffer('?offer=other')).toBe(null)
    expect(forcedOffer('')).toBe(null)
  })
})

describe('OfferStrip', () => {
  it('says nothing on the first day', async () => {
    given(1)
    const { container } = render(<OfferStrip now={NOW} quietMs={0} />)
    await settle()
    expect(container.textContent).toBe('')
  })

  it('waits while a session needs a permission answer', async () => {
    given(5)
    const { container } = render(<OfferStrip now={NOW} quietMs={0} busy />)
    await settle()
    expect(container.textContent).toBe('')
  })

  it('waits for the keyboard to be still', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      given(5)
      const { container } = render(<OfferStrip now={NOW} quietMs={20_000} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      fireEvent.keyDown(window, { key: 'a' })
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(container.textContent).toBe('')
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
      expect(container.textContent).not.toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  for (const label of ['Not interested', 'Close, not interested']) {
    it(`sends nothing on "${label}", and never asks that again`, async () => {
      const send = given(5)
      const first = render(<OfferStrip now={NOW} quietMs={0} />)
      const btn = label === 'Not interested' ? await screen.findByText(label) : await screen.findByLabelText(label)
      fireEvent.click(btn)
      first.unmount()
      expect(send).not.toHaveBeenCalled()
      expect(isDue('offer-second-brain-no', NOW + 1)).toBe(false)
      resetNudgeSlots()
      const again = render(<OfferStrip now={NOW + 400 * DAY} quietMs={0} />)
      await settle()
      expect(again.container.textContent).not.toMatch(/second brain/i)
    })
  }

  it('sends exactly the chosen answers, says what it sends, and is answered for good', async () => {
    for (const k of ['offer-second-brain-no', 'offer-local-models-no', 'offer-variant-youtube'] as const) markAnswered(k, NOW)
    const send = given(5)
    render(<OfferStrip now={NOW} quietMs={0} />)
    expect(await screen.findByText('Would you watch YouTube in Caprock while agents work?')).toBeTruthy()
    expect(screen.getByText(OFFER_DISCLOSURE)).toBeTruthy()
    const sendBtn = screen.getByText('Send') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
    fireEvent.click(screen.getByText('8–12'))
    fireEvent.click(screen.getByText('Over 70%'))
    expect(sendBtn.disabled).toBe(false)
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(sendBtn)
    await screen.findByText(OFFER_THANKS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toEqual({ offer: 'youtube', answers: { q1: '8-12', q2: 'over-70' } })
    expect(isDue('offer-youtube-sent', NOW + 1)).toBe(false)
  })

  it('second brain is a sale: how it works, the pre-order line, the usual purchase step, nothing sent', async () => {
    const send = given(5)
    render(<OfferStrip now={NOW} quietMs={0} />)
    expect(await screen.findByText('Your second brain — a knowledge graph of everything your agents do.')).toBeTruthy()
    expect(screen.queryByText('Send')).toBe(null)
    fireEvent.click(screen.getByText('How it works'))
    expect(await screen.findByText(PREORDER_LINE)).toBeTruthy()
    expect(PREORDER_LINE).toBe("Second Brain comes to Premium on 18 October 2026. If it doesn't, write to us for a full refund.")
    fireEvent.click(screen.getByText('Get Premium'))
    // The existing purchase step: the yearly and the once price, from the daemon.
    expect(await screen.findByText(/\/ year/)).toBeTruthy()
    const buy = screen.getByText(/\/ year/).closest('a')!
    expect(buy.getAttribute('href')).toContain('client_reference_id=app-second-brain')
    expect(send).not.toHaveBeenCalled()
  })

  it('second brain to someone who has Premium: included, nothing to buy', async () => {
    given(5, true)
    render(<OfferStrip now={NOW} quietMs={0} />)
    fireEvent.click(await screen.findByText('How it works'))
    expect(await screen.findByText(INCLUDED_LINE)).toBeTruthy()
    expect(screen.queryByText('Get Premium')).toBe(null)
  })

  it('second brain stops on its arrival date', () => {
    expect(offerForToday(USED, SECOND_BRAIN_DATE - 1)?.id).toBe('second-brain')
    expect(offerForToday(USED, SECOND_BRAIN_DATE)?.id).toBe('local-models')
  })

  it('local models: sends the two picks', async () => {
    markAnswered('offer-second-brain-no', NOW)
    const send = given(5)
    render(<OfferStrip now={NOW} quietMs={0} />)
    expect(await screen.findByText('Would you run Hugging Face models on this computer from Caprock?')).toBeTruthy()
    fireEvent.click(screen.getByText('Search over my files'))
    fireEvent.click(screen.getByText('PC with an NVIDIA GPU'))
    fireEvent.click(screen.getByText('Send'))
    await screen.findByText(OFFER_THANKS)
    expect(send.mock.calls[0]![0]).toEqual({ offer: 'local-models', answers: { q1: 'search', q2: 'pc-nvidia' } })
  })

  it('shows on demand from the address, and records nothing', async () => {
    history.replaceState(null, '', '/?offer=youtube')
    given(0)
    render(<OfferStrip now={NOW} quietMs={20_000} />)
    expect(await screen.findByText(/watch YouTube/)).toBeTruthy()
    fireEvent.click(screen.getByText('Not interested'))
    expect(isDue('offer-youtube-no', NOW)).toBe(true)
    expect(isDue('offer-variant-youtube', NOW)).toBe(true)
    expect(isDue('offer-last', NOW)).toBe(true)
  })
})
