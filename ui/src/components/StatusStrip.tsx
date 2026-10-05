/**
 * The status strip along the bottom of the app (.ai/21-app.md § What the user
 * sees): the connection, the plan limits, today's spend, and the terminal in
 * front. Read-only; each figure is the dashboard's own.
 */
import type { Summary } from '@/lib/api'
import { useLiveConn } from '@/lib/live'
import { fmtUSD } from '@/lib/format'
import type { PaneStatus } from './TerminalPane'

export function StatusStrip({ summary, pane, version }: { summary?: Summary; pane?: PaneStatus; version?: string }) {
  const conn = useLiveConn()
  const five = summary?.rate_limits?.five_hour
  const seven = summary?.rate_limits?.seven_day
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 border-t border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] px-3 text-[11.5px] text-fg-muted">
      <span className="inline-flex items-center gap-1.5" title="The daemon's live socket">
        <span className={`h-[6px] w-[6px] rounded-full ${conn === 'open' ? 'bg-ok' : conn === 'connecting' ? 'bg-warn' : 'bg-danger'}`} />
        {conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : 'Daemon unreachable — reconnecting'}
      </span>
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
        {version && <span className="mono text-fg-faint">{version}</span>}
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
      <span className="num text-fg">{Math.floor(v)}%</span>
    </span>
  )
}
