/**
 * One card of the Work board's Kanban (.ai/04-ui.md § Work): the same row as
 * the list (components/WorkRow.tsx) — title, stage bar and word, who, the
 * estimates with their basis, elapsed and cost — stacked to fit a column.
 */
import type { BoardFlow } from '@/lib/prboard'
import { spanText } from '@/lib/prstats'
import type { WorkItem } from '@/lib/work'
import { CostCell, Meta, NoteWord, StageBar, TitleLink, TodoMeter, rowNotes } from './WorkRow'

export function WorkCard({ it, now, passed, flow, onOpenSession, showRepo = true }: { it: WorkItem; now: number; passed: number; flow?: BoardFlow; onOpenSession?: (id: string) => void; showRepo?: boolean }) {
  const notes = rowNotes(it, flow, now, passed)
  return (
    <li data-work-card={it.key} data-work-stage={it.stage} data-needs-you={it.needsYou || undefined}
      className={`grid min-w-0 gap-1.5 rounded-[8px] border bg-panel px-2.5 py-2 ${it.needsYou ? 'border-warn/60' : 'border-border'}`}>
      <div className="flex min-w-0 items-baseline gap-1.5">
        {it.pr && <span className="num shrink-0 text-[12px] text-fg-muted">#{it.pr.number}</span>}
        <TitleLink it={it} onOpenSession={onOpenSession} className="text-[13px]" />
      </div>
      <Meta it={it} showRepo={showRepo} onOpenSession={onOpenSession} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <StageBar it={it} compact />
        <span className={`whitespace-nowrap text-[12px] font-medium ${it.red ? 'text-danger' : it.running ? 'text-warn' : it.stage === 'released' ? 'text-fg-muted' : 'text-fg'}`}>{it.word}</span>
        <NoteWord it={it} className="text-[11.5px]" />
        <span className="ml-auto num whitespace-nowrap text-[12px] text-fg-muted">
          {it.startedAt ? spanText(Math.max(0, now - it.startedAt)) : ''}{it.startedAt ? ' · ' : ''}<CostCell it={it} />
        </span>
      </div>
      {notes.length > 0 && (
        <div className="grid min-w-0 gap-0.5 text-[11.5px] text-fg-muted">
          {notes.map((n, i) => (
            <span key={i} data-work-note title={n.title} className={`flex min-w-0 items-center gap-1.5 ${n.tone ?? ''}`}>
              {n.todo && <TodoMeter done={n.todo.done} total={n.todo.total} />}
              <span className="[overflow-wrap:anywhere]">{n.text}</span>
            </span>
          ))}
        </div>
      )}
    </li>
  )
}
