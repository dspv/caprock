/**
 * The Caprock for Teams card, on Cost and Lifetime.
 *
 * It appears only when somebody else commits to the same code: two or more
 * distinct commit authors across the listed repositories in the last 30 days
 * (GET /v1/team-signal, counts only, read from git on this machine). Said to a
 * person who works alone, "your team runs agents too" would be a claim the
 * product cannot back, so for them there is no card at all.
 *
 * The same rules as every offer here (lib/nudges.ts): the reader's own figure
 * first, no price, nothing over an empty dashboard, one offer on screen at a
 * time, and "not now" is a month of silence. Rule 11: the team version is
 * presented as the product it is.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD } from '@/lib/format'
import { markAnswered, usePromptDue, type PromptKind } from '@/lib/prompts'
import { openExternal, teamEligible, TEAMS_URL, useNudgeSlot } from '@/lib/nudges'
import { TeamsModal, type TeamsFact } from './TeamsModal'

const KIND: PromptKind = 'teams-nudge'

export function TeamsBanner({ fact, now }: { fact: TeamsFact; now: number }) {
  const due = usePromptDue(KIND, now)
  const sig = useApi(() => api.teamSignal(), [], { live: false, intervalMs: 3_600_000 })
  const [open, setOpen] = useState(false)
  const mine = useNudgeSlot('teams-nudge', due && teamEligible(sig.data) && fact.costUSD > 0 && fact.projects > 0)
  if (!mine) return open ? <TeamsModal fact={fact} onClose={() => setOpen(false)} /> : null
  const people = sig.data?.authors ?? 0

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-panel)] border border-border bg-panel-2 px-3 py-2 text-[12px]">
      <span className="text-fg">
        Your team runs agents too.
        <span className="text-fg-muted">
          {' '}{people} people committed to your repositories in the last 30 days; this machine alone spent{' '}
          <span className="num text-fg">{fmtUSD(fact.costUSD)}</span> {fact.window}.
        </span>
      </span>
      <span className="text-fg-muted">See everyone&rsquo;s agent spend and cost per PR in one place.</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openExternal(TEAMS_URL)}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-bg hover:brightness-110"
        >
          Caprock for Teams →
        </button>
        <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-fg-muted hover:text-fg">
          what teams get
        </button>
        <button
          type="button"
          onClick={() => markAnswered(KIND, now)}
          className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg-muted"
          title="hide this for a month"
        >
          not now
        </button>
      </span>
      {open && <TeamsModal fact={fact} onClose={() => setOpen(false)} />}
    </div>
  )
}
