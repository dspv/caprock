/**
 * The one way to buy that is on every screen.
 *
 * Before this, the only entry points to paying were the two glass panels — the
 * daily cap on Cost, the weekly report on Lifetime. The Now screen, which is
 * where people actually sit, had none: "how do I even buy this?" was asked
 * while looking straight at it. A product that is difficult to pay for is not
 * being modest, it is losing the people who already decided.
 *
 * It is a chip rather than a button, in the header's own type size, because it
 * must not become the loudest thing on a dashboard someone opened to read
 * their own figures. The ultramarine is what makes it findable without making
 * it shout — it is the only element in the header that is not amber, so the
 * eye lands on it exactly when it is looking for the thing about money.
 *
 * **It buys directly.** The first version opened the dialog, which meant
 * someone who had already decided still had to read a screen and then find a
 * price — "you cannot go straight to premium" was the complaint, and it was
 * right. The chip is now two controls: the price goes to the checkout, and a
 * separate arrow opens the explanation for anyone who has not decided. The
 * ordering is deliberate: people who are ready should not be routed through a
 * pitch.
 *
 * When a licence is active it says so instead, and stops selling. Someone who
 * has paid being shown a buy button is the fastest way to make them feel they
 * bought nothing.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { PremiumModal } from './PremiumModal'

export function PremiumChip() {
  const [open, setOpen] = useState(false)
  const premium = useApi(() => api.premium(), [], { live: false, intervalMs: 300_000 })

  // Nothing until the daemon has answered: a chip that appears a beat after
  // everything else draws attention to itself by moving, which is the one
  // thing this must not do.
  //
  // The yearly plan is checked too, not just the response. An older daemon —
  // or any response missing it — would otherwise read `.url` off undefined and
  // take the whole header down with it, which is how this first went wrong:
  // one optional field crashed every screen rather than hiding one chip.
  if (!premium.data?.yearly?.url) return null

  // Paid: say which plan, not just that they paid.
  //
  // "premium" alone answers a question nobody has — they know they bought it.
  // What they cannot see anywhere else is which one they are on and when it
  // ends, and a renewal that has not arrived is worth noticing a week early
  // rather than the morning features stop.
  const lic = premium.data.license
  if (lic?.active) {
    const ends = lic.expires_at ? new Date(lic.expires_at) : null
    // A lifetime key is issued fifty years out, so anything beyond a decade is
    // one — there is no separate flag, and inventing one to render a word is
    // not worth a migration.
    const lifetime = !!ends && ends.getFullYear() - new Date().getFullYear() > 10
    return (
      <span
        className="text-premium-strong"
        title={ends && !lifetime ? `Covers you through ${ends.toLocaleDateString()}` : 'Bought outright'}
      >
        premium <span className="opacity-70">{lifetime ? 'lifetime' : 'yearly'}</span>
        {lic.in_grace && <span className="ml-1 text-warn">· renew</span>}
      </span>
    )
  }

  const p = premium.data

  // One control, and it opens the dialog.
  //
  // It used to be two: the label went straight to Stripe's checkout and a
  // chevron beside it opened the dialog, in one border, one colour, with no
  // seam between them. Nothing said the left half was a payment link, so
  // clicking the word "premium" to find out what premium *is* took you to a
  // card form — the one place a reader who has not decided should never land
  // by accident. The chevron said nothing either; it was a shape, not a label.
  //
  // Reading first is also the order the evidence asks for: five readers priced
  // the dialog and none bought (FB-027), which is a question about the offer,
  // not about how few clicks stand in front of the checkout. The dialog
  // carries the buy button, where it is a decision rather than a slip.
  return (
    <>
      {/* A verb, because "premium $30/yr" is a price tag and a price tag asks
        * nothing. What this control does is open the dialog, so it says so —
        * and carries the price, because a reader deciding whether to click
        * deserves to know the number before they do. */}
      <button
        onClick={() => setOpen(true)}
        title="What Premium includes"
        className="inline-flex items-center gap-1.5 rounded-sm border border-premium/60 bg-premium px-2 py-0.5 text-white hover:brightness-110"
      >
        <span>Get premium</span>
        <span className="opacity-75">${p.yearly.charged_usd}/yr</span>
      </button>
      {/* The cap, not the report: it is the feature people arrive worried
        * about, and the one a runaway session makes them want. */}
      {open && <PremiumModal feature="cap" onClose={() => setOpen(false)} />}
    </>
  )
}
