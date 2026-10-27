/**
 * Live pulse — one track per session, one bar per minute.
 *
 * The point is that the picture *is* the data: a bar's height is how much
 * happened in that minute and its colour is what kind of work it was, so the
 * shape of a track is the shape of the work. A task that ramped up and finished
 * draws a bell; steady grinding draws a plateau; working in bursts draws a
 * comb. Nothing is decorative — there is no animation that does not correspond
 * to something the daemon recorded.
 *
 * On drawing: the canvas is repainted only when the data changes, never on a
 * timer. The first version of this ran a requestAnimationFrame loop that
 * repainted every frame and visibly flickered; a dashboard that shimmers while
 * you read it is worse than a still one. The only motion is a CSS pulse on the
 * newest bar, which costs nothing and means "this minute is still filling".
 */
import { branchLabel, projectLabels, sessionHealth } from '@/lib/sessionLabels'
import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { api, errText, type DiffResult, type Event, type SessionCI, type SessionSummary } from '@/lib/api'
import { live } from '@/lib/live'
import { useFrameBatch } from '@/lib/framebatch'
import { buildPulse, costTier, medianCost, trackState, windowCost, windowEvents, PULSE_MINUTES, type Pulse as PulseModel } from '@/lib/pulse'
import { fmtAgo, fmtModel, fmtPct, fmtTokens, fmtUSD, shortId } from '@/lib/format'
import { AgentCharacter, agentName } from '@/components/Characters'
import { SessionCharacter } from '@/components/SessionFace'
import { ProjectTerminal, QUIET } from '@/components/ProjectTerminal'
import { RepoButtons } from '@/components/RepoLinks'
import { useApi } from '@/lib/useApi'
import { Panel } from '@/components/ui'
import { href, navigate } from '@/lib/router'
import { showsAgentMark } from '@/components/Projects'
import { AgentGlyph } from '@/components/AgentMarks'
import { sessionTitle } from '@/lib/sidebar'
import { loadPulseOrder, pulseOrder, savePulseOrder, tabSessionOrder } from '@/lib/pulseOrder'
import { moveKey } from '@/lib/rowOrder'
import { isMacPlatform } from '@/lib/appmode'
import { keys } from '@/lib/appkeys'
import { mayShare, overlapChip, useOverlap, type OverlapChip } from '@/lib/overlap'
import { SpawnDialog } from '@/components/SpawnDialog'
import { worktreeSlug } from '@/lib/slug'
import { OverlapLine } from '@/components/OverlapLine'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { endable, sessionJump, type SessionJump } from '@/lib/sessionJump'
import { extTitle } from '@/lib/externalLinks'

/** How many tracks to show. More than this and no single one is readable. */
const MAX_TRACKS = 6

/** Events pulled per session to seed a track. At ~33 events/minute in a busy
 * session, an hour needs about two thousand. */
const SEED_LIMIT = 2000

const OPEN_KEY = 'caprock-pulse-open'
/** "hidden" once this viewer closed the legend; the header's ? brings it back. */
const LEGEND_KEY = 'caprock-pulse-legend'

function readLegend(): boolean {
  try {
    return localStorage.getItem(LEGEND_KEY) !== 'hidden'
  } catch {
    return true
  }
}

function readOpen(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function PulsePanel({ sessions, now }: { sessions: SessionSummary[]; now: number }) {
  // The order set by hand (lib/pulseOrder.ts), this viewer's.
  const [manual, setManual] = useState<string[]>(loadPulseOrder)
  // Which sessions get a track: the running ones, newest first, when there
  // are more than fit. Ended sessions are dropped here rather than relying on
  // the caller's filter: the Now screen offers a "show ended" tick, and a
  // finished session has no pulse to show whether or not the list it came
  // from includes it. Where a track SITS is fixed (owner, 2026-10-14): by
  // hand, the tab strip, then start time — never by the newest event, which
  // swapped two busy sessions every few seconds.
  const tracked = useMemo(
    () =>
      pulseOrder(
        [...sessions]
          .filter((s) => s.status !== 'ended')
          .sort((a, b) => b.last_event_at - a.last_event_at)
          .slice(0, MAX_TRACKS),
        manual,
        tabSessionOrder(),
      ),
    [sessions, manual],
  )
  // The set, not the order: keyed on the order, a move would read 2,000
  // events per track again (60 requests a minute when busy sessions swapped
  // places; bench, 2026-10-13).
  const ids = tracked.map((s) => s.session_id).sort().join(',')
  const labels = useMemo(() => projectLabels(sessions), [sessions])

  const [events, setEvents] = useState<Map<string, Event[]>>(new Map())

  // Seed from history so a track is never blank on open, then follow the live
  // stream. Only the window's worth is kept: an unbounded array would grow for
  // as long as the tab stays open. A track already seeded is followed live,
  // not read again; one that left and came back is.
  const seeded = useRef(new Set<string>())
  useEffect(() => {
    let cancelled = false
    const list = ids ? ids.split(',') : []
    for (const id of seeded.current) if (!list.includes(id)) seeded.current.delete(id)
    const fresh = list.filter((id) => !seeded.current.has(id))
    void (async () => {
      const batches = await Promise.all(fresh.map((id) => api.recentEvents(id, SEED_LIMIT).catch(() => [] as Event[])))
      if (cancelled) return
      for (const id of fresh) seeded.current.add(id)
      const got = new Map(fresh.map((id, i) => [id, batches[i] ?? []]))
      setEvents((cur) => new Map(list.map((id) => [id, got.get(id) ?? cur.get(id) ?? []])))
    })()
    return () => {
      cancelled = true
    }
  }, [ids])

  // A batch at a time (lib/framebatch): one render per FRAME_BATCH_MS.
  const incoming = useFrameBatch<Event>((batch) => {
    setEvents((cur) => {
      let next: Map<string, Event[]> | null = null
      for (const ev of batch) {
        if (!cur.has(ev.session_id)) continue
        next ??= new Map(cur)
        const prior = next.get(ev.session_id) ?? []
        // Cap per track: the window only ever renders PULSE_MINUTES of bars.
        next.set(ev.session_id, [...prior, ev].slice(-SEED_LIMIT * 2))
      }
      return next ?? cur
    })
  })
  useEffect(() => {
    return live.onFrame((f) => {
      if (f.type === 'event') incoming.push(f.data)
    })
  }, [incoming])

  // `now` is rounded to the minute so a per-second clock does not rebuild
  // every model each tick.
  const minute = Math.floor(now / 60_000)
  // A track earns its row by having happened. Without this the panel drew a
  // row per known session — six identical project names over six flat
  // hairlines — which reads as a fault in the chart rather than as silence.
  const rows = useMemo(
    () =>
      tracked
        .map((s) => ({ s, pulse: buildPulse(events.get(s.session_id) ?? [], minute * 60_000) }))
        .filter((r) => windowEvents(r.pulse) > 0),
    [tracked, events, minute],
  )

  // Which rows are open, remembered in this browser by session id.
  const [open, setOpen] = useState<Set<string>>(readOpen)
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next].slice(-20))) } catch { /* a convenience */ }
      return next
    })

  // The legend is read once and then only in the way: shown until this
  // viewer closes it, then behind the header's ? (owner, 2026-10-14: the
  // opened rows should be "as neat as possible").
  const [legend, setLegend] = useState(readLegend)
  const showLegend = (on: boolean) => {
    setLegend(on)
    try { localStorage.setItem(LEGEND_KEY, on ? 'shown' : 'hidden') } catch { /* a convenience */ }
  }

  if (tracked.length === 0) return null

  return (
    <Panel
      fold="now.pulse"
      title="Live pulse"
      right={
        <span className="inline-flex items-center gap-2 text-[11px] text-fg-faint">
          last {PULSE_MINUTES} minutes · one bar per minute
          <button type="button" onClick={() => showLegend(!legend)} aria-expanded={legend}
            aria-label={legend ? 'Hide how to read the pulse' : 'How to read the pulse'}
            title={legend ? 'Hide the legend' : 'How to read the pulse'}
            className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border text-[10px] leading-none hover:text-fg hover:border-border-strong ${legend ? 'border-border-strong text-fg-muted' : 'border-border text-fg-faint'}`}>
            ?
          </button>
        </span>
      }
    >
      <div>
        {rows.length === 0 ? (
          // Saying the hour was quiet is information; six empty tracks are not.
          <div className="px-3 py-6 text-[12px] text-fg-faint text-center">
            Nothing ran in the last {PULSE_MINUTES} minutes.
          </div>
        ) : (
          <PulseRows rows={rows} minute={minute} labels={labels} all={sessions} open={open} onToggle={toggle}
            manual={manual} onReorder={(next) => { setManual(next); savePulseOrder(next) }} />
        )}
      </div>
      {/* Height and colour answer different questions, and saying so first is
        * the difference between a legend and a decoration. The tier words are
        * relative to this session's own median minute — "expensive" next to a
        * short bar is not a contradiction, it is a quiet minute that spent a
        * lot of context — so they name the comparison rather than implying an
        * absolute scale. */}
      {legend && <div className="px-3 py-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-fg-faint border-t border-border">
        <span className="text-fg-muted" title="Height and colour are independent.">bar height = turns and tools · colour = what the minute cost</span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={IDLE_TOKEN} className="h-[2px]" />idle
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={TIER_TOKEN.low} />below this session&apos;s median
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={TIER_TOKEN.mid} />around it
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={TIER_TOKEN.high} />well above it
        </span>
        <span>
          <span className="text-warn">×N same call</span> = most-repeated identical tool call in six minutes
        </span>
        <button type="button" onClick={() => showLegend(false)} className="ml-auto text-fg-faint hover:text-fg"
          title="The ? beside the panel's title brings it back">
          Hide
        </button>
      </div>}
    </Panel>
  )
}

/**
 * The tracks, in their fixed order, moved by hand: dragged onto another
 * (pointer events, as the sidebar's rows, since the desktop shell takes
 * HTML5 drops) or with ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift off macOS) from a focused row.
 * Also where two sessions sharing a checkout are told apart and warned
 * about (lib/overlap.ts) — asked only while the panel is unfolded, since a
 * folded panel does not render this, and only when two tracks could share
 * a folder at all.
 */
function PulseRows({ rows, minute, labels, all, open, onToggle, manual, onReorder }: {
  rows: { s: SessionSummary; pulse: PulseModel }[]
  minute: number
  labels: Map<string, string>
  all: SessionSummary[]
  open: Set<string>
  onToggle: (id: string) => void
  manual: readonly string[]
  onReorder: (ids: string[]) => void
}) {
  const shown = rows.map((r) => r.s)
  const overlap = useOverlap(mayShare(shown))
  const [moving, setMoving] = useState<OverlapChip | null>(null)
  const order = shown.map((s) => s.session_id)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const dragged = useRef(false)
  const reorder = (key: string, target: string, where: 'before' | 'after') => {
    const next = moveKey(order, key, target, where)
    if (next.join('\n') === order.join('\n')) return
    // Rows placed by hand that are not on screen now keep their turn after these.
    onReorder([...next, ...manual.filter((k) => !next.includes(k))])
  }
  const press = (key: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button, a, canvas, [data-pulse-chip], [data-live-session]')) return
    // A drag selected the rows' text on its way down (seen on the preview,
    // 2026-10-14); the click that opens a row still fires.
    if (e.pointerType === 'mouse') e.preventDefault()
    const y0 = e.clientY
    dragged.current = false
    const onMove = (m: PointerEvent) => {
      if (!dragged.current && Math.abs(m.clientY - y0) > 4) { dragged.current = true; setDragKey(key) }
    }
    const onUp = (u: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragKey(null)
      if (!dragged.current) return
      const over = document.elementFromPoint(u.clientX, u.clientY)?.closest<HTMLElement>('[data-pulse-key]')
      if (over?.dataset.pulseKey) reorder(key, over.dataset.pulseKey, u.clientY > y0 ? 'after' : 'before')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // The click that ends a drag opens nothing.
  const onClickCapture = (e: ReactMouseEvent) => {
    if (dragged.current) { dragged.current = false; e.preventDefault(); e.stopPropagation() }
  }
  // ⌥⇧↑ ⌥⇧↓ on macOS; Ctrl+Shift off it, where Alt+Shift arrows are the app's (lib/appkeys.ts).
  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const mods = isMacPlatform() ? e.altKey && !e.ctrlKey : e.ctrlKey && !e.altKey
    if (!mods || !e.shiftKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-pulse-key]')?.dataset.pulseKey
    if (!key) return
    e.preventDefault()
    e.stopPropagation()
    const at = order.indexOf(key)
    const to = order[at + (e.key === 'ArrowUp' ? -1 : 1)]
    if (at < 0 || !to) return
    reorder(key, to, e.key === 'ArrowUp' ? 'before' : 'after')
  }
  // What each track's hour cost, for the opened row's $/h beside each session.
  const hour = new Map(rows.map((r) => [r.s.session_id, windowCost(r.pulse)]))
  return (
    <div onKeyDown={onKey} onClickCapture={onClickCapture}>
      {rows.map(({ s, pulse }) => (
        <Track key={s.session_id} s={s} pulse={pulse} minute={minute} showId={rows.length > 1} label={labels.get(s.session_id)} hour={hour}
          all={all} open={open.has(s.session_id)} onToggle={() => onToggle(s.session_id)}
          chip={overlapChip(overlap, s, sessionTitle(s))} onMove={setMoving}
          dragging={dragKey === s.session_id} onPress={press(s.session_id)} />
      ))}
      {moving && (
        <SpawnDialog
          available
          initialCwd={moving.checkout}
          initialWorktree={worktreeSlug(moving.newer.name) || 'separate'}
          note={<><b className="font-medium text-fg">{moving.newer.name}</b> keeps running where it is: stop it once the new session has the work. Caprock types nothing into it.</>}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  )
}

/**
 * A colour chip, so the legend shows the colour rather than naming it.
 *
 * It is driven by the same token+alpha the canvas paints with, so the legend
 * cannot drift from the bars: the idle swatch used to be hardcoded at alpha
 * 0.35 while the canvas drew the hairline at 0.16, and the tier swatches were
 * three more copies of the dark-theme rgba that the light theme flattened.
 */
function Swatch({
  tier,
  className = '',
}: {
  tier: { token: string; fallback: string; alpha: number }
  className?: string
}) {
  return (
    <span
      data-token={tier.token}
      className={`inline-block w-3 h-3 rounded-[2px] ${className}`}
      style={{ background: `var(${tier.token}, ${tier.fallback})`, opacity: tier.alpha }}
    />
  )
}

function Track({
  s,
  pulse,
  minute,
  showId,
  label,
  all,
  open,
  onToggle,
  chip,
  onMove,
  dragging = false,
  onPress,
  hour,
}: {
  s: SessionSummary
  pulse: PulseModel
  minute: number
  /** The project's name, told apart from a same-named folder elsewhere. */
  label?: string
  /** Whether to name which session this is. See the header below. */
  showId: boolean
  /** Every session the screen knows, for the project's other live sessions. */
  all: SessionSummary[]
  open: boolean
  onToggle: () => void
  /** Another live session in the same checkout (lib/overlap.ts). */
  chip?: OverlapChip
  onMove?: (chip: OverlapChip) => void
  dragging?: boolean
  onPress?: (e: ReactPointerEvent<HTMLElement>) => void
  /** What each tracked session's last hour cost, by session id. */
  hour?: Map<string, number>
}) {
  // Health comes from the daemon's narrator, which knows "your turn" from the
  // agent.stop event. The bars cannot: they describe the hour, not this moment.
  const state = trackState(pulse, sessionHealth(s))
  // The session's own name leads (owner, 2026-10-14: two rows read
  // "dev/caprock master" and could not be told apart); the project, branch
  // and short id are the line under it.
  const name = sessionTitle(s)

  // The row opens in place rather than navigating: the owner wanted to see
  // what a project's sessions are doing without leaving Now. The session page
  // is one click further, from inside. A click on the chart itself still
  // opens the session at that minute (PulseCanvas stops the event).
  return (
    <div data-pulse-key={s.session_id} onPointerDown={onPress} className={`border-t border-border first:border-t-0 ${dragging ? 'opacity-60' : ''}`}>
      {/* Every row is its own grid, so every track after the name is a fixed
        * width: with `auto` for the agents (a model name, a crowd icon) each
        * row sized its own last column, the chart took what was left, and the
        * dollars sat at a different x on every row (owner's screenshot,
        * 2026-10-15). Fixed tracks make the charts one width and the money and
        * the agents one column down the panel. */}
      <div
        onClick={onToggle}
        className="grid cursor-pointer grid-cols-[minmax(0,1fr)_76px_128px] sm:grid-cols-[190px_minmax(0,1fr)_84px_216px] items-center gap-x-3 gap-y-1.5 px-3 py-2 hover:bg-panel-2 text-fg"
      >
        {/* Working all day in one repository used to draw six rows all labelled
          * "caprock", told apart only by a phrase like "was responding" that
          * three of them shared. The branch and the session id are what actually
          * differ, so they go where the eye already is. Only when there is more
          * than one track: a lone row needs no disambiguation.
          *
          * The project never shrinks and the branch is what gives way, because
          * the first attempt had it backwards: `shrink-0` on the branch let a
          * long one (`fix/session-end-and-pulse-tracks`) squeeze the project to
          * nothing, so the row lost the name it is actually about and read as a
          * branch floating with no repository. A label that can erase the
          * primary identity is worse than no label. */}
        <div className="min-w-0">
          <div className="text-[13px] flex items-baseline gap-1.5 min-w-0">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggle() }}
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} what is running in ${name}`}
              title={`Open or close. Drag the row, or ${keys('⌥⇧↑, ⌥⇧↓')} here, to move it.`}
              className="shrink-0 -ml-1 w-4 text-center text-fg-faint hover:text-fg"
            >
              <span aria-hidden className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
            </button>
            <span className="min-w-0 truncate font-semibold" title={name}>{name}</span>
            {showsAgentMark(s.agent) && <AgentGlyph agent={s.agent} />}
          </div>
          <div className="text-[10px] text-fg-faint mono truncate pl-3.5" title={`${s.repo_root || s.cwd}${s.git_branch ? ` · ${s.git_branch}` : ''} · session ${s.session_id} · started ${fmtAgo(s.started_at)} ago`}>
            <span className="text-fg-muted">{label || s.project || 'unknown project'}</span>
            {branchLabel(s.git_branch) && <> {branchLabel(s.git_branch)}</>}
            {showId && <> · {shortId(s.session_id)}</>}
            {s.activity?.phrase ? <> · {s.activity.phrase}</> : null}
          </div>
        </div>
        {/* At phone width the chart takes its own line under the row: squeezed
          * between the name and the agents it was thirty pixels of noise. */}
        <div className="col-span-3 order-last sm:col-span-1 sm:order-none min-w-0">
          <PulseCanvas pulse={pulse} now={minute * 60_000} sessionID={s.session_id} />
        </div>
        {/* The window's cost, not the session's. The bars describe an hour; a
          * lifetime figure beside them invited the reader to add a number to a
          * picture it does not belong to. */}
        <div
          data-pulse-cost
          className="num text-[13px] font-semibold text-right tabular-nums whitespace-nowrap"
          title={`${fmtUSD(s.stats?.cost_usd)} for the whole session`}
        >
          {fmtUSD(windowCost(pulse))}
        </div>
        <WorkingNow s={s} state={state} repeatSample={pulse.repeatSample} />
      </div>
      {chip && <OverlapLine chip={chip} onMove={onMove} className="px-3 pb-2 pl-[26px] -mt-1" />}
      {open && <ProjectNow s={s} all={all} now={minute * 60_000} hour={hour} />}
    </div>
  )
}

/** A track state as a small coloured pill: what the session is doing now. */
function StatePill({ state, title }: { state: { kind: string; label: string }; title?: string }) {
  const tone =
    state.kind === 'repeat' || state.kind === 'waiting'
      ? 'border-warn/50 bg-warn/15 text-warn'
      : state.kind === 'error'
        ? 'border-danger/50 bg-danger/15 text-danger'
        : state.kind === 'quiet'
          ? 'border-border-strong bg-panel-2 text-fg-muted'
          : 'border-ok/50 bg-ok/15 text-ok'
  return (
    <span title={title} className={`inline-flex items-center rounded-full border px-2 py-[1px] text-[11px] font-medium leading-[1.35] whitespace-nowrap ${tone}`}>
      {state.label}
    </span>
  )
}

/**
 * A project's row, opened: what the project has cost today and the ways in
 * on one line, then every live session in it — who, which model, what state
 * and what it is doing on the left; on the right what it has cost, how fast
 * it spends, how long it has run, how full its context is, and its branch,
 * its changes and its pull request.
 *
 * Calm on purpose (owner, 2026-10-14, translated: "lots of bright buttons
 * here; it destroys attention … as neat as possible"). The ways in are quiet
 * words, not two filled and two outlined buttons, and they share the summary
 * line instead of taking a row of their own. The space to the right of each
 * session, which used to be empty, carries that session's figures.
 */
function ProjectNow({ s, all, now, hour }: { s: SessionSummary; all: SessionSummary[]; now: number; hour?: Map<string, number> }) {
  const today = useApi(() => api.summary('today'), [], { intervalMs: 30000, share: 'summary:today:all' })
  // The repository link lives on the session's detail, read once when the
  // row opens (the same button as the session page).
  const detail = useApi(() => api.session(s.session_id), [s.session_id], { live: false })
  const live = all
    .filter((x) => x.project === s.project && x.status !== 'ended')
    .sort((a, b) => b.last_event_at - a.last_event_at)
  // Today's figures for this project, matched on the directory the Projects
  // panel keys it on; the session's own folder is inside it.
  const proj = today.data?.projects?.find((p) => (p.dir ? s.cwd === p.dir || s.cwd.startsWith(p.dir + '/') || s.cwd.startsWith(p.dir + '\\') : p.project === s.project))
  const dir = proj?.dir || s.cwd
  return (
    <div className="bg-panel-2/40 border-t border-border px-3 py-2 pl-7 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-fg-muted">
        <span className="min-w-0">
          <span className="text-fg-faint">Today in {s.project || 'this project'}:</span>{' '}
          {proj ? (
            <span className="num text-fg">{fmtUSD(proj.cost_usd)} · {fmtTokens(proj.tokens)} tokens · {proj.sessions} session{proj.sessions === 1 ? '' : 's'}</span>
          ) : today.data ? <span>nothing yet</span> : <span className="text-fg-faint">…</span>}
          <span className="text-fg-faint"> · {live.length} live</span>
        </span>
        {/* The ways in, as quiet words at the line's end. On a phone they
          * wrap under the figures, still left to right. */}
        <div className="flex flex-wrap items-center gap-0.5 sm:ml-auto -mx-2 sm:mx-0 sm:-mr-2" aria-label="Ways in">
          {dir ? <ProjectTerminal dir={dir} label={s.project || dir} sessions={live} quiet /> : null}
          <RepoButtons repo={detail.data?.repo} cwd={s.cwd} quiet />
          <a href={href({ name: 'session', id: s.session_id })} className={QUIET}>Open session</a>
        </div>
      </div>
      <ul className="mt-1.5 grid">
        {live.map((x) => (
          <LiveSession key={x.session_id} x={x} now={now} hourCost={hour?.get(x.session_id)} />
        ))}
      </ul>
    </div>
  )
}

/** "42m", "2h 5m": how long a session has been running, to the minute. */
export function fmtRunning(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A branch's changes as one figure: lines added and removed, files touched. */
export function diffTotals(d: DiffResult | undefined): { add: number; del: number; files: number } | null {
  if (!d || !d.files?.length) return null
  let add = 0
  let del = 0
  for (const f of d.files) {
    add += f.additions || 0
    del += f.deletions || 0
  }
  return { add, del, files: d.files.length }
}

/** The CI of the session's pull request in a word; null when there is none to say. */
export function ciWord(ci: SessionCI | undefined): { word: string; tone: string } | null {
  switch (ci?.ci?.state) {
    case 'fail': return { word: 'CI failing', tone: 'text-danger' }
    case 'running': return { word: 'CI running', tone: 'text-fg-muted' }
    case 'pass': return { word: 'CI passing', tone: 'text-fg-muted' }
    default: return null
  }
}

/**
 * One live session in an opened row. Two lines, two columns: who and what it
 * is doing on the left, its figures on the right, right-aligned. On a phone
 * the figures go under it.
 *
 * Every figure is one the dashboard already had: cost, context and running
 * time from the session list; the last hour from the track's own bars (only
 * for a session with a track); the branch's changes from the Changes diff
 * (`GET /v1/sessions/{id}/diff`, since the trunk); the pull request and its
 * CI from the deck's answer (`GET /v1/sessions/{id}/ci` — the session's own
 * record when GitHub is not connected, so CI then says nothing). Both are
 * asked while the row is open, once a minute.
 */
function LiveSession({ x, now, hourCost }: { x: SessionSummary; now: number; hourCost?: number }) {
  const diff = useApi(() => api.diff(x.session_id), [x.session_id], { live: false, intervalMs: 60_000, share: `diff:${x.session_id}` })
  const ci = useApi(() => api.sessionCI(x.session_id), [x.session_id], { live: false, intervalMs: 60_000, share: `pulse-ci:${x.session_id}` })
  const st = trackState({ bars: [], repeats: 0 } as unknown as PulseModel, sessionHealth(x))
  const model = x.model_display || (x.model ? fmtModel(x.model) : '')
  const doing = x.activity?.phrase || x.description || x.title || ''
  const plan = x.activity?.plan
  const changes = diffTotals(diff.data)
  const branch = branchLabel(diff.data?.branch || x.git_branch)
  const pr = ci.data?.pr
  const ciw = ciWord(ci.data)
  const ctx = x.context
  // In the desktop app the row is the way into the running session
  // (lib/sessionJump.ts); in a browser it keeps its "open" link to the page.
  const host = useContext(PipelineHostContext)
  const open = host.onOpenSession
  const jump = open ? sessionJump(x, host.tabDigitOf?.(x.session_id)) : null
  const go = open && jump && jump.kind !== 'away' ? () => open(x.session_id) : undefined
  return (
    <li
      data-live-session={x.session_id}
      data-jump={jump?.kind}
      tabIndex={go ? 0 : undefined}
      aria-label={go ? `Go to session ${sessionTitle(x)}` : undefined}
      title={go ? `Go to this session's tab${jump?.kind === 'tab' && jump.digit ? ` (${keys(`⌘${jump.digit}`)})` : ''}` : undefined}
      onClick={go ? (e) => { if (!(e.target as Element).closest('a, button, select, input')) go() } : undefined}
      onKeyDown={go ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); go() } } : undefined}
      className={`group grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-0.5 py-1.5 border-t border-border/60 first:border-t-0 min-w-0 ${go ? '-mx-2 px-2 rounded-sm cursor-pointer hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent' : ''}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <SessionCharacter agent={x.agent} sessionId={x.session_id} size={22} />
          <span className="font-medium text-fg">{agentName(x.agent ?? 'claude')}</span>
          {model && <span className="mono text-[11.5px] text-fg-muted">{model}</span>}
          <StatePill state={st} />
          {(x.live_subagents ?? 0) > 0 && <span className="text-fg-muted">+{x.live_subagents} subagent{x.live_subagents === 1 ? '' : 's'}</span>}
        </div>
        <div className="flex items-baseline gap-2 pl-[30px] min-w-0 text-fg-muted">
          <span className="min-w-0 truncate" title={doing}>{doing || <span className="text-fg-faint">nothing yet</span>}</span>
          {plan && plan.total > 0 && (
            <span className="num shrink-0 text-[11px] text-fg-faint" title={plan.next ? `Next: ${plan.next}` : undefined}>plan {plan.done}/{plan.total}</span>
          )}
          <span className="shrink-0 text-[11px] text-fg-faint whitespace-nowrap">{fmtAgo(x.last_event_at, now)}</span>
          {jump ? <SessionWays x={x} jump={jump} /> : (
            <a href={href({ name: 'session', id: x.session_id })} className="shrink-0 text-[11px] text-fg-faint hover:text-fg whitespace-nowrap">open</a>
          )}
        </div>
      </div>
      <div className="min-w-0 pl-[30px] sm:pl-0 sm:text-right text-[11.5px] text-fg-muted" data-pulse-facts={x.session_id}>
        <div className="num whitespace-nowrap">
          <span className="text-fg" title="What this session has cost so far">{fmtUSD(x.stats?.cost_usd)}</span>
          {hourCost !== undefined && <span title="What it cost in the last hour"> · {fmtUSD(hourCost)}/h</span>}
          <span title={`Started ${fmtAgo(x.started_at, now)}`}> · {fmtRunning(now - x.started_at)}</span>
          {ctx && (
            <span className={ctx.pct >= 85 ? 'text-warn' : ''} title={`${fmtTokens(ctx.tokens)} of ${fmtTokens(ctx.window)} context`}> · ctx {fmtPct(ctx.pct)}</span>
          )}
        </div>
        {(branch || changes || pr) && (
          <div className="flex items-baseline sm:justify-end gap-1.5 min-w-0 whitespace-nowrap">
            {branch && <span className="mono min-w-0 truncate max-w-[16rem] text-fg-faint" title={branch}>{branch}</span>}
            {changes && (
              <span className="num shrink-0" title={`${changes.files} file${changes.files === 1 ? '' : 's'} changed${diff.data?.base ? ` ${diff.data.base}` : ''}, committed or not`}>
                <span className="text-ok">+{changes.add}</span> <span className="text-danger">−{changes.del}</span>
              </span>
            )}
            {pr && (
              <a href={pr.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-fg-muted hover:text-fg" title={extTitle(pr.title ? `#${pr.number} ${pr.title}` : `#${pr.number}`)}>
                · PR #{pr.number}{pr.state === 'merged' ? ' merged' : ''}
              </a>
            )}
            {ciw && <span className={`shrink-0 ${ciw.tone}`}>· {ciw.word}</span>}
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * A live row's ways in, in the desktop app (lib/sessionJump.ts): where a
 * click on the row goes, said on hover and focus with the tab's ⌘N; the
 * session's page as a quiet *details*; for a session another terminal holds,
 * that fact and *Continue in Caprock*; and *End* for one Caprock started
 * that sits at its prompt — at once, or after one question when messages
 * wait in its queue (ADR-053), which ending would drop.
 */
function SessionWays({ x, jump }: { x: SessionSummary; jump: SessionJump }) {
  const host = useContext(PipelineHostContext)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(0)
  const away = jump.kind === 'away' || (jump.kind === 'tab' && !jump.typeable)
  const where = jump.kind === 'away' && jump.why === 'detached' ? 'no terminal' : 'in your terminal'
  const canContinue = away && !!host.onStartAgent && (x.agent ?? 'claude') === 'claude'
  const canEnd = !!host.onEndSession && endable(x)
  const small = 'shrink-0 text-[11px] whitespace-nowrap'
  const cont = async () => {
    if (!host.onStartAgent) return
    setBusy(true)
    try {
      await host.onStartAgent({ cwd: x.cwd, resume: x.session_id, fork: true }, `${sessionTitle(x)} (copy)`, x.session_id)
    } catch (e) {
      host.onToast?.(`Could not continue the session: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const end = async () => {
    // Messages waiting for its turn (ADR-053) go with it: say so once.
    let n = 0
    try { n = (await api.queue(x.session_id)).messages?.length ?? 0 } catch { /* none known: end */ }
    if (n > 0) { setQueued(n); return }
    host.onEndSession?.(x.session_id)
  }
  if (queued > 0) {
    return (
      <span className={`${small} text-warn`} data-end-confirm={x.session_id}>
        {queued} queued message{queued === 1 ? '' : 's'} won't be sent (kept in its chat).{' '}
        <button type="button" onClick={() => { setQueued(0); host.onEndSession?.(x.session_id) }} className="text-danger hover:underline">End anyway</button>{' '}
        <button type="button" onClick={() => setQueued(0)} className="text-fg-muted hover:text-fg">Keep</button>
      </span>
    )
  }
  return (
    <>
      {jump.kind !== 'away' && (
        <span aria-hidden className={`${small} text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100`} data-go-hint>
          Go to session →{jump.kind === 'tab' && jump.digit ? <span className="ml-1 mono text-fg-faint">{keys(`⌘${jump.digit}`)}</span> : null}
        </span>
      )}
      {away && (
        <span className={`${small} text-fg-faint`} title={x.owned ? 'Its terminal is gone — Caprock can’t type into it.' : 'Started in your terminal — end it there. Caprock can’t type into it.'}>{where}</span>
      )}
      <a href={href({ name: 'session', id: x.session_id })} className={`${small} text-fg-faint hover:text-fg`}>details</a>
      {canContinue && (
        <button
          type="button"
          disabled={busy}
          onClick={() => { void cont() }}
          title="Starts a new process on a copy of this conversation, in a Caprock tab. The one in your terminal keeps running, untouched."
          className={`${small} text-fg-muted hover:text-fg disabled:opacity-50`}
        >
          {busy ? 'Starting…' : 'Continue in Caprock'}
        </button>
      )}
      {canEnd && (
        <button
          type="button"
          onClick={() => { void end() }}
          aria-label={`End session ${sessionTitle(x)}`}
          title="End this session: it is idle at its prompt. Caprock started it, so Caprock stops it."
          className={`${small} text-fg-faint hover:text-danger`}
        >
          × End
        </button>
      )}
    </>
  )
}

/**
 * Bar colours by cost tier, as a design token plus the alpha it is drawn at.
 *
 * These used to be hardcoded rgba lifted from the *dark* palette, which made
 * the light theme unreadable: `mid` (#feb157 at 0.72) and `high` (#ffcb85 at
 * 0.95) composite against a white panel to a contrast ratio of 1.05 — the same
 * orange to any eye — so the legend named a distinction a light-theme viewer
 * could not see. Every bar was also near-invisible on white (1.46–1.68 against
 * the panel). Reading the tokens instead lets each theme supply its own hue:
 * on dark the tiers climb in brightness, on light they climb in depth, because
 * light's --color-accent-strong is *darker* than --color-accent, not lighter.
 *
 * The alphas are per tier rather than shared: they are what separates two tiers
 * drawn from neighbouring hues, and they were tuned against the composited
 * contrast in both themes (worst-case adjacent-tier ratio 1.59, against 1.05
 * before). Alpha is applied via globalAlpha rather than baked into the colour
 * string, because the tokens are opaque hex — the same approach SparkCanvas in
 * Projects.tsx uses.
 */
export const TIER_TOKEN = {
  low: { token: '--color-ok', fallback: '#4fbf6b', alpha: 0.55 },     // a cheap minute
  mid: { token: '--color-accent', fallback: '#feb157', alpha: 0.85 }, // typical
  high: { token: '--color-accent-strong', fallback: '#ffcb85', alpha: 1 }, // expensive
} as const

/** A minute with no events still draws a hairline, so the track reads as a
 * continuous hour with quiet stretches rather than as a broken chart. Gaps in
 * a bar chart look like a rendering fault; a flat floor looks like silence.
 *
 * It is deliberately the faintest thing on the track — present, never competing
 * with a real bar — which is a ratio to the panel, not a fixed grey: the old
 * fixed value sat at 1.13 against a white panel and disappeared. */
export const IDLE_TOKEN = { token: '--color-fg-faint', fallback: '#8f8b84', alpha: 0.3 } as const

/** Resolve a design token against an element, with the dark-theme value as the
 * fallback for the brief moment before the stylesheet has applied. */
function token(css: CSSStyleDeclaration, name: string, fallback: string): string {
  return css.getPropertyValue(name).trim() || fallback
}

/**
 * One session's hour as bars. `fill` lets the canvas take its box's height —
 * the session deck under an agent's terminal grows with its divider — where
 * the Now screen's rows draw it at a fixed 44px.
 */
export function PulseCanvas({ pulse, now, sessionID, fill = false }: { pulse: PulseModel; now: number; sessionID: string; fill?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const paint = () => {
      const w = cv.clientWidth
      const h = cv.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Tokens from the stylesheet, so the track follows the theme. A canvas
      // cannot use a CSS variable directly, so they are resolved once per paint
      // against the element itself.
      const css = getComputedStyle(cv)
      const idle = token(css, IDLE_TOKEN.token, IDLE_TOKEN.fallback)

      const bars = pulse.bars
      const max = Math.max(...bars.map((b) => b.n), 1)
      const median = medianCost(bars)
      const bw = w / bars.length
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]
        if (!b) continue
        const x = i * bw
        const width = Math.max(1, bw - 1)
        if (b.n === 0) {
          // Silence, drawn rather than left blank.
          ctx.globalAlpha = IDLE_TOKEN.alpha
          ctx.fillStyle = idle
          ctx.fillRect(x, h - 2, width, 2)
          continue
        }
        // Gamma: a quiet minute beside a busy one would otherwise be invisible,
        // and "almost nothing happened" is exactly what you want to see.
        const bh = Math.max(3, Math.pow(b.n / max, 0.62) * (h - 4))
        const tier = TIER_TOKEN[costTier(b.cost, median)]
        ctx.globalAlpha = tier.alpha
        ctx.fillStyle = token(css, tier.token, tier.fallback)
        ctx.fillRect(x, h - bh, width, bh)
      }
      ctx.globalAlpha = 1
    }
    paint()
    // Repaint on resize, and on a theme change — the colours are read from the
    // stylesheet at paint time, so without this a track keeps the old theme's
    // palette until its data next changes.
    const ro = new ResizeObserver(paint)
    ro.observe(cv)
    const mo = new MutationObserver(paint)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [pulse])

  // A minute is a small target, so the readout follows the pointer rather than
  // requiring a hit on the bar itself: hovering a silent minute is a legitimate
  // question ("was anything happening here?") and must answer it too.
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (r.width === 0) return
    const i = Math.floor(((e.clientX - r.left) / r.width) * pulse.bars.length)
    setHover(i >= 0 && i < pulse.bars.length ? i : null)
  }

  const bar = hover === null ? null : pulse.bars[hover]
  // The colour is a comparison, so the readout states what it compares to.
  // Without it "expensive" on a short bar looks like a bug rather than a
  // quiet minute that carried a lot of context.
  const barMedian = medianCost(pulse.bars)
  const at = hover === null ? 0 : now - (pulse.bars.length - 1 - hover) * 60_000

  // Clicking a minute opens the session *at that minute* rather than at the
  // top. Landing in a session of thousands of events with no indication of
  // which ones you clicked is the same as not having clicked anything.
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hover === null || !bar || bar.n === 0) return
    e.preventDefault()
    e.stopPropagation()
    navigate({ name: 'session', id: sessionID, at })
  }

  return (
    <div className={`relative ${fill ? 'h-full' : ''}`}>
      <canvas
        ref={ref}
        className={`w-full ${fill ? 'h-full' : 'h-[44px]'} block cursor-pointer`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
        aria-hidden
      />
      {bar && (
        <div className="absolute -top-1 left-0 right-0 pointer-events-none flex justify-center">
          <span className="num text-[10px] bg-panel-2 border border-border-strong rounded-sm px-1.5 py-0.5 text-fg-muted whitespace-nowrap">
            {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {bar.n === 0 ? (
              ' · nothing happened'
            ) : (
              <>
                {` · ${bar.n} event${bar.n === 1 ? '' : 's'}`}
                {bar.turns > 0 && ` · ${bar.turns} turn${bar.turns === 1 ? '' : 's'}`}
                {bar.cost > 0 && ` · ${fmtUSD(bar.cost)}`}
                {bar.cost > 0 && barMedian > 0 && (
                  <span className="text-fg-faint">{` (median ${fmtUSD(barMedian)})`}</span>
                )}
                <span className="text-fg-faint"> · click to open</span>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * Who is working in the session now, on what model, in what state: a status
 * pill, the session's character with a crowd beside it when subagents are
 * live, "N agents" in words, and the model's display name. Both are measured —
 * the model is the main thread's latest, live subagents are those heard from
 * and not yet stopped. The owner could not read the first version (15 px icons,
 * a faint "×4", a grey model), so everything here is at reading size. At phone
 * width the model gives way; the pill, the icons and the count stay.
 */
export function WorkingNow({ s, state, repeatSample }: { s: SessionSummary; state: { kind: string; label: string }; repeatSample?: string }) {
  const subs = s.live_subagents ?? 0
  const working = s.activity?.health === 'working' || s.activity?.health === 'looping'
  const model = s.model_display || (s.model ? fmtModel(s.model) : '')
  const agents = subs + 1
  const title = `${model ? `${model}${working ? '' : ' (last turn)'}` : 'model unknown'} · ${subs > 0 ? `main thread and ${subs} live subagent${subs === 1 ? '' : 's'}` : 'main thread only'}`
  return (
    <div data-pulse-agents className="min-w-0 w-full flex flex-col items-end gap-1">
      <StatePill state={state} title={repeatSample} />
      <div className="flex max-w-full min-w-0 items-center justify-end gap-1.5 text-[11.5px] leading-none" title={title}>
        <span className="inline-flex items-center -space-x-2" aria-hidden>
          <SessionCharacter agent={s.agent} sessionId={s.session_id} size={26} />
          {subs > 0 && <AgentCharacter who="crowd" size={26} />}
        </span>
        <span className="num text-fg whitespace-nowrap">{agents} agent{agents === 1 ? '' : 's'}</span>
        {model && <span className="hidden sm:inline mono truncate min-w-0 max-w-[96px] text-fg">{model}</span>}
        <span className="sr-only">{title}</span>
      </div>
    </div>
  )
}
