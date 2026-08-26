/**
 * The banner that sells the paid version, on the two screens where money is
 * already the subject.
 *
 * The constraint that shapes this: Caprock is a tool someone installed and
 * runs on their own machine, and the free version is the whole product rather
 * than a crippled preview. An advertisement that is always there turns that
 * into a trial, and the moment it reads as a trial the local-first promise
 * reads as a sales tactic too.
 *
 * So three rules, all of them tested:
 *
 *  - It only appears on Cost and Lifetime — screens someone opened *to think
 *    about spending*. Never on Now, where they are working, and never on a
 *    session or a task.
 *  - It states a fact from this machine before it offers anything. "You spent
 *    $312 last week" earns the next sentence; "Upgrade to Premium!" does not.
 *  - Dismissing it means a month of silence, and it says so on the control.
 *
 * It quotes no price, for the same reason nothing else in the dashboard does:
 * a figure here turns a working screen into a storefront, and the page it
 * links to is where selling belongs.
 */
import { useState } from 'react'
import { fmtUSD } from '@/lib/format'
import { isDue, markAnswered, type PromptKind } from '@/lib/prompts'
import { PremiumModal } from './PremiumModal'

const KIND: PromptKind = 'premium-banner'

export function PremiumBanner({ costUSD, days, now }: { costUSD: number; days: number; now: number }) {
  const [shown] = useState(() => isDue(KIND, now))
  const [gone, setGone] = useState(false)
  const [open, setOpen] = useState(false)
  // Nothing measured, nothing to say. A banner over an empty dashboard is an
  // advertisement to someone who has not seen the product work yet.
  if (!shown || gone || costUSD <= 0 || days <= 0) return null

  const perDay = costUSD / days
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-border bg-panel-2 px-3 py-2 text-[12px]">
      {/* The measured fact first. Everything after it is a claim, and a claim
        * that follows one of the reader's own numbers is one they can check. */}
      <span className="text-fg">
        <span className="num">{fmtUSD(perDay)}</span>
        <span className="text-fg-muted"> a day, on average, across {days} active {days === 1 ? 'day' : 'days'}.</span>
      </span>
      <span className="text-fg-muted">
        Premium stops a day that runs away from you, and alerts before a plan window does.
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {/* Opens the explanation rather than the shop. One line cannot say what
          * someone would be paying for, and sending them straight to a pricing
          * page to find out is asking them to leave in order to be persuaded. */}
        <button
          onClick={() => setOpen(true)}
          className="rounded-sm border border-accent/50 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20"
        >
          what it does
        </button>
        <button
          onClick={() => { markAnswered(KIND, Date.now()); setGone(true) }}
          className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg-muted"
          title="hide this for a month"
        >
          not now
        </button>
      </span>
      {open && <PremiumModal onClose={() => setOpen(false)} />}
    </div>
  )
}
