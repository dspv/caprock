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
 * Keys name the view and its scope: `prs:<session>`, `ci:<session>:<pr>`
 * (the Pipeline page) and `ci:<repository>:<pr>` (the cockpit's CI block, so
 * another session's tab on the repository draws it at once),
 * `release:<repository>`, `main:<repository>`, `branches:<folder>`, the
 * Pipeline page's `stats:<repository>`, and `work:<repository>` (a
 * repository's entry of the Work answer, for the cockpit's folded Release
 * line); Now's Repos section keeps `repos:now`.
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
  for (const fn of listeners) fn(key)
}

/**
 * Who wants to hear of a new answer: the cockpit's CI block draws from what
 * the deck was told and never asks anything itself.
 */
const listeners = new Set<(key: string) => void>()
export function onDeckAnswer(fn: (key: string) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * A kept copy at least this old is drawn faint while it is read again
 * (owner, 2026-11-20, translated: "I open it, see red, click around and it
 * fixes itself"): younger, it is as good as the answer on its way, and
 * fading it would only flicker.
 */
export const KEPT_FAINT_MS = 15_000

/** When a kept answer was read from GitHub: the daemon's own read time when it says one (a copy it kept while composing a newer one is as old as that), else when it was kept here. */
export function keptAt(a: DeckAnswer<unknown> | undefined): number | undefined {
  if (!a) return undefined
  const d = a.d as { read_at?: number; fetched_at?: number } | null | undefined
  const said = d && typeof d === 'object' ? (d.read_at || d.fetched_at) : undefined
  return said ? Math.min(said, a.at) : a.at
}

/**
 * The keys whose kept copy is on screen, old, while a read of it is under
 * way (lib/usePoll marks them): what draws from such a copy — the CI
 * section, the Release section's CI words — draws it faint, as of its age,
 * until the read lands. A count per key: two polls may ask the same.
 */
const reading = new Map<string, number>()

/** Marks (on) or unmarks a read of key's kept copy under way. */
export function markReading(key: string, on: boolean): void {
  const n = (reading.get(key) ?? 0) + (on ? 1 : -1)
  if (n > 0) reading.set(key, n)
  else reading.delete(key)
  for (const fn of listeners) fn(key)
}

/** Whether key's kept copy is old and being read again (markReading). */
export function isReading(key: string | undefined): boolean {
  return !!key && reading.has(key)
}

/** The key a repository's entry of the Work answer is kept under: the Release section keeps it, the CI section reads its next version. */
export const workRepoKey = (root: string) => `work:${root}`

/** Drops the answers kept in memory (tests). */
export function forgetDeckAnswers(): void {
  mem.clear()
  reading.clear()
}

/** How fresh a shown answer is, in the cell's header: "updated 12 s ago". */
export function freshText(ms: number): string {
  if (ms < 5_000) return 'updated just now'
  if (ms < 60_000) return `updated ${Math.floor(ms / 1000)} s ago`
  if (ms < 3_600_000) return `updated ${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `updated ${Math.floor(ms / 3_600_000)} h ago`
  return `updated ${Math.floor(ms / 86_400_000)} d ago`
}
