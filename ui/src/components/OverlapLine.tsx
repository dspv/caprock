import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { OverlapChip } from '@/lib/overlap'

/** The most files the hover card lists; the rest are counted. */
const FILES_SHOWN = 12

/**
 * Another live session in the same checkout, on one line: a quiet chip when
 * they share only the folder, a warning when both edited the same files in
 * the last half hour, and the one way out. Hovering or focusing the chip
 * opens a card with who and every file both touched — a card rather than the
 * browser's tooltip, which waits a second and cuts a long list. Shared with
 * the agent cockpit.
 */
export function OverlapLine({ chip, onMove, className = '' }: { chip: OverlapChip; onMove?: (chip: OverlapChip) => void; className?: string }) {
  const tone = chip.tone === 'warn' ? 'border-warn/50 bg-warn/15 text-warn' : 'border-border-strong bg-panel-2 text-fg-muted'
  const anchor = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <div data-pulse-chip className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ${className}`}>
      <span ref={anchor} tabIndex={0} aria-label={chip.title} data-overlap={chip.tone}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onClick={(e) => e.stopPropagation()}
        className={`inline-flex min-w-0 max-w-full cursor-default items-center rounded-full border px-2 py-[1px] font-medium leading-[1.35] outline-none focus-visible:ring-1 focus-visible:ring-accent ${tone}`}>
        <span className="truncate">{chip.label}</span>
      </span>
      {onMove && (
        <button type="button" data-share-skip onClick={(e) => { e.stopPropagation(); onMove(chip) }} className="link whitespace-nowrap"
          title={`Start a new session in a copy of the folder on its own branch, named after ${chip.newer.name}`}>
          Move to a worktree…
        </button>
      )}
      {open && <OverlapCard chip={chip} anchor={anchor.current} />}
    </div>
  )
}

/** The hover card: placed under the chip, kept inside the window, above every panel. */
function OverlapCard({ chip, anchor }: { chip: OverlapChip; anchor: HTMLElement | null }) {
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
  }, [anchor, chip])
  const more = chip.files.length - FILES_SHOWN
  return createPortal(
    <div ref={card} role="tooltip" data-overlap-card style={style}
      className="pointer-events-none fixed z-50 w-max max-w-[min(380px,calc(100vw-16px))] rounded-[8px] border border-border-strong bg-panel px-3 py-2 text-[11.5px] leading-[1.45] text-fg shadow-[0_12px_32px_-12px_rgba(0,0,0,0.45)]">
      <p className="text-fg-muted">{chip.summary}</p>
      {chip.files.length > 0 && (
        <ul className="mt-1.5 grid gap-0.5">
          {chip.files.slice(0, FILES_SHOWN).map((f) => <li key={f} className="mono truncate text-fg">{f}</li>)}
          {more > 0 && <li className="text-fg-faint">and {more} more</li>}
        </ul>
      )}
    </div>,
    document.body,
  )
}
