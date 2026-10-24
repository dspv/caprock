/**
 * What the Week card says, decided from the measured week.
 *
 * Kept apart from the drawing so the rules are testable: which figure leads,
 * what is left out when it is zero, and where a "≈" goes. Two rules matter most.
 *
 *   - A figure that is not measured is not on the card. Nothing is filled in,
 *     and a zero is never the headline: a week without a merged PR leads with
 *     what it did do.
 *   - Nothing on the card names a repository, a path, a prompt or a session
 *     title. The API does not send them, and nothing here asks for them.
 */
import type { Week, WeekAgent, WeekLoop } from '@/lib/api'
import { agentName, characterFor, type Character } from '@/components/Characters'

/** "13.8k", "961", "1.2M" — the compact form a card can carry. */
export function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e4) return `${trim(n / 1e3)}k`
  if (a >= 1e3) return `${trim(n / 1e3, 1)}k`
  return new Intl.NumberFormat('en-US').format(Math.round(n))
}

function trim(v: number, digits = 1): string {
  return v.toFixed(digits).replace(/\.0$/, '')
}

/** Whole dollars from $10 up, cents below, "4¢" under a dollar. */
export function money(v: number): string {
  if (v >= 10) return `$${new Intl.NumberFormat('en-US').format(Math.round(v))}`
  if (v >= 1) return `$${v.toFixed(2)}`
  if (v >= 0.01) return `${Math.round(v * 100)}¢`
  if (v > 0) return '<1¢'
  return '$0'
}

/** "Sep 27 – Oct 3, 2026". */
export function rangeLabel(start: string, end: string): string {
  const a = parseDay(start)
  const b = parseDay(end)
  const md = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (start === end) return `${md(a)}, ${a.getFullYear()}`
  const sameYear = a.getFullYear() === b.getFullYear()
  return `${md(a)}${sameYear ? '' : `, ${a.getFullYear()}`} – ${md(b)}, ${b.getFullYear()}`
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day)
  d.setDate(d.getDate() + n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A named window the card can be drawn for, as the share dialog names them. */
export type StoryPeriod = 'today' | '7d' | '30d' | 'all'

/**
 * How the card speaks about a window: the words after the headline figure
 * ("this week."), the noun a share is "of" ("91% of the week."), and the
 * word a quiet window starts with ("A quiet day:").
 *
 * "this month" is the last 30 days, the same days the share dialog's month
 * and the Cost screen's 30d range cover; the card prints the dates, so the
 * reader is never left to guess which 30.
 */
export interface PeriodWords { when: string; noun: string }

export function periodWords(period: StoryPeriod): PeriodWords {
  switch (period) {
    case 'today': return { when: 'today', noun: 'day' }
    case '30d': return { when: 'this month', noun: 'month' }
    case 'all': return { when: '— all time', noun: 'total' }
    default: return { when: 'this week', noun: 'week' }
  }
}

/** "this week" for a window that reaches into the last seven days, else "that week". */
export function weekWord(w: Week, today: string): string {
  return w.end >= addDays(today, -6) ? 'this week' : 'that week'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${new Intl.NumberFormat('en-US').format(n)} ${n === 1 ? one : many}`
}

export interface Headline {
  /** Before the highlighted figure: "My agents shipped". */
  lead: string
  /** The highlighted figure: "126 PRs". */
  figure: string
  /** After it: "this week." */
  tail: string
  /** Which measurement led, so the tally does not repeat it. */
  led: 'merged' | 'opened' | 'commits' | 'lines' | 'sessions' | 'none'
  approx: boolean
}

/**
 * The headline leads with the strongest thing the week measured. Merged pull
 * requests first; a week with none falls back through opened, commits, lines
 * and sessions, so the card never shouts "0 PRs".
 */
export function headline(w: Week, when: string, noun = 'week'): Headline {
  const tail = `${when}.`
  if (w.prs_merged > 0) return { lead: 'My agents shipped', figure: plural(w.prs_merged, 'PR'), tail, led: 'merged', approx: false }
  if (w.prs_opened > 0) return { lead: 'My agents opened', figure: plural(w.prs_opened, 'PR'), tail, led: 'opened', approx: false }
  if (w.commits > 0) return { lead: 'My agents made', figure: plural(w.commits, 'commit'), tail, led: 'commits', approx: false }
  if (w.lines_added > 0) return { lead: 'My agents wrote', figure: `≈${compact(w.lines_added)} lines`, tail, led: 'lines', approx: true }
  if (w.sessions > 0) return { lead: 'My agents ran', figure: plural(w.sessions, 'session'), tail, led: 'sessions', approx: false }
  return { lead: `A quiet ${noun === 'total' ? 'machine' : noun}:`, figure: 'no agent activity', tail: '', led: 'none', approx: false }
}

export interface TallyItem { value: string; label: string; approx?: boolean }

/** The line under the headline: every other non-zero count, in a fixed order. */
export function tally(w: Week, led: Headline['led']): TallyItem[] {
  const out: TallyItem[] = []
  if (led === 'merged' && w.prs_opened > 0) out.push({ value: compact(w.prs_opened), label: 'opened' })
  if (led !== 'commits' && w.commits > 0) out.push({ value: compact(w.commits), label: w.commits === 1 ? 'commit' : 'commits' })
  if (w.files_edited > 0) out.push({ value: compact(w.files_edited), label: w.files_edited === 1 ? 'file' : 'files' })
  if (led !== 'lines' && w.lines_added > 0) out.push({ value: compact(w.lines_added), label: 'lines', approx: true })
  // Turns are not repeated here: the side column falls back to them when it
  // has a free slot, and one figure printed twice reads as padding.
  return out
}

/** "One machine · 12 hand-run sessions · 6 days". */
export function eyebrow(w: Week): string {
  const parts = ['One machine']
  if (w.sessions > 0) parts.push(plural(w.sessions, (w.scheduled_sessions ?? 0) > 0 ? 'hand-run session' : 'session'))
  if (w.active_days > 0) parts.push(plural(w.active_days, 'day'))
  return parts.join(' · ')
}

export interface SideStat { value: string; label: string; approx?: boolean }

/** The plan the user said they are on (Settings → plan), when they said. */
export interface CardPlan { kind: 'flat' | 'metered'; label: string; usdPerMonth: number }

/** The stated plan from GET /v1/settings, or undefined when none was stated. */
export function planOf(s: { plan_kind?: string; plan_label?: string; plan_usd_per_month?: number } | undefined): CardPlan | undefined {
  if (!s || (s.plan_kind !== 'flat' && s.plan_kind !== 'metered')) return undefined
  return { kind: s.plan_kind, label: s.plan_label ?? '', usdPerMonth: s.plan_usd_per_month ?? 0 }
}

/**
 * The multiple of a flat plan's fee the window's work came to at API list
 * prices — "33×" — or undefined where it is not honest: no flat plan with a
 * price, a window that is not a week or a month (a day's share of a monthly
 * fee is not a thing anyone pays; all time has no known start), or under
 * 1.5× (the dollars say it better). Never "saved".
 */
export function planMultiple(w: Week, plan: CardPlan | undefined): string | undefined {
  if (!plan || plan.kind !== 'flat' || !(plan.usdPerMonth > 0) || !(w.cost_usd > 0)) return undefined
  const days = w.days.length
  if (w.period === 'all' || w.period === 'today' || (days !== 7 && days !== 30)) return undefined
  const m = w.cost_usd / ((plan.usdPerMonth * days) / 30)
  if (m < 1.5) return undefined
  return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}×`
}

/** One of the card's two big figures and what it is. */
export interface Hero { figure: string; label: string; approx?: boolean }

/** "the $200/mo Max plan". */
function planWords(plan: CardPlan): string {
  return `the ${money(plan.usdPerMonth)}/mo ${plan.label ? `${plan.label} plan` : 'plan'}`
}

/**
 * The two big figures, the same on both layouts (owner, 2026-10-25: the
 * landscape card led with the multiple and the portrait one with PRs, so
 * the format changed the message). First the money: the multiple of the
 * stated flat plan where planMultiple allows it, else the dollars at API
 * list price. Then what it bought: merged pull requests, or — never a zero —
 * the strongest thing the window did measure.
 */
export function heroes(w: Week, plan: CardPlan | undefined): [Hero, Hero] {
  const m = planMultiple(w, plan)
  const cash: Hero = m && plan
    ? { figure: m, label: `${planWords(plan)}, at API list prices` }
    : { figure: money(w.cost_usd), label: 'at API list prices — not a bill' }
  const h = headline(w, '')
  let work: Hero
  switch (h.led) {
    case 'merged': work = { figure: new Intl.NumberFormat('en-US').format(w.prs_merged), label: w.prs_merged === 1 ? 'PR merged' : 'PRs merged' }; break
    case 'opened': work = { figure: new Intl.NumberFormat('en-US').format(w.prs_opened), label: w.prs_opened === 1 ? 'PR opened' : 'PRs opened' }; break
    case 'commits': work = { figure: compact(w.commits), label: w.commits === 1 ? 'commit' : 'commits' }; break
    case 'lines': work = { figure: compact(w.lines_added), label: 'lines written', approx: true }; break
    case 'sessions': work = { figure: compact(w.sessions), label: w.sessions === 1 ? 'session' : 'sessions' }; break
    default: work = { figure: '0', label: 'sessions' }
  }
  return [cash, work]
}

/**
 * The row of figures under the two big ones: the cost per merged pull
 * request first, then the dollars when the multiple led, the pull requests
 * opened, the share re-reading context; turns and active days fill a free
 * slot. At most four.
 */
export function sideStats(w: Week, plan?: CardPlan): SideStat[] {
  const out: SideStat[] = []
  const multiple = !!planMultiple(w, plan)
  if (w.cost_per_merged_pr && w.prs_merged > 0) out.push({ value: money(w.cost_per_merged_pr), label: 'per merged PR', approx: true })
  if (multiple) out.push({ value: money(w.cost_usd), label: 'at API list price' })
  if (w.prs_merged > 0 && w.prs_opened > 0) out.push({ value: compact(w.prs_opened), label: w.prs_opened === 1 ? 'PR opened' : 'PRs opened' })
  if (w.tax && w.tax.share > 0) out.push({ value: `${Math.round(w.tax.share)}%`, label: 'of it re-reading context' })
  if (out.length < 4 && w.turns > 0) out.push({ value: compact(w.turns), label: 'turns' })
  if (out.length < 4 && w.active_days > 0) out.push({ value: String(w.active_days), label: w.active_days === 1 ? 'active day' : 'active days' })
  return out.slice(0, 4)
}

/**
 * The card's footnote: where the pull requests came from, that scheduled
 * runs are left out, and the two caveats. Short — it is set in 14 px mono.
 */
export function footNote(w: Week): string {
  const parts: string[] = ['measured locally']
  if (w.prs_merged > 0 || w.prs_opened > 0) {
    parts.push(w.prs_source === 'github' ? 'PRs from GitHub'
      : w.prs_source === 'both' ? 'PRs from GitHub + agent merges'
      : 'PRs = merges the agents ran')
  }
  if ((w.scheduled_sessions ?? 0) > 0) parts.push('hand-run sessions')
  parts.push('≈ = estimate', 'API list prices, not a bill')
  return parts.join(' · ')
}

export interface CrewMember {
  who: Character
  name: string
  turns: number
  cost: number
  /** One line about what it did; short for the landscape card. */
  bit: string
  bitLong: string
}

function hours(ms: number): string {
  const h = ms / 3_600_000
  return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`
}

/**
 * Who did what. Claude Code's main threads and its subagents are two members;
 * every other agent is one, its own subagents folded in — the card has room
 * for one line each, and only Claude Code's subagents are numerous enough to
 * be a character of their own.
 */
export function crew(w: Week): CrewMember[] {
  const by = new Map<string, WeekAgent & { subThreads: number }>()
  let claudeSubs: WeekAgent | undefined
  for (const a of w.agents) {
    if (a.agent === 'claude' && a.subagent) { claudeSubs = a; continue }
    const cur = by.get(a.agent)
    if (cur) {
      cur.turns += a.turns
      cur.cost_usd += a.cost_usd
      if (a.subagent) cur.subThreads += a.threads ?? 0
      else cur.sessions = Math.max(cur.sessions, a.sessions)
    } else {
      by.set(a.agent, { ...a, subagent: false, sessions: a.subagent ? 0 : a.sessions, subThreads: a.subagent ? a.threads ?? 0 : 0 })
    }
  }
  const out: CrewMember[] = []
  const order = ['claude', 'codex', 'opencode', 'gemini', 'deepseek', 'hermes']
  const agents = [...by.keys()].sort((a, b) => (order.indexOf(a) + 99 * +(order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * +(order.indexOf(b) < 0)))
  for (const agent of agents) {
    const a = by.get(agent)!
    if (a.turns <= 0) continue
    let bit = plural(a.sessions, 'session')
    let bitLong = `${cap(plural(a.sessions, 'session'))}${a.subThreads > 0 ? `, ${plural(a.subThreads, 'sub-agent')} of its own` : ''}.`
    // GitHub's count is everyone's pull requests, not Claude Code's: only the
    // agents' own count may be said to be what it opened.
    const opened = w.prs_source === 'github' || w.prs_source === 'both' ? 0 : w.prs_opened
    if (agent === 'claude') {
      if (w.ci_wait_ms >= 360_000) {
        bit = `${hours(w.ci_wait_ms)} watching CI`
        bitLong = `${opened > 0 ? `Opened ${plural(opened, 'PR')} with its helpers. ` : ''}Spent ${hours(w.ci_wait_ms)} of tool time watching CI.`
      } else if (opened > 0) {
        bit = `opened ${plural(opened, 'PR')}`
        bitLong = `Opened ${plural(opened, 'PR')} with its helpers.`
      }
    }
    out.push({ who: characterFor(agent), name: agentName(agent), turns: a.turns, cost: a.cost_usd, bit, bitLong })
    if (agent === 'claude' && claudeSubs && claudeSubs.turns > 0) {
      const n = claudeSubs.threads ?? 0
      out.push({
        who: 'crowd',
        name: n > 0 ? plural(n, 'subagent') : 'Subagents',
        turns: claudeSubs.turns,
        cost: claudeSubs.cost_usd,
        bit: 'sent by Claude Code',
        bitLong: 'Sent off by Claude Code to work beside it.',
      })
    }
  }
  return out
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "72 s", "7 min", "1 h 5 min". */
export function span(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 120) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/** What the loop did, as a sentence a card can carry without quoting it. */
export function loopSentence(l: WeekLoop): { what: string; count: string } {
  const who = agentName(l.agent)
  const what: Record<string, string> = {
    // An episode can span several jobs, so it is never "a job".
    poll: `${who} kept asking “done yet?”`,
    input: `${who} typed into a running job`,
    command: `${who} ran the same command`,
    edit: `${who} rewrote the same file`,
    fetch: `${who} fetched the same page`,
    subagent: `${who} sent the same subagent`,
  }
  return {
    what: what[l.kind] ?? `${who} repeated one ${l.tool} call`,
    count: `${l.calls}× in ${span(l.last_ms - l.first_ms)}`,
  }
}

/** "One Claude Code session, five days, $431. 91% of the week." */
export function biggestSentence(w: Week, noun = 'week'): { lead: string; cost: string; share: string } | null {
  const b = w.biggest
  if (!b || w.cost_usd <= 0 || w.sessions < 2) return null
  const share = Math.round((100 * b.cost_usd) / w.cost_usd)
  const days = ['', 'one day', 'two days', 'three days', 'four days', 'five days', 'six days', 'seven days'][b.active_days] ?? `${b.active_days} days`
  return { lead: `One ${agentName(b.agent)} session, ${days},`, cost: money(b.cost_usd), share: `${share}% of the ${noun}.` }
}

export interface BarStrip {
  label: string
  values: number[]
  /** One short label per column: a day of the month, a week's first day, a month. */
  ticks: string[]
  /** What the strip spans: "Sat → Fri", "Sep 5 → Oct 4", "Oct 2025 → Oct 2026". */
  span: string
  format: (v: number) => string
}

/**
 * The bar strip: PRs opened per column, or the cost when no PR was opened.
 *
 * Seven days are seven columns. A longer window is folded so the card keeps
 * room for its figures: up to five weeks into weeks (counted back from the
 * last day, so the newest column is a whole week and the oldest may be
 * short), anything longer into calendar months. Folding sums; nothing is
 * averaged or filled in. A single day has no strip.
 */
export function dayBars(w: Week): BarStrip {
  const prs = w.prs_opened > 0
  const pick = (d: Week['days'][number]) => (prs ? d.prs_opened : d.cost_usd)
  const unit = w.days.length <= 7 ? 'day' : w.days.length <= 35 ? 'week' : 'month'
  const label = `${prs ? 'PRs opened' : 'Cost'} per ${unit}`
  const format = prs ? (v: number) => String(v) : money
  if (unit === 'day') {
    return { label, values: w.days.map(pick), ticks: w.days.map((d) => String(Number(d.day.slice(8)))), span: weekdaySpan(w), format }
  }
  const groups: { first: string; value: number }[] = []
  if (unit === 'week') {
    for (let end = w.days.length; end > 0; end -= 7) {
      const part = w.days.slice(Math.max(0, end - 7), end)
      groups.unshift({ first: part[0]!.day, value: part.reduce((a, d) => a + pick(d), 0) })
    }
  } else {
    for (const d of w.days) {
      const month = d.day.slice(0, 7)
      const last = groups[groups.length - 1]
      if (last && last.first.slice(0, 7) === month) last.value += pick(d)
      else groups.push({ first: d.day, value: pick(d) })
    }
  }
  const md = (day: string) => parseDay(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const mon = (day: string) => parseDay(day).toLocaleDateString('en-US', { month: 'short' })
  const monY = (day: string) => parseDay(day).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  return {
    label,
    values: groups.map((g) => g.value),
    ticks: groups.map((g) => (unit === 'week' ? md(g.first) : mon(g.first))),
    span: unit === 'week' ? `${md(w.start)} → ${md(w.end)}` : `${monY(w.start)} → ${monY(w.end)}`,
    format,
  }
}

/** "Sat → Fri". */
export function weekdaySpan(w: Week): string {
  const f = (d: string) => parseDay(d).toLocaleDateString('en-US', { weekday: 'short' })
  return `${f(w.start)} → ${f(w.end)}`
}
