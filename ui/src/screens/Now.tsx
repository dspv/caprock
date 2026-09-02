import { api, errText, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { navigate } from '@/lib/router'
import { live, useLive } from '@/lib/live'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD, shortId } from '@/lib/format'
import { Badge, Empty, Panel, Skeleton, Stat } from '@/components/ui'
import { ProjectsPanel, AGENTS, agentName, type AgentFilter } from '@/components/Projects'
import { ActivityFeed } from '@/components/ActivityFeed'
import { LifetimeStrip } from '@/components/Lifetime'
import { CacheStat } from '@/components/CacheStat'
import { PlanLimitsStat } from '@/components/PlanLimits'
import { PremiumBanner } from '@/components/PremiumBanner'
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

/** How recently a session must have spoken to belong on the Now screen.
 *
 *  Two days rather than one: a session left overnight on Friday should still be
 *  there on Monday morning if its process is alive, and a day would drop it.
 *  Everything older is reachable through the Lifetime screen and the "show
 *  ended" toggle, which is where history belongs. */
export const NOW_WINDOW_MS = 2 * 24 * 60 * 60 * 1000

/** Whether an answer is still on its way — as opposed to having arrived empty.
 *
 *  Exported so the distinction is testable: conflating the two is what made a
 *  screen full of figures announce "nothing measured yet" for the second it
 *  took the first response to land. */
export function isLoading(data: unknown, error: unknown): boolean {
  return !data && !error
}

export function recentEnough(s: { last_event_at?: number | null }, now: number): boolean {
  // A row with no timestamp is shown rather than hidden: not knowing when
  // something happened is not evidence that it was long ago, and hiding a
  // live session is the worse mistake.
  if (!s.last_event_at) return true
  return now - s.last_event_at < NOW_WINDOW_MS
}

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
  // All-time totals, for the one line that mentions the paid version. Slow
  // enough to be worth a long interval and cheap enough to share with the
  // strip below, which asks for the same thing.
  const lifetime = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  const { alerts } = useLive()
  const now = useNow(1000)
  const everySession = sessions.data ?? []
  // Sessions carry their own agent, so this needs no second request.
  const list = agent === 'all'
    ? everySession
    : everySession.filter((s) => (s.agent ?? 'claude') === agent)
  // Only offer a filter for an agent this machine actually runs: a chip that
  // always finds nothing is a control that lies about what is here. The
  // session list cannot answer this on its own — it holds only live sessions
  // unless "show ended" is ticked, and an agent's history is usually all
  // ended. So each is detected where it exists: the daemon reports whether it
  // reads OpenCode at all, and whether a gemini binary is on PATH.
  // A filter chip is offered when there is something to filter — a session
  // from that agent — not when the machine merely could run one. Having the
  // gemini binary on PATH is what decides whether the New Session dialog
  // offers Gemini; it says nothing about whether any Gemini session exists,
  // and a first run showed `all · claude · gemini` above an empty screen with
  // nothing to sort.
  //
  // OpenCode is the one exception, and for a reason rather than by accident:
  // its sessions are usually all ended and older than the visible window, so
  // the list genuinely cannot answer "is OpenCode here" — the daemon reporting
  // that it reads OpenCode at all is the honest test.
  const agentsHere = AGENTS.filter(
    (a) => a.key === 'all' || a.key === 'claude' ||
      (a.key === 'opencode' && !!status.data?.opencode) ||
      (a.key === 'gemini' && everySession.some((s) => s.agent === 'gemini')),
  )
  const hasBoth = agentsHere.length > 2
  const working = list.filter((s) => s.activity.health === 'working' || s.activity.health === 'looping' || s.activity.health === 'error' || s.activity.health === 'waiting-on-you')
  // "Now" is a screen about now. A session that has not made a sound in two
  // days is history, whatever its status column says — and status alone is not
  // enough to tell them apart, because an observed agent's sessions are read
  // out of its own database and arrive already weeks old. Without this, opening
  // the screen after connecting OpenCode filled it with 97-day-old rows marked
  // idle, which is technically true and useless.
  //
  // Anything working shows regardless of age: a long-running agent that has
  // been quiet while it thinks is exactly what this screen is for.
  const rest = list.filter((s) => !working.includes(s) && s.status !== 'ended' && recentEnough(s, now))
  const ended = list.filter((s) => s.status === 'ended')
  const [plan, savePlan] = usePlan()
  const attention = findAttention({ sessions: list, alerts, now, limits: summary.data?.rate_limits })
  const hooksMissing = status.data?.hooks && (status.data.hooks.missing ?? []).length > 0
  // Defect: before any session exists the API returns Go zero values, so a new
  // user's first screen was a $0.00 hero, three zeroes, and a *warn*-toned
  // "Cache hit 0%" — the only coloured thing on the page was a warning about a
  // cache that had never been used. Nothing measured means no number to show.
  const measured = !!summary.data && summary.data.turns > 0
  // Not the same as "nothing measured", and saying so was a lie the first
  // screen told on every load: until the first response lands there is no
  // answer yet, and "nothing measured yet" is an answer. On a large database
  // the all-time query takes about half a second — long enough to read.
  const loading = isLoading(summary.data, summary.error)
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
          <span className="text-fg-muted">Run <span className="mono text-fg">caprock hooks install</span> for live activity. Without it, updates lag by a few seconds.</span>
          <a href="#/settings" className="link ml-auto text-[11px]">details</a>
        </div>
      )}
      {/* Only sessions Caprock spawned end with the daemon; the ones the user
        * started themselves are untouched by an upgrade. */}
      <UpdateBanner plan={plan} onSave={savePlan} now={now} owned={list.filter((s) => s.owned && s.status !== 'ended').length} />
      <Attention items={attention} now={now} onDismiss={(id) => live.dismissAlert(id)} sessions={list} />

      {/* Above Today because it is the wider frame Today sits inside: what all
        * of this has come to, before what happened in the last few hours. */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><LifetimeStrip plan={plan} /></div>
        {/* Starting a session is the only thing on this screen that DOES
          * something, and it used to sit at the very bottom in 11px grey,
          * sharing a row with a checkbox and a "refreshed 3s ago" timestamp —
          * the last place anyone reading top-down would look. A user who had
          * moved onto Caprock full-time still could not find it. Top of the
          * screen, at the size of an action. */}
        <QuickChatButton available={status.data?.claude_available} />
        <NewSessionButton available={status.data?.claude_available} onClick={() => setSpawning(true)} />
      </div>

      {/* The share offer lives beside the figures it is about, in the ALL TIME
        * panel — see ShareNudge. It used to be a second banner here, which put
        * two invitations one above the other and made the screen read as a
        * page that wants something from you. */}

      {/* Now too, not only Cost and Lifetime. Keeping it off the screen people
        * actually live in meant a user with no loop and no runaway session
        * never saw that a paid version exists at all — the caution was so
        * complete it removed the offer. Still one line, still dismissible for
        * a month, still nothing on an empty dashboard. */}
      {measured && lifetime.data?.totals && (
        <PremiumBanner
          costUSD={lifetime.data.totals.cost_usd}
          days={lifetime.data.totals.days}
          now={now}
        />
      )}

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
              {agentsHere.map((a) => (
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
        <div className="grid grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr] divide-x divide-border">
          <Stat label="Cost today" value={measured ? fmtUSD(summary.data?.cost_usd) : '—'} sub={<span title={costBasisLong(plan)}>{measured ? costBasis(plan) : loading ? 'reading your figures…' : 'nothing measured yet'}</span>} tone="info" size="hero" />
          <Stat label="Burn now" value={measured ? `${fmtUSD(summary.data!.burn.usd_per_hour)}/h` : '—'} sub={measured ? `${fmtTokens(Math.round(summary.data!.burn.tokens_per_min))} tok/min · last ${summary.data!.burn.window_min}m` : undefined} />
          <Stat label="Sessions" value={measured ? summary.data!.sessions : '—'} sub={measured ? `${summary.data!.active_sessions} active` : undefined} size="compact" />
          <Stat label="Turns" value={measured ? summary.data!.turns : '—'} sub={measured ? `${summary.data!.tool_calls} tool calls` : undefined} size="compact" />
          {/* Cache hit is ~99% forever on Claude Code, so it is reassurance
            * rather than news: it keeps its place but not a colour, and only
            * speaks up when it drops far enough to mean something broke. */}
          {/* The warn tone fires below 90%, which is true of a zero — so an
            * untouched cache was styled as a fault on a brand-new install. */}
          {/* "Can I keep going" belongs beside "what is it costing me",
            * at the size of its neighbours — it had a full-width panel of its
            * own above this row, which made two stale percentages look like a
            * headline. */}
          <PlanLimitsStat limits={summary.data?.rate_limits} now={now} />
          <CacheStat hitRate={summary.data?.savings.hit_rate} cutPct={summary.data?.savings.cut_pct} measured={measured} />
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
                Nothing from {agentName(agent)} yet.
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
          <Empty title={`No ${agentName(agent)} sessions here`}>
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
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
          show ended sessions
        </label>
        {sessions.loadedAt > 0 && <span className="num ml-auto">refreshed {fmtAgo(sessions.loadedAt, now)}</span>}
      </div>
      {spawning && (
        <SpawnDialog
          available={status.data?.claude_available ?? false}
          geminiAvailable={status.data?.gemini_available ?? false}
          onClose={() => { setSpawning(false); sessions.refresh() }}
        />
      )}
    </div>
  )
}

/**
 * Ask something, without first answering where.
 *
 * "New session" demands an absolute path to a repository, which is the right
 * question for work and a wall for "look this up for me" — the way at least
 * one user spends much of his time in Claude. This starts a session Caprock
 * has found a home for, in the data directory, on the default model; the model
 * can still be changed inside the session afterwards.
 */
function QuickChatButton({ available }: { available: boolean | undefined }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (available === false) return null
  const start = async () => {
    setBusy(true); setError('')
    try {
      const { session_id } = await api.spawn({ chat: true })
      navigate({ name: 'session', id: session_id, tab: 'terminal' })
    } catch (e) {
      setError(errText(e))
    } finally { setBusy(false) }
  }
  return (
    <>
      {/* No wrapper div around the button.
        *
        * It sat in a `shrink-0` div beside a bare `+ New session` button, so
        * the two were different boxes in the same flex row and did not line
        * up. The error, which is the only reason a wrapper existed, is
        * positioned absolutely instead — it appears rarely and must not
        * change the height of the row when it does. */}
      <button
        onClick={start}
        disabled={busy}
        title="start a session without picking a folder"
        className="relative shrink-0 rounded-[var(--radius-panel)] border border-border-strong px-3 py-2 text-[13px] leading-5 text-fg-muted hover:text-fg hover:border-accent/50 disabled:opacity-50"
      >
        {busy ? 'starting…' : 'Quick chat'}
        {error && (
          <span className="absolute right-0 top-full mt-1 block max-w-[220px] text-right text-[11px] text-danger">
            {error}
          </span>
        )}
      </button>
    </>
  )
}

/**
 * The one control on this screen that starts something.
 *
 * It is shown even when `claude` is missing rather than hidden: the dialog
 * explaining why spawning is unavailable was only reachable from this button,
 * so hiding it hid the explanation too.
 */
function NewSessionButton({ available, onClick }: { available: boolean | undefined; onClick: () => void }) {
  const missing = available === false
  return (
    <button
      onClick={onClick}
      title={missing ? 'claude was not found on this machine — click for details' : 'start a session Caprock owns'}
      className={`shrink-0 rounded-[var(--radius-panel)] border px-3 py-2 text-[13px] leading-5 font-medium transition-colors ${
        missing
          ? 'border-border text-fg-faint hover:text-fg-muted'
          : 'border-accent/60 bg-accent/15 text-accent hover:bg-accent/25'
      }`}
    >
      + New session{missing ? ' (claude not found)' : ''}
    </button>
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
    <div data-testid="session-grid" className="mt-3 grid gap-2 gap-y-6">
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
        {s.agent && s.agent !== 'claude' && (
          <span className="text-[10px] uppercase tracking-[0.08em] text-fg-muted border border-border px-1 py-px rounded-sm">
            {s.agent}
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
