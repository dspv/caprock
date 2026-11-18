/**
 * EXAMPLE DATA for the subscription-pool mockups (branch mock/subscription-pool).
 * Every figure here is invented to show a layout; none is measured. Each one
 * stands for a field Caprock already serves (GET /v1/subscriptions,
 * GET /v1/settings limit_action/limit_fallbacks) unless marked GAP.
 */

export type Agent = 'claude' | 'codex'

export interface Win {
  /** used_percentage of the window's latest reading */
  used: number
  /** resets_at, as the screen prints it */
  resets: string
  /** countdown to resets_at */
  inText: string
  /** resets_at is already past: the reading says nothing about now. The
   *  window has reopened since; Auto counts it as 0% used (an inference). */
  passed?: boolean
}

export interface Sub {
  id: string
  agent: Agent
  label: string
  account?: string
  plan?: string
  /** the own sign-in (id "default") */
  own?: boolean
  /** Make default: where new sessions start when none is picked */
  preferred?: boolean
  signedIn: boolean
  five?: Win
  week?: Win
  /** observed_at of the newest window, as an age */
  seen?: string
  /** sessions_7d and cost_7d_usd (trailing 7 days, API-list equivalent) */
  sessions7d: number
  cost7d: number
  /** GAP: tokens per sign-in are not served; the events table has them */
  tokens7d?: string
  /** `running` — sessions Caprock started; terminal sessions are not counted (GAP) */
  running: number
  /** position in limit_fallbacks while limit_action is "auto"; undefined: not in it */
  autoOrder?: number
  /** ADR-090: a Claude sign-in continues the same conversation, Codex from a summary */
  carry?: 'same session' | 'new session from a summary'
}

export const SUBS: Sub[] = [
  {
    id: 'default', agent: 'claude', label: 'Personal', own: true, preferred: true, signedIn: true,
    account: 'me@example.com', plan: 'Max',
    five: { used: 88, resets: '17:05', inText: 'in 1 h 14 min' },
    week: { used: 41, resets: 'Sat 09:00', inText: 'in 2 d 17 h' },
    seen: '1 min ago', sessions7d: 23, cost7d: 412.3, tokens7d: '61.2M', running: 2,
  },
  {
    id: '3fa1c2d0', agent: 'claude', label: 'Work', signedIn: true,
    account: 'dev@work.example', plan: 'Max',
    five: { used: 38, resets: '18:20', inText: 'in 2 h 29 min' },
    week: { used: 30, resets: 'Fri 22:00', inText: 'in 2 d 6 h' },
    seen: '14 min ago', sessions7d: 11, cost7d: 186.1, tokens7d: '27.9M', running: 1,
    autoOrder: 1, carry: 'same session',
  },
  {
    id: '9b0e77aa', agent: 'claude', label: 'Client', signedIn: true,
    account: 'contractor@client.example', plan: 'Pro',
    five: { used: 71, resets: '11:40', inText: 'reopened since', passed: true },
    week: { used: 81, resets: 'Mon 11:00', inText: 'in 4 d 19 h' },
    seen: '6 h ago', sessions7d: 3, cost7d: 24.8, tokens7d: '3.4M', running: 0,
    autoOrder: 2, carry: 'same session',
  },
  {
    id: 'c41d5e02', agent: 'claude', label: 'Side project', signedIn: false,
    sessions7d: 0, cost7d: 0, running: 0,
  },
  {
    id: 'default', agent: 'codex', label: 'Own sign-in', own: true, preferred: true, signedIn: true,
    account: 'me@example.com', plan: 'Plus',
    five: { used: 12, resets: '16:20', inText: 'in 29 min' },
    week: { used: 64, resets: 'Thu 08:10', inText: 'in 16 h' },
    seen: '2 h ago', sessions7d: 6, cost7d: 51.2, tokens7d: '9.8M', running: 0,
    autoOrder: 3, carry: 'new session from a summary',
  },
]

/** What the user set in Settings → When a limit is reached (example). */
export const LIMIT_ACTION: 'ask' | 'auto' | 'wait' = 'auto'

/** The share of a window still free, counting a passed reset as reopened. */
export function leftOf(w?: Win): number | undefined {
  if (!w) return undefined
  return w.passed ? 100 : Math.max(0, 100 - Math.round(w.used))
}

/** The window that binds: the one with the least left. */
export function binding(s: Sub): { name: '5-hour' | 'weekly'; left: number; w: Win } | undefined {
  const c: { name: '5-hour' | 'weekly'; left: number; w: Win }[] = []
  const f = leftOf(s.five)
  const k = leftOf(s.week)
  if (f !== undefined && s.five) c.push({ name: '5-hour', left: f, w: s.five })
  if (k !== undefined && s.week) c.push({ name: 'weekly', left: k, w: s.week })
  return c.sort((a, b) => a.left - b.left)[0]
}

/**
 * Auto's rule, as the mockup proposes it: the agent's signed-in sign-ins
 * (never DeepSeek or Kimi), the one whose tightest window has the most left;
 * a sign-in with no reading ranks after every one with a reading; a tie goes
 * to the default one.
 */
export function autoPick(agent: Agent): Sub | undefined {
  const pool = SUBS.filter((s) => s.agent === agent && s.signedIn)
  const score = (s: Sub) => binding(s)?.left ?? -1
  return [...pool].sort((a, b) => score(b) - score(a) || Number(!!b.preferred) - Number(!!a.preferred))[0]
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`
}
