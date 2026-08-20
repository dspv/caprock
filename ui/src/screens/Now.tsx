import { api, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { live, useLive } from '@/lib/live'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD, shortId } from '@/lib/format'
import { Badge, Empty, Panel, Stat } from '@/components/ui'
import { href } from '@/lib/router'
import { useEffect, useState } from 'react'

export function NowScreen() {
  const [showEnded, setShowEnded] = useState(false)
  const sessions = useApi(() => api.sessions(!showEnded), [showEnded], { intervalMs: 5000 })
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 30000 })
  const summary = useApi(() => api.summary('today'), [], { intervalMs: 5000 })
  const { alerts } = useLive()
  const now = useNow(1000)
  const list = sessions.data ?? []
  const working = list.filter((s) => s.activity.health === 'working' || s.activity.health === 'looping' || s.activity.health === 'error' || s.activity.health === 'waiting-on-you')
  const rest = list.filter((s) => !working.includes(s) && s.status !== 'ended')
  const ended = list.filter((s) => s.status === 'ended')
  const hooksMissing = status.data?.hooks && (status.data.hooks.missing ?? []).length > 0
  return (
    <div className="grid gap-3">
      {hooksMissing && (
        <div className="border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] flex items-center gap-3">
          <span className="text-warn font-medium">Hooks not installed</span>
          <span className="text-fg-muted">Activity is coming from transcripts only (a few seconds late, no tool-level detail for running commands). Run <span className="mono text-fg">caprock hooks install</span> for real-time narration.</span>
          <a href="#/settings" className="link ml-auto text-[11px]">details</a>
        </div>
      )}
      {alerts.length > 0 && (
        <div className="grid gap-1.5">
          {alerts.map((a) => (
            <div key={`${a.session_id}-${a.ts}`} className="border border-danger/50 bg-danger/10 text-fg px-3 py-2 flex items-center gap-3 rounded-[var(--radius-panel)]">
              <span className="text-danger font-medium">Loop detected</span>
              <span className="text-[12px]">
                <a href={href({ name: 'session', id: a.session_id })} className="link mono">{shortId(a.session_id)}</a> ran <span className="mono">{a.sample}</span> {a.count}× in {a.window_min} min
              </span>
              <span className="ml-auto text-[11px] text-fg-muted num">{fmtAgo(a.ts, now)}</span>
              <button className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 rounded-sm" onClick={() => live.dismissAlert(a.session_id)}>dismiss</button>
            </div>
          ))}
        </div>
      )}

      <Panel title="Today" right={summary.data ? <span className="num">pricing {summary.data.pricing_version} · at API list price</span> : null}>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-border">
          <Stat label="Sessions" value={summary.data ? summary.data.sessions : '—'} sub={summary.data ? `${summary.data.active_sessions} active` : undefined} />
          <Stat label="Turns" value={summary.data ? summary.data.turns : '—'} sub={summary.data ? `${summary.data.tool_calls} tool calls` : undefined} />
          <Stat label="Tokens" value={summary.data ? fmtTokens(summary.data.tokens_in + summary.data.tokens_out + summary.data.cache_read + summary.data.cache_write) : '—'} sub={summary.data ? `${fmtTokens(summary.data.cache_read)} cache read` : undefined} />
          <Stat label="Cost" value={fmtUSD(summary.data?.cost_usd)} sub="API-equivalent" />
          <Stat label="Burn now" value={summary.data ? `${fmtUSD(summary.data.burn.usd_per_hour)}/h` : '—'} sub={summary.data ? `${fmtTokens(Math.round(summary.data.burn.tokens_per_min))} tok/min · last ${summary.data.burn.window_min}m` : undefined} tone={summary.data && summary.data.burn.usd_per_hour > 0 ? 'info' : undefined} />
          <Stat label="Cache hit" value={summary.data ? fmtPct(summary.data.savings.hit_rate * 100) : '—'} sub={summary.data ? `${fmtPct(summary.data.savings.cut_pct)} input cost cut` : undefined} tone={summary.data && summary.data.savings.hit_rate > 0.5 ? 'ok' : undefined} />
        </div>
      </Panel>

      {sessions.error && !sessions.data && (
        <Empty title="Cannot reach the daemon">{sessions.error.message} — is <span className="mono">caprock up</span> running?</Empty>
      )}
      {sessions.data && list.length === 0 && (
        <Empty title="No sessions yet">Start <span className="mono">claude</span> in any terminal — it will show up here within seconds.</Empty>
      )}

      {working.length > 0 && <Section title={`Active · ${working.length}`} items={working} now={now} />}
      {rest.length > 0 && <Section title={`Idle · ${rest.length}`} items={rest} now={now} dim />}
      {showEnded && ended.length > 0 && <Section title={`Ended · ${ended.length}`} items={ended} now={now} dim />}
      <div className="flex items-center gap-3 text-[11px] text-fg-faint px-0.5">
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
          show ended sessions
        </label>
        {sessions.loadedAt > 0 && <span className="num ml-auto">refreshed {fmtAgo(sessions.loadedAt, now)}</span>}
      </div>
    </div>
  )
}

function Section({ title, items, now, dim }: { title: string; items: SessionSummary[]; now: number; dim?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-1.5 px-0.5">{title}</div>
      <div className={`grid gap-2 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 ${dim ? 'opacity-80' : ''}`}>
        {items.map((s) => <SessionCard key={s.session_id} s={s} now={now} />)}
      </div>
    </div>
  )
}

export function SessionCard({ s, now }: { s: SessionSummary; now: number }) {
  const ctx = s.context
  const ctxTone = ctx ? (ctx.pct >= 85 ? 'danger' : ctx.pct >= 60 ? 'warn' : undefined) : undefined
  return (
    <a href={href({ name: 'session', id: s.session_id })} className="block border border-border bg-panel rounded-[var(--radius-panel)] hover:border-border-strong no-underline hover:no-underline text-fg">
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <span className="font-medium truncate">{s.project || 'unknown project'}</span>
        <span className="mono text-[11px] text-fg-faint">{shortId(s.session_id)}</span>
        {s.git_branch && <span className="mono text-[11px] text-fg-muted truncate">{s.git_branch}</span>}
        <span className="ml-auto"><Badge health={s.activity.health} /></span>
      </div>
      <div className="px-3 pb-2 text-[13px] truncate" title={s.activity.phrase}>
        <span className={s.activity.health === 'working' ? 'text-fg' : 'text-fg-muted'}>{s.activity.phrase}</span>
        <span className="text-fg-faint num text-[11px] ml-2">{fmtAgo(s.activity.at || s.last_event_at, now)}</span>
      </div>
      {s.activity.plan && s.activity.plan.total > 0 && (
        <div className="px-3 pb-2 flex items-center gap-2 text-[11px] text-fg-muted">
          <div className="h-1 flex-1 bg-panel-2 rounded-sm overflow-hidden"><div className="h-full bg-accent" style={{ width: `${(100 * s.activity.plan.done) / s.activity.plan.total}%` }} /></div>
          <span className="num">{s.activity.plan.done}/{s.activity.plan.total}</span>
          {s.activity.plan.next && <span className="truncate max-w-[50%]">→ {s.activity.plan.next}</span>}
        </div>
      )}
      <div className="grid grid-cols-4 divide-x divide-border border-t border-border">
        <Stat label="Cost" value={fmtUSD(s.stats.cost_usd)} sub={s.model || '—'} />
        <Stat label="Tokens" value={fmtTokens(s.stats.tokens_in + s.stats.tokens_out + s.stats.cache_read + s.stats.cache_write)} sub={`${fmtPct(s.savings.hit_rate * 100)} cache hit`} />
        <Stat label="Context" value={ctx ? fmtPct(ctx.pct) : '—'} sub={ctx ? `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}` : 'unknown model'} tone={ctxTone} />
        <Stat label="Activity" value={s.stats.tool_calls} sub={`${s.stats.turns} turns · ${s.stats.files_touched} files`} />
      </div>
    </a>
  )
}

export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}
