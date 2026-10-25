/**
 * Plan figures: what a cost at API list price was in subscription terms.
 *
 *   $50 at API · ≈$5 of plan · ≈8% of a week
 *
 * The daemon computes the rates once, per sign-in (GET /v1/plan-share,
 * internal/planshare): plan dollars per API dollar from the trailing 30 days,
 * and a week's percent per API dollar from one weekly limit window. A figure
 * carries its cost split by the sign-in each session ran on (`parts`), and
 * this file prices it — the one place every screen does, so the arithmetic
 * and the words cannot drift (owner, 2026-10-25). Both are estimates
 * (rule 6), and the explanation says how each was made and why it runs a
 * little high: use outside Caprock draws on the same plan and limit. Pure;
 * the rates are read once per page by lib/planRates.ts.
 */
/** A cost on one sign-in: an agent and the subscription its sessions recorded ("" the own sign-in). */
export interface SpendPart {
  agent: string
  subscription: string
  cost_usd: number
}

export interface PlanRate {
  label?: string
  usd_per_month: number
  /** Days of the trailing period the sign-in was recorded for. */
  days: number
  fee_usd: number
  api_usd: number
  from: number
  to: number
  /** Plan dollars per API dollar. */
  factor: number
}

export interface WeekRate {
  /** The calibrated window's end, unix seconds. */
  resets_at: number
  completed: boolean
  from: number
  to: number
  used_points: number
  api_usd: number
  /** A week's percent per API dollar. */
  pct_per_usd: number
}

export interface SignInRate {
  agent: string
  subscription: string
  label: string
  plan_kind: string
  plan?: PlanRate
  plan_note?: string
  week?: WeekRate
  week_note?: string
}

/** GET /v1/plan-share. */
export interface PlanRates {
  computed_at: number
  plan_days: number
  rates: SignInRate[]
}

const fin = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A figure's parts, read defensively: an older daemon sends none. */
export function asSpendParts(v: unknown): SpendPart[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((p) => p && typeof p === 'object' && typeof p.agent === 'string')
    .map((p) => ({ agent: p.agent as string, subscription: typeof p.subscription === 'string' ? p.subscription : '', cost_usd: fin(p.cost_usd) }))
    .filter((p) => p.cost_usd > 0)
  return out.length ? out : undefined
}

/** The one part a single session is. */
export function sessionParts(s: { agent?: string; subscription?: string; stats?: { cost_usd?: number } }): SpendPart[] | undefined {
  const c = fin(s.stats?.cost_usd)
  return c > 0 ? [{ agent: s.agent || 'claude', subscription: s.subscription || '', cost_usd: c }] : undefined
}

/** The rates read defensively: an odd answer is none, never a crash. */
export function asRates(v: unknown): PlanRates | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Partial<PlanRates>
  if (!Array.isArray(o.rates)) return undefined
  const rates: SignInRate[] = []
  for (const r of o.rates) {
    if (!r || typeof r !== 'object' || typeof r.agent !== 'string') continue
    const plan = r.plan && fin(r.plan.factor) > 0 ? { ...r.plan, factor: fin(r.plan.factor) } : undefined
    const week = r.week && fin(r.week.pct_per_usd) > 0 ? { ...r.week, pct_per_usd: fin(r.week.pct_per_usd) } : undefined
    rates.push({ agent: r.agent, subscription: typeof r.subscription === 'string' ? r.subscription : '', label: typeof r.label === 'string' ? r.label : '',
      plan_kind: typeof r.plan_kind === 'string' ? r.plan_kind : '', plan, plan_note: r.plan_note, week, week_note: r.week_note })
  }
  return { computed_at: fin(o.computed_at), plan_days: fin(o.plan_days) || 30, rates }
}

/** One sign-in's share of its own week. */
export interface WeekShare {
  rate: SignInRate
  /** Percent of that sign-in's week; may pass 100 (a release spanning weeks). */
  pct: number
  /** The API dollars it is of. */
  cost_usd: number
}

/** A figure in subscription terms. Absent fields have no estimate. */
export interface PlanShare {
  total_usd: number
  /** Plan dollars of the parts on a flat plan with a known factor. */
  plan_usd?: number
  /** The API dollars plan_usd prices; less than total_usd when `partial`. */
  covered_usd: number
  /** Some of the cost ran where no plan price is stated (or is metered):
   *  plan_usd is a floor and is drawn with a "+". */
  partial: boolean
  /** The parts with no plan figure, and why. */
  uncovered: { rate?: SignInRate; part: SpendPart }[]
  /** One per sign-in with a weekly rate, largest first. Different sign-ins'
   *  weeks are different limits and are never added together. */
  weeks: WeekShare[]
  /** The rate of every sign-in that priced something, for the explanation. */
  priced: SignInRate[]
}

/** Below this share of the figure, an unpriced remainder is rounding, not a gap. */
const PARTIAL_EPS = 0.005
/** Under this share covered, a plan figure would say more about what is missing than what is there. */
const MIN_COVERED = 0.5

/**
 * Price a figure's parts by the rates. undefined when there is nothing to
 * say: no rates, no parts, or no part on a sign-in with either rate.
 */
export function planShare(rates: PlanRates | undefined, parts: SpendPart[] | undefined): PlanShare | undefined {
  if (!rates || !parts?.length) return undefined
  const by = new Map(rates.rates.map((r) => [`${r.agent}|${r.subscription}`, r]))
  let total = 0, covered = 0, plan = 0
  const uncovered: PlanShare['uncovered'] = []
  const weeks = new Map<string, WeekShare>()
  const priced = new Map<string, SignInRate>()
  for (const p of parts) {
    if (!(p.cost_usd > 0)) continue
    total += p.cost_usd
    const key = `${p.agent || 'claude'}|${p.subscription || ''}`
    const r = by.get(key)
    if (r?.plan) {
      plan += p.cost_usd * r.plan.factor
      covered += p.cost_usd
      priced.set(key, r)
    } else {
      uncovered.push({ rate: r, part: p })
    }
    if (r?.week) {
      const w = weeks.get(key) ?? { rate: r, pct: 0, cost_usd: 0 }
      w.pct += p.cost_usd * r.week.pct_per_usd
      w.cost_usd += p.cost_usd
      weeks.set(key, w)
      priced.set(key, r)
    }
  }
  if (!(total > 0)) return undefined
  const hasPlan = covered > 0 && covered / total >= MIN_COVERED
  const share: PlanShare = {
    total_usd: total,
    plan_usd: hasPlan ? plan : undefined,
    covered_usd: hasPlan ? covered : 0,
    partial: hasPlan && (total - covered) / total > PARTIAL_EPS,
    uncovered,
    weeks: [...weeks.values()].sort((a, b) => b.pct - a.pct),
    priced: [...priced.values()],
  }
  if (share.plan_usd === undefined && share.weeks.length === 0) return undefined
  return share
}

/** Plan dollars, short: a secondary figure, never wider than the one it sits under. */
export function fmtPlanUSD(v: number): string {
  if (v > 0 && v < 0.01) return '<$0.01'
  if (v < 100) return `$${v.toFixed(2)}`
  if (v < 1000) return `$${Math.round(v)}`
  if (v < 100_000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `$${Math.round(v / 1000)}k`
}

/** A share of a week: one decimal under 10%, whole above; never rounded to a misleading 0. */
export function fmtWeekPct(v: number): string {
  if (v > 0 && v < 0.1) return '<0.1%'
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, '')}%`
  return `${Math.round(v).toLocaleString('en-US')}%`
}

/** "≈" before an estimate, but not before a "<" bound, which already says it is not exact. */
const approx = (t: string) => (t.startsWith('<') ? t : `≈${t}`)

/** How a week is named when a figure spans several sign-ins. */
function weekOwner(w: WeekShare, all: WeekShare[]): string {
  if (all.length < 2) return 'a week'
  const agents = new Set(all.map((x) => x.rate.agent))
  if (agents.size > 1) return `a ${w.rate.agent === 'codex' ? 'Codex' : w.rate.agent === 'claude' ? 'Claude' : w.rate.agent} week`
  return `${w.rate.label || 'its'} week`
}

/** The most week shares drawn on the line; the rest are in the explanation. */
export const WEEKS_SHOWN = 2

/** The figure's pieces as the line draws them, in order. */
export function planShareItems(s: PlanShare): string[] {
  const out: string[] = []
  if (s.plan_usd !== undefined) out.push(`${approx(fmtPlanUSD(s.plan_usd))}${s.partial ? '+' : ''} of plan`)
  for (const w of s.weeks.slice(0, WEEKS_SHOWN)) out.push(`${approx(fmtWeekPct(w.pct))} of ${weekOwner(w, s.weeks)}`)
  return out
}

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
const signIn = (r: SignInRate) => `${r.agent === 'codex' ? 'Codex' : r.agent === 'claude' ? 'Claude Code' : r.agent}${r.label ? ` (${r.label})` : ''}`

/** Why a sign-in priced nothing, in words. */
function noPlanWhy(r: SignInRate | undefined): string {
  if (!r) return 'which Caprock has no plan for'
  if (r.plan_note === 'metered') return 'billed per token, so its API figure is the bill'
  if (r.plan_note === 'no_spend') return 'with no spend recorded in the last 30 days'
  return 'with no plan price stated'
}

/** The explanation, as lines: what each figure is, from what, over when, and why it runs high. */
export function planShareLines(s: PlanShare, days = 30): string[] {
  const out: string[] = ['Estimates from what Caprock recorded on this computer.']
  if (s.plan_usd !== undefined) {
    out.push(`${approx(fmtPlanUSD(s.plan_usd))}${s.partial ? '+' : ''} of plan: ${usd(s.covered_usd)} at API list price, at what your plan cost per API dollar of work.`)
    for (const r of s.priced) {
      if (!r.plan) continue
      const p = r.plan
      const span = p.days < days - 0.5 ? `the ${Math.round(p.days)} days recorded (${day(p.from)}–${day(p.to)})` : `the last ${days} days (${day(p.from)}–${day(p.to)})`
      out.push(`${signIn(r)}: ${p.label || 'the plan'} at ${usd(p.usd_per_month)}/mo is ${usd(p.fee_usd)} over ${span}, against ${usd(p.api_usd)} of work at API list price — ≈$${p.factor < 0.1 ? p.factor.toFixed(3) : p.factor.toFixed(2)} of plan per API dollar.`)
    }
    if (s.partial) {
      const rest = s.uncovered.map((u) => `${usd(u.part.cost_usd)} on ${u.rate ? signIn(u.rate) : u.part.agent}, ${noPlanWhy(u.rate)}`)
      out.push(`Not in it (hence the +): ${rest.join('; ')}.`)
    }
  }
  for (const w of s.weeks) {
    const k = w.rate.week!
    const when = k.completed ? `the week that ended ${day(k.resets_at * 1000)}` : `this week so far (it resets ${day(k.resets_at * 1000)})`
    out.push(`${approx(fmtWeekPct(w.pct))} of ${signIn(w.rate)}'s weekly limit: in ${when}, ${Math.round(k.used_points)} points of it went on ${usd(k.api_usd)} of work at API list price — ≈${fmtWeekPct(k.pct_per_usd * 100)} per $100.${w.pct > 100 ? ' Over 100%: this took more than a week’s limit.' : ''}`)
  }
  out.push('Use outside Caprock — claude.ai chats, another computer — shares the same plan and limits without being recorded here, so these figures run a little high.')
  return out
}

/** The explanation as one string, for a row whose own tooltip carries it. */
export function planShareTitle(s: PlanShare, days = 30): string {
  return planShareLines(s, days).join('\n')
}
