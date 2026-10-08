/**
 * The menu bar popover's model (macOS, `#/tray`): what needs you, what is
 * running, the plan windows and today's spend — the glance a menu bar item
 * is for. A pure function over the same API answers the workspace reads, so
 * the popover and the window never disagree, plus a lean hook that asks only
 * while the popover is shown (a hidden window costs nothing but its socket).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type Permission, type RateLimits, type SessionSummary, type Summary } from './api'
import { live, useLiveTick } from './live'
import { countdown } from './limitclock'
import { folderName } from './projects'
import { dotOf, sessionTitle } from './sidebar'
import { readWindow } from '@/components/PlanLimits'

/** The event the shell dispatches each time it shows the popover. */
export const TRAY_SHOWN_EVENT = 'caprock:tray-shown'

/** The event the shell dispatches when it hides the popover. */
export const TRAY_HIDDEN_EVENT = 'caprock:tray-hidden'

/** Longest request detail an Approve button may stand for; longer ones are clipped, so only Deny is offered. */
export const APPROVE_MAX_CHARS = 200

const MAX_LIVE = 8

export interface ApprovalRow {
  session: SessionSummary
  project: string
  title: string
  permission: Permission
  /** The whole request is shown, so Approve may answer it (ADR-035). */
  canApprove: boolean
}

export interface SessionRow {
  session: SessionSummary
  project: string
  title: string
  /** What it is doing, in the agent's words. */
  phrase: string
  /** Since it started: "12m", "3h 4m". */
  elapsed: string
  cost: number
}

export interface LimitRow {
  agent: 'Claude' | 'Codex'
  label: '5h' | '7d'
  pct: number
  /** "1 h 39 min" until the window resets; null when the clock cannot be believed. */
  resetIn: string | null
  stale: boolean
}

export interface PopoverModel {
  approvals: ApprovalRow[]
  /** Turn ended, waiting for your next message. */
  waiting: SessionRow[]
  live: SessionRow[]
  /** Live sessions beyond the ones listed. */
  moreLive: number
  limits: LimitRow[]
  today?: number
  /** Nothing waits on you. */
  calm: boolean
}

export interface PopoverInput {
  sessions: SessionSummary[]
  permissions: ReadonlyMap<string, Permission>
  summary?: Summary
  now: number
}

/**
 * Whether the request is short and on one line, so a button can stand for all
 * of it — the rule the notifications follow (internal/alerts/notify.go,
 * shownWhole): a button must not answer a question it did not show. Never
 * while several prompts are outstanding: which one the terminal shows is
 * unknown (ADR-035, amended 2026-10-09).
 */
export function canApprove(p: Pick<Permission, 'detail' | 'waiting'>): boolean {
  if ((p.waiting?.length ?? 0) > 1) return false
  const d = (p.detail ?? '').trim()
  return d !== '' && !/[\r\n]/.test(d) && d.length <= APPROVE_MAX_CHARS
}

/** "now", "12m", "3h 4m", "2d 5h". */
export function fmtElapsed(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function projectOf(s: SessionSummary): string {
  return s.project || folderName(s.repo_root || s.cwd) || 'session'
}

function row(s: SessionSummary, now: number): SessionRow {
  return {
    session: s,
    project: projectOf(s),
    title: sessionTitle(s),
    phrase: s.activity?.phrase ?? '',
    elapsed: fmtElapsed(now - (s.started_at || now)),
    cost: s.stats?.cost_usd ?? 0,
  }
}

function limitRows(agent: LimitRow['agent'], limits: RateLimits | undefined, now: number): LimitRow[] {
  const out: LimitRow[] = []
  for (const [label, w] of [['5h', limits?.five_hour], ['7d', limits?.seven_day]] as const) {
    if (!w) continue
    const r = readWindow(w, now)
    out.push({ agent, label, pct: r.pct, resetIn: r.resetsAt ? countdown(w.resets_at * 1000 - now) : null, stale: r.stale })
  }
  return out
}

function ms(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

export function buildPopover({ sessions, permissions, summary, now }: PopoverInput): PopoverModel {
  const approvals: ApprovalRow[] = []
  const waiting: SessionRow[] = []
  const running: SessionRow[] = []
  for (const s of sessions) {
    if (!s || s.status === 'ended' || s.kind === 'shell') continue
    const p = s.owned ? permissions.get(s.session_id) : undefined
    if (p) {
      approvals.push({ session: s, project: projectOf(s), title: sessionTitle(s), permission: p, canApprove: canApprove(p) })
    } else if (dotOf(s, false) === 'waiting') {
      waiting.push(row(s, now))
    } else {
      running.push(row(s, now))
    }
  }
  // The one that has waited longest has cost the most time: first.
  approvals.sort((a, b) => ms(a.permission.since) - ms(b.permission.since))
  waiting.sort((a, b) => (ms(a.session.activity?.at) || a.session.last_event_at) - (ms(b.session.activity?.at) || b.session.last_event_at))
  // Working before idle, then the most recent.
  running.sort((a, b) =>
    Number(dotOf(b.session, false) === 'working') - Number(dotOf(a.session, false) === 'working') ||
    (b.session.last_event_at ?? 0) - (a.session.last_event_at ?? 0))
  return {
    approvals,
    waiting,
    live: running.slice(0, MAX_LIVE),
    moreLive: Math.max(0, running.length - MAX_LIVE),
    limits: [...limitRows('Claude', summary?.rate_limits, now), ...limitRows('Codex', summary?.codex_rate_limits, now)],
    today: summary?.cost_usd,
    calm: approvals.length === 0 && waiting.length === 0,
  }
}

export interface PopoverData {
  sessions: SessionSummary[]
  permissions: ReadonlyMap<string, Permission>
  summary?: Summary
  loaded: boolean
  refresh: () => void
}

/**
 * What the popover reads: live sessions, their pending prompts and today's
 * summary. Asked when the page opens, each time the shell shows it, and on
 * the live tick while it is visible — never while hidden.
 */
export function usePopoverData(): PopoverData {
  const tick = useLiveTick(1000)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [permissions, setPermissions] = useState<ReadonlyMap<string, Permission>>(() => new Map())
  const [summary, setSummary] = useState<Summary | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Shown until the shell says otherwise, so the page also works in a browser.
  const [shown, setShown] = useState(true)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const onShown = () => { setShown(true); refresh() }
    const onHidden = () => setShown(false)
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener(TRAY_SHOWN_EVENT, onShown)
    window.addEventListener(TRAY_HIDDEN_EVENT, onHidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener(TRAY_SHOWN_EVENT, onShown)
      window.removeEventListener(TRAY_HIDDEN_EVENT, onHidden)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  useEffect(() => {
    if (!shown || document.visibilityState === 'hidden') return
    let alive = true
    api.sessions(true)
      .then(async (list) => {
        const owned = list.filter((s) => s?.owned && s.status !== 'ended' && s.kind !== 'shell')
        const answers = await Promise.all(owned.map((s) => api.permission(s.session_id)
          .then((r) => [s.session_id, r.permission] as const)
          .catch(() => [s.session_id, null] as const)))
        if (!alive) return
        setSessions(list)
        setPermissions(new Map(answers.filter((a): a is readonly [string, Permission] => !!a[1])))
        setLoaded(true)
      })
      .catch(() => { if (alive) setLoaded(true) })
    api.summary('today').then((s) => { if (alive) setSummary(s) }).catch(() => { /* kept as last known */ })
    return () => { alive = false }
  }, [tick, nonce, shown])

  // A prompt that appears or goes while the popover is open lands at once.
  useEffect(() => live.onFrame((f) => {
    if (f.type !== 'permission') return
    const d = f.data
    setPermissions((cur) => {
      const next = new Map(cur)
      if (d.permission) next.set(d.session_id, d.permission)
      else next.delete(d.session_id)
      return next
    })
  }), [])

  return { sessions, permissions, summary, loaded, refresh }
}
