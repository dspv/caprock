/**
 * The share dialog's figures, kept so opening it shows a card at once.
 *
 * The dialog used to start from nothing every time, and the slowest reads
 * take seconds on a large database. Most of the time the figures had not
 * changed since the last look. So the last week (GET /v1/week?period=) for
 * each period is kept — in memory for this tab and in localStorage for the
 * next one — and drawn the moment the dialog opens, marked as the earlier
 * reading while the current one is fetched behind it. Saving or sending
 * waits for the current one, for a few seconds at most (Share.tsx,
 * FIGURES_WAIT_MS); past that the card goes as shown, marked as the earlier
 * reading.
 *
 * One request per period is in flight at a time, shared by everyone who asks,
 * so hovering the Share button (which warms the default period) and then
 * opening the dialog costs one request, not two.
 *
 * What is kept is what the card shows: totals and agent names. Nothing names
 * a repository, a path or a prompt — the endpoint does not send them.
 */
import { api, type Week } from '@/lib/api'
import type { SharePeriod } from '@/components/ShareCard'

export interface Kept<T> { value: T; at: number }

/** How long a reading is current enough to save without asking again. */
export const FRESH_MS = 60_000

// v2: the week counts GitHub's pull requests and leaves scheduled runs out;
// a v1 reading said something else and is not shown.
const STORY_KEY = (p: SharePeriod) => `caprock-share-story-v2-${p}`

const stories = new Map<SharePeriod, Kept<Week>>()
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

/** The last card's figures for a period, from this tab or an earlier one. */
export function lastStory(p: SharePeriod): Kept<Week> | undefined {
  const mem = stories.get(p)
  if (mem) return mem
  const raw = read(STORY_KEY(p))
  if (!isKept(raw)) return undefined
  const v = raw.value as unknown as Week
  // A shape from another version is dropped rather than half-drawn.
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

/** The current figures, reusing a reading taken within the last minute. */
export function currentStory(p: SharePeriod): Promise<Week> {
  const k = stories.get(p)
  if (k && Date.now() - k.at < FRESH_MS) return Promise.resolve(k.value)
  return fetchStory(p)
}

/** Start the default card's figures before the dialog is even open. */
export function warmShare() {
  const s = stories.get('7d')
  if (s && Date.now() - s.at < FRESH_MS) return
  void fetchStory('7d').catch(() => { /* the dialog reports it when opened */ })
}

/** For tests: forget everything kept in memory. */
export function resetShareCache() {
  stories.clear()
  storyFlights.clear()
}
