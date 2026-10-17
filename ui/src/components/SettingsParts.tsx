/**
 * The pieces the Settings screen is built from.
 *
 * Plain on purpose. Each section has a title a person would use for it
 * ("Appearance", not "light tone"), and each option says in one line what
 * happens when it is on — not how it works, not why it exists. The how and
 * why live in the code comments and .ai/04-ui.md; the screen is for deciding.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { SectionIcon } from './SettingsIcons'
import { useFilteredOut } from './SettingsSearch'

/** A section's anchor: its own id, else one made from its title. */
export function sectionId(title: string): string {
  return `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

const FOLDS_KEY = 'caprock-settings-folds'

/** The window event that unfolds a section by id: a link landing on it (Pairing's revealSection). */
export const REVEAL_EVENT = 'caprock:settings-reveal'

function readFolds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '[]') as string[]) } catch { return new Set() }
}

/**
 * A section: its icon and title large, the controls, and the explanations
 * only on demand (owner, 2026-10-11, translated: "everything large — big
 * buttons; nobody wants to read all this; quick settings and numbers in view;
 * maybe a fold toggle"). The title folds the section, kept per viewer; *?*
 * shows this section's explanations when the page hides them
 * (`data-settings-explain`, StatusScreen).
 */
export function Section({ id, title, aside, children, explained }: { id?: string; title: string; aside?: ReactNode; children: ReactNode; /** Always shows its prose: a problem is its explanation. */ explained?: boolean }) {
  const sid = id ?? sectionId(title)
  const [folded, setFolded] = useState(() => readFolds().has(sid))
  const [explain, setExplain] = useState(false)
  // Settings search (SettingsSearch): a section the query does not find is
  // hidden, not unmounted, so its text stays readable to the index.
  const filteredOut = useFilteredOut(sid)
  // A link that lands here (#/settings/phone) opens a folded section: being
  // sent somewhere and finding a closed lid was the complaint.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== sid) return
      setFolded(false)
      try {
        const all = readFolds()
        if (all.delete(sid)) localStorage.setItem(FOLDS_KEY, JSON.stringify([...all]))
      } catch { /* private window */ }
    }
    window.addEventListener(REVEAL_EVENT, on)
    return () => window.removeEventListener(REVEAL_EVENT, on)
  }, [sid])
  const fold = () => {
    const next = !folded
    setFolded(next)
    try {
      const all = readFolds()
      if (next) all.add(sid); else all.delete(sid)
      localStorage.setItem(FOLDS_KEY, JSON.stringify([...all]))
    } catch { /* private window */ }
  }
  return (
    <section id={sid} hidden={filteredOut || undefined} data-settings-section={title} data-explain={explain || explained ? 'on' : undefined} className="min-w-0 scroll-mt-16 rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
      {/* Wraps rather than squeezing: on a phone the status beside a long
        * title drops under it instead of pushing the page sideways. */}
      <header className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 ${folded ? 'py-3' : 'pt-3.5'}`}>
        <button type="button" onClick={fold} aria-expanded={!folded} className="flex min-w-0 items-center gap-2.5 text-left">
          <span aria-hidden className={`text-[13px] text-fg-faint transition-transform ${folded ? '' : 'rotate-90'}`}>›</span>
          <SectionIcon title={title} size={18} />
          <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
        </button>
        <span className="flex items-center gap-2">
          {aside}
          {!folded && !explained && (
            <button type="button" data-explain-toggle onClick={() => setExplain((v) => !v)} aria-pressed={explain}
              title={explain ? 'Hide the explanations' : 'What do these do?'}
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-[12px] font-semibold ${explain ? 'border-accent text-accent' : 'border-border-strong text-fg-faint hover:text-fg'}`}>
              ?
            </button>
          )}
        </span>
      </header>
      {!folded && <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5 px-4 pb-4 pt-3 text-[14px]">{children}</div>}
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
        className="mt-[2px] h-[18px] w-[18px] shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[14.5px] text-fg">{label}</span>
        <span data-help className="block text-[12.5px] leading-relaxed text-fg-muted">{hint}</span>
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
      <span className="w-28 shrink-0 text-[14px] text-fg-muted">{label}</span>
      <span className="inline-flex flex-wrap gap-1 rounded-lg bg-panel-2 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3.5 py-1.5 text-[14px] ${
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
