/**
 * The status strip along the bottom of the app (.ai/21-app.md § What the user
 * sees): the connection, the plan limits, today's spend, and the terminal in
 * front. Read-only; each figure is the dashboard's own.
 */
import type { Summary } from '@/lib/api'
import { live, useLiveLink } from '@/lib/live'
import { fmtUSD } from '@/lib/format'
import type { PaneStatus } from './TerminalPane'
import { ConnectionState } from './ConnectionState'
import { AppUpdateNotice } from './AppUpdateNotice'
import { useAppUpdate } from '@/lib/appupdate'

export function StatusStrip({ summary, pane, version }: { summary?: Summary; pane?: PaneStatus; version?: string }) {
  const link = useLiveLink()
  // In the app, its own version: the one an update changes at once. The
  // daemon's follows within a minute of the move (AppShell asks again).
  const app = useAppUpdate()
  const five = summary?.rate_limits?.five_hour
  const seven = summary?.rate_limits?.seven_day
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 border-t border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] px-3 text-[11.5px] text-fg-muted">
      <ConnectionState link={link} heardAt={live.heardAt} />
      {five && <Limit label="5h" pct={five.used_percentage} />}
      {seven && <Limit label="7d" pct={seven.used_percentage} />}
      {summary && (
        <span title="Spent today, every agent">
          Today <span className="num text-fg">{fmtUSD(summary.cost_usd)}</span>
        </span>
      )}
      <span className="ml-auto flex items-center gap-4">
        {pane && (
          <span className="num" title="The terminal in front: protocol and size">
            {pane.status === 'live' ? '' : `${pane.status} · `}
            {pane.protocol ? `${pane.protocol} · ` : ''}{pane.cols}×{pane.rows}
          </span>
        )}
        <AppUpdateNotice />
        {(app?.version || version) && (
          <span className="mono text-fg-faint" title={app?.version && version && version !== app.version ? `The app ${app.version} · the daemon ${version}` : undefined}>
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
