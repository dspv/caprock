import { useId, useRef, type KeyboardEvent } from 'react'
import { EFFORT_SHORT, EFFORT_WORDS } from '@/lib/effort'

/**
 * Effort, beside Model: one segment per level the agent takes at launch, the
 * one it would use on its own marked "default" and selected until another is
 * picked. Drawn only for an agent with levels (Claude Code, Codex); the
 * caller hides it otherwise. Arrow keys move along it, as the permission
 * picker's do.
 */
export function EffortPicker({
  levels,
  value,
  def,
  onChange,
  labelClassName = 'flex items-baseline gap-2 text-[13px] font-medium text-fg-muted',
}: {
  levels: readonly string[]
  /** The level shown selected: the pick, else the default; '' for none. */
  value: string
  /** The level the agent would start at with nothing passed; '' when unknown. */
  def: string
  onChange: (level: string) => void
  labelClassName?: string
}) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  if (levels.length === 0) return null
  const at = levels.indexOf(value)
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
      <span id={`${id}-l`} className={labelClassName}>Effort</span>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-l`}
        onKeyDown={onKeyDown}
        className="flex min-w-0 gap-[2px] rounded-[7px] border border-border bg-panel-2 p-[2px]"
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
              className={`grid min-w-0 flex-1 content-center justify-items-center rounded-[5px] px-1.5 py-[3px] text-[12px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                on ? 'bg-panel font-semibold text-fg shadow-[inset_0_0_0_1px_var(--color-border-strong)]' : 'text-fg-muted hover:bg-panel/60'
              }`}
            >
              <span className="whitespace-nowrap">{EFFORT_SHORT[v] ?? v}</span>
              {isDef && <span aria-hidden className="text-[9.5px] font-normal leading-none text-fg-faint">default</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
