/**
 * When the dashboard says "these are good numbers, show them off".
 *
 * The share button itself is always there — someone who wants to post their
 * figures should never have to wait for permission, and whether they are worth
 * posting is their call. This is the extra nudge, for the moments a person
 * might not notice they have something worth saying.
 *
 * Three occasions, chosen because each one happens to a different kind of
 * user: a round number rewards heavy use, the first full week arrives for
 * everybody exactly once, and a record week reaches people whose spend never
 * lands on a round figure.
 */
import type { History, Summary } from '@/lib/api'

export interface Occasion {
  /** Which occasion, so the prompt can be shown once per kind. */
  kind: 'milestone' | 'first-week' | 'record-week'
  /** The sentence, in the user's own numbers. */
  line: string
}

const STEPS = [1000, 5000, 10_000, 25_000, 50_000, 100_000]

const usd = (v: number) =>
  v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`

/**
 * A round number crossed recently.
 *
 * "Recently" is within a tenth of the step: crossing $10,000 is worth saying
 * for a while, but by $12,000 the moment has gone and a banner still shouting
 * about it is noise.
 */
function milestone(cost: number): Occasion | null {
  const passed = STEPS.filter((v) => cost >= v).pop()
  if (passed === undefined) return null
  if (cost - passed > passed * 0.1) return null
  return { kind: 'milestone', line: `You just passed ${usd(passed)} of Claude Code.` }
}

/** The first full week of data — the first moment there is a shape to show. */
function firstWeek(days: number, cost: number): Occasion | null {
  if (days < 7 || days > 10) return null
  return { kind: 'first-week', line: `A week of Claude Code: ${usd(cost)} measured.` }
}

/**
 * A week that beat every week before it — by enough to mean something.
 *
 * A bare "highest ever" fires almost every week while usage is growing, and a
 * prompt that appears every week is one people stop reading. Twenty per cent
 * clear of the previous best is a jump somebody would actually mention.
 */
function recordWeek(weeks: number[]): Occasion | null {
  if (weeks.length < 3) return null
  const [current, ...rest] = weeks
  if (current === undefined) return null
  const best = Math.max(...rest)
  if (best <= 0 || current < best * 1.2) return null
  return { kind: 'record-week', line: `Your biggest week yet: ${usd(current)}.` }
}

/** Weekly totals, newest first, from the daily series. */
export function weeklyTotals(daily: { day: string; cost_usd: number }[]): number[] {
  const byDay = new Map<string, number>()
  for (const d of daily) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.cost_usd)
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  const weeks: number[] = []
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7).reduce((a, d) => a + d[1], 0))
  }
  return weeks
}

/**
 * The occasion worth mentioning, if there is one.
 *
 * Order is deliberate: a milestone is the rarest and the most specific, so it
 * wins; the first week only ever fires once; a record week is the fallback
 * that reaches everyone else.
 */
export function findOccasion(
  totals: History['totals'],
  daily: { day: string; cost_usd: number }[],
  week: Pick<Summary, 'cost_usd'>,
): Occasion | null {
  if (totals.sessions === 0 || totals.cost_usd <= 0) return null
  return (
    milestone(totals.cost_usd)
    ?? firstWeek(totals.days, week.cost_usd)
    ?? recordWeek(weeklyTotals(daily))
  )
}
