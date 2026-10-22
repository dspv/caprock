import { useState } from 'react'
import type { Week } from '@/lib/api'
import { fmtUSD, fmtUSDShort } from '@/lib/format'
import { defaultSubagentModel, setDefaultSubagentModel } from '@/lib/subagentModel'

type Saving = NonNullable<Week['subagent_saving']>

/** "Opus 5.5", "Opus 5.5 and Sonnet 5.5", "Opus 5.5, Sonnet 5.5 and Haiku 4.5". */
function models(list: string[]): string {
  if (list.length <= 1) return list[0] ?? 'a pricier model'
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** The share the same work on Haiku would save, in whole percent; 0 when it would save nothing. */
export function savingPercent(s: Saving): number {
  if (!(s.cost_usd > 0) || !(s.haiku_usd >= 0) || s.haiku_usd >= s.cost_usd) return 0
  return Math.round((1 - s.haiku_usd / s.cost_usd) * 100)
}

function Figure({ value, approx, label, title, ok }: { value: string; approx?: boolean; label: string; title: string; ok?: boolean }) {
  return (
    <div className="min-w-0" title={title}>
      <div className={`num font-bold leading-none tracking-[-0.03em] text-[40px] sm:text-[52px] ${ok ? 'text-ok' : 'text-fg'}`}>
        {approx && <span className="mr-1 text-[0.6em] font-medium text-fg-muted">≈</span>}{value}
      </div>
      <div className="mt-1.5 text-[11px] text-fg-muted max-w-[20ch]">{label}</div>
    </div>
  )
}

// On a phone the figures wrap, and an arrow left at a line's end points at nothing.
const Arrow = () => <span aria-hidden className="hidden sm:inline self-start pt-3 text-[28px] leading-none text-fg-faint">→</span>

/**
 * The week's subagent spend against the same tokens on Haiku, said big, under
 * the Week card — never on it. Computed by the daemon from Caprock's own
 * subagent token counts and the pricing table, and only sent when the
 * difference is a dollar or more; always worded as an estimate. The button
 * sets the model New agent starts a project's subagents on when that project
 * chose none (`lib/subagentModel.ts`).
 */
export function SubagentSavingNote({ saving }: { saving: Saving }) {
  const [on, setOn] = useState(() => defaultSubagentModel() === 'haiku')
  const pct = savingPercent(saving)
  const used = models(saving.models)
  const toggle = () => {
    const next = !on
    setDefaultSubagentModel(next ? 'haiku' : '')
    setOn(next)
  }
  return (
    <section role="note" aria-label="Subagents this week" className="grid gap-3 rounded-md border border-border bg-panel px-4 py-3.5 min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Subagents this week</div>
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <Figure value={fmtUSDShort(saving.cost_usd)} label={`what they cost, on ${used}`}
          title={`Subagents this week cost ${fmtUSD(saving.cost_usd)} on ${used}.`} />
        {pct > 0 && (
          <>
            <Arrow />
            <Figure approx value={fmtUSDShort(saving.haiku_usd)} label={`same work on ${saving.haiku}`}
              title={`On ${saving.haiku} about ${fmtUSD(saving.haiku_usd)}: an estimate at list prices, the same tokens.`} />
            <Arrow />
            <Figure value={`−${pct}%`} label="possible saving" ok
              title={`About ${fmtUSD(saving.cost_usd - saving.haiku_usd)} less, an estimate.`} />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={toggle} aria-pressed={on}
          title={on
            ? 'New agent starts subagents on Haiku in every project that has not chosen otherwise. Click to have them follow the session again.'
            : 'New agent will start subagents on Haiku in every project that has not chosen otherwise; Subagents run on in New agent still changes it per project.'}
          className={on
            ? 'px-3 py-1.5 rounded-md text-[12px] font-medium border border-ok/50 text-ok hover:border-ok'
            : 'px-3 py-1.5 rounded-md text-[12px] font-medium bg-accent text-panel hover:bg-accent-strong'}>
          {on ? 'New agents use Haiku subagents ✓' : 'Start new agents with Haiku subagents'}
        </button>
        <span className="text-[11px] text-fg-faint">≈ estimate: same tokens at list prices. Haiku is not right for every task.</span>
      </div>
    </section>
  )
}
