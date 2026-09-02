import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, type DiffResult, type Event, type SessionDetail } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { live } from '@/lib/live'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD, shortId, basename } from '@/lib/format'
import { Badge, Empty, Panel, Sparkline, Stat } from '@/components/ui'
import { href, navigate } from '@/lib/router'
import { useNow } from './Now'
import { SessionNotes } from '@/components/Notes'
import { TerminalView } from '@/components/Terminal'
import { costBasisLong } from '@/components/CostBasis'
import { agentName } from '@/components/Projects'
import { usePlan } from '@/components/PlanPicker'
import { ContinueSession } from '@/components/ContinueSession'

type Tab = 'timeline' | 'notes' | 'changes' | 'terminal'

/** Names the source a session's figures come from.
 *
 *  Claude Code has hooks and a transcript; Gemini has neither and is read from
 *  the OpenTelemetry file it writes when Caprock asks it to. Saying "no hooks"
 *  about a session Caprock is actively measuring is technically true and
 *  practically a lie. */
function sourceLine(s: SessionDetail): string {
  if (s.agent === 'gemini') return 'telemetry'
  const parts = [s.has_hooks ? 'hooks' : 'no hooks', s.has_transcript ? 'transcript' : 'no transcript']
  return parts.join(' · ')
}

export function SessionScreen({ id, tab, at }: { id: string; tab?: string; at?: number }) {
  const detail = useApi(() => api.session(id), [id], { intervalMs: 5000 })
  // 'diff' and 'files' were separate tabs answering one question between them
  // — what did this session change — so a reader had to visit both and hold
  // the two lists in their head. Old links keep working.
  const active: Tab =
    tab === 'changes' || tab === 'diff' || tab === 'files'
      ? 'changes'
      : tab === 'terminal' || tab === 'notes'
        ? tab
        : 'timeline'
  const now = useNow(1000)
  const [plan] = usePlan()
  const s = detail.data
  if (detail.error && !s) {
    return <Empty title={detail.error instanceof ApiError && detail.error.status === 404 ? 'Session not found' : 'Cannot load session'}>{detail.error.message}</Empty>
  }
  if (!s) return <div className="text-fg-muted px-1">loading…</div>
  const setTab = (t: Tab) => navigate({ name: 'session', id, tab: t })
  const total = s.stats.tokens_in + s.stats.tokens_out + s.stats.cache_read + s.stats.cache_write
  // Nothing measured, and no source that could measure it. Both halves matter:
  // a Claude session in its first second also has zeros, but it has hooks, so
  // its bar is about to fill in and the zeros are true.
  //
  // A Gemini session is read from its telemetry file, which starts empty and
  // fills on the first model call — so it looks unmeasurable for a few seconds
  // and then is not. Saying "nothing to read here" about a session that is
  // about to report would be wrong in the more annoying direction, so it is
  // told apart and given its own line.
  const unmeasurable = !s.has_hooks && !s.has_transcript && total === 0 && s.stats.turns === 0
  const waitingOnTelemetry = unmeasurable && s.agent === 'gemini'
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <a href={href({ name: 'now' })} className="link text-fg-muted text-[12px]">← Now</a>
        <h1 className="text-[15px] font-medium">{s.project || 'unknown project'}</h1>
        <span className="mono text-[11px] text-fg-faint">{s.session_id}</span>
        {s.git_branch && <span className="mono text-[11px] text-fg-muted">{s.git_branch}</span>}
        <Badge health={s.activity.health} />
        {s.owned && s.status !== 'ended' && <OwnedControls id={id} />}
        {/* A session Caprock did not start is readable and not typeable —
          * rule 7, and for a good reason: two writers on one PTY interleave.
          * What it can do is start a second process on the same conversation,
          * which is what this offers. Only for Claude Code: Gemini has its own
          * --resume with different semantics, and offering a button that means
          * something slightly different per agent is worse than not offering
          * it yet. */}
        {!s.owned && (s.agent ?? 'claude') === 'claude' && (
          <ContinueSession sessionID={s.session_id} cwd={s.cwd} live={s.status !== 'ended'} />
        )}
        <span className="text-[12px] text-fg-muted ml-auto num">{s.cwd}</span>
      </div>
      <div className="text-[13px]">
        <span className="text-fg">{s.activity.phrase}</span>
        <span className="text-fg-faint num text-[11px] ml-2">{fmtAgo(s.activity.at || s.last_event_at, now)}</span>
        {s.loop && <span className="ml-3 text-danger text-[12px]">loop: {s.loop.sample} ×{s.loop.count} in {s.loop.window_min}m</span>}
      </div>
      {/* A session Caprock starts but cannot read — Gemini today — produced six
        * columns of zeros with the reason in 11px grey underneath. Zeros are
        * how this bar shows "nothing happened yet", so it read as broken
        * rather than as out of scope. Say the one true thing instead. */}
      {unmeasurable ? (
        <Panel>
          <div className="px-3 py-2.5 text-[13px] text-fg-muted">
            {waitingOnTelemetry ? (
              <>
                Nothing measured yet — Gemini reports its own figures, and the first
                ones arrive with its first answer.{' '}
                <span className="text-fg-faint">The terminal below is live.</span>
              </>
            ) : (
              <>
                Caprock started this {agentName(s.agent)} session but does not measure it — there are no hooks and no transcript to read, so cost, tokens and turns are not counted here.{' '}
                <span className="text-fg-faint">The terminal below is live.</span>
              </>
            )}
          </div>
        </Panel>
      ) : (
      <Panel>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-border">
          {/* One of six columns, so the basis cannot fit beside the model
              name without truncating — and it is the basis that would be cut.
              The model stays visible; the basis is on hover, and stated in
              full on the screens whose whole subject is money. */}
          <Stat label="Cost" value={fmtUSD(s.stats.cost_usd)} sub={<span title={costBasisLong(plan)}>{s.model || 'unknown model'}</span>} />
          {/* The total includes cache reads, which are usually 99% of it. Breaking
              out only in/out made the subtitle contradict the number above it. */}
          <Stat label="Tokens" value={fmtTokens(total)} sub={`in ${fmtTokens(s.stats.tokens_in)} · out ${fmtTokens(s.stats.tokens_out)} · cache ${fmtTokens(s.stats.cache_read + s.stats.cache_write)}`} />
          <Stat label="Cache" value={fmtPct(s.savings.hit_rate * 100)} sub={`read ${fmtTokens(s.stats.cache_read)} · write ${fmtTokens(s.stats.cache_write)}`} tone={s.savings.hit_rate > 0.5 ? 'ok' : undefined} />
          <Stat label="Context" value={s.context ? fmtPct(s.context.pct) : '—'} sub={s.context ? `${fmtTokens(s.context.tokens)} / ${fmtTokens(s.context.window)}` : 'unknown model'} tone={s.context && s.context.pct >= 85 ? 'danger' : s.context && s.context.pct >= 60 ? 'warn' : undefined} />
          <Stat label="Turns" value={s.stats.turns} sub={`${s.stats.tool_calls} tool calls`} />
          {/* What is being read, named. "no hooks · no transcript" is true of a
            * Gemini session and reads as "nothing is being measured", which
            * stopped being true once its telemetry was ingested — the row
            * above it now carries real tokens and a real cost. */}
          <Stat label="Files" value={s.stats.files_touched} sub={sourceLine(s)} />
        </div>
      </Panel>
      )}
      <div className="flex items-center gap-1 border-b border-border">
        {(['timeline', 'notes', 'changes', 'terminal'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-[12px] border-b-2 -mb-px ${active === t ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}>
            {t === 'timeline' ? 'Timeline' : t === 'notes' ? 'Answers' : t === 'changes' ? 'Changes' : 'Terminal'}
          </button>
        ))}
        {!s.owned && <span className="ml-auto text-[11px] text-fg-faint pr-1">observe-only — terminal is read/write for spawned sessions only</span>}
      </div>
      {active === 'timeline' && <Timeline id={id} initial={s.events} now={now} at={at} />}
      {active === 'notes' && <SessionNotes id={id} now={now} />}
      {active === 'changes' && <ChangesTab id={id} s={s} />}
      {active === 'terminal' && <Panel className="overflow-hidden"><TerminalView sessionId={id} owned={s.owned && s.status !== 'ended'} cwd={s.cwd} /></Panel>}
    </div>
  )
}

type Filter = 'all' | 'tools' | 'turns'

/** How much history one "load earlier" click brings back. Big enough to be
 *  worth the round trip, small enough that the page stays responsive. */
const EARLIER_PAGE = 200

function Timeline({ id, initial, now, at }: { id: string; initial: Event[]; now: number; at?: number }) {
  const [events, setEvents] = useState<Event[]>(initial)
  const [filter, setFilter] = useState<Filter>('all')
  const lastId = useRef(initial.length ? initial[initial.length - 1]!.id : 0)
  const list = useRef<HTMLOListElement>(null)
  // The session detail ships only the newest events, so a long session opened
  // to its timeline showed a peephole of its final seconds with no way back.
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const loadEarlier = async () => {
    const oldest = events[0]?.id
    if (oldest === undefined || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      // One page back from the oldest row held. This used to ask for the first
      // thousand events of the *session* and discard everything already shown,
      // which on a sixteen-thousand-event session fetched the wrong end of the
      // history and threw nearly all of it away.
      const before = await api.eventsBefore(id, oldest, EARLIER_PAGE)
      if (before.length === 0) setExhausted(true)
      else setEvents((cur) => [...before, ...cur])
    } catch {
      setExhausted(true)
    } finally {
      setLoadingEarlier(false)
    }
  }
  useEffect(() => { setEvents(initial); setExhausted(false); lastId.current = initial.length ? initial[initial.length - 1]!.id : 0 }, [initial])
  // Append live events for this session as they arrive.
  useEffect(() => live.onFrame((f) => {
    if (f.type !== 'event' || f.data.session_id !== id || f.data.id <= lastId.current) return
    lastId.current = f.data.id
    setEvents((evs) => [...evs, f.data].slice(-5000))
  }), [id])
  const cost = useMemo(() => {
    let acc = 0
    return events.filter((e) => e.kind === 'turn.assistant').map((e) => (acc += e.cost_usd ?? 0))
  }, [events])
  // tool.post rows from transcripts carry no tool name; resolve it via the matching tool.pre.
  const toolByUse = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of events) if (e.kind === 'tool.pre' && e.tool) { const p = e.payload as { tool_use_id?: string }; if (p?.tool_use_id) m.set(p.tool_use_id, e.tool) }
    return m
  }, [events])
  // Newest first. The list is read the way a feed is — you arrive wanting the
  // last thing that happened, not the first — and it used to be the only place
  // in Caprock ordered the other way, so the same glance meant two different
  // things on two screens. Oldest-first suited the `follow` autoscroll that is
  // now gone: with new rows arriving at the top there is nothing to chase.
  const visible = events
    .filter((e) => filter === 'all' || (filter === 'tools' ? e.kind.startsWith('tool.') : e.kind.startsWith('turn.') || e.kind === 'agent.stop'))
    .slice()
    .reverse()
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <Panel title={`Events · ${events.length} shown`} className="min-w-0 overflow-hidden" right={
        <span className="inline-flex items-center gap-2">
          {(['all', 'tools', 'turns'] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-1.5 rounded-sm ${filter === f ? 'bg-panel-2 text-fg' : 'hover:text-fg'}`}>{f}</button>
          ))}
        </span>
      }>
        <ol ref={list} className="max-h-[70vh] overflow-auto">
          {visible.length === 0 && <Empty title="No events yet" />}
          {visible.map((e) => (
            <EventRow key={e.id} e={e} now={now} toolByUse={toolByUse} inMinute={at !== undefined && sameMinute(e.ts, at)} />
          ))}
          {/* History is behind a link rather than loaded up front: a long
            * session has thousands of events and nobody wants them rendered to
            * reach the one they came for. It sits at the bottom because that is
            * where the oldest row now is. */}
          {!exhausted && events.length > 0 && (
            <li className="px-3 py-1.5 border-t border-border/60">
              <button
                className="text-[11px] text-fg-muted hover:text-fg border border-border px-2 py-0.5 rounded-sm"
                onClick={() => void loadEarlier()}
                disabled={loadingEarlier}
              >
                {loadingEarlier ? 'loading…' : 'load earlier events'}
              </button>
            </li>
          )}
          {exhausted && <li className="px-3 py-1 text-[11px] text-fg-faint">start of session</li>}
        </ol>
      </Panel>
      <div className="grid gap-3 content-start">
        <Panel title="Cost, cumulative">
          <div className="px-3 py-2"><Sparkline values={cost.length ? cost : [0, 0]} width={230} height={40} tone="accent" /></div>
          <div className="px-3 pb-2 text-[11px] text-fg-muted num">{cost.length} priced turns · {fmtUSD(cost[cost.length - 1] ?? 0)}</div>
        </Panel>
        <Panel title="Tokens per turn">
          <div className="px-3 py-2"><Sparkline values={events.filter((e) => e.tokens).map((e) => (e.tokens!.in + e.tokens!.cache_read + e.tokens!.cache_write))} width={230} height={40} /></div>
          <div className="px-3 pb-2 text-[11px] text-fg-muted">prompt size (input + cache) per assistant turn</div>
        </Panel>
      </div>
    </div>
  )
}

/** True when an event falls inside the minute the caller asked to see. */
function sameMinute(ts: string, at: number): boolean {
  const t = Date.parse(ts)
  return Number.isFinite(t) && Math.floor(t / 60_000) === Math.floor(at / 60_000)
}

function EventRow({ e, now, toolByUse, inMinute }: {
  e: Event
  now: number
  toolByUse: Map<string, string>
  /** Arrived here from the pulse: this is one of the events that was clicked. */
  inMinute?: boolean
}) {
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  // Scroll the first event of the minute into view once, so landing here from a
  // click puts you at what you clicked rather than at the top of the session.
  useEffect(() => {
    if (inMinute) row.current?.scrollIntoView({ block: 'center' })
  }, [inMinute])
  const p = (e.payload ?? {}) as Record<string, unknown>
  const resolved = e.tool || (e.kind === 'tool.post' ? toolByUse.get(String(p.tool_use_id ?? '')) : undefined)
  const label = describe({ ...e, tool: resolved }, p)
  // The full text of what Claude (or you) wrote, for the expanded view.
  const prose = e.kind === 'turn.assistant' ? String(p.text ?? '')
    : e.kind === 'turn.user' ? String(p.prompt ?? '')
    // A failing test tail or a stack trace is the single most useful thing in a
    // timeline, and the row shows 160 characters of it. Render it as text too,
    // rather than leaving raw JSON as the only way to read it.
    : e.kind === 'tool.post' && typeof p.tool_response === 'string' ? p.tool_response
    : ''
  const kindCls =
    e.kind === 'turn.user' ? 'text-info' :
    e.kind === 'turn.assistant' ? 'text-fg' :
    e.kind === 'agent.stop' ? 'text-warn' :
    e.kind === 'context.compact' ? 'text-warn' :
    'text-fg-muted'
  return (
    <li
      ref={row}
      className={`border-b border-border/60 last:border-0 hover:bg-panel-2 animate-flash ${
        inMinute ? 'bg-accent/10 border-l-2 border-l-accent' : ''
      }`}
    >
      <button className="w-full text-left flex items-baseline gap-2 px-3 py-[3px]" onClick={() => setOpen(!open)}>
        <span className="num text-[10px] text-fg-faint w-14 shrink-0">{fmtAgo(e.ts, now)}</span>
        <span className={`mono text-[10px] w-24 shrink-0 ${kindCls}`}>{e.kind}</span>
        <span className="truncate text-[12px] min-w-0" title={label}>{label}</span>
        {e.tokens && <span className="ml-auto num text-[10px] text-fg-faint shrink-0">{fmtTokens(e.tokens.in + e.tokens.cache_read + e.tokens.cache_write)}→{fmtTokens(e.tokens.out)}{e.cost_usd !== undefined ? ` · ${fmtUSD(e.cost_usd)}` : ''}</span>}
      </button>
      {open && (
        <div className="px-3 pb-2">
          {/* Prose Claude wrote is shown as prose. Expanding used to reveal raw
            * JSON, which is complete but unreadable — and the row above it is a
            * 200-character slice, so a summary had nowhere to be read at all. */}
          {prose ? (
            <div className="text-[12px] leading-[1.55] whitespace-pre-wrap break-words max-h-96 overflow-auto border-l-2 border-border-strong pl-3 mb-2">
              {prose}
            </div>
          ) : null}
          <details>
            <summary className="text-[10px] text-fg-faint cursor-pointer select-none">raw event</summary>
            <pre className="mono text-[10px] leading-[1.4] text-fg-muted pt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify({ id: e.id, ts: e.ts, source: e.source, key: e.key, agent_id: e.agent_id, model: e.model, tokens: e.tokens, cost_usd: e.cost_usd, payload: e.payload }, null, 2)}</pre>
          </details>
        </div>
      )}
    </li>
  )
}

export function describe(e: Event, p: Record<string, unknown>): string {
  const input = (p.tool_input ?? {}) as Record<string, unknown>
  switch (e.kind) {
    case 'tool.pre': {
      const t = e.tool ?? String(p.tool_name ?? 'tool')
      const arg = (input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.prompt ?? '') as string
      return arg ? `${t}  ${String(arg).split('\n')[0]}` : t
    }
    case 'tool.post': {
      const t = e.tool ?? String(p.tool_name ?? 'tool')
      const r = p.tool_response
      const isErr = p.is_error === true
      const s = typeof r === 'string' ? r : r ? JSON.stringify(r) : ''
      return `${t} ${isErr ? 'failed' : 'done'}${s ? `  ${s.slice(0, 160)}` : ''}`
    }
    case 'turn.user':
      return `you: ${String(p.prompt ?? '').slice(0, 200)}`
    case 'turn.assistant': {
      const text = String(p.text ?? '')
      const tools = Array.isArray(p.tools) ? (p.tools as string[]) : []
      return text ? text.slice(0, 200) : tools.length ? `→ ${tools.join(', ')}` : `${e.model ?? 'assistant'} turn`
    }
    case 'agent.stop':
      return e.agent_id ? `subagent ${e.agent_id} stopped` : `turn ended (${String(p.stop_reason ?? 'stop')})`
    case 'agent.spawn':
      return `session started (${String(p.source ?? 'startup')})`
    case 'context.compact':
      return `context compaction (${String(p.trigger ?? 'auto')})`
    default:
      return e.kind
  }
}

function ChangesTab({ id, s }: { id: string; s: SessionDetail }) {
  const diff = useApi(() => api.diff(id), [id, s.last_event_at], { live: false, intervalMs: 8000 })
  // Which files are expanded. A set rather than a single path: comparing two
  // changes means seeing both at once, and the old one-at-a-time accordion
  // made that impossible — opening the second closed the first.
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (p: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(p)) next.add(p)
      return next
    })

  if (diff.error && !diff.data) {
    const e = diff.error
    if (e instanceof ApiError && e.status === 409) {
      const body = e.body as { error?: string; cwd?: string } | undefined
      return (
        <div className="grid gap-3">
          <Empty title="No git repository">{body?.cwd ? <span className="mono">{body.cwd}</span> : null} {body?.error}</Empty>
          <TouchedPanel s={s} />
        </div>
      )
    }
    return <Empty title="Cannot load diff">{e.message}</Empty>
  }
  const d: DiffResult | undefined = diff.data
  if (!d) return <div className="text-fg-muted px-1">loading…</div>

  // Files the session touched that carry no change: already committed, or
  // reverted, or only read-modified-back. They belong on the same screen —
  // "what did this session touch" and "what changed" are two halves of one
  // question — but not mixed into the diff list, where a row with no patch
  // reads as a rendering fault.
  const changed = new Set(d.files.map((f) => f.path))
  const alsoTouched = s.files.filter((f) => !changed.has(f) && !changed.has(f.replace(/^.*?\//, '')))
  const allOpen = d.files.length > 0 && d.files.every((f) => open.has(f.path))

  return (
    <div className="grid gap-3">
      {/* The base is named because the same file count means different things
        * against a branch than against HEAD: on a branch whose work is
        * committed, "vs HEAD" is zero files while the branch changed twenty. */}
      <Panel
        title={`Changes · ${d.branch || 'detached'}`}
        right={
          <span className="flex items-center gap-2">
            {d.base && <span className="text-[11px] text-fg-faint">{d.base}</span>}
            {d.files.length > 0 && (
              <button
                className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
                onClick={() => setOpen(allOpen ? new Set() : new Set(d.files.map((f) => f.path)))}
              >
                {allOpen ? 'collapse all' : 'expand all'}
              </button>
            )}
            <span className="num">{d.files.length} files</span>
          </span>
        }
      >
        {d.files.length === 0 && <Empty title="Clean working tree" />}
        <ul>
          {d.files.map((f) => {
            const isOpen = open.has(f.path)
            return (
              <li key={f.path} className="border-b border-border/60 last:border-0">
                <button
                  className="w-full text-left px-3 py-1.5 flex items-center gap-3 hover:bg-panel-2"
                  onClick={() => toggle(f.path)}
                  aria-expanded={isOpen}
                >
                  {/* A disclosure caret, because a row that expands should look
                    * like one before it is clicked. */}
                  <span className={`text-fg-faint text-[10px] shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                  <span className={`mono text-[10px] w-16 shrink-0 ${f.status === 'added' || f.status === 'untracked' ? 'text-ok' : f.status === 'deleted' ? 'text-danger' : 'text-fg-muted'}`}>{f.status}</span>
                  <span className="mono text-[12px] truncate">{f.path}</span>
                  <span className="ml-auto num text-[11px] shrink-0"><span className="text-ok">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span></span>
                </button>
                {isOpen && f.patch && <Patch patch={f.patch} />}
                {isOpen && !f.patch && <div className="px-3 pb-2 text-[11px] text-fg-faint">{f.binary ? 'binary file' : 'no patch'}</div>}
              </li>
            )
          })}
        </ul>
      </Panel>
      {alsoTouched.length > 0 && <TouchedPanel s={s} only={alsoTouched} />}
    </div>
  )
}

function Patch({ patch }: { patch: string }) {
  return (
    <pre className="mono text-[11px] leading-[1.35] px-3 pb-2 overflow-auto max-h-[50vh]">
      {patch.split('\n').map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'text-ok' : line.startsWith('-') && !line.startsWith('---') ? 'text-danger' : line.startsWith('@@') ? 'text-info' : 'text-fg-muted'
        return <div key={i} className={cls}>{line || ' '}</div>
      })}
    </pre>
  )
}

function TouchedPanel({ s, only }: { s: SessionDetail; only?: string[] }) {
  const list = only ?? s.files
  // The endpoint caps this list, so a busy session shows 100 while the stat
  // tile above says 132. Presenting a truncated list as the complete answer is
  // worst exactly here, where someone is auditing what an agent changed.
  const capped = s.files.length < s.stats.files_touched
  return (
    <Panel
      title={only ? 'Also touched, unchanged' : 'Files touched'}
      right={
        <span className="num">
          {capped ? `${list.length} of ${s.stats.files_touched} · most recent` : list.length}
        </span>
      }
    >
      {list.length === 0 && <Empty title="No Edit/Write calls yet" />}
      <ul>
        {list.map((f) => (
          <li key={f} className="px-3 py-1 border-b border-border/60 last:border-0 flex gap-2 items-baseline">
            <span className="mono text-[12px]">{basename(f)}</span>
            <span className="mono text-[10px] text-fg-faint truncate">{f}</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function OwnedControls({ id }: { id: string }) {
  const [busy, setBusy] = useState('')
  const act = async (action: 'pause' | 'resume' | 'kill') => {
    setBusy(action)
    try { await api.signal(id, action) } catch { /* shown via live update */ } finally { setBusy('') }
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-ok border border-ok/40 rounded-sm px-1">owned</span>
      <button disabled={!!busy} onClick={() => act('pause')} className="text-[11px] border border-border px-1.5 rounded-sm text-fg-muted hover:text-fg">pause</button>
      <button disabled={!!busy} onClick={() => act('resume')} className="text-[11px] border border-border px-1.5 rounded-sm text-fg-muted hover:text-fg">resume</button>
      <button disabled={!!busy} onClick={() => act('kill')} className="text-[11px] border border-danger/40 text-danger px-1.5 rounded-sm hover:bg-danger/10">kill</button>
    </span>
  )
}

export { shortId }
