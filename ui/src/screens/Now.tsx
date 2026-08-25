import { api, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { live, useLive } from '@/lib/live'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD, shortId } from '@/lib/format'
import { Badge, Empty, Panel, Skeleton, Stat } from '@/components/ui'
import { ProjectsPanel, AGENTS, type AgentFilter } from '@/components/Projects'
import { ActivityFeed } from '@/components/ActivityFeed'
import { LifetimeStrip } from '@/components/Lifetime'
import { BreakdownPanel } from '@/components/Breakdown'
import { PulsePanel } from '@/components/Pulse'
import { Attention } from '@/components/Attention'
import { findAttention } from '@/lib/attention'
import { UpdateBanner } from '@/components/UpdateBanner'
import { UnpricedNote } from '@/components/Unpriced'
import { SpawnDialog } from '@/components/SpawnDialog'
import { LastWord } from '@/components/LastWord'
import { usePlan } from '@/components/PlanPicker'
import { costBasis, costBasisLong } from '@/components/CostBasis'
import { href } from '@/lib/router'
import { useState } from 'react'
import { useNow } from '@/lib/useNow'

export function NowScreen() {
  const [showEnded, setShowEnded] = useState(false)
  // Which agent this whole screen is about. It reaches every panel, so the
  // figure at the top and the rows underneath always answer the same question
  // — a filtered list beside an unfiltered total is how a reader ends up
  // quoting the wrong number.
  const [agent, setAgent] = useState<AgentFilter>('all')
  const [spawning, setSpawning] = useState(false)
  const sessions = useApi(() => api.sessions(!showEnded), [showEnded], { intervalMs: 5000 })
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 30000 })
  const summary = useApi(() => api.summary('today', agent), [agent], { intervalMs: 5000 })
  const { alerts } = useLive()
  const now = useNow(1000)
  const everySession = sessions.data ?? []
  // Sessions carry their own agent, so this needs no second request.
  const list = agent === 'all'
    ? everySession
    : everySession.filter((s) => (s.agent ?? 'claude') === agent)
  // Whether the control has anything to switch between. Neither the session
  // list nor today's summary can answer this: the list holds only live
  // sessions unless "show ended" is ticked, and a machine's OpenCode history
  // is usually all ended and all older than today. The daemon reports whether
  // it is reading OpenCode at all, which is the honest test — and it says so
  // whether or not anything ran in the visible window.
  const hasBoth = !!status.data?.opencode
  const working = list.filter((s) => s.activity.health === 'working' || s.activity.health === 'looping' || s.activity.health === 'error' || s.activity.health === 'waiting-on-you')
  const rest = list.filter((s) => !working.includes(s) && s.status !== 'ended')
  const ended = list.filter((s) => s.status === 'ended')
  const [plan, savePlan] = usePlan()
  const attention = findAttention({ sessions: list, alerts, now })
  const hooksMissing = status.data?.hooks && (status.data.hooks.missing ?? []).length > 0
  // Defect: before any session exists the API returns Go zero values, so a new
  // user's first screen was a $0.00 hero, three zeroes, and a *warn*-toned
  // "Cache hit 0%" — the only coloured thing on the page was a warning about a
  // cache that had never been used. Nothing measured means no number to show.
  const measured = !!summary.data && summary.data.turns > 0
  const ingestError = status.data?.ingest_error
  return (
    <div className="grid gap-3">
      {/* A dead tailer used to be a log line: the daemon reported healthy, the
        * status said "backfill done", and this screen told the user to start
        * `claude` and wait for sessions that could never arrive. */}
      {ingestError && (
        <div className="border border-danger/50 bg-danger/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] flex items-center gap-3">
          <span className="text-danger font-medium">Ingest stopped</span>
          <span className="text-fg-muted">
            No new sessions are being captured. <span className="mono text-fg">{ingestError}</span> — check that
            <span className="mono text-fg"> ~/.claude</span> is readable, then restart with
            <span className="mono text-fg"> caprock down &amp;&amp; caprock up</span>.
          </span>
        </div>
      )}
      {hooksMissing && (
        <div className="border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] flex items-center gap-3">
          <span className="text-warn font-medium">Hooks not installed</span>
          <span className="text-fg-muted">Activity is coming from transcripts only (a few seconds late, no tool-level detail for running commands). Run <span className="mono text-fg">caprock hooks install</span> for real-time narration.</span>
          <a href="#/settings" className="link ml-auto text-[11px]">details</a>
        </div>
      )}
      <UpdateBanner plan={plan} onSave={savePlan} now={now} />
      <Attention items={attention} now={now} onDismiss={(id) => live.dismissAlert(id)} sessions={list} />

      {/* Above Today because it is the wider frame Today sits inside: what all
        * of this has come to, before what happened in the last few hours. */}
      <LifetimeStrip plan={plan} />

      <Panel
        title="Today"
        center={
          hasBoth ? (
            /* Centred on the panel rather than tucked beside the pricing
              * note: this control governs every figure below it, and a
              * governing control belongs where the eye lands.
              *
              * Larger than the range buttons, with the selection as a filled
              * pill. At 11px in a bordered strip the active state was a
              * slightly lighter grey — a control whose state you have to
              * squint at is one people misread. */
            <span className="inline-flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
              {AGENTS.map((a) => (
                <button
                  key={a.key}
                  onClick={() => setAgent(a.key)}
                  title={a.key === 'all' ? 'Every agent' : `Only ${a.label}`}
                  className={`px-2.5 py-1 text-[12px] mono rounded-[5px] transition-colors ${
                    agent === a.key
                      ? 'bg-accent text-panel font-medium'
                      : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </span>
          ) : null
        }
        right={
          summary.data ? (
            <span className="num">pricing {summary.data.pricing_version} · at API list price</span>
          ) : null
        }
      >
        {/* Cost leads and dominates. It sat fourth of six at the same size as
          * a turn counter, while the two tinted cells were cache hit (a
          * permanent ~99%) and burn (tinted whenever anything runs) — so
          * colour pointed away from the money. The rest are reference figures
          * and step down, which is what makes room for the headline. */}
        <div className="grid grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr] divide-x divide-border">
          <Stat label="Cost today" value={measured ? fmtUSD(summary.data?.cost_usd) : '—'} sub={<span title={costBasisLong(plan)}>{measured ? costBasis(plan) : 'nothing measured yet'}</span>} tone="info" size="hero" />
          <Stat label="Burn now" value={measured ? `${fmtUSD(summary.data!.burn.usd_per_hour)}/h` : '—'} sub={measured ? `${fmtTokens(Math.round(summary.data!.burn.tokens_per_min))} tok/min · last ${summary.data!.burn.window_min}m` : undefined} />
          <Stat label="Sessions" value={measured ? summary.data!.sessions : '—'} sub={measured ? `${summary.data!.active_sessions} active` : undefined} size="compact" />
          <Stat label="Turns" value={measured ? summary.data!.turns : '—'} sub={measured ? `${summary.data!.tool_calls} tool calls` : undefined} size="compact" />
          {/* Cache hit is ~99% forever on Claude Code, so it is reassurance
            * rather than news: it keeps its place but not a colour, and only
            * speaks up when it drops far enough to mean something broke. */}
          {/* The warn tone fires below 90%, which is true of a zero — so an
            * untouched cache was styled as a fault on a brand-new install. */}
          <Stat label="Cache hit" value={measured ? fmtPct(summary.data!.savings.hit_rate * 100) : '—'} sub={measured ? `${fmtPct(summary.data!.savings.cut_pct)} input cost cut` : undefined} tone={measured && summary.data!.savings.hit_rate < 0.9 ? 'warn' : undefined} size="compact" />
        </div>
        <UnpricedNote u={summary.data?.unpriced} className="mx-3 mb-2.5" />
      </Panel>

      {/* The shape of the work, above the detail of it: a glance says which
        * sessions are busy, which are grinding, and which have gone quiet. */}
      <PulsePanel sessions={list} now={now} />

      {/* What is happening (left) beside what it costs (right). */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ActivityFeed
          sessions={list}
          now={now}
          emptyHint={
            agent === 'all' ? undefined : (
              <>
                Nothing from {agent === 'opencode' ? 'OpenCode' : 'Claude Code'} yet.
              </>
            )
          }
        />
        <ProjectsPanel sessions={list} agent={agent} />
      </div>

      {/* The lifetime figures sit here rather than in the all-time line at the
        * top: hidden in that line nobody found them, expanded there they
        * pushed Today and the live pulse below the fold. Between the live
        * panels and the session rows there is room, and nothing they compete
        * with. */}
      <BreakdownPanel />

      {sessions.error && !sessions.data && (
        <Empty title="Cannot reach the daemon">{sessions.error.message} — is <span className="mono">caprock up</span> running?</Empty>
      )}
      {!sessions.data && !sessions.error && <Skeleton rows={4} className="border border-border rounded-[var(--radius-panel)] bg-panel" />}
      {sessions.data && list.length === 0 && (
        agent === 'all' ? (
          <Empty title="No sessions yet">Start <span className="mono">claude</span> in any terminal — it will show up here within seconds.</Empty>
        ) : (
          /* Under a filter this is not "nothing has ever run" but "nothing
           * from this agent, in this window" — and telling a reader to start
           * `claude` when they filtered for OpenCode is advice for the wrong
           * program. */
          <Empty title={`No ${agent === 'opencode' ? 'OpenCode' : 'Claude Code'} sessions here`}>
            Nothing from this agent in the current view. Switch to{' '}
            <button className="link underline" onClick={() => setAgent('all')}>all</button>{' '}
            to see everything.
          </Empty>
        )
      )}

      {/* One grid, not three.
        *
        * Each state used to open its own section with its own grid, so on a
        * machine running one busy session and one idle one — the ordinary
        * case — "Active · 1" took a third of a row and left the rest empty,
        * then "Idle · 1" did it again below. Two cards, three columns, and a
        * screen of dead space between them and the panels above.
        *
        * The cards now flow through a single grid in the same order, with the
        * state label riding on the first card of each run. Grouping survives —
        * it just stops reserving a row per group. */}
      <SessionGrid
        groups={[
          { label: 'Active', items: working },
          { label: 'Idle', items: rest, dim: true },
          ...(showEnded ? [{ label: 'Ended', items: ended, dim: true }] : []),
        ]}
        now={now}
      />
      <div className="flex items-center gap-3 text-[11px] text-fg-faint px-0.5">
        {/* The spawn dialog existed but nothing rendered it, so the Terminal
          * tab told people to use a "New session" control that was nowhere on
          * the dashboard — and no session could ever be owned. */}
        {/* The button used to be hidden outright when `claude` was missing, and
          * the dialog that explains why was only reachable from that button —
          * so the explanation existed and nobody could ever see it. Show the
          * control either way and let the dialog do the explaining. */}
        <button
          className={`text-[11px] px-2 py-0.5 rounded-sm border ${status.data?.claude_available ? 'border-accent/50 text-accent bg-accent/10 hover:bg-accent/20' : 'border-border text-fg-faint hover:text-fg-muted'}`}
          onClick={() => setSpawning(true)}
          title={status.data?.claude_available ? 'start a session Caprock owns' : 'claude was not found on this machine — click for details'}
        >
          + New session{status.data && !status.data.claude_available ? ' (claude not found)' : ''}
        </button>
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

/**
 * Every session as a full-width row, grouped without a row per group.
 *
 * Tiles three to a viewport made the figures small enough to be reference
 * material — you read the project name and moved on. A session is the unit
 * this screen is about, so it gets the width: the numbers come up to the size
 * of the ones in Today, and the narration sits beside them instead of above a
 * cramped four-column strip.
 *
 * The group label is drawn above the row that starts each run rather than
 * above the run itself, and absolutely positioned so it costs no height.
 */
function SessionGrid({
  groups,
  now,
}: {
  groups: { label: string; items: SessionSummary[]; dim?: boolean }[]
  now: number
}) {
  const cells = groups.flatMap((g) =>
    g.items.map((s, i) => ({
      s,
      dim: g.dim,
      // Only the first card of a run is labelled; the count goes with it so
      // "Active · 3" still reads as a count rather than a repeated tag.
      label: i === 0 ? `${g.label} · ${g.items.length}` : null,
    })),
  )
  if (cells.length === 0) return null
  return (
    <div className="mt-3 grid gap-2 gap-y-6">
      {cells.map(({ s, dim, label }) => (
        <div key={s.session_id} className={`relative ${dim ? 'opacity-80' : ''}`}>
          {label && (
            <div className="absolute -top-4 left-0.5 text-[11px] uppercase tracking-[0.08em] text-fg-faint">
              {label}
            </div>
          )}
          <SessionCard s={s} now={now} />
        </div>
      ))}
    </div>
  )
}

export function SessionCard({ s, now }: { s: SessionSummary; now: number }) {
  const ctx = s.context
  const ctxTone = ctx ? (ctx.pct >= 85 ? 'danger' : ctx.pct >= 60 ? 'warn' : undefined) : undefined
  const [asking, setAsking] = useState(false)
  // A session waiting on you is the one case where the terminal is the only
  // place the answer lives — and the text is already here.
  const waiting = s.activity?.health === 'waiting-on-you'
  return (
    <a href={href({ name: 'session', id: s.session_id })} className="block border border-border bg-panel rounded-[var(--radius-panel)] hover:border-border-strong no-underline hover:no-underline text-fg">
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <span className="font-medium truncate text-[15px]">{s.project || 'unknown project'}</span>
        <span className="mono text-[11px] text-fg-faint">{shortId(s.session_id)}</span>
        {/* Only the second agent is labelled. Marking every Claude Code
          * session too would put a badge on almost every row on most machines,
          * which is noise: the label exists to answer "why is this one
          * different", not to restate the common case. */}
        {s.agent === 'opencode' && (
          <span className="text-[10px] uppercase tracking-[0.08em] text-fg-muted border border-border px-1 py-px rounded-sm">
            opencode
          </span>
        )}
        {s.git_branch && <span className="mono text-[11px] text-fg-muted truncate">{s.git_branch}</span>}
        <span className="ml-auto flex items-center gap-2">
          {waiting && (
            <button
              className="text-[11px] border border-warn/50 text-warn bg-warn/10 px-1.5 py-0.5 rounded-sm hover:bg-warn/20"
              onClick={(e) => {
                e.preventDefault()
                setAsking(true)
              }}
            >
              what did it ask?
            </button>
          )}
          <Badge health={s.activity.health} />
        </span>
      </div>
      {asking && <LastWord session={s} now={now} onClose={() => setAsking(false)} />}
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
      {/* Default size, not compact. Across a full row there is space for the
        * figures to be read rather than referred to, and a session's own cost
        * is the number this screen exists to surface. Cost keeps the accent so
        * the money is still what the eye lands on first. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border border-t border-border">
        <Stat label="Cost" value={fmtUSD(s.stats.cost_usd)} sub={s.model || '—'} tone="info" />
        <Stat label="Tokens" value={fmtTokens(s.stats.tokens_in + s.stats.tokens_out + s.stats.cache_read + s.stats.cache_write)} sub={`${fmtPct(s.savings.hit_rate * 100)} cache hit`} />
        <Stat label="Context" value={ctx ? fmtPct(ctx.pct) : '—'} sub={ctx ? `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}` : 'unknown model'} tone={ctxTone} />
        <Stat label="Activity" value={s.stats.tool_calls} sub={`${s.stats.turns} turns · ${s.stats.files_touched} files`} />
      </div>
    </a>
  )
}

export { useNow }
