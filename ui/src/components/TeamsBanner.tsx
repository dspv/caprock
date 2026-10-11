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
import { fmtUSD, fmtUSDShort } from '@/lib/format'
import { markAnswered, usePromptDue, type PromptKind } from '@/lib/prompts'
import { openExternal, teamEligible, TEAMS_URL, useNudgeSlot } from '@/lib/nudges'
import { TeamsModal, type TeamsFact } from './TeamsModal'
import { Banner, BannerButton, BannerDismiss, Fig } from './Banner'

const KIND: PromptKind = 'teams-nudge'

export function TeamsBanner({ fact, now }: { fact: TeamsFact; now: number }) {
  const due = usePromptDue(KIND, now)
  const sig = useApi(() => api.teamSignal(), [], { live: false, intervalMs: 3_600_000 })
  const [open, setOpen] = useState(false)
  const mine = useNudgeSlot('teams-nudge', due && teamEligible(sig.data) && fact.costUSD > 0 && fact.projects > 0)
  if (!mine) return open ? <TeamsModal fact={fact} onClose={() => setOpen(false)} /> : null
  const people = sig.data?.authors ?? 0

  return (
    <Banner
      id="teams"
      art="team"
      title="Your team runs agents too"
      line={<>
        <Fig>{people}</Fig> people committed to your repositories in 30 days. This machine alone spent{' '}
        <Fig title={fmtUSD(fact.costUSD)}>{fmtUSDShort(fact.costUSD)}</Fig> {fact.window}.
      </>}
      actions={<>
        <BannerButton onClick={() => openExternal(TEAMS_URL)}>Caprock for Teams →</BannerButton>
        <button type="button" onClick={() => setOpen(true)} className="bn-link">What teams get</button>
        <BannerDismiss onClick={() => markAnswered(KIND, now)} title="Hide this for a month">Not now</BannerDismiss>
      </>}
    >
      {open && <TeamsModal fact={fact} onClose={() => setOpen(false)} />}
    </Banner>
  )
}
