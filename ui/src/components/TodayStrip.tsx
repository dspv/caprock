/**
 * The sidebar's Today strip (.ai/21-app.md § What the user sees): today's
 * spend across every agent, how many agents run and how many wait on you,
 * and the Claude plan's 5-hour and weekly windows as thin bars with the
 * share used and when each resets. Each figure is a way in: spend opens
 * Cost, the windows open Cost's plan limits, running opens Now, waiting
 * opens the session that has waited longest.
 *
 * Built by lib/today.ts from the day's summary and the sidebar's model —
 * the figures the status strip and the cockpit already show. One the data
 * does not carry is left out (no windows on API billing) or shown as a dash
 * until it is known, never as a zero.
 */
import type { ReactNode } from 'react'
import { fmtUSD } from '@/lib/format'
import { countdown, resetClock } from '@/lib/limitclock'
import { useNow } from '@/lib/useNow'
import type { TodayModel, TodayWindow } from '@/lib/today'
import { fmtCostShort } from './ProjectRow'

export interface TodayStripProps {
  today: TodayModel
  /** The session list has answered: before it, the counts are not known. */
  loaded: boolean
  onSpend: () => void
  onWindows: () => void
  onRunning: () => void
  /** The longest-waiting session; absent when nothing waits. */
  onWaiting?: () => void
}

function fmtSpend(v: number): string {
  return v >= 1000 ? fmtCostShort(v) : fmtUSD(v)
}

export function TodayStrip({ today, loaded, onSpend, onWindows, onRunning, onWaiting }: TodayStripProps) {
  const now = useNow(30_000)
  const { spend, agents, working, waiting, windows } = today
  return (
    <section aria-label="Today" className="today-strip mb-2 rounded-[10px] border border-[var(--app-hairline)] px-1 pb-1 pt-1">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-stretch">
        <Cell
          label="Today"
          title={spend === undefined ? 'Spent today, every agent — not known yet' : `Spent today, every agent: ${fmtUSD(spend)}. Opens Cost.`}
          onClick={onSpend}
        >
          <span className="num block truncate text-[16px] font-semibold leading-none tracking-[-0.02em] text-fg">{spend === undefined ? '—' : fmtSpend(spend)}</span>
        </Cell>
        <Cell
          label="Running"
          title={loaded ? `${agents} ${agents === 1 ? 'agent' : 'agents'} running${working > 0 ? `, ${working} working` : ''}. Opens Now.` : 'Not known yet'}
          onClick={onRunning}
        >
          <span className="num inline-flex items-center gap-1 text-[14px] font-semibold leading-none text-fg">
            {loaded ? agents : '—'}
            {loaded && agents > 0 && (
              <span aria-hidden className={`today-dot inline-block h-[6px] w-[6px] rounded-full ${working > 0 ? 'bg-ok' : 'bg-fg-faint/70'}`} data-working={working > 0 ? 'true' : undefined} />
            )}
          </span>
        </Cell>
        <Cell
          label="Waiting"
          title={waiting > 0 ? `${waiting} waiting on you. Opens the one that has waited longest.` : 'Nothing is waiting on you'}
          onClick={onWaiting}
        >
          <span className={`num text-[14px] font-semibold leading-none ${waiting > 0 ? 'text-accent' : 'text-fg-faint'}`}>{loaded ? waiting : '—'}</span>
        </Cell>
      </div>
      {windows.length > 0 && (
        // One grid for both rows, so the bars start and end together however long each reset time reads.
        <div className="mt-0.5 grid grid-cols-[18px_minmax(0,1fr)_32px_auto] gap-x-2 gap-y-px">
          {windows.map((w) => <WindowRow key={w.label} w={w} now={now} onClick={onWindows} />)}
        </div>
      )}
    </section>
  )
}

function Cell({ label, title, onClick, children }: { label: string; title: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={!onClick}
      className="app-row grid min-w-0 content-start gap-[5px] rounded-[7px] px-1.5 py-1.5 text-left disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="text-[9.5px] font-semibold uppercase leading-none tracking-[0.08em] text-fg-faint">{label}</span>
      {children}
    </button>
  )
}

/** "14:20" within a day, "Tue 09:00" past it; the countdown in the tooltip. */
function WindowRow({ w, now, onClick }: { w: TodayWindow; now: number; onClick: () => void }) {
  const reset = w.resetMs !== undefined ? resetClock(w.resetMs, now) : ''
  const when = w.resetMs !== undefined ? `resets ${reset}, in ${countdown(w.resetMs - now)}` : w.stale ? 'reset time stale' : ''
  const title = `Claude ${w.name} window: ${w.pct}% used${when ? ` · ${when}` : ''}${w.forecast ? ` · ${w.forecast}` : ''} · every Claude Code session. Opens plan limits.`
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="app-row col-span-4 grid h-[22px] w-full grid-cols-subgrid items-center gap-x-2 rounded-[6px] px-1.5 text-left"
    >
      <span className="mono text-[10.5px] text-fg-faint">{w.label}</span>
      <span className="cockpit-track h-[4px] overflow-hidden rounded-full" role="meter" aria-label={`${w.name} window used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.pct}>
        <span className="cockpit-fill block h-full rounded-full" data-tone={w.tone} style={{ width: `${Math.max(2, Math.min(100, w.pct))}%` }} />
      </span>
      <span className={`num text-right text-[11.5px] font-medium ${w.tone === 'danger' ? 'text-danger' : w.tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{w.pct}%</span>
      <span className={`num whitespace-nowrap text-right text-[10.5px] ${w.forecast ? 'text-warn' : 'text-fg-faint'}`}>{w.resetMs !== undefined ? reset : w.stale ? 'stale' : ''}</span>
    </button>
  )
}
