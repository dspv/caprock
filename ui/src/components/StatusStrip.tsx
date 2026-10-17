/**
 * The status strip along the bottom of the app (.ai/21-app.md § What the user
 * sees): the connection, the plan limits, today's spend, the terminal in
 * front, and a mark while Caprock keeps the computer awake. Read-only; each figure is the dashboard's own. The plan limits and
 * the spend show only while the sidebar is closed: open, its Today strip
 * carries them, and the same figures twice on one screen read as two.
 */
import { useState } from 'react'
import type { SessionSummary, Summary, UpdateStatus } from '@/lib/api'
import { useUpdateStatus } from './AppUpdateNotice'
import { live, useLiveLink } from '@/lib/live'
import { fmtUSD } from '@/lib/format'
import type { PaneStatus } from './TerminalPane'
import { ConnectionState } from './ConnectionState'
import { AppUpdateNotice } from './AppUpdateNotice'
import { StaleUiPill } from './StaleUiPill'
import { KeepAwakeIndicator } from './KeepAwake'
import { SessionLoad } from './ResourceMeter'
import { CaprockFootprint } from './FootprintPanel'
import { isPairedDevice } from '@/lib/api'
import { useAppUpdate } from '@/lib/appupdate'
import { VersionPanel } from './VersionPanel'
import { GitHubStatusDot } from './GitHubOutage'
import { SetupChip } from './SetupStrip'
import { PremiumChip } from './PremiumChip'
import { PremiumModal } from './PremiumModal'
import { useLicensed } from '@/lib/nudges'

export function StatusStrip({ summary, pane, session, version, figures = true, sessions, onOpenSession }: {
  summary?: Summary
  pane?: PaneStatus
  /** The agent session in the focused pane; absent for a shell or a file. */
  session?: SessionSummary
  version?: string
  /** The plan limits and today's spend; false while the sidebar shows them. */
  figures?: boolean
  /** Every session, for the resource popover's names; and how one's tab is brought forward. */
  sessions?: SessionSummary[]
  onOpenSession?: (id: string) => void
}) {
  const link = useLiveLink()
  // In the app, its own version: the one an update changes at once. The
  // daemon's follows within a minute of the move (AppShell asks again).
  const app = useAppUpdate()
  const polled = useUpdateStatus()
  const [checked, setStatus] = useState<UpdateStatus>()
  const status = checked ?? polled
  const shown = app?.version || version
  const five = figures ? summary?.rate_limits?.five_hour : undefined
  const seven = figures ? summary?.rate_limits?.seven_day : undefined
  // The front terminal's protocol and size are for debugging, not for
  // reading: "v2 · 167×36" beside the version was noise to the owner
  // (2026-10-09). They live in the version's tooltip.
  const term = pane ? `terminal protocol ${pane.protocol ?? 'unknown'} · ${pane.cols}×${pane.rows}` : ''
  const versionTitle = [
    app?.version && version && version !== app.version ? `The app ${app.version} · the daemon ${version}` : '',
    term,
  ].filter(Boolean).join('\n')
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 border-t border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] px-3 text-[11.5px] text-fg-muted">
      <ConnectionState link={link} heardAt={live.heardAt} onReconnect={() => live.reconnectNow()} />
      {five && <Limit label="5h" pct={five.used_percentage} />}
      {seven && <Limit label="7d" pct={seven.used_percentage} />}
      {/* Beside the limits only while one is close (PremiumHint's rule: an
        * offer appears beside the problem it solves, never on a quiet day). */}
      {Math.max(five?.used_percentage ?? 0, seven?.used_percentage ?? 0) >= WINDOW_HINT_PCT && <WindowStopHint />}
      {figures && summary && (
        <span className="whitespace-nowrap" title="Spent today, every agent">
          Today <span className="num text-fg">{fmtUSD(summary.cost_usd)}</span>
        </span>
      )}
      {/* The session in front, the figures you check while you work in its
        * terminal: the strip stood empty beside an open sidebar, and the
        * cockpit that carries them is often closed (owner, 2026-10-10). */}
      {session && <SessionFigures s={session} sessions={sessions} onOpenSession={onOpenSession} />}
      <span className="ml-auto flex items-center gap-4">
        {/* Caprock's own memory and disk, always: whether a slow machine
          * is Caprock is a question with or without a session in front. */}
        <CaprockFootprint owner={!isPairedDevice()} />
        {pane && pane.status !== 'live' && (
          <span title="The terminal in front">{pane.status}</span>
        )}
        {/* Only while Watch GitHub Status is ticked and GitHub reports an incident. */}
        <GitHubStatusDot />
        {/* The setup strip folded by its ×: "0 of 2", a click unfolds it. */}
        <SetupChip />
        {/* Only while the daemon holds the machine awake (ADR-049). */}
        <KeepAwakeIndicator />
        <StaleUiPill />
        <AppUpdateNotice />
        {/* The header's way to buy, at the strip's size: with a terminal in
          * front the header is not on screen (owner, 2026-10-17). */}
        <PremiumChip variant="strip" />
        {shown && <VersionPanel shown={shown} title={versionTitle} status={status} onStatus={setStatus} />}
      </span>
    </footer>
  )
}

/** How full a plan window is before the strip offers to pause before it: the bar's own warn tone. */
export const WINDOW_HINT_PCT = 70

/**
 * "pause before the limit": Premium's plan-window stop, offered while a
 * window is close and never to someone who has it. Opens the dialog on that
 * feature; quotes no price.
 */
function WindowStopHint() {
  const licensed = useLicensed()
  const [open, setOpen] = useState(false)
  if (licensed) return null
  return (
    <>
      <button
        type="button"
        data-window-hint
        onClick={() => setOpen(true)}
        title="Premium pauses the sessions Caprock started before a plan window runs out, and resumes them after it resets"
        className="whitespace-nowrap text-premium-strong underline-offset-2 hover:underline"
      >
        pause before the limit
      </button>
      {open && <PremiumModal feature="window" onClose={() => setOpen(false)} />}
    </>
  )
}

function Limit({ label, pct }: { label: string; pct: number }) {
  const v = Math.max(0, Math.min(100, pct))
  const tone = v >= 90 ? 'bg-danger' : v >= 70 ? 'bg-warn' : 'bg-fg-muted'
  return (
    <span className="inline-flex items-center gap-1.5" title={`Plan usage, ${label} window`}>
      {label}
      <span className="relative h-[4px] w-[38px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
        <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${v}%` }} />
      </span>
      {/* Rounded as Now and the menu bar round it (readWindow), so one figure never reads 41% here and 42% there. */}
      <span className="num text-fg">{Math.round(v)}%</span>
    </span>
  )
}

/** Model, how full the context is, what the next call costs, what the session has cost, and what its processes use. */
function SessionFigures({ s, sessions, onOpenSession }: { s: SessionSummary; sessions?: SessionSummary[]; onOpenSession?: (id: string) => void }) {
  const ctx = s.context
  const pct = ctx ? Math.max(0, Math.min(100, ctx.pct)) : 0
  const tone = pct >= 85 ? 'bg-danger' : pct >= 65 ? 'bg-warn' : 'bg-fg-muted'
  return (
    <span data-session-figures className="flex min-w-0 items-center gap-3 truncate">
      {s.model_display && <span className="truncate text-fg" title="The model of the session in front">{s.model_display}</span>}
      {ctx && (
        <span className="inline-flex items-center gap-1.5" title={`Context: ${Math.round(ctx.tokens / 1000)}k of ${Math.round(ctx.window / 1000)}k tokens`}>
          context
          <span className="relative h-[4px] w-[38px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
            <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="num text-fg">{Math.round(pct)}%</span>
        </span>
      )}
      {ctx && ctx.next_call_usd > 0 && (
        <span title="What the next call pays to re-read the context, before it does any work">
          next call <span className="num text-fg">{fmtUSD(ctx.next_call_usd)}</span>
        </span>
      )}
      <span title="What this session has cost at API list prices">
        session <span className="num text-fg">{fmtUSD(s.stats.cost_usd)}</span>
      </span>
      {/* Its processes' CPU and memory, from the resource meter: absent
        * until the daemon has measured them, and for a daemon without one. */}
      <SessionLoad sessionId={s.session_id} sessions={sessions} onOpenSession={onOpenSession} />
    </span>
  )
}
