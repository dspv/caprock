/**
 * One subagent opened in the cockpit's Subagents section (.ai/21-app.md §
 * Agent cockpit): the task its parent gave it, its own calls in order, what
 * it answered, and its numbers. Read from the daemon once when the row opens
 * (`/v1/sessions/{id}/subagents/{agent}`), then followed on the live socket
 * the page already holds; read once more when it stops, for its answer.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Event, type SubagentCall, type SubagentDetail as Detail } from '@/lib/api'
import { live } from '@/lib/live'
import { fmtRun, toolKind } from '@/lib/cockpit'
import { fmtTokens, fmtUSD } from '@/lib/format'
import { FEED_PAGE, followSubagent, needsClamp } from '@/lib/subagentFeed'
import { KindIcon } from './KindIcon'

export function SubagentDetail({ sessionId, agentId, now, id }: { sessionId: string; agentId: string; now: number; id?: string }) {
  const [d, setD] = useState<Detail | undefined>(undefined)
  const [calls, setCalls] = useState<readonly SubagentCall[]>([])
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [older, setOlder] = useState(false)
  // Frames that arrive before the first read are applied once it lands.
  const early = useRef<Event[]>([])
  const loaded = useRef(false)

  useEffect(() => {
    let alive = true
    api.subagent(sessionId, agentId, { limit: FEED_PAGE })
      .then((r) => {
        if (!alive || !r || !Array.isArray(r.calls)) return
        loaded.current = true
        let next: readonly SubagentCall[] = r.calls
        for (const e of early.current) next = followSubagent(next, e, sessionId, agentId)
        early.current = []
        setD(r)
        setCalls(next)
        setFailed(false)
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [sessionId, agentId, reload])

  useEffect(() => live.onFrame((f) => {
    if (f.type !== 'event' || f.data.session_id !== sessionId || f.data.agent_id !== agentId) return
    if (f.data.kind === 'agent.stop') { setReload((n) => n + 1); return }
    if (!loaded.current) { early.current.push(f.data); return }
    setCalls((c) => followSubagent(c, f.data, sessionId, agentId))
  }), [sessionId, agentId])

  const showEarlier = () => {
    const first = calls[0]
    if (!first || older) return
    setOlder(true)
    api.subagent(sessionId, agentId, { before: first.id, limit: FEED_PAGE })
      .then((r) => {
        if (!r || !Array.isArray(r.calls)) return
        setCalls((c) => [...r.calls.filter((x) => !c.some((y) => y.id === x.id)), ...c])
        setD((prev) => (prev ? { ...prev, earlier: r.earlier } : prev))
      })
      .catch(() => { /* the button stays */ })
      .finally(() => setOlder(false))
  }

  if (failed) return <p id={id} className="px-1 py-2 text-[11.5px] text-fg-faint">Could not read this subagent.</p>
  if (!d) return <p id={id} className="px-1 py-2 text-[11.5px] text-fg-faint">Reading…</p>

  const working = d.state === 'working'
  const added = calls.filter((c) => c.id > (d.calls[d.calls.length - 1]?.id ?? 0)).length
  const total = d.stats.tool_calls + added
  const until = working ? now : d.stopped_at || d.last_at
  const duration = Math.max(0, until - d.started_at)
  const t = d.stats.tokens
  const tokens = t.in + t.out + t.cache_read + t.cache_write

  return (
    <div id={id} className="grid gap-2.5 border-t border-[var(--app-hairline)] px-1 pb-1 pt-2" data-subagent-detail={agentId}>
      <Part label="Task" right={[d.subagent_type || d.agent_type, d.background ? 'background' : ''].filter(Boolean).join(' · ')}>
        {d.prompt || d.description
          ? <Clamp text={d.prompt || d.description!} label="task" />
          : <p className="text-[11.5px] text-fg-faint">The parent’s call that started it was not recorded.</p>}
      </Part>

      <Part label={`Activity · ${total} ${total === 1 ? 'call' : 'calls'}`}>
        {d.earlier > 0 && (
          <button type="button" onClick={showEarlier} disabled={older}
            className="w-fit rounded-[5px] text-[11px] text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
            Show earlier · {d.earlier}
          </button>
        )}
        {calls.length === 0 ? (
          <p className="text-[11.5px] text-fg-faint">No tool calls yet.</p>
        ) : (
          <ol aria-label="Subagent activity" className="grid">
            {calls.map((c) => {
              const open = c.ended_at === undefined
              const ms = open ? (working ? now - c.started_at : -1) : c.ended_at! - c.started_at
              const name = c.tool.startsWith('mcp__') ? c.tool.replace(/^mcp__(.+?)__/, '$1·') : c.tool
              return (
                <li key={c.id} className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-1.5 py-[3px] text-[11.5px]"
                  data-live={open && working ? 'true' : undefined} title={`${c.tool}${c.detail ? ` — ${c.detail}` : ''} · ${new Date(c.started_at).toLocaleTimeString()}`}>
                  <span className={c.error ? 'text-danger' : open && working ? 'text-ok' : 'text-fg-muted'}><KindIcon kind={toolKind(c.tool)} size={12} /></span>
                  <span className="min-w-0 truncate">
                    <span className={c.error ? 'text-danger' : 'text-fg'}>{name}</span>
                    {c.detail && <span className="mono ml-1 text-[11px] text-fg-muted">{c.detail}</span>}
                  </span>
                  <span className={`num text-right text-[11px] ${c.error ? 'text-danger' : open && working ? 'text-ok' : 'text-fg-faint'}`}>
                    {c.error ? <span aria-label="failed">✕ {fmtRun(ms)}</span> : ms >= 0 ? fmtRun(ms) : '—'}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </Part>

      <Part label="Result">
        {d.result
          ? <Clamp text={d.result} label="result" />
          : <p className="text-[11.5px] text-fg-faint">{working ? 'Still working…' : 'No result was recorded.'}</p>}
      </Part>

      <Part label="Numbers">
        <p className="num text-[11.5px] text-fg-muted">
          {[d.stats.model_display || d.stats.model, fmtRun(duration), `${total} ${total === 1 ? 'call' : 'calls'}`,
            typeof d.stats.cost_usd === 'number' ? fmtUSD(d.stats.cost_usd) : ''].filter(Boolean).join(' · ')}
        </p>
        {tokens > 0 && (
          <p className="num text-[11px] text-fg-faint" title={`${t.in} in · ${t.out} out · ${t.cache_read} cache read · ${t.cache_write} cache write`}>
            {fmtTokens(tokens)} tokens · {fmtTokens(t.cache_read)} cache read · {fmtTokens(t.out)} out
          </p>
        )}
        {d.stats.by_tool.length > 0 && (
          <ul aria-label="Costliest tools" className="grid gap-0.5">
            {d.stats.by_tool.map((b) => (
              <li key={b.tool || '(text)'} className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-1.5 text-[11px]">
                <span className="text-fg-faint">{b.tool ? <KindIcon kind={toolKind(b.tool)} size={11} /> : null}</span>
                <span className="min-w-0 truncate text-fg-muted">{b.tool ? b.tool.replace(/^mcp__(.+?)__/, '$1·') : 'Writing'}{b.calls > 0 && <span className="text-fg-faint"> · {b.calls} {b.calls === 1 ? 'call' : 'calls'}</span>}</span>
                <span className="num text-fg-muted">{typeof b.cost_usd === 'number' ? fmtUSD(b.cost_usd) : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Part>
    </div>
  )
}

function Part({ label, right, children }: { label: string; right?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <p className="flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{label}</span>
        {right && <span className="ml-auto truncate text-[10.5px] text-fg-faint">{right}</span>}
      </p>
      {children}
    </div>
  )
}

/** A long text folded to six lines, with "Show all". */
function Clamp({ text, label }: { text: string; label: string }) {
  const [all, setAll] = useState(false)
  const long = needsClamp(text)
  return (
    <div className="grid gap-0.5">
      <p className={`whitespace-pre-wrap break-words text-[11.5px] leading-[1.45] text-fg ${long && !all ? 'line-clamp-6' : ''}`}
        data-clamped={long && !all ? 'true' : undefined}>
        {text}
      </p>
      {long && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} aria-label={`${all ? 'Show less' : 'Show all'} of the ${label}`}
          className="w-fit rounded-[5px] text-[11px] text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}
