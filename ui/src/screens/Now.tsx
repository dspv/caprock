import { api, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { live, useLive } from '@/lib/live'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD, shortId } from '@/lib/format'
import { Badge, Empty, Panel, Skeleton, Stat } from '@/components/ui'
import { ProjectsPanel } from '@/components/Projects'
import { ActivityFeed } from '@/components/ActivityFeed'
import { Attention } from '@/components/Attention'
import { findAttention } from '@/lib/attention'
import { UpdateBanner } from '@/components/UpdateBanner'
import { SpawnDialog } from '@/components/SpawnDialog'
import { usePlan } from '@/components/PlanPicker'
import { href } from '@/lib/router'
import { useEffect, useState } from 'react'

export function NowScreen() {
  const [showEnded, setShowEnded] = useState(false)
  const [spawning, setSpawning] = useState(false)
  const sessions = useApi(() => api.sessions(!showEnded), [showEnded], { intervalMs: 5000 })
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 30000 })
  const summary = useApi(() => api.summary('today'), [], { intervalMs: 5000 })
  const { alerts } = useLive()
  const now = useNow(1000)
  const list = sessions.data ?? []
  const working = list.filter((s) => s.activity.health === 'working' || s.activity.health === 'looping' || s.activity.health === 'error' || s.activity.health === 'waiting-on-you')
  const rest = list.filter((s) => !working.includes(s) && s.status !== 'ended')
  const ended = list.filter((s) => s.status === 'ended')
  const [plan, savePlan] = usePlan()
  const attention = findAttention({ sessions: list, alerts, now })
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
      <UpdateBanner plan={plan} onSave={savePlan} now={now} />
      <Attention items={attention} now={now} onDismiss={(id) => live.dismissAlert(id)} />

      <Panel title="Today" right={summary.data ? <span className="num">pricing {summary.data.pricing_version} · at API list price</span> : null}>
        {/* Cost leads and dominates. It sat fourth of six at the same size as
          * a turn counter, while the two tinted cells were cache hit (a
          * permanent ~99%) and burn (tinted whenever anything runs) — so
          * colour pointed away from the money. The rest are reference figures
          * and step down, which is what makes room for the headline. */}
        <div className="grid grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr] divide-x divide-border">
          <Stat label="Cost today" value={fmtUSD(summary.data?.cost_usd)} sub="at API list price · not a bill" tone="info" size="hero" />
          <Stat label="Burn now" value={summary.data ? `${fmtUSD(summary.data.burn.usd_per_hour)}/h` : '—'} sub={summary.data ? `${fmtTokens(Math.round(summary.data.burn.tokens_per_min))} tok/min · last ${summary.data.burn.window_min}m` : undefined} />
          <Stat label="Sessions" value={summary.data ? summary.data.sessions : '—'} sub={summary.data ? `${summary.data.active_sessions} active` : undefined} size="compact" />
          <Stat label="Turns" value={summary.data ? summary.data.turns : '—'} sub={summary.data ? `${summary.data.tool_calls} tool calls` : undefined} size="compact" />
          {/* Cache hit is ~99% forever on Claude Code, so it is reassurance
            * rather than news: it keeps its place but not a colour, and only
            * speaks up when it drops far enough to mean something broke. */}
          <Stat label="Cache hit" value={summary.data ? fmtPct(summary.data.savings.hit_rate * 100) : '—'} sub={summary.data ? `${fmtPct(summary.data.savings.cut_pct)} input cost cut` : undefined} tone={summary.data && summary.data.savings.hit_rate < 0.9 ? 'warn' : undefined} size="compact" />
        </div>
      </Panel>

      {/* What is happening (left) beside what it costs (right). */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ActivityFeed sessions={list} now={now} />
        <ProjectsPanel sessions={list} />
      </div>

      {sessions.error && !sessions.data && (
        <Empty title="Cannot reach the daemon">{sessions.error.message} — is <span className="mono">caprock up</span> running?</Empty>
      )}
      {!sessions.data && !sessions.error && <Skeleton rows={4} className="border border-border rounded-[var(--radius-panel)] bg-panel" />}
      {sessions.data && list.length === 0 && (
        <Empty title="No sessions yet">Start <span className="mono">claude</span> in any terminal — it will show up here within seconds.</Empty>
      )}

      {working.length > 0 && <Section title={`Active · ${working.length}`} items={working} now={now} />}
      {rest.length > 0 && <Section title={`Idle · ${rest.length}`} items={rest} now={now} dim />}
      {showEnded && ended.length > 0 && <Section title={`Ended · ${ended.length}`} items={ended} now={now} dim />}
      <div className="flex items-center gap-3 text-[11px] text-fg-faint px-0.5">
        {/* The spawn dialog existed but nothing rendered it, so the Terminal
          * tab told people to use a "New session" control that was nowhere on
          * the dashboard — and no session could ever be owned. */}
        {status.data?.claude_available && (
          <button
            className="text-[11px] border border-accent/50 text-accent bg-accent/10 px-2 py-0.5 rounded-sm hover:bg-accent/20"
            onClick={() => setSpawning(true)}
          >
            + New session
          </button>
        )}
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
          show ended sessions
        </label>
        {sessions.loadedAt > 0 && <span className="num ml-auto">refreshed {fmtAgo(sessions.loadedAt, now)}</span>}
      </div>
      {spawning && (
        <SpawnDialog
          available={status.data?.claude_available ?? false}
          onClose={() => { setSpawning(false); sessions.refresh() }}
        />
      )}
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
        <span className="font-medium truncate text-[15px]">{s.project || 'unknown project'}</span>
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
          <div className="h-1 flex-1 bg-panel-2 rounded-sm overflow-hidden"><div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, (100 * s.activity.plan.done) / s.activity.plan.total))}%` }} /></div>
          <span className="num">{s.activity.plan.done}/{s.activity.plan.total}</span>
          {s.activity.plan.next && <span className="truncate max-w-[50%]">→ {s.activity.plan.next}</span>}
        </div>
      )}
      {/* Compact: these are reference figures inside a card, three or four to a
        * row. At the default size a long cost and a token count collide, and
        * stepping them down is what leaves room for the screen's headline to
        * be the biggest thing on the page. The session's own cost keeps the
        * accent, so the money is still the first thing read in the card. */}
      <div className="grid grid-cols-4 divide-x divide-border border-t border-border">
        <Stat label="Cost" value={fmtUSD(s.stats.cost_usd)} sub={s.model || '—'} tone="info" size="compact" />
        <Stat label="Tokens" value={fmtTokens(s.stats.tokens_in + s.stats.tokens_out + s.stats.cache_read + s.stats.cache_write)} sub={`${fmtPct(s.savings.hit_rate * 100)} cache hit`} size="compact" />
        <Stat label="Context" value={ctx ? fmtPct(ctx.pct) : '—'} sub={ctx ? `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}` : 'unknown model'} tone={ctxTone} size="compact" />
        <Stat label="Activity" value={s.stats.tool_calls} sub={`${s.stats.turns} turns · ${s.stats.files_touched} files`} size="compact" />
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
