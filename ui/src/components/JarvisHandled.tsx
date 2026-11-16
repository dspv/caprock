/**
 * Handled for you (.ai/04-ui.md § Jarvis): what Caprock did on its own today
 * — moved a session to another sign-in at a limit and back, carried one on
 * after a rate limit reset, ended finished or long-idle sessions, sent the
 * morning summary, answered a routine question — newest first, each with
 * Undo where one exists (a limit move, through the same continue-on the
 * terminal's toast uses) or a link to the session.
 *
 * GET /v1/jarvis/handled since local midnight, again when the digest's count
 * moves, and the "jarvis" live frame's op handled in between. Nothing is
 * drawn while the list is empty. Open with five or fewer, folded to one line
 * with the count beyond.
 */
import { useEffect, useState } from 'react'
import { api, errText, type HandledItem } from '@/lib/api'
import { live } from '@/lib/live'
import { clockTime, HANDLED_OPEN_MAX, mergeHandled, startOfDay } from '@/lib/jarvis'
import { announceContinued } from '@/lib/continueOn'

export function JarvisHandled({ count, now, canControl, onOpen, onChanged }: {
  /** The digest's handled_today: a change reads the list again. */
  count: number | undefined
  now: number
  canControl: boolean
  onOpen: (id: string) => void
  onChanged: () => void
}) {
  const [items, setItems] = useState<HandledItem[]>([])
  const day = startOfDay(now)
  useEffect(() => {
    let alive = true
    api.jarvisHandled(day).then((r) => { if (alive) setItems(mergeHandled([], r.items ?? [])) }, () => { /* a daemon before Jarvis V2: nothing to list */ })
    return () => { alive = false }
  }, [day, count])
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'jarvis' && f.data.op === 'handled') { const item = f.data.item; setItems((cur) => mergeHandled(cur, [item])) }
  }), [])
  const today = items.filter((h) => h.at >= day)
  // Open by default while short; the reader's own toggle wins after that.
  const [open, setOpen] = useState<boolean | null>(null)
  if (today.length === 0) return null
  const isOpen = open ?? today.length <= HANDLED_OPEN_MAX
  return (
    <section aria-label="Handled for you" data-jarvis-handled className="overflow-hidden rounded-[var(--radius-panel)] border border-border bg-panel">
      <button type="button" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-panel-2/60">
        <span className="num shrink-0 rounded-full bg-ok/15 px-2 text-[12px] font-semibold text-ok">{today.length}</span>
        <span className="min-w-0 truncate font-medium text-fg">Handled for you today</span>
        <span className="ml-auto hidden shrink-0 text-[12px] text-fg-faint sm:inline">nothing here needed you</span>
        <span aria-hidden className={`shrink-0 text-fg-faint transition-transform motion-reduce:transition-none ${isOpen ? 'rotate-90' : ''}`}>›</span>
      </button>
      {isOpen && (
        <ul className="grid grid-cols-[minmax(0,1fr)] border-t border-border">
          {today.map((h) => <HandledRow key={h.id} h={h} canControl={canControl} onOpen={onOpen} onChanged={onChanged} />)}
        </ul>
      )}
    </section>
  )
}

function HandledRow({ h, canControl, onOpen, onChanged }: { h: HandledItem; canControl: boolean; onOpen: (id: string) => void; onChanged: () => void }) {
  const [state, setState] = useState<{ busy?: boolean; done?: string; error?: string }>({})
  const undo = async () => {
    if (!h.undo) return
    setState({ busy: true })
    try {
      const r = await api.continueOn(h.undo.session_id, h.undo.target ?? 'default')
      announceContinued(r)
      setState({ done: 'Undone: continued back.' })
      onChanged()
    } catch (e) {
      setState({ error: errText(e) })
    }
  }
  return (
    <li data-jarvis-handled-item={h.kind} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 border-b border-border px-2.5 py-1.5 text-[13px] last:border-b-0">
      <time className="num text-[12px] text-fg-muted" dateTime={new Date(h.at).toISOString()}>{clockTime(h.at)}</time>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="text-fg">{h.text}</span>
        {h.reason && <span className="block text-[12px] text-fg-muted">{h.reason}</span>}
        {state.done && <span role="status" className="block text-[12px] text-ok">{state.done}</span>}
        {state.error && <span role="alert" className="block text-[12px] text-danger">{state.error}</span>}
      </span>
      <span className="flex shrink-0 gap-2 text-[12px]">
        {h.undo?.kind === 'continue_on' && canControl && !state.done && (
          <button type="button" disabled={state.busy} onClick={() => void undo()} className="text-accent hover:underline disabled:opacity-50">Undo</button>
        )}
        {h.session_id && !h.undo && <button type="button" onClick={() => onOpen(h.session_id!)} className="text-accent hover:underline">Open</button>}
      </span>
    </li>
  )
}
