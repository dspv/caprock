/**
 * When to offer something, and when to shut up about it.
 *
 * The share card only ever appeared at a money milestone — $1,000, $5,000,
 * $10,000. Someone whose spend never reaches a round number was never asked at
 * all, and the offer is worth making to them too: a week of work is a thing
 * people post about, and it does not require having spent four figures.
 *
 * The rule that matters is the second one. An offer that reappears on every
 * page load is a banner people learn not to see, and the fix is not "show it
 * less" but "remember that this person already answered". Dismissing one puts
 * it away for a full period; taking it puts it away too, because someone who
 * just shared this week's numbers has nothing new to share tomorrow.
 *
 * Where the answers live: in the daemon's settings (`prompts`, an id → Unix
 * ms map), mirrored in this browser's storage. The daemon copy is the one
 * that counts — "I starred it" said in the desktop app must hold in a browser
 * tab too, and browser storage is per origin and per window. The local copy
 * is what a test, a paired phone (which may not write settings) or an older
 * daemon falls back to. Nothing leaves the machine either way (rule 4).
 */
import { useSyncExternalStore } from 'react'

export type PromptKind =
  | 'share-week' | 'share-month'
  | 'premium-hint' | 'premium-banner' | 'premium-limit' | 'premium-cap'
  | 'teams-banner' | 'teams-nudge'
  | 'star-dismissed' | 'star-done'

const KEY = 'caprock-prompts'
const DAY = 24 * 60 * 60 * 1000

const PERIOD_MS: Record<PromptKind, number> = {
  'share-week': 7 * DAY,
  'share-month': 30 * DAY,
  // Dismissed for a month, not a week. This one is an advertisement inside a
  // tool someone installed for its own sake, and the tolerance for seeing it
  // again is lower than for being offered a card of your own numbers.
  'premium-hint': 30 * DAY,
  'premium-banner': 30 * DAY,
  // The contextual Premium nudges come back sooner, because they only appear
  // while the problem they answer is happening — a plan window nearly spent,
  // a day well above this machine's normal.
  'premium-limit': 14 * DAY,
  'premium-cap': 14 * DAY,
  'teams-banner': 30 * DAY,
  'teams-nudge': 30 * DAY,
  'star-dismissed': 30 * DAY,
  // "I starred it" is final.
  'star-done': Number.POSITIVE_INFINITY,
}

type Store = Partial<Record<PromptKind, number>>

const listeners = new Set<() => void>()
let persist: ((patch: Store) => void) | null = null

function readLocal(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : {}
    return v && typeof v === 'object' ? (v as Store) : {}
  } catch {
    // A corrupt or unavailable store must not take the dashboard down; the
    // worst case is being asked once more than intended.
    return {}
  }
}

// Read through on every call rather than cached: the store is a few bytes, and
// a cache is one more copy that can disagree with what a test or another tab
// just wrote.
function read(): Store {
  return readLocal()
}

function write(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch { /* private mode, quota — the offer just repeats */ }
  for (const l of listeners) l()
}

/**
 * Merge the daemon's answers in. The later answer wins per prompt, so a
 * dismissal made in one window is never undone by an older one from another.
 */
export function hydratePrompts(remote: Record<string, number> | undefined) {
  if (!remote) return
  const cur = { ...read() }
  let changed = false
  for (const [k, v] of Object.entries(remote)) {
    if (!(k in PERIOD_MS) || typeof v !== 'number') continue
    const kind = k as PromptKind
    if ((cur[kind] ?? 0) < v) { cur[kind] = v; changed = true }
  }
  if (changed) write(cur)
}

/**
 * Turn on writing answers to the daemon. Called once by the dashboard and the
 * app at start; tests never call it, so they stay on browser storage alone.
 */
export function syncPromptsWith(save: (patch: Store) => void) {
  persist = save
}

/** Whether this prompt is due: never answered, or answered a period ago. */
export function isDue(kind: PromptKind, now: number): boolean {
  const last = read()[kind]
  if (!last) return true
  return now - last >= PERIOD_MS[kind]
}

/**
 * Record that the person answered — by taking it or by dismissing it.
 *
 * Answering the monthly offer also answers the weekly one. They show the same
 * kind of thing, so someone who just dismissed "here is your month" does not
 * want "here is your week" tomorrow; without this the two take turns nagging.
 * The reverse does not hold: dismissing a week says nothing about the month.
 */
export function markAnswered(kind: PromptKind, now: number) {
  const patch: Store = { [kind]: now }
  if (kind === 'share-month') patch['share-week'] = now
  write({ ...read(), ...patch })
  try { persist?.(patch) } catch { /* the local copy still holds */ }
}

/**
 * Which offer to make, when more than one is due.
 *
 * Monthly wins: it is the rarer event and the bigger number, and showing both
 * at once is how a dashboard turns into a pile of banners. Answering it also
 * answers the weekly one (see markAnswered), so the two cannot take turns
 * nagging on consecutive days.
 */
export function dueShare(now: number): 'share-week' | 'share-month' | null {
  if (isDue('share-month', now)) return 'share-month'
  if (isDue('share-week', now)) return 'share-week'
  return null
}

/** Clear everything. Exported for tests and for a settings-screen reset. */
export function resetPrompts() {
  try { localStorage.removeItem(KEY) } catch { /* nothing to clear */ }
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/**
 * Re-renders when any answer changes — a dismissal arriving from the daemon
 * after first paint, or one given in another component — and reports whether
 * `kind` is due.
 */
export function usePromptDue(kind: PromptKind, now: number): boolean {
  const last = useSyncExternalStore(subscribe, () => read()[kind] ?? 0)
  return !last || now - last >= PERIOD_MS[kind]
}
