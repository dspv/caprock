/**
 * The status strip along the bottom of the app (.ai/21-app.md § What the user
 * sees): the connection, the plan limits, today's spend, and the terminal in
 * front. Read-only; each figure is the dashboard's own. The plan limits and
 * the spend show only while the sidebar is closed: open, its Today strip
 * carries them, and the same figures twice on one screen read as two.
 */
import type { Summary } from '@/lib/api'
import { live, useLiveLink } from '@/lib/live'
import { fmtUSD } from '@/lib/format'
import type { PaneStatus } from './TerminalPane'
import { ConnectionState } from './ConnectionState'
import { AppUpdateNotice } from './AppUpdateNotice'
import { StaleUiPill } from './StaleUiPill'
import { useAppUpdate } from '@/lib/appupdate'

export function StatusStrip({ summary, pane, version, figures = true }: {
  summary?: Summary
  pane?: PaneStatus
  version?: string
  /** The plan limits and today's spend; false while the sidebar shows them. */
  figures?: boolean
}) {
  const link = useLiveLink()
  // In the app, its own version: the one an update changes at once. The
  // daemon's follows within a minute of the move (AppShell asks again).
  const app = useAppUpdate()
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
      <ConnectionState link={link} heardAt={live.heardAt} />
      {five && <Limit label="5h" pct={five.used_percentage} />}
      {seven && <Limit label="7d" pct={seven.used_percentage} />}
      {figures && summary && (
        <span title="Spent today, every agent">
          Today <span className="num text-fg">{fmtUSD(summary.cost_usd)}</span>
        </span>
      )}
      <span className="ml-auto flex items-center gap-4">
        {pane && pane.status !== 'live' && (
          <span title="The terminal in front">{pane.status}</span>
        )}
        <StaleUiPill />
        <AppUpdateNotice />
        {(app?.version || version) && (
          <span className="mono text-fg-faint" title={versionTitle || undefined}>
            {app?.version || version}
          </span>
        )}
      </span>
    </footer>
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
