/**
 * The command palette (⌘K): sessions waiting on you, every project, open tab,
 * live session and action in one list, ranked as you type (a match at the
 * start of the name first, then at the start of a word, then anywhere).
 * ↑ ↓ move, Enter runs, ⇧Enter opens a session beside the one in front (a
 * split pane), Escape closes. With nothing matching, the text can start an
 * agent in a new worktree.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Sheet } from './Sheet'

export interface PaletteItem {
  id: string
  group: 'Waiting' | 'Actions' | 'Tabs' | 'Sessions' | 'Projects'
  label: string
  detail?: string
  hint?: string
  icon?: ReactNode
  run: () => void
  /** ⇧Enter: open it in a split pane instead. */
  runAlt?: () => void
}

/** Whether every word of the query appears in the text, in any order. */
export function matches(query: string, text: string): boolean {
  const hay = text.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

/**
 * How well an item matches, 0 for not at all: every word must appear; the
 * label starting with the query scores highest, a word of the label starting
 * with it next, the label containing it next, the detail last.
 */
export function score(query: string, item: Pick<PaletteItem, 'label' | 'detail' | 'group'>): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  if (!matches(q, `${item.label} ${item.detail ?? ''} ${item.group}`)) return 0
  const label = item.label.toLowerCase()
  if (label.startsWith(q)) return 4
  if (label.split(/[\s·/_.-]+/).some((w) => w.startsWith(q))) return 3
  if (label.includes(q)) return 2
  return 1
}

const GROUP_ORDER: PaletteItem['group'][] = ['Waiting', 'Actions', 'Tabs', 'Sessions', 'Projects']

/** The items shown for a query: by group, the group with the best match first once something is typed. */
export function rank(items: PaletteItem[], q: string): PaletteItem[] {
  const scored = items.map((i) => ({ i, s: score(q, i) })).filter((x) => x.s > 0)
  const groups = GROUP_ORDER.map((g, order) => {
    const hits = scored.filter((x) => x.i.group === g).sort((a, b) => b.s - a.s)
    return { hits, best: hits[0]?.s ?? 0, order }
  }).filter((g) => g.hits.length > 0)
  if (q.trim()) groups.sort((a, b) => b.best - a.best || a.order - b.order)
  return groups.flatMap((g) => g.hits.map((x) => x.i)).slice(0, 60)
}

export function CommandPalette({
  items,
  onClose,
  fallback,
}: {
  items: PaletteItem[]
  onClose: () => void
  /** What the typed text can do when nothing matches it. */
  fallback?: (q: string) => PaletteItem | undefined
}) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const shown = useMemo(() => {
    const hit = rank(items, q)
    const extra = hit.length === 0 && q.trim() ? fallback?.(q.trim()) : undefined
    return extra ? [extra] : hit
  }, [items, q, fallback])
  const run = (i: PaletteItem | undefined, alt = false) => {
    if (!i) return
    onClose()
    // After the sheet has handed focus back, so the action's own focus wins.
    window.setTimeout(alt && i.runAlt ? i.runAlt : i.run, 0)
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
            else if (e.key === 'Enter') { e.preventDefault(); run(shown[at], e.shiftKey) }
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
                onClick={(e) => run(i, e.shiftKey)}
                className={`flex h-[34px] cursor-default items-center gap-2.5 rounded-[7px] px-3 text-[13px] ${n === at ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg'}`}
              >
                <span className="flex w-4 justify-center text-fg-muted">{i.icon}</span>
                <span className="min-w-0 truncate">{i.label}</span>
                {i.detail && <span className="min-w-0 flex-1 truncate text-[12px] text-fg-faint">{i.detail}</span>}
                {!i.detail && <span className="flex-1" />}
                {n === at && i.runAlt && <kbd className="mono shrink-0 text-[11px] text-fg-faint" title="Open beside the terminal in front">⇧↩ split</kbd>}
                {i.hint && <kbd className="mono shrink-0 text-[11px] text-fg-faint">{i.hint}</kbd>}
              </div>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}
