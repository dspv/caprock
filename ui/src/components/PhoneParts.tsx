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
