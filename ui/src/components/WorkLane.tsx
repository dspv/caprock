/**
 * A group of the Work board (.ai/04-ui.md § Work): in the list, a panel of
 * rows under its name and count ("Next release", "In review", "In work",
 * "Planned", "Released" — that one folded); in the Kanban, a column of cards.
 */
import { useState, type ReactNode } from 'react'
import type { BoardFlow } from '@/lib/prboard'
import type { WorkItem } from '@/lib/work'
import { Panel } from './ui'
import { WorkRow } from './WorkRow'
import { WorkCard } from './WorkCard'

export interface LaneProps {
  id: string
  label: string
  note: string
  items: WorkItem[]
  now: number
  passed: number
  flowOf: (root?: string) => BoardFlow | undefined
  onOpenSession?: (id: string) => void
  showRepo: boolean
  /** Folded until opened (Released). */
  folded?: boolean
  /** Rows shown before "Show N more". */
  limit?: number
  /** What a group says with nothing in it; absent, an empty group is not drawn. */
  empty?: string
  /** A line after the rows (the idle sessions). */
  footer?: ReactNode
}

export function WorkLane({ id, label, note, items, now, passed, flowOf, onOpenSession, showRepo, folded = false, limit, empty, footer, hint = false }: LaneProps & { hint?: boolean }) {
  const [open, setOpen] = useState(!folded)
  const [all, setAll] = useState(false)
  if (items.length === 0 && !empty && !footer) return null
  const shown = limit && !all ? items.slice(0, limit) : items
  const more = items.length - shown.length
  const title = (
    <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={note} data-work-lane-toggle={id}
      className="inline-flex items-center gap-1.5 uppercase tracking-[0.12em] hover:text-fg">
      <span aria-hidden className={`inline-block transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>›</span>
      {label} <span className="num normal-case tracking-normal text-fg-faint">{items.length}</span>
    </button>
  )
  return (
    <section data-work-lane={id} aria-label={label} className="min-w-0">
      <Panel title={title} right={hint ? <span className="hidden sm:inline">agent → PR → CI → merged → released</span> : undefined}>
        {open && (
          <div className="@container/work min-w-0">
            {items.length === 0 && empty && <p className="px-3 py-2.5 text-[13px] text-fg-muted">{empty}</p>}
            {items.length > 0 && (
              <ul>
                {shown.map((it) => <WorkRow key={it.key} it={it} now={now} passed={passed} flow={flowOf(it.repo?.root)} onOpenSession={onOpenSession} showRepo={showRepo} />)}
                {more > 0 && (
                  <li><button type="button" onClick={() => setAll(true)} className="w-full px-3 py-2 text-left text-[13px] text-accent hover:bg-[var(--app-row-hover)]">Show {more} more</button></li>
                )}
              </ul>
            )}
            {footer}
          </div>
        )}
      </Panel>
    </section>
  )
}

/** A Kanban column: its name and count, then its cards. */
export function WorkColumn({ id, label, note, items, now, passed, flowOf, onOpenSession, showRepo, limit, footer }: LaneProps) {
  const [all, setAll] = useState(false)
  const shown = limit && !all ? items.slice(0, limit) : items
  const more = items.length - shown.length
  return (
    <section data-work-column={id} aria-label={label} className="grid min-w-0 content-start gap-2 rounded-[var(--radius-panel)] border border-border bg-panel-2/60 p-2">
      <h2 className="flex items-baseline gap-1.5 px-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted" title={note}>
        {label} <span className="num normal-case tracking-normal text-fg-faint">{items.length}</span>
      </h2>
      {items.length === 0 ? <p className="px-0.5 text-[12px] text-fg-faint">Nothing here.</p> : (
        <ul className="grid min-w-0 gap-2">
          {shown.map((it) => <WorkCard key={it.key} it={it} now={now} passed={passed} flow={flowOf(it.repo?.root)} onOpenSession={onOpenSession} showRepo={showRepo} />)}
          {more > 0 && <li><button type="button" onClick={() => setAll(true)} className="w-full px-1 py-1 text-left text-[12px] text-accent">Show {more} more</button></li>}
        </ul>
      )}
      {footer}
    </section>
  )
}
