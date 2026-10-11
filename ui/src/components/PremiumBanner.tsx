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
import { fmtUSD, fmtUSDShort } from '@/lib/format'
import { markAnswered, usePromptDue, type PromptKind } from '@/lib/prompts'
import { useLicensed, useNudgeSlot } from '@/lib/nudges'
import { PremiumModal } from './PremiumModal'
import { Banner, BannerButton, BannerDismiss, Fig } from './Banner'

const KIND: PromptKind = 'premium-banner'

export function PremiumBanner({ costUSD, days, now }: { costUSD: number; days: number; now: number }) {
  const shown = usePromptDue(KIND, now)
  const [gone, setGone] = useState(false)
  const [open, setOpen] = useState(false)
  // Never to someone who has paid, and only when no other offer holds the
  // one slot (lib/nudges.ts).
  const licensed = useLicensed()
  // Nothing measured, nothing to say. A banner over an empty dashboard is an
  // advertisement to someone who has not seen the product work yet.
  const mine = useNudgeSlot('premium-banner', shown && !gone && !licensed && costUSD > 0 && days > 0)
  if (!mine) return open ? <PremiumModal feature="cap" onClose={() => setOpen(false)} /> : null

  const perDay = costUSD / days
  return (
    <Banner
      id="premium"
      tone="premium"
      art="cap"
      /* The measured fact first. Everything after it is a claim, and a claim
       * that follows one of the reader's own numbers is one they can check. */
      title={<><Fig title={fmtUSD(perDay)}>{fmtUSDShort(perDay)}</Fig> a day, across {days} active {days === 1 ? 'day' : 'days'}</>}
      /* Says what the feature does, in the words the modal uses. It once read
       * "Premium stops a day that runs away from you" — a metaphor for a
       * mechanism, and the owner's verdict was "unclear" (translated). */
      line="Premium pauses sessions when the day crosses a limit you set."
      actions={<>
        {/* Opens the explanation rather than the shop: one line cannot say
          * what someone would be paying for. */}
        <BannerButton kind="premium" onClick={() => setOpen(true)}>What it does</BannerButton>
        {/* The `now` this component was given, not a fresh Date.now(): the
          * dismissal and the check must agree on one clock (a fixed-`now`
          * test failed a year on, on the date the two crossed). */}
        <BannerDismiss onClick={() => { markAnswered(KIND, now); setGone(true) }} title="Hide this for a month">Not now</BannerDismiss>
      </>}
    >
      {open && <PremiumModal feature="cap" onClose={() => setOpen(false)} />}
    </Banner>
  )
}
