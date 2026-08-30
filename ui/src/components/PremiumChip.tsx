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

  if (premium.data.license?.active) {
    return <span className="text-premium-strong">premium</span>
  }

  const p = premium.data

  return (
    <>
      <span className="inline-flex items-center overflow-hidden rounded-sm border border-premium/60">
        {/* Straight to the checkout, at the price most people should take. */}
        <a
          href={p.yearly.url}
          target="_blank"
          rel="noreferrer"
          className="bg-premium px-2 py-0.5 text-white no-underline hover:brightness-110"
        >
          premium ${p.yearly.charged_usd}/yr
        </a>
        {/* And a way to read first, for anyone who has not decided. Marked
          * with a chevron rather than words: the header has no room for a
          * second label, and the target of this one is a dialog, not a page. */}
        <button
          onClick={() => setOpen(true)}
          aria-label="What Premium includes"
          title="What Premium includes"
          className="px-1.5 py-0.5 text-premium-strong hover:bg-premium/10"
        >
          ›
        </button>
      </span>
      {/* The cap, not the report: it is the feature people arrive worried
        * about, and the one a runaway session makes them want. */}
      {open && <PremiumModal feature="cap" onClose={() => setOpen(false)} />}
    </>
  )
}
