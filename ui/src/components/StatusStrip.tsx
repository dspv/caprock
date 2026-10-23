/**
 * The status strip along the bottom of the app (.ai/21-app.md § What the user
 * sees): service things only — the connection, the plan limits, the
 * machine's and Caprock's load, the terminal in front, a mark while Caprock
 * keeps the computer awake, the update, the plan and the version. Read-only.
 * The plan limits show only while the sidebar is closed: open, its Today
 * strip carries them, and the same figures twice on one screen read as two.
 */
import { useState } from 'react'
import type { SessionSummary, Summary, UpdateStatus } from '@/lib/api'
import { useUpdateStatus } from './AppUpdateNotice'
import { live, useLiveLink } from '@/lib/live'
import type { PaneStatus } from './TerminalPane'
import { ConnectionState } from './ConnectionState'
import { AppUpdateNotice } from './AppUpdateNotice'
import { StaleUiPill } from './StaleUiPill'
import { KeepAwakeIndicator } from './KeepAwake'
import { SessionLoad } from './ResourceMeter'
import { MemoryBar } from './MemoryBar'
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
  /** The agent session in the focused pane, for its processes' load; absent for a shell or a file. */
  session?: SessionSummary
  version?: string
  /** The plan limits; false while the sidebar shows them. */
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
      {/* The session in front: its processes' CPU and memory only. Its model,
        * context, next-call price and cost, and today's spend, left the strip
        * (owner, 2026-10-23: the bottom bar holds service things; the cockpit
        * carries those figures). */}
      {session && <SessionLoad sessionId={session.session_id} sessions={sessions} onOpenSession={onOpenSession} />}
      <span className="ml-auto flex shrink-0 items-center gap-4">
        {/* Caprock's own memory and disk, always: whether a slow machine
          * is Caprock is a question with or without a session in front. */}
        {/* The machine's memory, always: a Mac froze with agents holding
          * all of it while the strip said only the front agent's share. */}
        <MemoryBar owner={!isPairedDevice()} sessions={sessions} onOpenSession={onOpenSession} />
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
