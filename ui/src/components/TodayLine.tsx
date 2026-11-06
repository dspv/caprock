/**
 * The sidebar's Today line (owner and a designer, 2026-11-05, translated:
 * "the Today indicator isn't needed there — at least closable or shrunk to
 * a minimum"; mockup V1): one thin line above the footer —
 * "$X today · N running · ▬ 7d NN%" — and a small × that hides it. It
 * replaced the Today card at the top of the list (2026-10 to 2026-11-05:
 * spend, running, waiting and both plan windows as bars, foldable to one
 * line).
 *
 * Each figure is a way in, as the card's were: the spend opens Cost, the
 * running count opens Home, the window opens Cost's plan limits, and, while
 * anything waits on you, "N waiting" in amber opens the one that has waited
 * longest. The one window drawn is the fuller of the Claude plan's two (the
 * weekly one on a tie), so a 5-hour window near its end is never hidden
 * behind a calm week; both are in its tooltip. A figure the data does not
 * carry is left out (no window on API billing) or a dash until known.
 *
 * Hidden by its × (the viewer's, lib/todayCard.ts), it comes back from
 * Settings → Appearance or the sidebar's ⋯ menu. What waits on you stays in
 * sight without it: each Open row's amber *needs you* chip and each folded
 * project's "● N needs you".
 */
import { fmtUSD } from '@/lib/format'
import { countdown, resetClock } from '@/lib/limitclock'
import type { TodayModel, TodayWindow } from '@/lib/today'
import { fmtCostShort } from './ProjectRow'
import { CloseIcon } from './AppIcons'

export interface TodayLineProps {
  today: TodayModel
  /** The session list has answered: before it, the counts are not known. */
  loaded: boolean
  now: number
  onSpend: () => void
  onWindows: () => void
  onRunning: () => void
  /** The longest-waiting session; absent when nothing waits. */
  onWaiting?: () => void
  /** Hides the line; absent, no ×. */
  onHide?: () => void
}

function fmtSpend(v: number): string {
  return v >= 1000 ? fmtCostShort(v) : fmtUSD(v)
}

/** The window the line draws: the fuller one, the weekly one on a tie; none without a plan. */
export function lineWindow(windows: readonly TodayWindow[]): TodayWindow | undefined {
  let best: TodayWindow | undefined
  for (const w of windows) if (!best || w.pct > best.pct || (w.pct === best.pct && w.label === '7d')) best = w
  return best
}

function windowTitle(w: TodayWindow, now: number): string {
  const when = w.resetMs !== undefined ? `resets ${resetClock(w.resetMs, now)}, in ${countdown(w.resetMs - now)}` : w.stale ? 'reset time stale' : ''
  return `Claude ${w.name} window: ${w.pct}% used${when ? ` · ${when}` : ''}${w.forecast ? ` · ${w.forecast}` : ''}`
}

export function TodayLine({ today, loaded, now, onSpend, onWindows, onRunning, onWaiting, onHide }: TodayLineProps) {
  const { spend, agents, working, waiting, windows } = today
  const w = lineWindow(windows)
  const tone = (t: TodayWindow) => (t.tone === 'danger' ? 'text-danger' : t.tone === 'warn' ? 'text-warn' : 'text-fg-muted')
  const seg = 'shrink-0 rounded-[5px] px-1 hover:bg-[var(--app-row-hover)] hover:text-fg'
  const spendTitle = spend === undefined ? 'Spent today, every agent — not known yet' : `Spent today, every agent: ${fmtUSD(spend)}. Opens Cost.`
  const runningTitle = loaded ? `${agents} ${agents === 1 ? 'agent' : 'agents'} running${working > 0 ? `, ${working} working` : ''}. Opens Home.` : 'Running: not known yet'
  const waitingTitle = `${waiting} waiting on you. Opens the one that has waited longest.`
  return (
    <section
      aria-label="Today"
      data-today-line
      className="@container/today group/today flex h-[30px] shrink-0 items-center gap-1 border-t border-[var(--app-hairline)] pl-2 pr-1 text-[12px] text-fg-muted"
    >
      <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap tabular-nums">
        <button type="button" data-today-spend onClick={onSpend} className={seg} title={spendTitle} aria-label={spendTitle}>
          <span className="font-semibold text-fg">{spend === undefined ? '—' : fmtSpend(spend)}</span> today
        </button>
        <span aria-hidden className="text-fg-faint">·</span>
        <button type="button" data-today-running onClick={onRunning} className={`${seg} min-w-0 truncate`} title={runningTitle} aria-label={runningTitle}>
          {loaded ? agents : '—'} running
        </button>
        {loaded && waiting > 0 && (
          <>
            <span aria-hidden className="text-fg-faint">·</span>
            <button type="button" data-today-waiting onClick={onWaiting} disabled={!onWaiting}
              className={`${seg} font-semibold text-warn`}
              title={waitingTitle} aria-label={waitingTitle}>
              {waiting} waiting
            </button>
          </>
        )}
      </span>
      {w && (
        <button
          type="button"
          data-today-window={w.label}
          onClick={onWindows}
          title={`${windows.map((x) => windowTitle(x, now)).join('\n')}\nEvery Claude Code session. Opens plan limits.`}
          aria-label={`${w.name} window ${w.pct}% used. Opens plan limits.`}
          className="flex shrink-0 items-center gap-1.5 rounded-[5px] px-1 hover:bg-[var(--app-row-hover)]"
        >
          <span className="cockpit-track h-[4px] w-[36px] overflow-hidden rounded-full @max-[230px]/today:hidden" role="meter" aria-label={`${w.name} window used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.pct}>
            <span className="cockpit-fill block h-full rounded-full" data-tone={w.tone} style={{ width: `${Math.max(2, Math.min(100, w.pct))}%` }} />
          </span>
          <span className={`num whitespace-nowrap ${tone(w)}`}>{w.label} {w.pct}%</span>
        </button>
      )}
      {onHide && (
        <button
          type="button"
          data-today-hide
          aria-label="Hide the Today line"
          title="Hide. Settings → Appearance or the ⋯ menu above shows it again."
          onClick={onHide}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          <CloseIcon size={10} />
        </button>
      )}
    </section>
  )
}
