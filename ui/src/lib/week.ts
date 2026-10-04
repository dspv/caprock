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
export function headline(w: Week, when: string): Headline {
  const tail = `${when}.`
  if (w.prs_merged > 0) return { lead: 'My agents shipped', figure: plural(w.prs_merged, 'PR'), tail, led: 'merged', approx: false }
  if (w.prs_opened > 0) return { lead: 'My agents opened', figure: plural(w.prs_opened, 'PR'), tail, led: 'opened', approx: false }
  if (w.commits > 0) return { lead: 'My agents made', figure: plural(w.commits, 'commit'), tail, led: 'commits', approx: false }
  if (w.lines_added > 0) return { lead: 'My agents wrote', figure: `≈${compact(w.lines_added)} lines`, tail, led: 'lines', approx: true }
  if (w.sessions > 0) return { lead: 'My agents ran', figure: plural(w.sessions, 'session'), tail, led: 'sessions', approx: false }
  return { lead: 'A quiet week:', figure: 'no agent activity', tail: '', led: 'none', approx: false }
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

/** "One machine · 12 sessions · 6 days". */
export function eyebrow(w: Week): string {
  const parts = ['One machine']
  if (w.sessions > 0) parts.push(plural(w.sessions, 'session'))
  if (w.active_days > 0) parts.push(plural(w.active_days, 'day'))
  return parts.join(' · ')
}

export interface SideStat { value: string; label: string; approx?: boolean }

/** The three figures beside the headline. Money first, then what it bought. */
export function sideStats(w: Week): SideStat[] {
  const out: SideStat[] = []
  if (w.cost_usd > 0) out.push({ value: money(w.cost_usd), label: 'at API list price' })
  if (w.cost_per_merged_pr && w.prs_merged > 0) out.push({ value: money(w.cost_per_merged_pr), label: 'per merged PR', approx: true })
  if (w.tax && w.tax.share > 0) out.push({ value: `${Math.round(w.tax.share)}%`, label: 'of it re-reading context' })
  if (out.length < 3 && w.turns > 0) out.push({ value: compact(w.turns), label: 'turns' })
  if (out.length < 3 && w.active_days > 0) out.push({ value: String(w.active_days), label: w.active_days === 1 ? 'active day' : 'active days' })
  return out.slice(0, 3)
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
  const order = ['claude', 'codex', 'opencode', 'gemini', 'deepseek']
  const agents = [...by.keys()].sort((a, b) => (order.indexOf(a) + 99 * +(order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * +(order.indexOf(b) < 0)))
  for (const agent of agents) {
    const a = by.get(agent)!
    if (a.turns <= 0) continue
    let bit = plural(a.sessions, 'session')
    let bitLong = `${cap(plural(a.sessions, 'session'))}${a.subThreads > 0 ? `, ${plural(a.subThreads, 'sub-agent')} of its own` : ''}.`
    if (agent === 'claude') {
      if (w.ci_wait_ms >= 360_000) {
        bit = `${hours(w.ci_wait_ms)} watching CI`
        bitLong = `${w.prs_opened > 0 ? `Opened ${plural(w.prs_opened, 'PR')} with its helpers. ` : ''}Spent ${hours(w.ci_wait_ms)} of tool time watching CI.`
      } else if (w.prs_opened > 0) {
        bit = `opened ${plural(w.prs_opened, 'PR')}`
        bitLong = `Opened ${plural(w.prs_opened, 'PR')} with its helpers.`
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
export function biggestSentence(w: Week): { lead: string; cost: string; share: string } | null {
  const b = w.biggest
  if (!b || w.cost_usd <= 0 || w.sessions < 2) return null
  const share = Math.round((100 * b.cost_usd) / w.cost_usd)
  const days = ['', 'one day', 'two days', 'three days', 'four days', 'five days', 'six days', 'seven days'][b.active_days] ?? `${b.active_days} days`
  return { lead: `One ${agentName(b.agent)} session, ${days},`, cost: money(b.cost_usd), share: `${share}% of the week.` }
}

/** The bar strip: PRs opened per day, or the cost per day when no PR was opened. */
export function dayBars(w: Week): { label: string; values: number[]; format: (v: number) => string } {
  if (w.prs_opened > 0) return { label: 'PRs opened per day', values: w.days.map((d) => d.prs_opened), format: (v) => String(v) }
  return { label: 'Cost per day', values: w.days.map((d) => d.cost_usd), format: money }
}

/** "Sat → Fri". */
export function weekdaySpan(w: Week): string {
  const f = (d: string) => parseDay(d).toLocaleDateString('en-US', { weekday: 'short' })
  return `${f(w.start)} → ${f(w.end)}`
}
