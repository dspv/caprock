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
import type { History, Summary, Week } from '@/lib/api'
import { planMultiple, type CardPlan } from '@/lib/week'

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

/** A moment worth a share prompt, and the sentence for it. */
export interface Moment {
  kind: Occasion['kind'] | 'week-closed' | 'sessions' | 'tokens' | 'cache'
  line: string
}

const SESSION_STEPS = [100, 500, 1000, 5000, 10_000]
const BILLION = 1_000_000_000

/** A round count crossed recently — within a tenth of the step, as for money. */
function crossed(v: number, steps: number[]): number | undefined {
  const passed = steps.filter((s) => v >= s).pop()
  if (passed === undefined || v - passed > passed * 0.1) return undefined
  return passed
}

/** The week the toast speaks of: the share card's own figures (GET /v1/week?period=7d). */
export type MomentWeek = Pick<Week, 'sessions' | 'cost_usd' | 'prs_merged' | 'days'> & Partial<Pick<Week, 'period'>>

/**
 * The toast's figures, the card's headline in one line: "33× your plan this
 * week · 48 PRs merged", or the dollars at API price without a flat plan.
 */
export function momentFigures(week: MomentWeek, plan?: CardPlan): string {
  const m = planMultiple({ ...week, period: week.period ?? '7d' } as Week, plan)
  const cash = m ? `${m} your plan this week` : `${usd(week.cost_usd)} at API price this week`
  const n = week.prs_merged
  return n > 0 ? `${cash} · ${n.toLocaleString('en-US')} ${n === 1 ? 'PR' : 'PRs'} merged` : cash
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The hour on Sunday, local time, a week is called closed. */
export const WEEK_CLOSES_HOUR = 18

/**
 * When the last week closed: the latest Sunday 18:00 local at or before
 * `now` (owner, 2026-10-25: he shares his week on X and Threads, weekly).
 */
export function weekClosedAt(now: number): number {
  const d = new Date(now)
  const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay(), WEEK_CLOSES_HOUR, 0, 0, 0)
  if (sunday.getTime() > now) sunday.setDate(sunday.getDate() - 7)
  return sunday.getTime()
}

/** How long after the close the first open still offers that week's card. */
export const WEEK_OFFER_MS = 2 * DAY_MS

/**
 * Whether the weekly card is due: a week closed within WEEK_OFFER_MS (Sunday
 * evening, or the first open after it up to Tuesday evening) and the share
 * toast was not answered since. Once per week, whichever way it is answered.
 */
export function weekClosedDue(now: number, lastAnswered: number | undefined): boolean {
  const closed = weekClosedAt(now)
  return now - closed < WEEK_OFFER_MS && !(lastAnswered && lastAnswered >= closed)
}

/**
 * The share toast's occasion. The week that just closed comes first, when
 * `weekly` says it is due (weekClosedDue) and it merged at least one pull
 * request; otherwise, when `milestones` allows, a milestone this machine
 * already measures — a round number of sessions, a billion tokens, a week of
 * 95% cache hits, or one of findOccasion's money moments. Every figure is
 * the reader's own and the card's (hand-run sessions, GitHub's PRs). Nothing
 * to say without a session this week: an empty week is not a card anyone
 * posts.
 */
export function findMoment(
  now: number,
  week: MomentWeek,
  hist: Pick<History, 'totals' | 'daily'> & { summary?: Pick<Summary, 'tokens_in' | 'tokens_out' | 'cache_read' | 'cache_write'> },
  plan?: CardPlan,
  hitRate = 0,
  when: { weekly?: boolean; milestones?: boolean } = { weekly: now - weekClosedAt(now) < WEEK_OFFER_MS, milestones: true },
): Moment | null {
  if (!(week.sessions > 0) || !(week.cost_usd > 0) || !Array.isArray(week.days) || !hist.totals) return null
  const figures = momentFigures(week, plan)
  if (when.weekly && week.prs_merged > 0) return { kind: 'week-closed', line: `Your week is done. ${figures}` }
  if (!when.milestones) return null
  const s = hist.summary
  const tokens = s ? s.tokens_in + s.tokens_out + s.cache_read + s.cache_write : 0
  const sessions = crossed(hist.totals.sessions, SESSION_STEPS)
  const money = findOccasion(hist.totals, hist.daily ?? [], week)
  const lead: Moment | null =
    sessions !== undefined ? { kind: 'sessions', line: `${sessions.toLocaleString('en-US')} sessions with Claude Code.` }
    : tokens >= BILLION && tokens < BILLION * 1.1 ? { kind: 'tokens', line: 'A billion tokens through Claude Code.' }
    : money ? money
    : hitRate >= 0.95 ? { kind: 'cache', line: `${Math.floor(hitRate * 100)}% cache hits.` }
    : null
  if (!lead) return null
  return { kind: lead.kind, line: `${lead.line} ${figures}` }
}
