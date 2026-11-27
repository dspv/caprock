/**
 * The sidebar's Today line (owner and a designer, 2026-11-05, translated:
 * "the Today indicator isn't needed there — at least closable or shrunk to
 * a minimum"; mockup V1): one thin line above the footer —
 * "$X today · N running · ▬ 7d NN%" — and a small × that hides it. It
 * replaced the Today card at the top of the list (2026-10 to 2026-11-05:
 * spend, running, waiting and both plan windows as bars, foldable to one
 * line).
 *
 * Since 2026-11-27 (owner, translated: "it doesn't fit; I'd show no figures
 * for today, just a noticeable, clear subscription progress bar") a plan
 * with a Claude window shows only that window: "<Weekly|5-hour> limit
 * ▬▬▬▬ NN%", the bar taking the width, opening Cost's plan limits. The
 * window drawn is the fuller of the two (the weekly one on a tie), so a
 * 5-hour window near its end is never hidden behind a calm week; both are
 * in its tooltip. Without a window (API billing, or before Claude Code
 * reports one) the line stays "$X today · N running", with "N waiting" in
 * amber while anything waits on you: spend opens Cost, running Home,
 * waiting the session that has waited longest; a dash until known.
 *
 * Hidden by its × (the viewer's, lib/todayCard.ts), it comes back from
 * Settings → Appearance or the sidebar's ⋯ menu. What waits on you stays in
 * sight without it: each Open row's amber *needs you* chip and each folded
 * project's "● N needs you".
 */
import type { Settings } from '@/lib/api'
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
  /** The stated plan: on a flat one the spend is named as work at API
   *  prices its plan covered, not money spent (components/PlanAsk). The line
   *  has no room to ask for an unstated plan; Home and Cost do. */
  plan?: Settings
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

export function TodayLine({ today, loaded, now, onSpend, onWindows, onRunning, onWaiting, onHide, plan }: TodayLineProps) {
  const { spend, agents, working, waiting, windows } = today
  const w = lineWindow(windows)
  const tone = (t: TodayWindow) => (t.tone === 'danger' ? 'text-danger' : t.tone === 'warn' ? 'text-warn' : 'text-fg-muted')
  const seg = 'shrink-0 rounded-[5px] px-1 hover:bg-[var(--app-row-hover)] hover:text-fg'
  const spendTitle = plan?.plan_kind === 'flat'
    ? spend === undefined ? 'Work at API prices today, every agent — not known yet' : `Work at API prices today, every agent: ${fmtUSD(spend)}. Claude Code work is covered by your ${plan.plan_label || 'flat'} plan. Opens Cost.`
    : spend === undefined ? 'Spent today, every agent — not known yet' : `Spent today, every agent: ${fmtUSD(spend)}. Opens Cost.`
  const runningTitle = loaded ? `${agents} ${agents === 1 ? 'agent' : 'agents'} running${working > 0 ? `, ${working} working` : ''}. Opens Home.` : 'Running: not known yet'
  const waitingTitle = `${waiting} waiting on you. Opens the one that has waited longest.`
  const hide = onHide && (
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
  )
  // With a plan window the line is that window alone, drawn wide (owner,
  // 2026-11-27, translated: "it doesn't fit; I'd show no figures for today,
  // just a noticeable, clear subscription progress bar"). Spend and running
  // stay on Home and Cost; what waits stays on its row and ⌘J.
  if (w) {
    const label = `${w.name} limit`
    return (
      <section
        aria-label="Today"
        data-today-line
        className="group/today flex h-[34px] shrink-0 items-center gap-1 border-t border-[var(--app-hairline)] pl-2 pr-1 text-[12px] text-fg-muted"
      >
        <button
          type="button"
          data-today-window={w.label}
          onClick={onWindows}
          title={`${windows.map((x) => windowTitle(x, now)).join('\n')}\nEvery Claude Code session. Opens plan limits.`}
          aria-label={`${w.name} window ${w.pct}% used. Opens plan limits.`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[5px] px-1 py-1 hover:bg-[var(--app-row-hover)]"
        >
          <span className="shrink-0 whitespace-nowrap">{label}</span>
          <span className="cockpit-track h-[6px] min-w-[40px] flex-1 overflow-hidden rounded-full" role="meter" aria-label={`${w.name} window used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.pct}>
            <span className="cockpit-fill block h-full rounded-full" data-tone={w.tone} style={{ width: `${Math.max(2, Math.min(100, w.pct))}%` }} />
          </span>
          <span className={`num shrink-0 whitespace-nowrap font-semibold ${tone(w)}`}>{w.pct}%</span>
        </button>
        {hide}
      </section>
    )
  }
  // No plan window (an API key, or before Claude Code reports one): spend and running, as before.
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
      {hide}
    </section>
  )
}
