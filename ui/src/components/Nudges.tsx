/**
 * The share prompt when a week closes or a milestone passes. (The Premium
 * offers beside a plan window and a heavy day are gone: Caprock is free for
 * one person since 2026-11-27, ADR-022 amended.)
 *
 * It is a rule plus a dismissal in lib/prompts.ts, and asks lib/nudges.ts for
 * the single slot, so at most one offer is on screen anywhere.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { markAnswered, promptAt, usePromptDue, usePromptStore } from '@/lib/prompts'
import { useNudgeSlot } from '@/lib/nudges'
import { findMoment, weekClosedDue } from '@/lib/shareprompt'
import { planOf } from '@/lib/week'
import { ShareDialog, useShareSheetOpen } from './Share'

/** "2026-10-09" in local time — the daemon's day key. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const primary = 'rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-bg hover:brightness-110'

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
