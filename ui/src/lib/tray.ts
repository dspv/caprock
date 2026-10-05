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

/** The sessions the badge counts: a permission prompt pending, as in the sidebar's inbox. */
export function waitingOnApproval(inbox: InboxItem[]): InboxItem[] {
  return inbox.filter((i) => i.reason === 'permission')
}

export function buildTrayView({ summary, inbox, conn, now }: TrayInput): TrayView {
  const waiting = waitingOnApproval(inbox)
  const lines = [
    ...limitLines('Claude', summary?.rate_limits, now),
    ...limitLines('Codex', summary?.codex_rate_limits, now),
  ]
  if (summary) lines.push(`Today  ${fmtUSD(summary.cost_usd)}`)
  else lines.push('Loading…')
  if (conn !== 'open') lines.push('Daemon unreachable — reconnecting')

  const five = summary?.rate_limits?.five_hour
  const title = [
    five ? `${readWindow(five, now).pct}%` : '',
    waiting.length ? `${waiting.length} waiting` : '',
  ].filter(Boolean).join(' · ')
  const tooltip = ['Caprock', waiting.length ? `${waiting.length} waiting` : '', summary ? `today ${fmtUSD(summary.cost_usd)}` : '']
    .filter(Boolean)
    .join(' · ')
  return {
    title,
    tooltip,
    lines,
    waiting: waiting.map((i) => ({ id: i.session.session_id, label: i.projectName ? `${i.projectName} · ${i.title}` : i.title })),
  }
}

/** Keeps the shell's tray and badge in step with the workspace. Does nothing outside the app. */
export function useShellTray(inbox: InboxItem[]): void {
  const inApp = isTauri()
  const conn = useLiveConn()
  // The same question Now asks, on the same live tick and interval.
  const summary = useApi(() => (inApp ? api.summary('today') : Promise.resolve(undefined)), [inApp], { intervalMs: 5000 })
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
