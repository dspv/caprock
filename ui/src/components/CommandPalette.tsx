/**
 * The command palette (⌘K): every project, open tab, live session and action
 * in one list, filtered as you type. ↑ ↓ move, Enter runs, Escape closes.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Sheet } from './Sheet'

export interface PaletteItem {
  id: string
  group: 'Actions' | 'Tabs' | 'Sessions' | 'Projects'
  label: string
  detail?: string
  hint?: string
  icon?: ReactNode
  run: () => void
}

/** Whether every word of the query appears in the text, in any order. */
export function matches(query: string, text: string): boolean {
  const hay = text.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

const GROUP_ORDER: PaletteItem['group'][] = ['Actions', 'Tabs', 'Sessions', 'Projects']

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const shown = useMemo(() => {
    const hit = items.filter((i) => !q.trim() || matches(q, `${i.label} ${i.detail ?? ''} ${i.group}`))
    return GROUP_ORDER.flatMap((g) => hit.filter((i) => i.group === g)).slice(0, 60)
  }, [items, q])
  const run = (i: PaletteItem | undefined) => {
    if (!i) return
    onClose()
    // After the sheet has handed focus back, so the action's own focus wins.
    window.setTimeout(i.run, 0)
  }
  let lastGroup = ''
  return (
    <Sheet label="Command palette" onClose={onClose} width={600}>
      <div className="flex items-center gap-2 border-b border-[var(--app-hairline)] px-4">
        <input
          autoFocus
          aria-label="Search"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[at] ? `palette-${shown[at]!.id}` : undefined}
          placeholder="Search projects, sessions, actions…"
          className="h-[48px] w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-faint"
          value={q}
          onChange={(e) => { setQ(e.target.value); setAt(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((n) => Math.min(shown.length - 1, n + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((n) => Math.max(0, n - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); run(shown[at]) }
          }}
        />
      </div>
      <ul id="palette-list" role="listbox" className="grid grid-cols-1 max-h-[52vh] gap-px overflow-y-auto p-1.5">
        {shown.length === 0 && <li className="px-3 py-3 text-[13px] text-fg-muted">Nothing matches “{q}”.</li>}
        {shown.map((i, n) => {
          const head = i.group !== lastGroup
          lastGroup = i.group
          return (
            <li key={i.id}>
              {head && <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-fg-faint">{i.group}</div>}
              <div
                id={`palette-${i.id}`}
                role="option"
                aria-selected={n === at}
                onMouseMove={() => setAt(n)}
                onClick={() => run(i)}
                className={`flex h-[34px] cursor-default items-center gap-2.5 rounded-[7px] px-3 text-[13px] ${n === at ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg'}`}
              >
                <span className="flex w-4 justify-center text-fg-muted">{i.icon}</span>
                <span className="min-w-0 truncate">{i.label}</span>
                {i.detail && <span className="min-w-0 flex-1 truncate text-[12px] text-fg-faint">{i.detail}</span>}
                {!i.detail && <span className="flex-1" />}
                {i.hint && <kbd className="mono shrink-0 text-[11px] text-fg-faint">{i.hint}</kbd>}
              </div>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}
