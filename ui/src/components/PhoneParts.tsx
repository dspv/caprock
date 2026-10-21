/**
 * Pieces the phone home's sections share (.ai/04-ui.md § The phone home):
 * a section's label and a chip that is a native select.
 */
import type { ReactNode } from 'react'
import { ChevronIcon } from './AppIcons'

/** A section's label, with what it offers on the right. */
export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline px-1 pb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-faint">
      <span>{children}</span>
      {right && <span className="ml-auto text-[13px] normal-case tracking-normal">{right}</span>}
    </div>
  )
}

/**
 * A section's label that is also its fold (owner, 2026-10-21): the whole row,
 * at least 44px tall, opens or closes the section. Folded, it says in one
 * line what the section would show (`summary`); open, it carries what the
 * section offers on the right (`right`, a link or a chip), which sits above
 * the row's button so it keeps its own tap.
 */
export function FoldHeader({ label, folded, onToggle, summary, right, controls }: {
  label: ReactNode
  folded: boolean
  onToggle: () => void
  summary?: ReactNode
  right?: ReactNode
  /** The id of the section's body, for aria-controls. */
  controls?: string
}) {
  return (
    <div data-fold-header className="relative flex min-h-11 min-w-0 items-center gap-2 px-1">
      <button type="button" aria-expanded={!folded} aria-controls={folded ? undefined : controls} onClick={onToggle}
        className="absolute inset-0 rounded-[10px] active:bg-panel-2">
        <span className="sr-only">{label}</span>
      </button>
      <span aria-hidden="true" className={`pointer-events-none relative text-[12px] font-medium uppercase tracking-[0.08em] text-fg-faint ${folded ? 'shrink-0' : 'min-w-0 truncate'}`}>{label}</span>
      <span data-fold-summary className="pointer-events-none relative min-w-0 flex-1 truncate text-[13px] text-fg-muted">{folded ? summary : null}</span>
      {!folded && right && <span className="relative z-[1] flex min-w-0 shrink-0 items-center text-[13px]">{right}</span>}
      <span aria-hidden="true" className={`pointer-events-none relative shrink-0 text-fg-faint transition-transform ${folded ? '' : 'rotate-90'}`}><ChevronIcon size={14} /></span>
    </div>
  )
}

/** A chip that is a native select: the phone's own picker, at the size of a thumb. */
export function ChipSelect({ label, value, onChange, options, icon, empty, className = 'max-w-[44%]' }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  icon?: ReactNode
  empty?: string
  /** Its width: a share of the row it sits in, by default. */
  className?: string
}) {
  const shown = options.find((o) => o.value === value)?.label ?? empty ?? ''
  return (
    <label className={`relative inline-flex min-h-9 ${className} shrink-0 items-center gap-1.5 rounded-full border border-border-strong bg-bg px-3 text-[14px] text-fg`}>
      {icon}
      <span className="truncate">{shown}</span>
      <ChevronIcon size={12} className="rotate-90 shrink-0" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}
