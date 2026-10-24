/**
 * PlanShare — the secondary line under (or beside) a cost at API list price:
 * what the same work was of the user's plan.
 *
 *   $50.00            ← the figure, unchanged, primary
 *   ≈$1.65 of plan · ≈2.3% of a week
 *
 * One component for every place a cost shows it (owner, 2026-10-25: the
 * Pipeline's most expensive pull requests and releases, its rows, the Cost
 * screen, the session card), so the wording and the arithmetic cannot drift
 * — the same reason CostBasis is shared. The figures are estimates: muted,
 * smaller than the figure they explain, each piece kept whole (a line wraps
 * between pieces, never inside one), and the hover card says how each was
 * computed, over which period, and why they run a little high.
 *
 * Draws nothing when there is nothing honest to say: no plan stated, a
 * metered plan, no weekly window ever seen, or a daemon from before the
 * rates (rule 6 — no figure is better than a guessed one).
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { planShare, planShareItems, planShareLines, type PlanShare as Share, type SpendPart } from '@/lib/planShare'
import { usePlanRates } from '@/lib/planRates'

/** The figure's plan share from the page's rates; undefined when there is none. */
export function usePlanShare(parts: SpendPart[] | undefined): Share | undefined {
  return planShare(usePlanRates(), parts)
}

export function PlanShare({ parts, tip = true, align = 'start', className = '' }: {
  parts: SpendPart[] | undefined
  /** false inside a row whose own tooltip carries the explanation (planShareTitle). */
  tip?: boolean
  /** Which side the pieces gather on when the line wraps: under a right-aligned figure, the end. */
  align?: 'start' | 'end'
  className?: string
}) {
  const share = usePlanShare(parts)
  const anchor = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  if (!share) return null
  const items = planShareItems(share)
  if (items.length === 0) return null
  const label = planShareLines(share).join(' ')
  return (
    <span ref={anchor} data-plan-share tabIndex={tip ? 0 : undefined} aria-label={tip ? label : undefined}
      onMouseEnter={tip ? () => setOpen(true) : undefined} onMouseLeave={tip ? () => setOpen(false) : undefined}
      onFocus={tip ? () => setOpen(true) : undefined} onBlur={tip ? () => setOpen(false) : undefined}
      className={`num block min-w-0 max-w-full overflow-hidden text-[11px] font-normal leading-snug tracking-normal text-fg-muted ${tip ? 'cursor-help rounded-[3px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent' : ''} ${className}`}>
      {/* Each piece carries its separator on the side the line starts
        * from (the left, or the right when gathered at the end), and the
        * row is pulled out by that much under overflow-hidden: a piece that
        * wraps to a new line never starts with a stray "·". A piece wider
        * than the column breaks between its words, never past the edge. */}
      <span className={`flex flex-wrap items-baseline ${align === 'end' ? '-mr-[1.1em] justify-end text-right' : '-ml-[1.1em]'}`}>
        {items.map((t, i) => (
          <span key={i} className={`min-w-0 ${align === 'end' ? 'pr-[1.1em]' : 'pl-[1.1em]'} relative`}>
            {align !== 'end' && <span aria-hidden className="absolute left-[0.3em] text-fg-faint">·</span>}
            {t}
            {align === 'end' && <span aria-hidden className="absolute right-[0.3em] text-fg-faint">·</span>}
          </span>
        ))}
      </span>
      {open && <PlanShareCard share={share} anchor={anchor.current} />}
    </span>
  )
}

/** The hover card: under the line, kept inside the window, above every panel. */
function PlanShareCard({ share, anchor }: { share: Share; anchor: HTMLElement | null }) {
  const card = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!anchor || !card.current) return
    const a = anchor.getBoundingClientRect()
    const c = card.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(a.left, window.innerWidth - c.width - 8))
    const below = a.bottom + 6
    const top = below + c.height > window.innerHeight - 8 ? Math.max(8, a.top - c.height - 6) : below
    setStyle({ left, top })
  }, [anchor, share])
  const lines = planShareLines(share)
  return createPortal(
    <div ref={card} role="tooltip" data-plan-share-card style={style}
      className="pointer-events-none fixed z-50 w-max max-w-[min(400px,calc(100vw-16px))] rounded-[8px] border border-border-strong bg-panel px-3 py-2 text-left text-[11.5px] font-normal leading-[1.45] tracking-normal text-fg shadow-[0_12px_32px_-12px_rgba(0,0,0,0.45)]">
      <p className="text-fg-muted">{lines[0]}</p>
      {lines.slice(1, -1).map((l, i) => <p key={i} className="mt-1">{l}</p>)}
      <p className="mt-1.5 text-fg-muted">{lines[lines.length - 1]}</p>
    </div>,
    document.body,
  )
}
