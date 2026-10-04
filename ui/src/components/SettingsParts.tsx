/**
 * The pieces the Settings screen is built from.
 *
 * Plain on purpose. Each section has a title a person would use for it
 * ("Appearance", not "light tone"), and each option says in one line what
 * happens when it is on — not how it works, not why it exists. The how and
 * why live in the code comments and .ai/04-ui.md; the screen is for deciding.
 */
import type { ReactNode } from 'react'

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
      {/* Wraps rather than squeezing: on a phone the status beside a long
        * title drops under it instead of pushing the page sideways. */}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3.5">
        <h2 className="text-[15px] font-medium text-fg">{title}</h2>
        {aside}
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4 pb-4 pt-2.5 text-[13px]">{children}</div>
    </section>
  )
}

/** A checkbox with its label and one plain line about what it does. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  label: string
  hint: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-fg">{label}</span>
        <span className="block text-[12px] leading-relaxed text-fg-muted">{hint}</span>
      </span>
    </label>
  )
}

/** A choice of a few named values, as a row of buttons that wraps. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" role="radiogroup" aria-label={label}>
      <span className="w-24 shrink-0 text-fg-muted">{label}</span>
      <span className="inline-flex flex-wrap gap-1 rounded-md bg-panel-2 p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-[5px] px-3 py-1 text-[12px] ${
              value === o.value ? 'bg-accent font-medium text-panel' : 'text-fg hover:text-accent'
            }`}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  )
}

/** Something most people never need, one click away rather than on screen. */
export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer list-none select-none text-[12px] text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>›</span> {summary}
      </summary>
      <div className="mt-2.5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">{children}</div>
    </details>
  )
}
