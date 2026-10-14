/**
 * The offer survey: demand tests for features that may be built (ADR-062).
 *
 * Caprock cannot see its users, so it talks to them inside the product.
 * Each offer has its own copy and show rule:
 *
 *  - `second-brain` is a sale, not a survey: a strip, then a dialog that says
 *    how it works and offers Premium, with a dated pre-order line. It sends
 *    nothing. Every install may see it at most twice, on different days, and
 *    never from its arrival date or once the feature is built.
 *  - `local-models` is a survey every install may see, at most twice.
 *  - `ads` and `youtube` are surveys; each install draws one of the two at
 *    random, locally, and is asked it once.
 *
 * Shared rules: after two days with sessions; one offer a day at most across
 * all of them; never again once answered. A survey sends nothing until Send,
 * and then only the chosen answers and the email if typed
 * (internal/api/offer.go). "Not interested" and × send nothing. Every mark is
 * kept with the other prompt answers on the daemon (lib/prompts.ts).
 *
 * The copy is the owner's, word for word (2026-10-14). The answer values are
 * the payload's enums and must match internal/api/offer.go and the site's
 * functions/api/offer.ts. .ai/04-ui.md § Product-led surfaces has the rules.
 */
import { useEffect, useState } from 'react'
import { isDue, markAnswered, promptAt, type OfferId, type PromptKind } from './prompts'

export type { OfferId }

export type OfferQuestion = {
  /** The answer's key in the payload: `q1`, `q2`. */
  key: 'q1' | 'q2'
  label: string
  options: readonly { value: string; label: string }[]
}

export type Offer = {
  id: OfferId
  /** A survey asks and may send; a sale opens a dialog and sends nothing. */
  kind: 'survey' | 'sale'
  title: string
  line: string
  questions: readonly OfferQuestion[]
  /** Unix ms from which it is never shown (a sale's arrival date). */
  until?: number
  /** Times it may be shown, each on a different day. */
  maxShows: 1 | 2
  /** One of a pair drawn per install, or seen by every install. */
  drawn: boolean
  /**
   * Where *Try it now* goes, for an offer that can already be tried (the
   * YouTube survey's Watch tab). It answers nothing and sends nothing.
   */
  tryHref?: string
}

const WORK_QUESTIONS: readonly OfferQuestion[] = [
  {
    key: 'q1',
    label: 'How many hours a day do you work?',
    options: [
      { value: 'under-4', label: 'Under 4' },
      { value: '4-8', label: '4–8' },
      { value: '8-12', label: '8–12' },
      { value: '12+', label: '12+' },
    ],
  },
  {
    key: 'q2',
    label: 'How much of that is in Caprock?',
    options: [
      { value: 'under-30', label: 'Under 30%' },
      { value: '30-70', label: '30–70%' },
      { value: 'over-70', label: 'Over 70%' },
    ],
  },
]

/**
 * The day Second Brain arrives in Premium (owner, 2026-10-14): the pre-order
 * line promises it, and from that day the sale is not shown.
 */
export const SECOND_BRAIN_DATE = new Date(2026, 9, 18).getTime()
export const SECOND_BRAIN_DATE_TEXT = '18 October 2026'

/**
 * Set by the Second Brain build when the feature exists: the sale stops
 * then, whatever the date.
 */
export const SECOND_BRAIN_BUILT = false

/** In the order they are tried: the first eligible one is the day's offer. */
export const OFFERS: readonly Offer[] = [
  {
    id: 'second-brain',
    kind: 'sale',
    title: 'Your second brain — a knowledge graph of everything your agents do.',
    line: '',
    questions: [],
    maxShows: 2,
    drawn: false,
    until: SECOND_BRAIN_BUILT ? 0 : SECOND_BRAIN_DATE,
  },
  {
    id: 'local-models',
    kind: 'survey',
    title: 'Would you run Hugging Face models on this computer from Caprock?',
    line: 'We\'re considering it: pick a model, Caprock checks it fits your machine, downloads it and runs it.',
    questions: [
      {
        key: 'q1',
        label: 'What would you run first?',
        options: [
          { value: 'coding', label: 'Coding model for agents' },
          { value: 'chat', label: 'Chat and writing' },
          { value: 'search', label: 'Search over my files' },
          { value: 'trying', label: 'Just trying models' },
        ],
      },
      {
        key: 'q2',
        label: 'What is this computer?',
        options: [
          { value: 'mac-16', label: 'Mac, 16 GB or less' },
          { value: 'mac-24-64', label: 'Mac, 24–64 GB' },
          { value: 'mac-96', label: 'Mac, 96 GB+' },
          { value: 'pc-nvidia', label: 'PC with an NVIDIA GPU' },
          { value: 'other', label: 'Other' },
        ],
      },
    ],
    maxShows: 2,
    drawn: false,
  },
  {
    id: 'ads',
    kind: 'survey',
    title: 'Would you watch short ads in Caprock to earn money?',
    line: 'We\'re considering an opt-in: a short ad while agents work, and you get paid for it.',
    questions: WORK_QUESTIONS,
    maxShows: 1,
    drawn: true,
  },
  {
    id: 'youtube',
    kind: 'survey',
    title: 'Would you watch YouTube in Caprock while agents work?',
    line: 'We\'re considering a small player on the left, so you don\'t switch windows while you wait.',
    questions: WORK_QUESTIONS,
    maxShows: 1,
    drawn: true,
    // An experiment beside the question (lib/watch.ts): try it, then answer.
    tryHref: '#/watch',
  },
]

export function offerById(id: OfferId): Offer {
  return OFFERS.find((o) => o.id === id)!
}

/** Days with sessions before any offer is shown: someone who came back. */
export const OFFER_MIN_DAYS = 2

/** How long the keyboard must be still before a card appears. */
export const OFFER_QUIET_MS = 20_000

const kind = (id: OfferId, mark: 'no' | 'sent' | 'seen-1' | 'seen-2') => `offer-${id}-${mark}` as PromptKind

/** The local calendar day of a time, for "different days". */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** Which of the pair this install drew, without drawing. */
export function drawnVariant(): 'ads' | 'youtube' | null {
  const ads = promptAt('offer-variant-ads')
  const yt = promptAt('offer-variant-youtube')
  if (ads && yt) return yt < ads ? 'youtube' : 'ads' // two windows drew at once: the earlier draw wins
  if (ads) return 'ads'
  if (yt) return 'youtube'
  return null
}

let pending: 'ads' | 'youtube' | null = null

/**
 * This install's draw: the one kept, or one made now for this page and kept
 * only when its card is actually shown (markShown) — an install that never
 * qualifies never records a draw. `rand` is injectable for tests.
 */
export function currentDraw(rand: () => number = Math.random): 'ads' | 'youtube' {
  const had = drawnVariant()
  if (had) return had
  pending ??= rand() < 0.5 ? 'ads' : 'youtube'
  return pending
}

/** For tests: forget a draw not yet kept. */
export function resetPendingDraw() {
  pending = null
}

/** Whether `offer` may be shown today, by its own marks and the shared ones. */
export function offerShowable(offer: Offer, now: number, rand: () => number = Math.random): boolean {
  if (!isDue(kind(offer.id, 'no'), now) || !isDue(kind(offer.id, 'sent'), now)) return false
  if (offer.until !== undefined && now >= offer.until) return false
  if (offer.drawn && currentDraw(rand) !== offer.id) return false
  const today = dayOf(now)
  const seen = [promptAt(kind(offer.id, 'seen-1')), promptAt(kind(offer.id, 'seen-2'))].filter((v): v is number => !!v)
  const shownToday = seen.some((t) => dayOf(t) === today)
  // One offer a day across all of them: another one already had today.
  const last = promptAt('offer-last')
  if (last && dayOf(last) === today && !shownToday) return false
  return shownToday || seen.length < offer.maxShows
}

/**
 * The offer for today, or null: real use first, then the first offer in
 * OFFERS whose rules allow it. Records nothing.
 */
export function offerForToday(totals: { days: number } | undefined, now: number, rand: () => number = Math.random): Offer | null {
  if (!totals || totals.days < OFFER_MIN_DAYS) return null
  return OFFERS.find((o) => offerShowable(o, now, rand)) ?? null
}

/**
 * Record that `offer` is on screen today: its show for the day (once a
 * day), the shared day mark, and for a drawn offer the draw itself.
 */
export function markShown(offer: Offer, now: number) {
  if (offer.drawn && !drawnVariant()) markAnswered(offer.id === 'ads' ? 'offer-variant-ads' : 'offer-variant-youtube', now)
  const today = dayOf(now)
  const s1 = promptAt(kind(offer.id, 'seen-1'))
  const s2 = promptAt(kind(offer.id, 'seen-2'))
  if ((s1 && dayOf(s1) === today) || (s2 && dayOf(s2) === today)) return
  markAnswered(s1 ? kind(offer.id, 'seen-2') : kind(offer.id, 'seen-1'), now)
  markAnswered('offer-last', now)
}

/** A final answer: never shown again. */
export function markOfferAnswered(offer: Offer, how: 'no' | 'sent', now: number) {
  markAnswered(kind(offer.id, how), now)
}

/**
 * The QA switch: `?offer=<id>` in the page's address shows that offer now,
 * whatever the gates say. It records nothing, so it can be used again; Send
 * still goes through the daemon, so point CAPROCK_OFFER_URL at a stub first.
 */
export function forcedOffer(search: string = typeof location === 'undefined' ? '' : location.search): Offer | null {
  const v = new URLSearchParams(search).get('offer')
  return OFFERS.find((o) => o.id === v) ?? null
}

let lastKey = 0
let listening = false

/**
 * True once the keyboard has been still for `ms` since mount, and true from
 * then on. A card that appears mid-keystroke moves the line someone is
 * typing on; one that appears in a pause does not. Latched, so it does not
 * vanish when typing resumes.
 */
export function useKeyboardQuiet(ms: number): boolean {
  const [quiet, setQuiet] = useState(ms <= 0)
  useEffect(() => {
    if (quiet) return
    if (!listening) {
      listening = true
      window.addEventListener('keydown', () => { lastKey = Date.now() }, true)
    }
    const start = Date.now()
    let t = 0
    const check = () => {
      const wait = Math.max(start, lastKey) + ms - Date.now()
      if (wait <= 0) setQuiet(true)
      else t = window.setTimeout(check, wait)
    }
    check()
    return () => window.clearTimeout(t)
  }, [ms, quiet])
  return quiet
}
