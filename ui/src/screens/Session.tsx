import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, type DiffResult, type Event, type SessionDetail } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { live } from '@/lib/live'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD, shortId, basename } from '@/lib/format'
import { Badge, Empty, Panel, Sparkline, Stat } from '@/components/ui'
import { href, navigate } from '@/lib/router'
import { useNow } from './Now'
import { TerminalView } from '@/components/Terminal'

type Tab = 'timeline' | 'diff' | 'files' | 'terminal'

export function SessionScreen({ id, tab }: { id: string; tab?: string }) {
  const detail = useApi(() => api.session(id), [id], { intervalMs: 5000 })
  const active: Tab = tab === 'diff' || tab === 'files' || tab === 'terminal' ? tab : 'timeline'
  const now = useNow(1000)
  const s = detail.data
  if (detail.error && !s) {
    return <Empty title={detail.error instanceof ApiError && detail.error.status === 404 ? 'Session not found' : 'Cannot load session'}>{detail.error.message}</Empty>
  }
  if (!s) return <div className="text-fg-muted px-1">loading…</div>
  const setTab = (t: Tab) => navigate({ name: 'session', id, tab: t })
  const total = s.stats.tokens_in + s.stats.tokens_out + s.stats.cache_read + s.stats.cache_write
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <a href={href({ name: 'now' })} className="link text-fg-muted text-[12px]">← Now</a>
        <h1 className="text-[15px] font-medium">{s.project || 'unknown project'}</h1>
        <span className="mono text-[11px] text-fg-faint">{s.session_id}</span>
        {s.git_branch && <span className="mono text-[11px] text-fg-muted">{s.git_branch}</span>}
        <Badge health={s.activity.health} />
        {s.owned && s.status !== 'ended' && <OwnedControls id={id} />}
        <span className="text-[12px] text-fg-muted ml-auto num">{s.cwd}</span>
      </div>
      <div className="text-[13px]">
        <span className="text-fg">{s.activity.phrase}</span>
        <span className="text-fg-faint num text-[11px] ml-2">{fmtAgo(s.activity.at || s.last_event_at, now)}</span>
        {s.loop && <span className="ml-3 text-danger text-[12px]">loop: {s.loop.sample} ×{s.loop.count} in {s.loop.window_min}m</span>}
      </div>
      <Panel>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-border">
          <Stat label="Cost" value={fmtUSD(s.stats.cost_usd)} sub={s.model || '—'} />
          <Stat label="Tokens" value={fmtTokens(total)} sub={`in ${fmtTokens(s.stats.tokens_in)} · out ${fmtTokens(s.stats.tokens_out)}`} />
          <Stat label="Cache" value={fmtPct(s.savings.hit_rate * 100)} sub={`read ${fmtTokens(s.stats.cache_read)} · write ${fmtTokens(s.stats.cache_write)}`} tone={s.savings.hit_rate > 0.5 ? 'ok' : undefined} />
          <Stat label="Context" value={s.context ? fmtPct(s.context.pct) : '—'} sub={s.context ? `${fmtTokens(s.context.tokens)} / ${fmtTokens(s.context.window)}` : 'unknown model'} tone={s.context && s.context.pct >= 85 ? 'danger' : s.context && s.context.pct >= 60 ? 'warn' : undefined} />
          <Stat label="Turns" value={s.stats.turns} sub={`${s.stats.tool_calls} tool calls`} />
          <Stat label="Files" value={s.stats.files_touched} sub={`${s.has_hooks ? 'hooks' : 'no hooks'} · ${s.has_transcript ? 'transcript' : 'no transcript'}`} />
        </div>
      </Panel>
      <div className="flex items-center gap-1 border-b border-border">
        {(['timeline', 'diff', 'files', 'terminal'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-[12px] border-b-2 -mb-px ${active === t ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}>
            {t === 'timeline' ? 'Timeline' : t === 'diff' ? 'Live diff' : t === 'files' ? `Files (${s.files.length})` : 'Terminal'}
          </button>
        ))}
        {!s.owned && <span className="ml-auto text-[11px] text-fg-faint pr-1">observe-only — terminal is read/write for spawned sessions only</span>}
      </div>
      {active === 'timeline' && <Timeline id={id} initial={s.events} now={now} />}
      {active === 'diff' && <DiffTab id={id} lastEventAt={s.last_event_at} />}
      {active === 'files' && <FilesTab s={s} />}
      {active === 'terminal' && <Panel className="overflow-hidden"><TerminalView sessionId={id} owned={s.owned && s.status !== 'ended'} /></Panel>}
    </div>
  )
}

type Filter = 'all' | 'tools' | 'turns'

function Timeline({ id, initial, now }: { id: string; initial: Event[]; now: number }) {
  const [events, setEvents] = useState<Event[]>(initial)
  const [filter, setFilter] = useState<Filter>('all')
  const [follow, setFollow] = useState(true)
  const lastId = useRef(initial.length ? initial[initial.length - 1]!.id : 0)
  const bottom = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => { setEvents(initial); lastId.current = initial.length ? initial[initial.length - 1]!.id : 0 }, [initial])
  // Append live events for this session as they arrive.
  useEffect(() => live.onFrame((f) => {
    if (f.type !== 'event' || f.data.session_id !== id || f.data.id <= lastId.current) return
    lastId.current = f.data.id
    setEvents((evs) => [...evs.slice(-499), f.data])
  }), [id])
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: 'end' }) }, [events, follow])
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
  const visible = events.filter((e) => filter === 'all' || (filter === 'tools' ? e.kind.startsWith('tool.') : e.kind.startsWith('turn.') || e.kind === 'agent.stop'))
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <Panel title={`Events · last ${events.length}`} className="min-w-0 overflow-hidden" right={
        <span className="inline-flex items-center gap-2">
          {(['all', 'tools', 'turns'] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-1.5 rounded-sm ${filter === f ? 'bg-panel-2 text-fg' : 'hover:text-fg'}`}>{f}</button>
          ))}
          <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[var(--color-accent)]" />follow</label>
        </span>
      }>
        <ol ref={list} className="max-h-[70vh] overflow-auto" onScroll={() => { const el = list.current; if (el && follow && el.scrollTop + el.clientHeight < el.scrollHeight - 40) setFollow(false) }}>
          {visible.length === 0 && <Empty title="No events yet" />}
          {visible.map((e) => <EventRow key={e.id} e={e} now={now} toolByUse={toolByUse} />)}
          <div ref={bottom} />
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

function EventRow({ e, now, toolByUse }: { e: Event; now: number; toolByUse: Map<string, string> }) {
  const [open, setOpen] = useState(false)
  const p = (e.payload ?? {}) as Record<string, unknown>
  const resolved = e.tool || (e.kind === 'tool.post' ? toolByUse.get(String(p.tool_use_id ?? '')) : undefined)
  const label = describe({ ...e, tool: resolved }, p)
  const kindCls =
    e.kind === 'turn.user' ? 'text-info' :
    e.kind === 'turn.assistant' ? 'text-fg' :
    e.kind === 'agent.stop' ? 'text-warn' :
    e.kind === 'context.compact' ? 'text-warn' :
    'text-fg-muted'
  return (
    <li className="border-b border-border/60 last:border-0 hover:bg-panel-2 animate-flash">
      <button className="w-full text-left flex items-baseline gap-2 px-3 py-[3px]" onClick={() => setOpen(!open)}>
        <span className="num text-[10px] text-fg-faint w-14 shrink-0">{fmtAgo(e.ts, now)}</span>
        <span className={`mono text-[10px] w-24 shrink-0 ${kindCls}`}>{e.kind}</span>
        <span className="truncate text-[12px] min-w-0" title={label}>{label}</span>
        {e.tokens && <span className="ml-auto num text-[10px] text-fg-faint shrink-0">{fmtTokens(e.tokens.in + e.tokens.cache_read + e.tokens.cache_write)}→{fmtTokens(e.tokens.out)}{e.cost_usd !== undefined ? ` · ${fmtUSD(e.cost_usd)}` : ''}</span>}
      </button>
      {open && (
        <pre className="mono text-[10px] leading-[1.4] text-fg-muted px-3 pb-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify({ id: e.id, ts: e.ts, source: e.source, key: e.key, agent_id: e.agent_id, model: e.model, tokens: e.tokens, cost_usd: e.cost_usd, payload: e.payload }, null, 2)}</pre>
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

function DiffTab({ id, lastEventAt }: { id: string; lastEventAt: number }) {
  const diff = useApi(() => api.diff(id), [id, lastEventAt], { live: false, intervalMs: 8000 })
  const [open, setOpen] = useState<string | null>(null)
  if (diff.error && !diff.data) {
    const e = diff.error
    if (e instanceof ApiError && e.status === 409) {
      const body = e.body as { error?: string; cwd?: string } | undefined
      return <Empty title="No git repository">{body?.cwd ? <span className="mono">{body.cwd}</span> : null} {body?.error}</Empty>
    }
    return <Empty title="Cannot load diff">{e.message}</Empty>
  }
  const d: DiffResult | undefined = diff.data
  if (!d) return <div className="text-fg-muted px-1">loading…</div>
  return (
    <Panel title={`Working tree · ${d.branch || 'detached'}`} right={<span className="num">{d.files.length} files</span>}>
      {d.files.length === 0 && <Empty title="Clean working tree" />}
      <ul>
        {d.files.map((f) => (
          <li key={f.path} className="border-b border-border/60 last:border-0">
            <button className="w-full text-left px-3 py-1.5 flex items-center gap-3 hover:bg-panel-2" onClick={() => setOpen(open === f.path ? null : f.path)}>
              <span className={`mono text-[10px] w-16 shrink-0 ${f.status === 'added' || f.status === 'untracked' ? 'text-ok' : f.status === 'deleted' ? 'text-danger' : 'text-fg-muted'}`}>{f.status}</span>
              <span className="mono text-[12px] truncate">{f.path}</span>
              <span className="ml-auto num text-[11px] shrink-0"><span className="text-ok">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span></span>
            </button>
            {open === f.path && f.patch && <Patch patch={f.patch} />}
            {open === f.path && !f.patch && <div className="px-3 pb-2 text-[11px] text-fg-faint">{f.binary ? 'binary file' : f.status === 'untracked' ? 'untracked — no diff against HEAD' : 'no patch'}</div>}
          </li>
        ))}
      </ul>
    </Panel>
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

function FilesTab({ s }: { s: SessionDetail }) {
  return (
    <Panel title="Files touched" right={<span className="num">{s.files.length}</span>}>
      {s.files.length === 0 && <Empty title="No Edit/Write calls yet" />}
      <ul>
        {s.files.map((f) => (
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
