/**
 * Queue — the Tasks screen's second tab (#/queue): across the sessions
 * Caprock started, what each is doing now, what waits in its message queue
 * and roughly when each message starts and is done, and the turns finished in
 * the last three hours. A message added here goes into a session's own queue
 * (ADR-053, POST /v1/agents/{id}/queue): typed in at once at its prompt,
 * otherwise when the turn ends.
 *
 * Estimates are ranges with their basis, never a single time: measured on the
 * owner's history the median missed a turn by about as much as a typical turn
 * lasts (.ai/12-risks.md RISK-08). Under five finished turns in a project
 * there is no number at all, only the count.
 *
 * Kept current by the live frames that can change it — a queue, a turn's
 * start or end, a task list, a prompt — not by polling; the clock ticks the
 * ages locally.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type BoardDone, type BoardSession } from '@/lib/api'
import { live, useLiveConn } from '@/lib/live'
import { useApi } from '@/lib/useApi'
import { useCanControl } from '@/lib/useCanControl'
import { useNow } from '@/lib/useNow'
import { fmtAgo, fmtDuration } from '@/lib/format'
import { basisLabel, changesBoard, etaRange, fmtSpan, freeLabel, itemEta, pickFree, positionLabel, projectsOf, sessionName, stateLabel } from '@/lib/queueboard'
import { Empty, Skeleton } from '@/components/ui'

const H2 = 'flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-fg-faint'
const LIST = 'grid overflow-hidden rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]'
const ROW = 'grid gap-1 border-b border-border/70 px-4 py-3 last:border-0'

/** The board, refetched (at most once a second) when a frame can change it. */
function useBoard() {
  const board = useApi(() => api.queueBoard(), [], { live: false })
  // The daemon's clock against this page's, so ages count from its now.
  const fetched = useRef({ at: Date.now(), now: 0 })
  if (board.data && board.data.now !== fetched.current.now) fetched.current = { at: Date.now(), now: board.data.now }
  const refresh = board.refresh
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = live.onFrame((f) => {
      if (!changesBoard(f) || timer) return
      timer = setTimeout(() => { timer = undefined; refresh() }, 1000)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [refresh])
  const conn = useLiveConn()
  useEffect(() => { if (conn === 'open') refresh() }, [conn, refresh])
  return { ...board, fetchedAt: fetched.current.at }
}

export function QueueView() {
  const board = useBoard()
  const now = useNow(5000)
  const canControl = useCanControl()
  const data = board.data
  // Time since the board was read: every estimate counts down from there.
  const passed = Math.max(0, now - board.fetchedAt)
  const serverNow = data ? data.now + passed : now
  const working = data?.sessions.filter((s) => s.waiting !== '') ?? []
  const idle = data?.sessions.filter((s) => s.waiting === '') ?? []
  const queued = data?.sessions.filter((s) => s.queue.length > 0) ?? []
  const waitingCount = queued.reduce((n, s) => n + s.queue.length, 0)
  return (
    <div className="grid gap-5" data-queue-view>
      <header className="grid gap-1.5 min-w-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-fg">Queue</h1>
        <p className="max-w-[48rem] text-[14px] leading-relaxed text-fg-muted">
          What each agent Caprock started is doing, the messages waiting for its turn to end, and roughly when each is
          done. Times are rough ranges from how long this project's past turns took — the middle half of them, not a promise.
        </p>
      </header>

      {board.error && !data && <Empty title="Cannot reach the daemon">{board.error.message}</Empty>}
      {!data && !board.error && <Skeleton rows={4} />}

      {data && data.sessions.length === 0 && (
        <Empty title="No agents Caprock started are running">
          Start one with New agent; sessions started in your own terminal are watched, never typed into.
        </Empty>
      )}

      {data && data.sessions.length > 0 && canControl && <AddToQueue sessions={data.sessions} onAdded={board.refresh} />}

      {data && data.sessions.length > 0 && (
        <section className="grid gap-2" aria-label="Now">
          <h2 className={H2}>Now<span className="num text-fg-muted">{working.length}</span></h2>
          <ul className={LIST}>
            {[...working, ...idle].map((s) => <NowRow key={s.session_id} s={s} serverNow={serverNow} passed={passed} />)}
          </ul>
        </section>
      )}

      {data && waitingCount > 0 && (
        <section className="grid gap-2" aria-label="Waiting">
          <h2 className={H2}>Waiting<span className="num text-fg-muted">{waitingCount}</span></h2>
          <div className="grid gap-3">
            {queued.map((s) => <WaitingGroup key={s.session_id} s={s} passed={passed} />)}
          </div>
        </section>
      )}

      {data && (
        <section className="grid gap-2" aria-label="Done">
          <h2 className={H2}>Done in the last 3 hours<span className="num text-fg-muted">{data.done.length}</span></h2>
          {data.done.length === 0
            ? <p className="text-[13px] text-fg-faint">No turn of an agent Caprock started has finished since {new Date(data.done_since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
            : <ul className={LIST}>{data.done.map((d) => <DoneRow key={`${d.session_id}-${d.started_at}`} d={d} now={serverNow} />)}</ul>}
        </section>
      )}
    </div>
  )
}

function NowRow({ s, serverNow, passed }: { s: BoardSession; serverNow: number; passed: number }) {
  const running = s.waiting === 'turn'
  const elapsed = s.turn_started_at ? serverNow - s.turn_started_at : undefined
  const tone = running ? 'text-accent' : s.waiting ? 'text-warn' : 'text-fg-faint'
  return (
    <li className={ROW} data-now-row={s.session_id}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <a href={`#/session/${encodeURIComponent(s.session_id)}`} className="truncate text-[15px] font-medium text-fg hover:text-accent">{sessionName(s)}</a>
        <span className={`inline-flex items-center gap-1.5 text-[12px] ${tone}`}>
          <span className={`h-1.5 w-1.5 rounded-full bg-current ${running ? 'animate-pulse' : ''}`} />{stateLabel(s)}
        </span>
        {/* The name already carries the project when the session has no title. */}
        <span className="truncate text-[12px] text-fg-faint">{[s.title ? s.project : '', s.branch].filter(Boolean).join(' · ')}</span>
      </div>
      {s.todo && s.todo.total > 0 && (
        <div className="text-[13px] text-fg-muted">
          {s.todo.active ? <>{s.todo.active} · </> : null}{s.todo.done} of {s.todo.total} done in its task list
        </div>
      )}
      {running && (
        <div className="text-[13px] text-fg-muted">
          {elapsed !== undefined ? <>this turn has run {fmtSpan(elapsed)}</> : 'a turn is running'}
          {s.turn_left && <> · about {etaRange(s.turn_left, passed)} left</>}
        </div>
      )}
      {(running || !s.estimate) && <EstimateNote s={s} />}
    </li>
  )
}

function EstimateNote({ s }: { s: BoardSession }) {
  if (s.estimate) return <div className="text-[11.5px] text-fg-faint" data-basis>{basisLabel(s.estimate, s.project)}{s.estimate_note ? ` · ${s.estimate_note}` : ''}</div>
  if (s.estimate_note) return <div className="text-[11.5px] text-fg-faint" data-basis>No estimate: {s.estimate_note}.</div>
  return null
}

function WaitingGroup({ s, passed }: { s: BoardSession; passed: number }) {
  const working = s.waiting !== ''
  return (
    <div className="grid gap-1.5" data-waiting-group={s.session_id}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        <a href={`#/session/${encodeURIComponent(s.session_id)}`} className="font-medium text-fg hover:text-accent">{sessionName(s)}</a>
        <span className="text-fg-faint">{stateLabel(s)}</span>
      </div>
      <ol className={LIST}>
        {s.queue.map((m) => (
          <li key={m.id} className={ROW} data-queued-item={m.id}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px]">
              <span className="rounded-full bg-accent/15 px-1.5 py-px font-medium text-fg-muted">{positionLabel(m.position, working)}</span>
              {m.start && m.finish
                ? <span className="text-fg-muted" data-eta>{itemEta(m.start, m.finish, passed)} <span className="text-fg-faint">(rough)</span></span>
                : <span className="text-fg-faint">no estimate</span>}
            </div>
            <div className="line-clamp-2 whitespace-pre-wrap break-words text-[14px] text-fg">{m.text}</div>
          </li>
        ))}
      </ol>
      <EstimateNote s={s} />
    </div>
  )
}

function DoneRow({ d, now }: { d: BoardDone; now: number }) {
  return (
    <li className={`${ROW} md:grid-cols-[minmax(0,1fr)_auto] md:items-baseline md:gap-x-5`} data-done-row>
      <div className="grid min-w-0 gap-0.5">
        <span className="truncate text-[14px] text-fg" title={d.prompt}>{d.prompt || <span className="text-fg-faint">(no prompt text)</span>}</span>
        <span className="truncate text-[12px] text-fg-faint">
          <a href={`#/session/${encodeURIComponent(d.session_id)}`} className="hover:text-accent">{sessionName(d)}</a>
          {d.queued && <span className="ml-2 rounded-full bg-accent/15 px-1.5 py-px text-fg-muted">from the queue</span>}
          {d.failed && <span className="ml-2 text-danger">stopped on an error</span>}
        </span>
      </div>
      <span className="text-[12px] text-fg-muted num">{fmtDuration(d.ended_at - d.started_at)} · {fmtAgo(d.ended_at, now)}</span>
    </li>
  )
}

const ANY = '__free__'

/** Add to queue: a session of a project, or whichever of the project's sessions is free first. Only sessions Caprock started are offered (rule 7). */
function AddToQueue({ sessions, onAdded }: { sessions: BoardSession[]; onAdded: () => void }) {
  const projects = useMemo(() => projectsOf(sessions), [sessions])
  const [dir, setDir] = useState(projects[0]?.[0] ?? '')
  const [target, setTarget] = useState(ANY)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  // A project that left the board: fall back to the first.
  const project = projects.some(([d]) => d === dir) ? dir : projects[0]?.[0] ?? ''
  const inProject = sessions.filter((s) => (s.dir ?? '') === project)
  const chosen = target === ANY ? pickFree(sessions, project) : inProject.find((s) => s.session_id === target)
  const submit = async () => {
    const body = text.trim()
    if (!body || !chosen) return
    setBusy(true)
    setNote(null)
    try {
      const res = await api.queueSend(chosen.session_id, body)
      const n = res.queue.messages?.length ?? 0
      setNote({ ok: true, text: res.sent ? `Typed into ${sessionName(chosen)} now.` : `Queued for ${sessionName(chosen)}, ${positionLabel(n, chosen.waiting !== '')}.` })
      setText('')
      onAdded()
    } catch (e) {
      setNote({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-2 rounded-[var(--radius-panel)] border border-border bg-panel px-4 py-3 shadow-[var(--shadow-panel)]" aria-label="Add to queue">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium text-fg">Add to queue</span>
        <label className="sr-only" htmlFor="queue-project">Project</label>
        <select id="queue-project" value={project} onChange={(e) => { setDir(e.target.value); setTarget(ANY) }}
          className="min-h-[32px] rounded-sm border border-border-strong bg-panel-2 px-2 text-fg">
          {projects.map(([d, label]) => <option key={d} value={d}>{label}</option>)}
        </select>
        <label className="sr-only" htmlFor="queue-target">Session</label>
        <select id="queue-target" value={target} onChange={(e) => setTarget(e.target.value)}
          className="min-h-[32px] min-w-0 max-w-full rounded-sm border border-border-strong bg-panel-2 px-2 text-fg">
          <option value={ANY}>Whichever is free first</option>
          {inProject.map((s) => <option key={s.session_id} value={s.session_id}>{sessionName(s)} — {stateLabel(s)}</option>)}
        </select>
        {target === ANY && (
          <span className="text-[12px] text-fg-faint" data-free-pick>
            {chosen ? <>→ {sessionName(chosen)}{chosen.free_in ? <>, {freeLabel(chosen.free_in)}</> : ''}</> : 'no session here can take it'}
          </span>
        )}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="What should it do next?"
        aria-label="Message" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() } }}
        className="w-full resize-y rounded-sm border border-border-strong bg-panel-2 px-3 py-2 text-[14px] text-fg placeholder:text-fg-faint" />
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => void submit()} disabled={busy || !text.trim() || !chosen}
          className="rounded-[8px] bg-accent px-4 py-1.5 text-[13px] font-semibold text-panel hover:opacity-90 disabled:opacity-50">Add</button>
        {note && <span role={note.ok ? 'status' : 'alert'} className={`text-[13px] ${note.ok ? 'text-fg-muted' : 'text-danger'}`}>{note.text}</span>}
      </div>
    </section>
  )
}
