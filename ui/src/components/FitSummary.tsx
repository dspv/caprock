/**
 * A section row's one-line summary that never cuts a word (owner,
 * 2026-10-22: the folded Changes row read "511 files +35244 −7781 Review
 * and co", clipped at the inspector's edge). It is given its wordings
 * widest first — full figures and the whole action, then compacted figures
 * (35.2k), a shorter action, fewer parts — and shows the first that fits
 * the room the row leaves it, measured again whenever that room or the
 * wordings change. When even the last does not fit, nothing is shown rather
 * than half of it: the section's label opens it for the rest.
 *
 * Every wording is laid out in the same grid cell so each can be measured;
 * only the one picked is visible, focusable or read out.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function FitSummary({ variants, className = '', title }: { variants: readonly ReactNode[]; className?: string; title?: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const [pick, setPick] = useState(0)
  const fit = useRef(() => {})
  fit.current = () => {
    const el = box.current
    if (!el) return
    const room = el.clientWidth
    const kids = Array.from(el.children) as HTMLElement[]
    // jsdom lays nothing out: every width is 0 and the widest wording stands.
    const i = kids.findIndex((k) => k.offsetWidth <= room)
    setPick(i < 0 ? kids.length : i)
  }
  // Each render: a figure that grew may no longer fit (a few reads, no writes).
  useLayoutEffect(() => { fit.current() })
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fit.current())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <span ref={box} data-fit-summary data-fit-pick={pick} title={title}
      className={`grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] justify-items-end overflow-hidden ${className}`}>
      {variants.map((v, i) => (
        <span key={i} data-fit-variant={i} aria-hidden={i !== pick || undefined} inert={i !== pick || undefined}
          className={`col-start-1 row-start-1 flex w-max items-baseline gap-2 whitespace-nowrap ${i === pick ? '' : 'invisible'}`}>
          {v}
        </span>
      ))}
    </span>
  )
}
