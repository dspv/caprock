/**
 * The one place the dashboard mentions that a paid version exists.
 *
 * Deliberately not a banner. Caprock is a tool someone installed for its own
 * sake, and a permanent advertisement inside it is how a local tool starts
 * feeling like a trial — the exact thing the free version promises it is not.
 *
 * So it appears only beside a problem the paid version would have acted on,
 * and only when that problem is actually happening: a plan window nearly
 * spent, a day whose cost has run well past this machine's own normal. When
 * nothing is wrong there is nothing to sell, and the dashboard says nothing.
 *
 * It also never quotes a price. A figure inside the tool turns a screen
 * someone opened to do their work into a storefront; the link says what it is
 * and the page it opens does the selling.
 */
import { markAnswered, isDue, type PromptKind } from '@/lib/prompts'
import { PremiumModal } from './PremiumModal'
import { useState } from 'react'

const KIND: PromptKind = 'premium-hint'

export function PremiumHint({ reason, now }: { reason: string; now: number }) {
  const [shown] = useState(() => isDue(KIND, now))
  const [gone, setGone] = useState(false)
  const [open, setOpen] = useState(false)
  if (!shown || gone) return null
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11px]">
      <span className="text-fg-faint">{reason}</span>
      <button
        onClick={() => setOpen(true)}
        className="rounded-sm border border-border px-1.5 py-0.5 text-fg-muted hover:border-border-strong hover:text-fg"
      >
        a cap that stops this
      </button>
      <button
        title="hide this for a month"
        /* The injected `now`, not the wall clock — see PremiumBanner: reading
         * a fresh Date.now() here while every other decision uses the prop
         * makes the dismissal and the check disagree, and the disagreement
         * only shows up on whichever date the two happen to cross. */
        onClick={() => { markAnswered(KIND, now); setGone(true) }}
        className="text-fg-faint hover:text-fg-muted"
      >
        ✕
      </button>
      {open && <PremiumModal feature="cap" onClose={() => setOpen(false)} />}
    </span>
  )
}
