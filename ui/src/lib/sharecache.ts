/**
 * The share dialog's figures, kept so opening it shows a card at once.
 *
 * The dialog used to start from nothing every time: four summary requests,
 * the slowest several seconds on a large database, and an empty box saying
 * "drawing…" until all of them answered. Most of the time the figures had not
 * changed since the last look. So the last figures for each period are kept —
 * in memory for this tab and in localStorage for the next one — and drawn the
 * moment the dialog opens, marked as the earlier reading while the current one
 * is fetched behind them. Saving or sending always waits for the current one:
 * a card that leaves the machine never carries old figures.
 *
 * One request per period is in flight at a time, shared by everyone who asks,
 * so hovering the Share button (which warms the default period) and then
 * opening the dialog costs one round of requests, not two.
 *
 * What is kept is what the card shows: totals, model names, kinds of work.
 * Nothing names a repository, a path or a prompt — the same rule as the card.
 */
import { api, type Week } from '@/lib/api'
import { collectCardData, type CardData, type SharePeriod } from '@/components/ShareCard'

export interface Kept<T> { value: T; at: number }

/** How long a reading is current enough to save without asking again. */
export const FRESH_MS = 60_000

const FIG_KEY = (p: SharePeriod) => `caprock-share-figures-v1-${p}`
const STORY_KEY = (p: SharePeriod) => `caprock-share-story-v1-${p}`

const figures = new Map<SharePeriod, Kept<CardData>>()
const stories = new Map<SharePeriod, Kept<Week>>()

interface Flight<T> { promise: Promise<T>; done: Set<SharePeriod>; subs: Set<(done: Set<SharePeriod>) => void> }
const figFlights = new Map<SharePeriod, Flight<CardData>>()
const storyFlights = new Map<SharePeriod, Promise<Week>>()

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* keeping it is a convenience */ }
}

function isKept(v: unknown): v is { value: Record<string, unknown>; at: number } {
  return !!v && typeof v === 'object' && typeof (v as { at?: unknown }).at === 'number'
    && !!(v as { value?: unknown }).value && typeof (v as { value?: unknown }).value === 'object'
}

/** The last figures drawn for a period, from this tab or an earlier one. */
export function lastFigures(p: SharePeriod): Kept<CardData> | undefined {
  const mem = figures.get(p)
  if (mem) return mem
  const raw = read(FIG_KEY(p))
  if (!isKept(raw)) return undefined
  const v = raw.value as unknown as CardData & { takenAt: string }
  // A shape from another version is dropped rather than half-drawn.
  if (v.period !== p || !v.today || !v.week || !v.month || !v.allTime || !Array.isArray(v.models)) return undefined
  const kept = { value: { ...v, takenAt: new Date(v.takenAt) }, at: raw.at }
  figures.set(p, kept)
  return kept
}

/**
 * The current figures for a period. `onStep` hears which ranges have answered
 * so far — at once with any already in, then as each lands.
 */
export function fetchFigures(p: SharePeriod, onStep?: (done: Set<SharePeriod>) => void): Promise<CardData> {
  let f = figFlights.get(p)
  if (!f) {
    const flight: Flight<CardData> = { promise: Promise.resolve(undefined as unknown as CardData), done: new Set(), subs: new Set() }
    flight.promise = collectCardData(p, (step) => {
      flight.done.add(step)
      for (const s of flight.subs) s(new Set(flight.done))
    }).then((data) => {
      const kept = { value: data, at: Date.now() }
      figures.set(p, kept)
      write(FIG_KEY(p), kept)
      return data
    }).finally(() => { figFlights.delete(p) })
    figFlights.set(p, flight)
    f = flight
  }
  if (onStep) {
    f.subs.add(onStep)
    onStep(new Set(f.done))
  }
  return f.promise
}

/** The current figures, reusing a reading taken within the last minute. */
export function currentFigures(p: SharePeriod): Promise<CardData> {
  const k = figures.get(p)
  if (k && Date.now() - k.at < FRESH_MS) return Promise.resolve(k.value)
  return fetchFigures(p)
}

/** The last story card's figures for a period. */
export function lastStory(p: SharePeriod): Kept<Week> | undefined {
  const mem = stories.get(p)
  if (mem) return mem
  const raw = read(STORY_KEY(p))
  if (!isKept(raw)) return undefined
  const v = raw.value as unknown as Week
  if (typeof v.start !== 'string' || !Array.isArray(v.days) || !Array.isArray(v.agents)) return undefined
  const kept = { value: v, at: raw.at }
  stories.set(p, kept)
  return kept
}

export function fetchStory(p: SharePeriod): Promise<Week> {
  let f = storyFlights.get(p)
  if (!f) {
    f = api.weekFor(p).then((w) => {
      const kept = { value: w, at: Date.now() }
      stories.set(p, kept)
      write(STORY_KEY(p), kept)
      return w
    }).finally(() => { storyFlights.delete(p) })
    storyFlights.set(p, f)
  }
  return f
}

export function currentStory(p: SharePeriod): Promise<Week> {
  const k = stories.get(p)
  if (k && Date.now() - k.at < FRESH_MS) return Promise.resolve(k.value)
  return fetchStory(p)
}

/**
 * Start the default card's figures before the dialog is even open — for the
 * style the dialog will open in, which is the one last chosen.
 */
export function warmShare() {
  let style: string | null = null
  try { style = localStorage.getItem('caprock-share-style') } catch { /* figures, then */ }
  if (style === 'story') {
    const s = stories.get('7d')
    if (s && Date.now() - s.at < FRESH_MS) return
    void fetchStory('7d').catch(() => { /* the dialog reports it when opened */ })
    return
  }
  const k = figures.get('7d')
  if (k && Date.now() - k.at < FRESH_MS) return
  void fetchFigures('7d').catch(() => { /* the dialog reports it when opened */ })
}

/** For tests: forget everything kept in memory. */
export function resetShareCache() {
  figures.clear()
  stories.clear()
  figFlights.clear()
  storyFlights.clear()
}
