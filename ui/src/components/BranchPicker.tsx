/**
 * The branch a new copy starts from (New agent → Where → New copy). Type to
 * filter; the main branches lead — the remote's default first — then the rest
 * by their newest commit. The owner asked for exactly this (2026-10-10,
 * translated): "I want to take it from master/main, pulled from the chosen
 * branch; there are very strange branches, no branch search, the main ones
 * should be shown".
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { BranchInfo } from '@/lib/projects'
import { scrollIntoList } from '@/lib/scrollIntoList'

export function BranchPicker({ branches, value, onChange, loading }: {
  branches: readonly BranchInfo[]
  value: string
  onChange: (name: string) => void
  loading?: boolean
}) {
  const id = useId().replace(/:/g, '')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches
    return hit.slice(0, 60)
  }, [branches, query])
  useEffect(() => { setActive(0) }, [query])
  // The list alone scrolls to the active row, never the sheet around it (lib/scrollIntoList.ts).
  useEffect(() => {
    const list = listRef.current
    scrollIntoList(list, list?.querySelector<HTMLElement>(`[data-i="${active}"]`))
  }, [active])

  const pick = (name: string) => { onChange(name); setQuery(''); setOpen(false) }
  const firstOther = items.findIndex((b) => !b.main)

  return (
    <div className="relative min-w-0">
      <input
        className="input w-full"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label="Start from branch"
        placeholder={loading ? 'Reading branches…' : value || 'Pick a branch'}
        value={open ? query : value}
        spellCheck={false}
        onFocus={() => { setOpen(true); setQuery('') }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey) && items[active]) { e.preventDefault(); pick(items[active].name) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
        }}
      />
      {open && items.length > 0 && (
        <ul
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-[280px] overflow-y-auto rounded-[8px] border border-border-strong bg-panel p-1 shadow-[var(--shadow-panel)]"
        >
          {items.map((b, i) => (
            <li key={b.name} data-i={i}>
              {i === firstOther && firstOther > 0 && <div className="mx-2 my-1 border-t border-border" />}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(b.name)}
                className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[13px] ${i === active ? 'bg-[var(--app-row-hover)] text-fg' : 'text-fg-muted'}`}
              >
                <span className={`mono truncate ${b.main ? 'text-fg font-medium' : ''}`}>{b.name}</span>
                {b.default && <span className="shrink-0 rounded-[4px] bg-accent/15 px-1.5 text-[11px] text-accent">default</span>}
                <span className="ml-auto shrink-0 text-[11px] text-fg-faint">{b.remote ? (b.local ? `local · ${b.remote}` : b.remote) : 'local'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
