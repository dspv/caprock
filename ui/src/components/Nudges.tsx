/**
 * The contextual offers: Premium beside a plan window nearly spent and beside
 * a heavy day, and the share prompt when a week closes or a milestone passes.
 *
 * Each one is a rule in lib/nudges.ts plus a dismissal in lib/prompts.ts, and
 * each asks lib/nudges.ts for the single slot, so at most one offer is on
 * screen anywhere. Copy states the reader's own figure first and promises no
 * saving (rule 6). Premium offers never reach someone with a licence.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type DailyStat, type RateLimits } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD } from '@/lib/format'
import { markAnswered, usePromptDue } from '@/lib/prompts'
import { capNudge, limitNudge, useLicensed, useNudgeSlot } from '@/lib/nudges'
import { findMoment } from '@/lib/shareprompt'
import { PremiumModal } from './PremiumModal'
import { ShareDialog } from './Share'

/** "2026-10-09" in local time — the daemon's day key. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const card = 'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-panel)] border border-border bg-panel-2 px-3 py-2 text-[12px]'
const primary = 'rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-bg hover:brightness-110'
const later = 'rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg-muted'

/**
 * Under PLAN LIMITS, and in the app's Today strip: a Claude window at 80% or
 * more. Premium's plan-window stop pauses the sessions Caprock started before
 * the limit and resumes them after the reset — the feature the reader would
 * be asking for at this moment.
 */
export function PlanLimitNudge({ limits, now, compact = false, className = '' }: {
  limits: RateLimits | undefined; now: number; compact?: boolean; className?: string
}) {
  const licensed = useLicensed()
  const due = usePromptDue('premium-limit', now)
  const hit = limitNudge(limits)
  const mine = useNudgeSlot('premium-limit', !licensed && due && !!hit)
  const [open, setOpen] = useState(false)
  if (!mine || !hit) return open ? createPortal(<PremiumModal feature="window" onClose={() => setOpen(false)} />, document.body) : null
  const fact = `Claude's ${hit.name} window is at ${Math.round(hit.pct)}%.`
  return (
    <div className={compact ? `mx-1 mt-1 flex items-center gap-1.5 rounded-[7px] border border-[var(--app-hairline)] px-1.5 py-1 text-[11px] ${className}` : `${card} ${className}`}>
      <span className={compact ? 'min-w-0 truncate text-fg-muted' : 'text-fg-muted'} title={fact}>
        {compact ? `${hit.name[0]!.toUpperCase()}${hit.name.slice(1)} at ${Math.round(hit.pct)}%` : <><span className="text-fg">{fact}</span> Premium pauses the agents Caprock started before the limit and resumes them after the reset.</>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={() => setOpen(true)} className={compact ? 'rounded-sm px-1 text-accent hover:underline' : primary}>
          {compact ? 'Pause before the limit' : 'Pause agents before the limit — Premium'}
        </button>
        <button type="button" onClick={() => markAnswered('premium-limit', now)} className={compact ? 'px-0.5 text-fg-faint hover:text-fg-muted' : later}
          title="hide this for two weeks" aria-label="hide this for two weeks">
          {compact ? '×' : 'not now'}
        </button>
      </span>
      {/* Portalled: in the app's sidebar a fixed dialog is clipped to it. */}
      {open && createPortal(<PremiumModal feature="window" onClose={() => setOpen(false)} />, document.body)}
    </div>
  )
}

/**
 * On Cost, when today is in the top quarter of this machine's own days.
 * Premium's daily cap pauses the sessions Caprock started once a day passes a
 * limit the reader sets.
 */
export function CapNudge({ daily, now, className = '' }: { daily: Pick<DailyStat, 'day' | 'cost_usd'>[] | undefined; now: number; className?: string }) {
  const licensed = useLicensed()
  const due = usePromptDue('premium-cap', now)
  const today = localDay(now)
  const todayCost = (daily ?? []).filter((d) => d.day === today).reduce((a, d) => a + d.cost_usd, 0)
  const hit = !!daily && capNudge(daily, today, todayCost)
  const mine = useNudgeSlot('premium-cap', !licensed && due && hit)
  const [open, setOpen] = useState(false)
  if (!mine) return open ? <PremiumModal feature="cap" onClose={() => setOpen(false)} /> : null
  return (
    <div className={`${card} ${className}`}>
      <span className="text-fg-muted">
        <span className="num text-fg">{fmtUSD(todayCost)}</span> today, in the top quarter of your days on this machine.
        {' '}Premium pauses the sessions Caprock started when the day passes a limit you set.
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} className={primary}>Set a daily cap — Premium</button>
        <button type="button" onClick={() => markAnswered('premium-cap', now)} className={later} title="hide this for two weeks">not now</button>
      </span>
      {open && <PremiumModal feature="cap" onClose={() => setOpen(false)} />}
    </div>
  )
}

/**
 * The share prompt: a small toast when a week closes (Monday) or a milestone
 * passes — "Your week with Claude Code: N sessions, $X at API price — share
 * the card?". At most once a week, whichever way it is answered.
 */
export function ShareMoment({ now = Date.now() }: { now?: number }) {
  const due = usePromptDue('share-week', now)
  const week = useApi(() => api.summary('7d'), [], { live: false, intervalMs: 600_000 })
  const hist = useApi(() => api.history('all'), [], { live: false, intervalMs: 600_000 })
  const moment = week.data && hist.data ? findMoment(now, week.data, hist.data) : null
  const mine = useNudgeSlot('share-moment', due && !!moment)
  const [open, setOpen] = useState(false)
  if (open) return <ShareDialog initialPeriod="7d" onClose={() => setOpen(false)} />
  if (!mine || !moment) return null
  const answer = () => markAnswered('share-week', now)
  return (
    <div role="status" className="fixed bottom-12 right-4 z-40 max-w-[380px] rounded-[10px] border border-accent/40 bg-panel px-3.5 py-3 text-[12.5px] shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">
      <p className="text-fg">{moment.line}</p>
      <p className="mt-0.5 text-[11px] text-fg-faint">At API list price · not a bill</p>
      <div className="mt-2.5 flex items-center gap-2">
        <button type="button" onClick={() => { answer(); setOpen(true) }} className={primary}>Share the card</button>
        <button type="button" onClick={answer} className="rounded-md px-2 py-1 text-[12px] text-fg-muted hover:text-fg">Not this week</button>
      </div>
    </div>
  )
}
