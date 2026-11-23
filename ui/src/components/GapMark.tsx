import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { gapSentence } from '@/lib/gaps'

/**
 * The small ⓘ after a "—" that is a dash because the session's agent does not
 * save the figure (`SessionSummary.gaps`, lib/gaps.ts). The reason used to be
 * a hover title alone, so a dash read as Caprock broken (owner, 2026-11-23);
 * the mark says it is the agent's limit, on hover, keyboard focus or a tap —
 * a phone has no hover, so a tap pins the card and a tap elsewhere, Escape or
 * a scroll puts it away.
 *
 * Quiet: faint ink at 11px, both themes from the tokens. Its card is drawn in
 * a portal at a fixed place clamped to the window, so neither a truncating row
 * nor the inspector's narrowest width cuts it or scrolls sideways, and the
 * mark itself is one glyph wide, its larger hit area drawn outside its box, so
 * nothing moves when it is added. It stops the click, since it sits inside
 * rows and cards that open something when clicked.
 *
 * `decorative` draws the glyph alone, hidden from screen readers, for a place
 * that is itself a control (a menu item): a button in a button is not allowed,
 * and the item carries the sentence in its title.
 */
export function GapMark({ why, decorative, className = '' }: { why: string; decorative?: boolean; className?: string }) {
  const said = gapSentence(why)
  if (decorative) {
    return <span aria-hidden data-gap-mark="decorative" className={`inline-flex shrink-0 align-middle text-fg-faint ${className}`}><InfoGlyph /></span>
  }
  return <GapButton said={said} className={className} />
}

/**
 * A tile's figure that the agent does not save: the dash, its sentence on
 * hover, and the mark after it (a Stat's value, the Session screen and the
 * Now card).
 */
export function GapDash({ why }: { why: string }) {
  return (
    <span data-gap-dash className="inline-flex items-center">
      <span title={gapSentence(why)}>—</span>
      <GapMark why={why} className="ml-1.5" />
    </span>
  )
}

function GapButton({ said, className }: { said: string; className: string }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [place, setPlace] = useState<CSSProperties>()
  const id = useId()
  const open = hover || focus || pinned

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const vw = window.innerWidth || document.documentElement.clientWidth || 320
    const vh = window.innerHeight || document.documentElement.clientHeight || 480
    const width = Math.min(260, vw - 16)
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, vw - width - 8))
    // Under the mark, or over it when it sits near the bottom of the window.
    const below = r.bottom + 6
    setPlace(below + 80 > vh && r.top > 90
      ? { left, width, bottom: vh - r.top + 6 }
      : { left, width, top: below })
  }, [open])

  useEffect(() => {
    if (!open) return
    const away = (e: Event) => {
      if (btn.current && e.target instanceof Node && btn.current.contains(e.target)) return
      setPinned(false); setHover(false)
    }
    const shut = () => { setPinned(false); setHover(false) }
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('scroll', shut, true)
    window.addEventListener('resize', shut)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('scroll', shut, true)
      window.removeEventListener('resize', shut)
    }
  }, [open])

  const onClick = (e: MouseEvent) => {
    // Inside a card that is a link and rows that fold open on a click.
    e.preventDefault(); e.stopPropagation()
    setPinned((p) => !p)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) { e.stopPropagation(); setPinned(false); setHover(false); setFocus(false) }
  }
  // Hover is a mouse's: a tap fires pointerenter too, and must not leave the
  // card stuck open after the tap that closes it.
  const enter = (e: PointerEvent) => { if (e.pointerType === 'mouse') setHover(true) }
  const leave = (e: PointerEvent) => { if (e.pointerType === 'mouse') setHover(false) }

  return (
    <>
      <button ref={btn} type="button" data-gap-mark aria-label={said} aria-describedby={open ? id : undefined} aria-expanded={pinned}
        onClick={onClick} onKeyDown={onKey} onPointerEnter={enter} onPointerLeave={leave}
        onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); setPinned(false) }}
        className={`relative ml-1 inline-flex shrink-0 cursor-help items-center justify-center rounded-full align-middle text-fg-faint outline-none after:absolute after:-inset-1.5 after:content-[''] hover:text-fg-muted focus-visible:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:text-fg-muted ${className}`}>
        <InfoGlyph />
      </button>
      {open && place && createPortal(
        <span id={id} role="tooltip" data-gap-card style={place}
          className="pointer-events-none fixed z-[80] rounded-lg border border-border-strong bg-panel px-2.5 py-1.5 text-left font-sans text-[12px] font-normal normal-case leading-snug tracking-normal text-fg shadow-lg whitespace-normal">
          {said}
        </span>,
        document.body,
      )}
    </>
  )
}

/** A circled i, 11px, drawn in the current ink. */
function InfoGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden className="block">
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
    </svg>
  )
}
