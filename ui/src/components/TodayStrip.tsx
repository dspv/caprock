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
 *
 * Three states, the viewer's (lib/todayCard.ts): the whole card; one line —
 * spend, running, what waits when anything does, and the 5h and 7d
 * percentages — by its chevron, unfolded by a click on the line; or hidden,
 * by the × that shows on hover or its menu (right-click, Shift+F10: Full
 * card, One line, Hide), until Settings → Appearance shows it again (a user,
 * 2026-10-15, translated: "can this be hidden? it's in the way"). No Share
 * button on it (owner, 2026-10-16, translated): sharing stays in ⌘K and on
 * Pipeline.
 */
import { useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { fmtUSD } from '@/lib/format'
import { countdown, resetClock } from '@/lib/limitclock'
import { useNow } from '@/lib/useNow'
import type { TodayModel, TodayWindow } from '@/lib/today'
import { fmtCostShort } from './ProjectRow'
import { PlanLimitNudge } from './Nudges'
import type { RateLimits } from '@/lib/api'
import { ChevronIcon, CloseIcon, DashboardIcon, EyeOffIcon, ListIcon } from './AppIcons'
import { MenuBox, MenuItem, type MenuAt } from './RowMenu'

export interface TodayStripProps {
  today: TodayModel
  /** The session list has answered: before it, the counts are not known. */
  loaded: boolean
  onSpend: () => void
  onWindows: () => void
  onRunning: () => void
  /** The longest-waiting session; absent when nothing waits. */
  onWaiting?: () => void
  /** Folded to one line by hand. */
  folded?: boolean
  /** Folds or unfolds it; absent, it does not fold. */
  onFold?: (folded: boolean) => void
  /** Hides the card (Settings → Appearance shows it again); absent, no such action. */
  onHide?: () => void
}

function fmtSpend(v: number): string {
  return v >= 1000 ? fmtCostShort(v) : fmtUSD(v)
}

export function TodayStrip({ today, loaded, onSpend, onWindows, onRunning, onWaiting, folded = false, onFold, onHide }: TodayStripProps) {
  const now = useNow(30_000)
  const { spend, agents, working, waiting, windows } = today
  const [menuAt, setMenuAt] = useState<(MenuAt & { from: HTMLElement | null }) | null>(null)
  const menuable = !!(onFold || onHide)
  const menuProps = menuable ? {
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY, from: e.target as HTMLElement }) },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault()
        const r = (e.target as HTMLElement).getBoundingClientRect()
        setMenuAt({ x: r.left, y: r.bottom + 2, from: e.target as HTMLElement })
      }
    },
  } : {}
  const closeMenu = () => {
    const from = menuAt?.from
    setMenuAt(null)
    if (from?.isConnected) requestAnimationFrame(() => { if (document.activeElement === document.body) from.focus() })
  }
  const pick = (fn: () => void) => () => { setMenuAt(null); fn() }
  const menu = menuAt && (
    <MenuBox at={menuAt} label="Today card" width={232} onClose={closeMenu}>
      {onFold && <MenuItem icon={<DashboardIcon size={14} />} label="Full card" hint={folded ? undefined : 'shown'} onClick={pick(() => onFold(false))} />}
      {onFold && <MenuItem icon={<ListIcon size={14} />} label="One line" hint={folded ? 'shown' : undefined} onClick={pick(() => onFold(true))} />}
      {onHide && <MenuItem icon={<EyeOffIcon size={14} />} label="Hide" hint="Settings shows it" onClick={pick(onHide)} />}
    </MenuBox>
  )
  // Hides the card. Shown on hover or focus only, so at rest it adds nothing.
  const close = onHide && (
    <button
      type="button"
      data-today-hide
      aria-label="Hide the Today card"
      title="Hide. Settings → Appearance shows it again."
      onClick={onHide}
      className="grid h-5 w-6 shrink-0 place-items-center rounded-[5px] text-fg-faint opacity-0 transition-opacity hover:bg-[var(--app-row-hover)] hover:text-fg focus-visible:opacity-100 group-hover/today:opacity-100 pointer-coarse:opacity-100"
    >
      <CloseIcon size={10} />
    </button>
  )
  if (folded) {
    const pctTone = (w: TodayWindow) => w.tone === 'danger' ? 'text-danger' : w.tone === 'warn' ? 'text-warn' : ''
    const head = spend === undefined ? '—' : fmtSpend(spend)
    const running = `${loaded ? agents : '—'} running`
    const waits = loaded && waiting > 0
    const line = [head, running, ...(waits ? [`${waiting} waiting`] : []), ...windows.map((w) => `${w.label} ${w.pct}%`)].join(' · ')
    return (
      <section aria-label="Today" data-today-folded className="today-strip group/today mb-2 flex items-center gap-0.5 rounded-[10px] border border-[var(--app-hairline)] p-1" {...menuProps}>
        <button
          type="button"
          data-today-unfold
          aria-expanded={false}
          aria-label={`Today: ${line}. Unfold the card.`}
          title={`${line}. Unfold. Right-click for full, one line or hidden.`}
          onClick={() => onFold?.(false)}
          className="app-row flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-[7px] px-1.5 text-left"
        >
          <span aria-hidden className="flex shrink-0 text-fg-muted"><ChevronIcon size={10} /></span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] tabular-nums text-fg-muted">
            <span className="font-semibold text-fg">{head}</span>
            {' · '}{running}
            {waits && <>{' · '}<span data-today-waiting className="font-semibold text-warn">{waiting} waiting</span></>}
            {windows.map((w) => <span key={w.label}>{' · '}<span data-today-window={w.label} className={pctTone(w)}>{w.label} {w.pct}%</span></span>)}
          </span>
        </button>
        {close}
        {menu}
      </section>
    )
  }
  // The windows as the plan-limit nudge reads them (components/Nudges.tsx).
  const limits: RateLimits = {}
  for (const w of windows) {
    const row = { used_percentage: w.pct, resets_at: 0 }
    if (w.label === '5h') limits.five_hour = row
    else limits.seven_day = row
  }
  return (
    <section aria-label="Today" className="today-strip group/today mb-2 rounded-[10px] border border-[var(--app-hairline)] px-1 pb-1 pt-1" {...menuProps}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-stretch">
        <Cell
          label="Today"
          title={spend === undefined ? 'Spent today, every agent — not known yet' : `Spent today, every agent: ${fmtUSD(spend)}. Opens Cost.`}
          onClick={onSpend}
        >
          <span className="num block truncate text-[16px] font-semibold leading-none tracking-[-0.02em] text-fg">{spend === undefined ? '—' : fmtSpend(spend)}</span>
        </Cell>
        <Cell
          label="Running"
          title={loaded ? `${agents} ${agents === 1 ? 'agent' : 'agents'} running${working > 0 ? `, ${working} working` : ''}. Opens Home.` : 'Not known yet'}
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
          <span className={`num text-[14px] font-semibold leading-none ${waiting > 0 ? 'text-warn' : 'text-fg-faint'}`}>{loaded ? waiting : '—'}</span>
        </Cell>
        <span className="flex flex-col items-center justify-between">
        {close || <span aria-hidden className="h-5 w-6" />}
        {/* Folds it to one line, as Second Brain's chevron folds that card. */}
        {onFold && (
          <button
            type="button"
            data-today-fold
            aria-expanded
            aria-label="Fold the Today card to one line"
            title="Fold to one line. Right-click for full, one line or hidden."
            onClick={() => onFold(true)}
            className="grid h-5 w-6 place-items-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
          >
            <span aria-hidden className="flex rotate-90"><ChevronIcon size={10} /></span>
          </button>
        )}
        </span>
      </div>
      {windows.length > 0 && (
        // One grid for both rows, so the bars start and end together however long each reset time reads.
        <div className="mt-0.5 grid grid-cols-[18px_minmax(0,1fr)_32px_auto] gap-x-2 gap-y-px">
          {windows.map((w) => <WindowRow key={w.label} w={w} now={now} onClick={onWindows} />)}
        </div>
      )}
      {windows.length > 0 && <PlanLimitNudge compact limits={limits} now={now} />}
      {menu}
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
