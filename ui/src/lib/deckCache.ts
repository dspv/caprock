/**
 * The last answer of each of the deck's Pull requests & CI views, so the cell
 * opens on what it last knew instead of an empty area while the daemon is
 * asked (owner, 2026-10-13, translated: "for a while nothing is shown, it
 * looks frozen and empty"). The deck is unmounted while closed, so the
 * answers live here: in memory for the app's run, and through `lib/swr` in
 * localStorage (group `deck:`, the newest GROUP_LIMITS['deck:'] kept), so a
 * fresh start of the app shows the last known list too. Nothing here asks
 * anything: it only remembers what the deck was told.
 *
 * Keys name the view and its scope: `prs:<session>`, `ci:<session>:<pr>`,
 * `release:<repository>`, `main:<repository>`, `branches:<folder>`, and the
 * PRs & CI tab's `stats:<repository>`; Now's Repos section keeps `repos:now`.
 */
import { readCache, writeCache } from './swr'

export interface DeckAnswer<T> {
  d: T
  /** When the deck received it (ms). */
  at: number
}

/** How many answers are kept in memory, the oldest out first. */
const KEPT = 64
const mem = new Map<string, DeckAnswer<unknown>>()

/** The last answer kept under key, if any. */
export function readDeck<T>(key: string | undefined): DeckAnswer<T> | undefined {
  if (!key) return undefined
  const m = mem.get(key) as DeckAnswer<T> | undefined
  if (m) return m
  const c = readCache<T>(`deck:${key}`)
  if (!c) return undefined
  const a = { d: c.data, at: c.at }
  mem.set(key, a)
  return a
}

/** Keeps d as the last answer under key. */
export function writeDeck<T>(key: string, d: T, at = Date.now()): void {
  mem.delete(key)
  mem.set(key, { d, at })
  while (mem.size > KEPT) {
    const oldest = mem.keys().next().value
    if (oldest === undefined) break
    mem.delete(oldest)
  }
  writeCache(`deck:${key}`, d, at)
}

/** Drops the answers kept in memory (tests). */
export function forgetDeckAnswers(): void {
  mem.clear()
}

/** How fresh a shown answer is, in the cell's header: "updated 12 s ago". */
export function freshText(ms: number): string {
  if (ms < 5_000) return 'updated just now'
  if (ms < 60_000) return `updated ${Math.floor(ms / 1000)} s ago`
  if (ms < 3_600_000) return `updated ${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `updated ${Math.floor(ms / 3_600_000)} h ago`
  return `updated ${Math.floor(ms / 86_400_000)} d ago`
}
