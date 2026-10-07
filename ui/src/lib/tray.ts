/**
 * What the desktop app's menu bar or tray and badge show (WP-10, F08, F10):
 * the plan windows, today's spend and the sessions waiting on your approval.
 *
 * Built here rather than in the shell so every figure is formatted by the
 * code the dashboard uses, and so it moves with the same live frame: the
 * summary is asked again on each live tick, exactly as Now asks it.
 */
import { useEffect } from 'react'
import { api, type RateLimits, type RateWindow, type Summary } from './api'
import { isTauri } from './appmode'
import { fmtUSD } from './format'
import { useLiveConn, type ConnState } from './live'
import { resetClock } from './limitclock'
import { shell, type TrayView } from './shell'
import type { InboxItem } from './sidebar'
import { useApi } from './useApi'
import { readWindow } from '@/components/PlanLimits'

export interface TrayInput {
  summary?: Summary
  inbox: InboxItem[]
  conn: ConnState
  now: number
}

/** "Claude 5h  42% · resets 15:20", the dashboard's figure and clock. */
function windowLine(agent: string, label: string, w: RateWindow, now: number): string {
  const { pct, resetsAt } = readWindow(w, now)
  const clock = resetsAt ? resetClock(w.resets_at * 1000, now) : null
  return `${agent} ${label}  ${pct}%${clock ? ` · resets ${clock}` : ''}`
}

function limitLines(agent: string, limits: RateLimits | undefined, now: number): string[] {
  const out: string[] = []
  if (limits?.five_hour) out.push(windowLine(agent, '5h', limits.five_hour, now))
  if (limits?.seven_day) out.push(windowLine(agent, '7d', limits.seven_day, now))
  return out
}

/** A plan window this full is named in the menu bar; below it the bar stays quiet. */
export const LIMIT_WARN_PCT = 80

/**
 * The sessions the badge and the menu bar count: everything in the sidebar's
 * inbox — a permission prompt pending, or the agent finished and it is your
 * turn — the same "Needs you" the popover lists. Only prompts used to count,
 * so a session done and waiting left the dock bare (owner, 2026-10-07).
 */
export function waitingOnYou(inbox: InboxItem[]): InboxItem[] {
  return inbox
}

export function buildTrayView({ summary, inbox, conn, now }: TrayInput): TrayView {
  const waiting = waitingOnYou(inbox)
  const lines = [
    ...limitLines('Claude', summary?.rate_limits, now),
    ...limitLines('Codex', summary?.codex_rate_limits, now),
  ]
  if (summary) lines.push(`Today  ${fmtUSD(summary.cost_usd)}`)
  else lines.push('Loading…')
  if (conn !== 'open') lines.push('Daemon unreachable — reconnecting')

  // Beside the icon: how many need you, in words, and a plan window only
  // when it is close to full, named — a bare "10%" read as nothing and a bare
  // "2" no better (owner, 2026-10-07). The Dock badge stays a bare number:
  // that is what a badge is.
  const near = [
    ['5h', summary?.rate_limits?.five_hour],
    ['7d', summary?.rate_limits?.seven_day],
  ] as const
  const warn = near
    .map(([label, w]) => (w ? { label, pct: readWindow(w, now).pct } : null))
    .filter((x): x is { label: '5h' | '7d'; pct: number } => !!x && x.pct >= LIMIT_WARN_PCT)
    .sort((a, b) => b.pct - a.pct)[0]
  const title = [
    waiting.length ? `${waiting.length} waiting` : '',
    warn ? `${warn.label} ${warn.pct}%` : '',
  ].filter(Boolean).join(' · ')
  const tooltip = ['Caprock', waiting.length ? `${waiting.length} need you` : '', summary ? `today ${fmtUSD(summary.cost_usd)}` : '']
    .filter(Boolean)
    .join(' · ')
  return {
    title,
    tooltip,
    lines,
    waiting: waiting.map((i) => {
      const label = i.projectName ? `${i.projectName} · ${i.title}` : i.title
      return { id: i.session.session_id, label: i.reason === 'permission' ? `${label} · approve` : label }
    }),
  }
}

/** Keeps the shell's tray and badge in step with the workspace. Does nothing outside the app. */
export function useShellTray(inbox: InboxItem[]): void {
  const inApp = isTauri()
  const conn = useLiveConn()
  // The same question Now asks, on the same live tick: spend and limits move
  // with events, which the tick follows. The interval is only a backstop, so
  // a slow one (WP-16: every poll re-renders the workspace), and slower still
  // with the window hidden, where the menu bar must stay current.
  const summary = useApi(() => (inApp ? api.summary('today') : Promise.resolve(undefined)), [inApp], { intervalMs: 30_000, hiddenIntervalMs: 60_000 })
  const view = buildTrayView({ summary: summary.data, inbox, conn, now: Date.now() })
  const key = JSON.stringify(view)
  const count = view.waiting.length
  useEffect(() => {
    if (!inApp) return
    shell.setTray(JSON.parse(key) as TrayView).catch(() => { /* an older shell: no tray */ })
  }, [inApp, key])
  useEffect(() => {
    if (!inApp) return
    shell.setBadge(count).catch(() => { /* an older shell: no badge */ })
  }, [inApp, count])
}
