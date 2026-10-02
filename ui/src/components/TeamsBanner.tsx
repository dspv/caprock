/**
 * One line on the Cost screen about the team version.
 *
 * Cost is where the subject is already "where did the money go, per
 * repository" — the exact question the team version answers across machines.
 * It takes the slot PremiumBanner had on this screen rather than sitting
 * under it: two offers stacked is how a screen starts to read as a page that
 * wants something. Premium keeps Now and Lifetime.
 *
 * The same rules as PremiumBanner: the reader's own number first, no price,
 * nothing over an empty dashboard, and "not now" is a month of silence.
 */
import { useState } from 'react'
import { fmtUSD } from '@/lib/format'
import { isDue, markAnswered, type PromptKind } from '@/lib/prompts'
import { TeamsModal, type TeamsFact } from './TeamsModal'

const KIND: PromptKind = 'teams-banner'

export function TeamsBanner({ fact, now }: { fact: TeamsFact; now: number }) {
  const [shown] = useState(() => isDue(KIND, now))
  const [gone, setGone] = useState(false)
  const [open, setOpen] = useState(false)
  if (!shown || gone || fact.costUSD <= 0 || fact.projects <= 0) return null

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-panel)] border border-border bg-panel-2 px-3 py-2 text-[12px]">
      <span className="text-fg">
        <span className="num">{fmtUSD(fact.costUSD)}</span>
        <span className="text-fg-muted">
          {' '}across {fact.projects} {fact.projects === 1 ? 'project' : 'projects'} {fact.window}, on this machine.
        </span>
      </span>
      <span className="text-fg-muted">Caprock for Teams shows the same for every laptop on your team.</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <button
          onClick={() => setOpen(true)}
          className="rounded-sm border border-accent/50 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20"
        >
          what teams get
        </button>
        <button
          onClick={() => { markAnswered(KIND, now); setGone(true) }}
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
