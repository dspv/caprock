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
 * State is local — a dismissal is a preference about this browser, not
 * something to send anywhere. Rule 4: all data stays on the machine.
 */

export type PromptKind = 'share-week' | 'share-month' | 'premium-hint' | 'premium-banner'

const KEY = 'caprock-prompts'

const PERIOD_MS: Record<PromptKind, number> = {
  'share-week': 7 * 24 * 60 * 60 * 1000,
  'share-month': 30 * 24 * 60 * 60 * 1000,
  // Dismissed for a month, not a week. This one is an advertisement inside a
  // tool someone installed for its own sake, and the tolerance for seeing it
  // again is lower than for being offered a card of your own numbers.
  'premium-hint': 30 * 24 * 60 * 60 * 1000,
  'premium-banner': 30 * 24 * 60 * 60 * 1000,
}

type Store = Partial<Record<PromptKind, number>>

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Store) : {}
  } catch {
    // A corrupt or unavailable store must not take the dashboard down; the
    // worst case is being asked once more than intended.
    return {}
  }
}

function write(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch { /* private mode, quota — the offer just repeats */ }
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
  const s = { ...read(), [kind]: now }
  if (kind === 'share-month') s['share-week'] = now
  write(s)
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
}
