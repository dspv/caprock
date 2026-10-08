/**
 * The sidebar's Today strip (.ai/21-app.md § What the user sees): the day's
 * spend, how many agents run and how many wait on you, and the Claude plan
 * windows — the glance at the top of the app's left side.
 *
 * Pure, over figures the workspace already holds: the day's summary (the one
 * the status strip and the cockpit read) and the sidebar's model. A figure
 * the data does not carry comes back undefined, never zero.
 */
import type { RateWindow, Summary } from './api'
import type { SidebarModel } from './sidebar'
import { planWindowsFor } from './cockpit'
import { readWindow } from '@/components/PlanLimits'

export type WindowTone = 'accent' | 'warn' | 'danger'

export interface TodayWindow {
  /** "5h" or "7d". */
  label: string
  /** "5-hour" or "Weekly", for what is read aloud. */
  name: string
  pct: number
  /** When the window resets, in ms; undefined when the clock cannot be believed. */
  resetMs?: number
  stale: boolean
  tone: WindowTone
  forecast?: string
}

export interface TodayModel {
  /** Spent today by every agent; undefined until the summary answers. */
  spend?: number
  /** Live agent sessions, shells left out. */
  agents: number
  /** Of those, working this moment. */
  working: number
  /** Waiting on you now: the Inbox's count, the put-down left out. */
  waiting: number
  /** Claude Code's 5-hour and weekly windows; empty without a plan that has them. */
  windows: TodayWindow[]
}

/** The tone a plan bar takes: the cockpit's thresholds, so one window never reads amber here and red there. */
export function windowTone(pct: number): WindowTone {
  return pct > 85 ? 'danger' : pct >= 60 ? 'warn' : 'accent'
}

function planWindow(label: string, name: string, w: RateWindow, now: number): TodayWindow {
  const r = readWindow(w, now)
  return {
    label,
    name,
    pct: r.pct,
    resetMs: r.resetsAt ? w.resets_at * 1000 : undefined,
    stale: r.stale,
    tone: windowTone(r.pct),
    forecast: w.forecast || undefined,
  }
}

export function buildToday(model: SidebarModel, summary: Summary | undefined, now: number): TodayModel {
  let agents = 0
  let working = 0
  for (const n of model.projects) {
    agents += n.agents
    working += n.working
  }
  const limits = planWindowsFor('claude', summary)
  const windows: TodayWindow[] = []
  if (limits?.five_hour) windows.push(planWindow('5h', '5-hour', limits.five_hour, now))
  if (limits?.seven_day) windows.push(planWindow('7d', 'Weekly', limits.seven_day, now))
  return {
    spend: summary && Number.isFinite(summary.cost_usd) ? summary.cost_usd : undefined,
    agents,
    working,
    waiting: model.inbox.filter((i) => !i.stale).length,
    windows,
  }
}
