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
  if (!premium.data) return null

  if (premium.data.license?.active) {
    return <span className="text-premium-strong">premium</span>
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-sm border border-premium/60 px-2 py-0.5 text-premium-strong hover:bg-premium/10"
      >
        premium
      </button>
      {/* The cap, not the report: it is the feature people arrive worried
        * about, and the one a runaway session makes them want. */}
      {open && <PremiumModal feature="cap" onClose={() => setOpen(false)} />}
    </>
  )
}
