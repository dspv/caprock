/**
 * A paid feature, shown in the place it will occupy, with a lock on it.
 *
 * Banners sell an idea; this sells the thing itself. Someone looking at their
 * own cost screen sees the panel that would cap their spending, sitting where
 * it will sit, with their own figures behind it — and one click from there to
 * paying for it. That is a shorter path than any sentence about a plan, and it
 * is honest in a way a feature list is not: the feature is visibly not working
 * yet, which is exactly true.
 *
 * The rules that keep this from being a nag:
 *
 *  - It occupies real space only where the feature belongs. Not floated, not
 *    injected above the content someone came for.
 *  - It never pretends to work. The preview is inert and marked, so nobody
 *    clicks expecting a cap they do not have.
 *  - It is not dismissible, because it is not an interruption — it is the
 *    feature's own place on the screen, the way a greyed-out menu item is.
 */
import { useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { PremiumModal, type PaidFeature } from './PremiumModal'

export function Locked({
  feature,
  title,
  children,
}: {
  feature: PaidFeature
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const premium = useApi(() => api.premium(), [])
  // A paid key unlocks the feature: the glass comes off and the children are
  // live. Until the feature itself is built this is the whole difference a
  // subscription makes on this panel, and it has to work — someone who paid
  // and still sees a lock has been charged for nothing.
  if (premium.data?.license?.active) return <>{children}</>
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-panel)] border border-border">
      {/* The feature as it will look, behind glass. Inert: a preview that
        * responds to a click is a preview that lies. */}
      {/* Legible through the glass, not merely suggested by it.
        *
        * At opacity-35 the preview was a grey smear: the reader could see that
        * *something* was there and not what. That is the worst of both — it
        * occupies the space of a demonstration while demonstrating nothing,
        * and "I cannot tell what is under it" was the first thing said about
        * this panel. Dimmed enough to read as inert, sharp enough to read. */}
      <div aria-hidden className="pointer-events-none select-none opacity-90">
        {children}
      </div>

      {/* The scrim sits behind the words only, not over the whole panel.
        *
        * Raising the preview's opacity did nothing the first time, because a
        * full-panel `bg-panel/70` was laid over the top of it: the content was
        * brighter underneath and the sheet dimmed it straight back. The panel
        * is legible now because nothing covers it — the caption carries its
        * own backing so it stays readable against whatever it lands on. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-4 text-center">
        <span className="rounded-sm bg-panel/95 px-3 py-1 text-[15px] font-medium text-fg shadow-[0_2px_12px_var(--color-bg)]">
          {title}
        </span>
        <button
          onClick={() => setOpen(true)}
          className="rounded-sm bg-premium px-3.5 py-1.5 text-[13px] font-medium text-white shadow-[0_2px_12px_var(--color-bg)] hover:brightness-110"
        >
          Unlock with Premium
        </button>
      </div>

      {open && <PremiumModal feature={feature} onClose={() => setOpen(false)} />}
    </div>
  )
}
