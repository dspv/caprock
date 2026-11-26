import { useId, useRef, type KeyboardEvent } from 'react'
import { EFFORT_SHORT, EFFORT_WORDS } from '@/lib/effort'

/**
 * Effort, beside Model: one segment per level the agent takes at launch, the
 * one it would use on its own selected until another is picked and named in
 * the label row ("Effort  Med is default"), the muted hint the sheet's other
 * fields carry. Drawn only for an agent with levels (Claude Code, Codex); the
 * caller hides it otherwise. Arrow keys move along it, as the permission
 * picker's do.
 *
 * One line per segment, the group exactly as tall as the Model select beside
 * it (an `.input`: 12px text, 1.5 line height, 4px padding, 1px border =
 * 28px), so the two labels share a baseline and the two controls a top and a
 * bottom. The marker used to stack a second line under its segment, which
 * made the group taller and lifted the Effort label above Model's (owner,
 * 2026-11-26).
 */
export function EffortPicker({
  levels,
  value,
  def,
  onChange,
  labelClassName = 'flex items-baseline gap-2 text-[13px] font-medium text-fg-muted',
  dotHint = false,
}: {
  levels: readonly string[]
  /** The level shown selected: the pick, else the default; '' for none. */
  value: string
  /** The level the agent would start at with nothing passed; '' when unknown. */
  def: string
  onChange: (level: string) => void
  labelClassName?: string
  /** The hint written "Effort · Med is default", as a compact dialog's fields write theirs. */
  dotHint?: boolean
}) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  if (levels.length === 0) return null
  const at = levels.indexOf(value)
  const defShort = levels.includes(def) ? (EFFORT_SHORT[def] ?? def) : ''
  const pick = (i: number) => {
    const n = levels.length
    const j = ((i % n) + n) % n
    onChange(levels[j]!)
    refs.current[j]?.focus()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    let to: number
    if (e.key === 'ArrowRight') to = at + 1
    else if (e.key === 'ArrowLeft') to = at < 0 ? levels.length - 1 : at - 1
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = levels.length - 1
    else return
    e.preventDefault()
    e.stopPropagation()
    pick(to)
  }
  return (
    <div className="grid min-w-0 gap-1.5" data-effort-picker>
      {/* The group is named by "Effort" alone; each segment says its own default. */}
      <span className={labelClassName}>
        <span id={`${id}-l`}>Effort</span>
        {defShort && (
          <span aria-hidden data-effort-hint className="min-w-0 truncate font-normal text-fg-faint">
            {dotHint ? ` · ${defShort} is default` : `${defShort} is default`}
          </span>
        )}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-l`}
        onKeyDown={onKeyDown}
        className="flex h-[28px] min-w-0 max-sm:h-[34px] pointer-coarse:h-[34px] gap-[2px] rounded-[7px] border border-border bg-panel-2 p-[2px]"
      >
        {levels.map((v, i) => {
          const on = i === at
          const isDef = v === def
          const words = EFFORT_WORDS[v] ?? v
          return (
            <button
              key={v}
              ref={(el) => { refs.current[i] = el }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={isDef ? `${words}, its default` : words}
              title={isDef ? `${words} · what it uses on its own; nothing is passed` : `${words} · passed at start`}
              tabIndex={on || (at < 0 && i === 0) ? 0 : -1}
              onClick={() => onChange(v)}
              data-effort={v}
              data-default={isDef || undefined}
              className={`flex min-w-0 flex-1 items-center justify-center rounded-[5px] px-1.5 text-[12px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                on ? 'bg-panel font-semibold text-fg shadow-[inset_0_0_0_1px_var(--color-border-strong)]' : 'text-fg-muted hover:bg-panel/60'
              }`}
            >
              <span className="whitespace-nowrap">{EFFORT_SHORT[v] ?? v}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
