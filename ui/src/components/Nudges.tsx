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
import { fmtUSD, fmtUSDShort } from '@/lib/format'
import { markAnswered, promptAt, usePromptDue, usePromptStore } from '@/lib/prompts'
import { capNudge, limitNudge, useLicensed, useNudgeSlot } from '@/lib/nudges'
import { findMoment, weekClosedDue } from '@/lib/shareprompt'
import { planOf } from '@/lib/week'
import { PremiumModal } from './PremiumModal'
import { ShareDialog, useShareSheetOpen } from './Share'
import { Banner, BannerButton, BannerDismiss, Fig } from './Banner'

/** "2026-10-09" in local time — the daemon's day key. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const primary = 'rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-bg hover:brightness-110'

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
  if (!compact) {
    return (
      <Banner
        id="limit"
        tone="premium"
        art="window"
        className={className}
        title={<>Claude&apos;s {hit.name} window is at <Fig>{Math.round(hit.pct)}%</Fig></>}
        line="Premium pauses the agents Caprock started before the limit and resumes them after the reset."
        actions={<>
          <BannerButton kind="premium" onClick={() => setOpen(true)}>Pause before the limit</BannerButton>
          <BannerDismiss onClick={() => markAnswered('premium-limit', now)} title="Hide this for two weeks" aria-label="hide this for two weeks">Not now</BannerDismiss>
        </>}
      >
        {open && createPortal(<PremiumModal feature="window" onClose={() => setOpen(false)} />, document.body)}
      </Banner>
    )
  }
  // The app sidebar's Today strip: one short line, not a banner.
  return (
    <div className={`mx-1 mt-1 flex items-center gap-1.5 rounded-[7px] border border-[var(--app-hairline)] px-1.5 py-1 text-[11px] ${className}`}>
      <span className="min-w-0 truncate text-fg-muted" title={fact}>
        {`${hit.name[0]!.toUpperCase()}${hit.name.slice(1)} at ${Math.round(hit.pct)}%`}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={() => setOpen(true)} className="rounded-sm px-1 text-accent hover:underline">
          Pause before the limit
        </button>
        <button type="button" onClick={() => markAnswered('premium-limit', now)} className="px-0.5 text-fg-faint hover:text-fg-muted"
          title="hide this for two weeks" aria-label="hide this for two weeks">
          ×
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
    <Banner
      id="cap"
      tone="premium"
      art="cap"
      className={className}
      title={<><Fig title={fmtUSD(todayCost)}>{fmtUSDShort(todayCost)}</Fig> today, one of your busiest days</>}
      /* "Busiest" is the rule itself: today is in the top quarter of this
       * machine's own days (lib/nudges.ts capNudge). */
      line="Premium pauses the sessions Caprock started when a day passes your limit."
      actions={<>
        <BannerButton kind="premium" onClick={() => setOpen(true)}>Set a daily cap</BannerButton>
        <BannerDismiss onClick={() => markAnswered('premium-cap', now)} title="Hide this for two weeks">Not now</BannerDismiss>
      </>}
    >
      {open && <PremiumModal feature="cap" onClose={() => setOpen(false)} />}
    </Banner>
  )
}

/**
 * The share prompt: one small toast when a week closes (Sunday 18:00 local,
 * or the first open within two days after) with a merged pull request, or a
 * milestone passes — "Your week is done. 33× your plan this week · 48 PRs
 * merged" and *Share*, which opens the sheet on this week. The figures are the share
 * card's own (GET /v1/week: hand-run sessions, GitHub's PRs). Rendered by
 * both shells — the dashboard and the app with its session tabs, where the
 * owner works (2026-10-25) — and holding the one offer slot, so it is never
 * shown twice at once. The closed week once per week, a milestone at most
 * seven days after the last answer, whichever way it was answered; never
 * modal.
 */
export function ShareMoment({ now = Date.now() }: { now?: number }) {
  // Milestones wait seven days after any answer; the closed week is offered
  // once per week, whichever way the last one was answered.
  const milestones = usePromptDue('share-week', now)
  usePromptStore()
  const weekly = weekClosedDue(now, promptAt('share-week'))
  const due = milestones || weekly
  // Asked only while the prompt is due: a week of payloads is not read for
  // a toast that would not show.
  const week = useApi(() => (due ? api.weekFor('7d') : Promise.resolve(undefined)), [due], { live: false, intervalMs: 3_600_000 })
  const hist = useApi(() => api.history('all'), [], { live: false, intervalMs: 600_000, share: 'history:all' })
  const settings = useApi(() => api.settings(), [], { live: false, intervalMs: 600_000 })
  const summary = useApi(() => api.summary('7d'), [], { live: false, intervalMs: 600_000 })
  const plan = planOf(settings.data)
  const moment = week.data && hist.data ? findMoment(now, week.data, hist.data, plan, summary.data?.savings?.hit_rate ?? 0, { weekly, milestones }) : null
  const mine = useNudgeSlot('share-moment', due && !!moment)
  const [open, setOpen] = useState(false)
  const sheet = useShareSheetOpen()
  if (open) return createPortal(<ShareDialog initialPeriod="7d" onClose={() => setOpen(false)} />, document.body)
  if (!mine || !moment || sheet) return null
  const answer = () => markAnswered('share-week', now)
  return (
    <div role="status" data-share-moment className="fixed bottom-12 right-4 z-40 flex max-w-[400px] items-center gap-2.5 rounded-[10px] border border-accent/40 bg-panel py-2 pl-3.5 pr-2 text-[12.5px] shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">
      <p className="min-w-0 text-fg" title="At API list prices, not a bill">{moment.line}</p>
      <button type="button" onClick={() => { answer(); setOpen(true) }} className={`${primary} shrink-0`}>Share</button>
      <button type="button" onClick={answer} aria-label="Not this week" title="Not this week"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-faint hover:text-fg">×</button>
    </div>
  )
}
