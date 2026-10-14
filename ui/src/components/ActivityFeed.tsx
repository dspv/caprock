/**
 * ActivityFeed — "What happened" on Home: the moments of every session on the
 * machine, newest first. A session list tells you what exists; this tells you
 * what got done.
 *
 * It was "Live activity", a line per tool call, and on a working machine that
 * is nine reads for every change: the owner (2026-10-14, translated) — "This
 * block is completely uninformative." It now shows moments (lib/moments.ts):
 * files edited, tests and builds with their result, commits, pushes, pull
 * requests, subagents, a session waiting on you, a command that failed. The
 * calls in between are a quiet count. *All commands* brings the line-per-call
 * feed back for whoever wants it.
 *
 * Seeded from recent history so it is never empty on open, then fed by the
 * live WebSocket. It keeps a window of raw events and derives the rows from
 * it, so a frame that lands before the seed cannot leave them out of order.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type Event, type SessionSummary } from '@/lib/api'
import { live } from '@/lib/live'
import { toFeedItem, type FeedItem } from '@/lib/feed'
import { momentLine, slimEvent, toMoments, type Moment } from '@/lib/moments'
import { fmtAgo, shortId } from '@/lib/format'
import { Panel } from '@/components/ui'
import { href } from '@/lib/router'
import { NewPill } from './NewPill'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { useFrameBatch } from '@/lib/framebatch'

/** Raw events kept: enough for an hour of moments on a busy machine. */
const WINDOW = 1500
/** Events read per session when seeding. */
const SEED_PER_SESSION = 300
/** Rows shown. */
const ROWS = 60
/** Per-viewer choice of view; the page works the same without it. */
const MODE_KEY = 'caprock.activity.mode'

type Mode = 'moments' | 'all'

function readMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === 'all' ? 'all' : 'moments' } catch { return 'moments' }
}

/** One row, whichever view made it. */
interface Row {
  id: string
  ts: number
  sessionId: string
  icon: string
  text: string
  detail?: string
  tone: FeedItem['tone']
  quiet?: number
  agent?: string
}

function momentRow(m: Moment): Row {
  const l = momentLine(m)
  return { id: m.id, ts: m.ts, sessionId: m.sessionId, ...l, quiet: m.quiet, agent: m.agent }
}

/** Keeps the window: dedupe by id, newest WINDOW by id. */
function merge(cur: Event[], add: Event[]): Event[] {
  const seen = new Set(cur.map((e) => e.id))
  const fresh = add.filter((e) => !seen.has(e.id))
  if (fresh.length === 0) return cur
  const all = [...cur, ...fresh].sort((a, b) => a.id - b.id)
  return all.length > WINDOW ? all.slice(all.length - WINDOW) : all
}

export function ActivityFeed({ sessions, now, emptyHint }: { sessions: SessionSummary[]; now: number; emptyHint?: ReactNode }) {
  const [events, setEvents] = useState<Event[]>([])
  const [paused, setPaused] = useState(false)
  const [mode, setMode] = useState<Mode>(readMode)
  const [tasks, setTasks] = useState<ReadonlyMap<string, string>>(() => new Map())
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  // Held in a ref so the WS subscription never re-subscribes when sessions load.
  const known = useRef(new Map<string, SessionSummary>())
  for (const s of sessions) known.current.set(s.session_id, s)

  // Frames land a batch at a time (lib/framebatch): one render per
  // FRAME_BATCH_MS while agents work, not one per event.
  const incoming = useFrameBatch<Event>((batch) => setEvents((cur) => merge(cur, batch)))

  // Seed from history so the panel has content the moment it opens.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Seed from the most recently active sessions whether or not they are
      // still running: on a quiet machine every session is "ended", and an
      // empty feed reads as broken rather than as a calm morning.
      const recent = [...sessions]
        .sort((a, b) => b.last_event_at - a.last_event_at)
        .slice(0, 4)
      // The NEWEST events, not the oldest: `events(id, 0, n)` pages forward
      // from the start of a session, so on anything long-running this seeded
      // the feed with a fortnight-old history and called it live activity.
      const batches = await Promise.all(
        recent.map((s) => api.recentEvents(s.session_id, SEED_PER_SESSION).catch(() => [] as Event[])),
      )
      // Subagents launched before the seeded window, by the task they were
      // given: a busy session's window is minutes long, and without this
      // every subagent row read "subagent".
      const subs = await Promise.all(
        recent.map((s) => api.subagents(s.session_id, 30).catch(() => null)),
      )
      if (cancelled) return
      setTasks((cur) => {
        const next = new Map(cur)
        for (const n of subs) for (const a of [...(n?.working ?? []), ...(n?.recent ?? [])]) {
          if (a.description) next.set(a.agent_id, a.description)
        }
        return next
      })
      const seeded = batches.flat().map(slimEvent)
      // Merge rather than replace: a live frame usually lands before this
      // resolves. Drop anything from a session no longer in scope: a filter
      // change must clear the other agent's rows rather than merge around them.
      const inScope = new Set(recent.map((s) => s.session_id))
      setEvents((cur) => merge(cur.filter((e) => !e.session_id || inScope.has(e.session_id)), seeded))
    })()
    return () => { cancelled = true }
    // Re-seeds when the set of sessions changes, which is what an agent filter
    // does. The set, not the order: keyed on the order, every swap between
    // two busy sessions read their history again (50 requests a minute under
    // a steady stream; bench, 2026-10-13).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.map((s) => s.session_id).sort().join(',')])

  // Which sessions this feed is allowed to show. A live frame carries no
  // agent, only a session id, so the filter has to be applied by membership.
  const allowed = useRef(new Set<string>())
  allowed.current = new Set(sessions.map((s) => s.session_id))

  useEffect(() => {
    return live.onFrame((f) => {
      if (f.type !== 'event' || pausedRef.current) return
      const e = f.data as Event
      if (!e || typeof e.id !== 'number') return
      const id = e.session_id
      // An unknown id is shown: it is a session that started after this list
      // was fetched, and hiding new work is worse than briefly showing one
      // that a filter would have excluded.
      if (id && known.current.has(id) && !allowed.current.has(id)) return
      incoming.push(slimEvent(e))
    })
  }, [incoming])

  // "Running" turns into "no result recorded" after ten minutes; a minute's
  // resolution is enough for that, and keeps the rows from being rebuilt on
  // every one-second tick.
  const minute = Math.floor(now / 60_000)
  const rows = useMemo<Row[]>(() => {
    if (mode === 'all') {
      return events
        .map((e) => toFeedItem(e))
        .filter((x): x is FeedItem => x !== null)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, ROWS)
    }
    return toMoments(events, minute * 60_000 + 60_000, ROWS, tasks).map(momentRow)
  }, [events, mode, minute, tasks])

  // Newest first: a reader scrolled down keeps their row while new ones arrive
  // above (the scrolling rule, WP-11). The pill counts rows not seen before.
  const seenIds = useRef(new Set<string>())
  const [received, setReceived] = useState(0)
  useEffect(() => {
    let n = 0
    for (const r of rows) if (!seenIds.current.has(r.id)) { seenIds.current.add(r.id); n++ }
    if (n) setReceived((v) => v + n)
  }, [rows])
  const stick = useStickToBottom({ edge: 'top', total: received })

  const pickMode = (m: Mode) => {
    setMode(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* this page only */ }
  }

  const chip = 'text-[11px] mono px-1.5 py-0.5 rounded-sm border'
  return (
    <Panel
      fold="now.activity"
      title="What happened"
      right={
        <span className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => pickMode(mode === 'all' ? 'moments' : 'all')}
            aria-pressed={mode === 'all'}
            title={mode === 'all' ? 'Show only what happened: edits, tests, commits, PRs' : 'Show every command and tool call'}
            className={`${chip} ${mode === 'all' ? 'text-fg border-fg-faint bg-panel' : 'text-fg-faint border-border hover:text-fg'}`}
          >
            All commands
          </button>
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            className={`${chip} text-fg-faint hover:text-fg border-border`}
          >
            {paused ? 'resume' : 'pause'}
          </button>
        </span>
      }
    >
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-fg-muted">
          {/* Under an agent filter this is "nothing from that agent", not
            * "nothing at all". */}
          {emptyHint ?? (events.length > 0 && mode === 'moments'
            ? <>Only reads and searches so far — nothing edited, tested or committed.</>
            : <>Nothing yet — start <span className="mono">claude</span> in any terminal.</>)}
        </div>
      ) : (
        // A fade at the bottom edge, so a list that continues looks like one.
        <div className="relative">
          <div ref={stick.ref} className="max-h-[420px] overflow-y-auto">
            {rows.map((r) => (
              <RowLine key={r.id} r={r} now={now} session={known.current.get(r.sessionId)} />
            ))}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-panel to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 top-1.5 flex justify-center">
            <NewPill count={stick.newCount} edge="top" onJump={stick.jump} />
          </div>
        </div>
      )}
    </Panel>
  )
}

function toneClass(tone: FeedItem['tone']): string {
  switch (tone) {
    case 'ok': return 'text-ok'
    case 'warn': return 'text-warn'
    case 'danger': return 'text-danger'
    default: return 'text-fg-faint'
  }
}

/** What names a session in a row: its title, else its repo, else its id. */
function sessionName(s: SessionSummary | undefined, id: string): string {
  return s?.description || s?.project || shortId(id)
}

// Every row is one fixed height with its cells centred, whatever they hold:
// baseline alignment with an emoji glyph (⏳) and two font sizes in one row
// gave rows of different heights, and the gaps between them looked random.
function RowLine({ r, now, session }: { r: Row; now: number; session?: SessionSummary }) {
  const name = sessionName(session, r.sessionId)
  const who = session?.project && session.description ? `${session.project} · ${session.description}` : name
  return (
    <a
      href={href({ name: 'session', id: r.sessionId, at: r.ts })}
      data-testid="activity-row"
      title={r.agent ? `${who} — subagent: ${r.agent}` : who}
      className="grid h-7 grid-cols-[1rem_minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 px-3 border-t border-border first:border-t-0 hover:bg-panel-2 no-underline text-fg leading-none"
    >
      <span aria-hidden className={`mono text-[12px] text-center overflow-hidden ${toneClass(r.tone)}`}>{r.icon}</span>
      <span className="text-[11px] text-fg-muted truncate">
        {r.agent ? <><span className="text-fg-faint">↳ </span>{r.agent === 'subagent' ? <span className="text-fg-faint">{name}</span> : r.agent}</> : name}
      </span>
      <span className="text-[12px] truncate">
        <span className="text-fg-muted">{r.text}</span>
        {r.detail && <span className="mono text-fg ml-1.5">{r.detail}</span>}
      </span>
      <span className="inline-flex items-center gap-2 text-[11px] text-fg-faint">
        {r.quiet ? <span className="num" title={`${r.quiet} reads, searches and other calls before this`}>+{r.quiet}</span> : null}
        <span className="num">{fmtAgo(r.ts, now)}</span>
      </span>
    </a>
  )
}
