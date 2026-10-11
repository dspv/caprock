/**
 * The cockpit's Tasks block: the task list the agent keeps for itself, as the
 * daemon rebuilds it from the agent's own TodoWrite, TaskCreate/TaskUpdate
 * and update_plan calls (`GET /v1/sessions/{id}/todos`). One row per task with
 * its state — a spinner while in progress, a check when done, a hollow circle
 * still to do — and "3 of 7 done" above them. A session that never kept a
 * list shows nothing at all.
 *
 * Read on open, every twenty seconds while the window is visible (the
 * inspector's cadence for its changes), and again a moment after the session
 * makes a task call on the live socket it already follows.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type SessionTodos, type TodoItem } from '@/lib/api'
import { live } from '@/lib/live'
import { everyWhileVisible } from '@/lib/visible'
import { SectionLabel } from './Cockpit'

const TODOS_POLL_MS = 20_000
/** A task call on the socket is followed by a read this long after it. */
const TODOS_AFTER_CALL_MS = 1_000
/** Longer lists fold to this many rows around the work in hand. */
export const TODO_ROWS = 8
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan'])

export function useSessionTodos(sessionId: string): SessionTodos | undefined {
  const [data, setData] = useState<SessionTodos | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { setData(undefined) }, [sessionId])
  useEffect(() => {
    let alive = true
    api.todos(sessionId)
      .then((r) => { if (alive && r && Array.isArray(r.items)) setData(r) })
      .catch(() => { /* an older daemon: no block */ })
    return () => { alive = false }
  }, [sessionId, tick])
  useEffect(() => {
    const stop = everyWhileVisible(() => setTick((t) => t + 1), TODOS_POLL_MS)
    const off = live.onFrame((f) => {
      if (f.type !== 'event' || f.data.session_id !== sessionId || f.data.agent_id || !TODO_TOOLS.has(f.data.tool ?? '') || pending.current) return
      pending.current = setTimeout(() => { pending.current = undefined; setTick((t) => t + 1) }, TODOS_AFTER_CALL_MS)
    })
    return () => {
      stop()
      off()
      if (pending.current) { clearTimeout(pending.current); pending.current = undefined }
    }
  }, [sessionId])
  return data
}

/** "3 of 7 done": a cancelled task is neither done nor still to do. */
export function todoCount(items: readonly TodoItem[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const t of items) {
    if (t.status === 'cancelled') continue
    total++
    if (t.status === 'completed') done++
  }
  return { done, total }
}

/**
 * The rows a folded list shows: TODO_ROWS of them, starting two before the
 * first task not yet finished, so the work in hand is on screen with what was
 * just done above it.
 */
export function todoWindow(items: readonly TodoItem[], rows = TODO_ROWS): { start: number; end: number } {
  if (items.length <= rows) return { start: 0, end: items.length }
  let open = items.findIndex((t) => t.status === 'in_progress')
  if (open < 0) open = items.findIndex((t) => t.status === 'pending')
  if (open < 0) open = items.length
  const start = Math.max(0, Math.min(open - 2, items.length - rows))
  return { start, end: start + rows }
}

export function TodoBlock({ sessionId }: { sessionId: string }) {
  const todos = useSessionTodos(sessionId)
  const [all, setAll] = useState(false)
  useEffect(() => { setAll(false) }, [sessionId])
  const items = todos?.items ?? []
  if (items.length === 0) return null
  const { done, total } = todoCount(items)
  const { start, end } = all ? { start: 0, end: items.length } : todoWindow(items)
  const shown = items.slice(start, end)
  const folded = items.length - shown.length
  return (
    <section aria-label="Tasks" className="grid gap-2">
      <SectionLabel right={<span className="num text-[13px] text-fg-muted"><span className="font-semibold text-fg">{done}</span> of {total} done</span>}>
        Tasks
      </SectionLabel>
      <ul className="grid gap-1">
        {shown.map((t) => <TodoRow key={t.id} t={t} />)}
      </ul>
      {(folded > 0 || all) && (
        <button type="button" onClick={() => setAll((v) => !v)} className="justify-self-start text-[12.5px] text-fg-muted hover:text-fg">
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  )
}

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: 'to do',
  in_progress: 'in progress',
  completed: 'done',
  cancelled: 'cancelled',
}

function TodoRow({ t }: { t: TodoItem }) {
  const active = t.status === 'in_progress'
  const text = active && t.active_form ? t.active_form : t.text
  const tone = active ? 'font-medium text-fg' : t.status === 'pending' ? 'text-fg' : t.status === 'completed' ? 'text-fg-muted' : 'text-fg-faint line-through'
  return (
    <li className={`flex items-start gap-2.5 rounded-[8px] px-2 py-1.5 ${active ? 'bg-warn/[0.09]' : ''}`} data-status={t.status}
      title={active && t.active_form ? `${t.text} (in progress)` : `${t.text} (${STATUS_LABEL[t.status]})`}>
      <span className="mt-[3px] grid h-[16px] w-[16px] shrink-0 place-items-center" role="img" aria-label={STATUS_LABEL[t.status]}>
        <TodoIcon status={t.status} />
      </span>
      <span className={`line-clamp-2 min-w-0 text-[14px] leading-[1.4] ${tone}`}>{text}</span>
    </li>
  )
}

function TodoIcon({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'in_progress':
      return <span className="ci-spin block h-[13px] w-[13px] rounded-full" />
    case 'completed':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="text-ok">
          <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.16" />
          <path d="m4.8 8.2 2.2 2.2 4.3-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'cancelled':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="text-fg-faint">
          <path d="M5 8h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
    default:
      return <span className="block h-[13px] w-[13px] rounded-full border-[1.5px] border-fg-faint" />
  }
}
