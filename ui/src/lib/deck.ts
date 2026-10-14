/**
 * The session deck's size and whether it is open (.ai/21-app.md § What the
 * user sees, Session deck): a band under the agent's terminal that pushes the
 * terminal's bottom — and Claude Code's prompt with it — up from the window's
 * edge, and shows the session's live figures in the room it makes.
 *
 * Kept per viewer in the page's storage, every read and write behind a
 * try/catch: a private window or blocked storage opens it closed, at the
 * default height, and nothing breaks.
 */

export const DECK_KEY = 'caprock.app.deck'
/** Bumped when the kept height means something else: 2 is after the chart left. */
const DECK_VERSION = 2

/** The lowest height the deck is useful at: one line of figures over the bars. */
export const DECK_MIN = 72
/** The highest share of the pane it may take: the terminal keeps the rest. */
export const DECK_MAX_SHARE = 0.6
/** Where it opens the first time: high enough to lift the prompt off the window's edge. */
export const DECK_DEFAULT = 176
/** One arrow-key step on the divider. */
export const DECK_STEP = 16
/** From this height the deck has room for a second line in each cell. */
export const DECK_TALL = 150

export interface DeckPrefs {
  open: boolean
  /** Its height in CSS pixels, kept while it is closed. */
  height: number
}

/** The height clamped to the deck's range in a pane this tall; without a pane, only the floor applies. */
export function clampDeck(height: number, pane?: number): number {
  const max = pane && pane > 0 ? Math.max(DECK_MIN, Math.floor(pane * DECK_MAX_SHARE)) : Infinity
  if (Number.isNaN(height)) return Math.min(max, DECK_DEFAULT)
  return Math.min(max, Math.max(DECK_MIN, Math.round(height)))
}

/** What is kept: closed at the default height when nothing is, or what is there is not ours. */
export function readDeck(): DeckPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(DECK_KEY) ?? 'null') as unknown
    if (!v || typeof v !== 'object') return { open: false, height: DECK_DEFAULT }
    const o = v as { open?: unknown; height?: unknown; v?: unknown }
    if (typeof o.height !== 'number' || !Number.isFinite(o.height)) return { open: o.open === true, height: DECK_DEFAULT }
    // A height kept before the chart left the deck is a third lower now
    // (owner, 2026-10-11: "cut it by about a third"), once.
    const height = o.v === DECK_VERSION ? o.height : o.height * (2 / 3)
    return { open: o.open === true, height: clampDeck(height) }
  } catch {
    return { open: false, height: DECK_DEFAULT }
  }
}

export function saveDeck(p: DeckPrefs): void {
  try { localStorage.setItem(DECK_KEY, JSON.stringify({ open: p.open, height: clampDeck(p.height), v: DECK_VERSION })) } catch { /* not kept */ }
}

/**
 * How many minutes of bars the events held can draw honestly. The deck reads
 * the session's newest `cap` calls and turns, shared with the cockpit; when
 * that list is full, nothing older than its oldest event is held, and a minute
 * before it would be drawn as silence that may not have been. The window then
 * starts at the oldest event held, never past `max`.
 */
export function pulseMinutes(events: readonly { ts: string }[], now: number, cap: number, max = 60): number {
  if (events.length < cap || events.length === 0) return max
  const oldest = Date.parse(events[0]!.ts)
  if (!Number.isFinite(oldest) || oldest >= now) return max
  return Math.max(1, Math.min(max, Math.floor((now - oldest) / 60_000)))
}

/** The height an arrow key, Page Up/Down, Home or End moves the divider to; undefined for any other key. */
export function deckKeyStep(key: string, height: number, pane?: number): number | undefined {
  switch (key) {
    // The divider is the deck's top edge: up makes the deck taller.
    case 'ArrowUp': return clampDeck(height + DECK_STEP, pane)
    case 'ArrowDown': return clampDeck(height - DECK_STEP, pane)
    case 'PageUp': return clampDeck(height + DECK_STEP * 4, pane)
    case 'PageDown': return clampDeck(height - DECK_STEP * 4, pane)
    case 'Home': return pane && pane > 0 ? clampDeck(Infinity, pane) : height
    case 'End': return DECK_MIN
    default: return undefined
  }
}
