/**
 * The app sidebar's bottom block (.ai/04-ui.md § App sidebar footer): Send
 * feedback, then one row of Dashboard with two square buttons beside it — the
 * PRs & CI view's mode and the theme — then Settings.
 *
 * The PRs & CI button (owner, 2026-10-14, translated: "the CI/CD window — the
 * bottom bar, and its separate full page — could hide behind one button with
 * the bar's modes … Expand/Hide inside the bar is not noticeable; bottom-left
 * in the sidebar is where it's handy"): its glyph is the mode on screen,
 * Hidden, Bar or Full page, and a click moves to the next. It owns no state:
 * the mode is AppShell's, read from the deck's switch (⌘B) and the tab in
 * front (⇧⌘B), and the click runs the same actions those keys do.
 *
 * The theme button moved here from the Settings row, as its own square: the
 * Dashboard row gave up the width (same request).
 *
 * Mail has a row of its own above Dashboard (owner, 2026-10-14, translated:
 * "put it on the main screen as a button — in the left bottom too — and it
 * opens another system tab with its own key combo"): the envelope, *Mail*,
 * ⇧⌘M. It opens the Mail tab, or brings it to the front.
 *
 * Collapsed, the block is one row of icons, the same actions and the way back.
 */
import type { ReactNode } from 'react'
import type { SettingsSection } from '@/lib/router'
import { THEME_MODE_NAME, useThemeMode } from '@/lib/theme'
import { THEMES } from '@/lib/themes'
import { keys } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { BAR_MODE_NAME, nextBarMode, type BarMode } from '@/lib/deck'
import { ThemeMenu } from './ThemePicker'
import { FeedbackButton } from './Feedback'
import { BarModeIcon, ChevronIcon, DashboardIcon, MailIcon, MoonIcon, SettingsIcon, SunIcon } from './AppIcons'

export interface SidebarFooterProps {
  /** Folded to one row of icons; remembered by the sidebar. */
  folded: boolean
  onToggleFold: () => void
  dashboardActive: boolean
  onDashboard: () => void
  /** Mail in its own tab (⇧⌘M); absent, no Mail row. */
  onMail?: () => void
  /** The Mail tab is in front. */
  mailActive?: boolean
  onSettings?: () => void
  /** Settings on the phone or Telegram section; absent: plain Settings. */
  onSettingsSection?: (section: SettingsSection) => void
  /** The PRs & CI view's mode on screen; with `onCycleBar`, the button shows. */
  barMode?: BarMode
  onCycleBar?: () => void
}

/** Mail's key, in macOS spelling; `keys()` writes it for this OS. */
export const MAIL_KEY = '⇧⌘M'

/** Every button in the footer's icon rows: one size, one hover. */
const SQUARE = 'flex shrink-0 items-center justify-center text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none'
/** The 32px squares beside the Dashboard row: its height and its outline. */
const ROW_SQUARE = `${SQUARE} app-row h-[32px] w-[32px] rounded-[8px] border border-[var(--app-hairline-strong)]`
/** The 26px icons of the folded row. */
const ICON = `${SQUARE} h-[26px] w-[26px] rounded-[6px]`

export function SidebarFooter(props: SidebarFooterProps) {
  const toPhone = () => (props.onSettingsSection ? props.onSettingsSection('phone') : props.onSettings?.())
  const bar = props.barMode && props.onCycleBar
    ? <BarModeButton mode={props.barMode} onCycle={props.onCycleBar} className={props.folded ? ICON : ROW_SQUARE} />
    : null
  if (props.folded) {
    return (
      /* Collapsed (owner, 2026-10-11, translated: "can this block fold and
       * unfold"): the same actions as icons, plus the way back. */
      <div data-sidebar-footer className="flex shrink-0 items-center gap-1 border-t border-[var(--app-hairline)] px-2 py-1.5">
        <FeedbackButton variant="icon" />
        {props.onMail && (
          <IconButton label={`Mail (${keys(MAIL_KEY)})`} onClick={props.onMail}>
            <MailIcon size={15} className="text-accent" />
          </IconButton>
        )}
        <IconButton label={`Dashboard (${keys('⌘0')})`} onClick={props.onDashboard}>
          <DashboardIcon size={15} />
        </IconButton>
        {props.onSettings && (
          <IconButton label={`Settings: phone, Telegram (${keys('⌘,')})`} onClick={toPhone}>
            <SettingsIcon size={15} />
          </IconButton>
        )}
        {bar}
        {/* Opening rightwards: from here a leftward picker left the window. */}
        <ThemeButton className={ICON} align="left" />
        <span className="flex-1" />
        <FooterToggle open={false} onToggle={props.onToggleFold} />
      </div>
    )
  }
  return (
    <div data-sidebar-footer className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-1.5 border-t border-[var(--app-hairline)] px-2 py-2">
      {/* Feedback on a labelled row of its own: on screen whatever tab is in
        * front, where the header's button is only on the dashboard. As a bare
        * icon beside Settings and the theme switch it read as a volume
        * control. */}
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1"><FeedbackButton variant="row" /></div>
        <FooterToggle open onToggle={props.onToggleFold} />
      </div>
      {props.onMail && (
        <button
          type="button"
          data-nav-row
          data-mail-button
          aria-current={props.mailActive ? 'true' : undefined}
          aria-keyshortcuts={isMacPlatform() ? 'Shift+Meta+M' : 'Control+Shift+M'}
          title={`Mail: every inbox in one place (${keys(MAIL_KEY)})`}
          onClick={props.onMail}
          className="app-row flex h-[32px] min-w-0 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg"
        >
          <MailIcon size={15} className="text-accent" />
          <span className="min-w-0 flex-1 truncate">Mail</span>
          <kbd className="app-kbd-key shrink-0">{keys(MAIL_KEY)}</kbd>
        </button>
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-nav-row
          aria-current={props.dashboardActive ? 'true' : undefined}
          onClick={props.onDashboard}
          className="app-row flex h-[32px] min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg"
        >
          <DashboardIcon size={15} className="text-fg-muted" />
          <span className="min-w-0 flex-1 truncate">Dashboard</span>
          <kbd className="app-kbd-key shrink-0">{keys('⌘0')}</kbd>
        </button>
        {/* The theme last, at the edge: its picker opens up and to the
          * left of it, and anywhere further in it would leave the sidebar. */}
        {bar}
        <ThemeButton className={ROW_SQUARE} />
      </div>
      {/* Settings as a row with its name, not a bare icon (owner, 2026-10-11,
        * translated: "I don't see Settings from here"). Phone, Telegram and
        * subscriptions are set up there. */}
      {/* The words "phone" and "Telegram" are links of their own, each
        * landing on its section; the row lands on the phone (owner,
        * 2026-10-13, translated: "I go in there and don't understand where
        * phone and Telegram are"). Buttons beside the row's button, never
        * inside it: a button in a button is invalid and one swallows the
        * other's click. */}
      {props.onSettings && (
        <div className="app-row relative flex h-[32px] min-w-0 items-center gap-1 rounded-[8px] border border-[var(--app-hairline-strong)] pr-2 text-[13px] text-fg">
          <button
            type="button"
            data-nav-row
            onClick={toPhone}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[8px] pl-2 text-left"
          >
            <SettingsIcon size={15} className="text-fg-muted" />
            <span className="flex-1">Settings</span>
          </button>
          {props.onSettingsSection && (
            <span className="flex min-w-0 shrink items-center truncate text-[11px] text-fg-faint">
              <button type="button" onClick={toPhone} className="rounded-sm hover:text-accent hover:underline" title="Settings → Use on your phone">phone</button>
              <span aria-hidden>,&nbsp;</span>
              <button type="button" onClick={() => props.onSettingsSection?.('telegram')} className="rounded-sm hover:text-accent hover:underline" title="Settings → Telegram">Telegram</button>
            </span>
          )}
          <kbd className="app-kbd">{keys('⌘,')}</kbd>
        </div>
      )}
    </div>
  )
}

/** What the button's tooltip and name say: the mode, what a click does, the keys. */
export function barModeLabel(mode: BarMode, isMac?: boolean): string {
  const next = BAR_MODE_NAME[nextBarMode(mode)]
  return `PRs & CI: ${BAR_MODE_NAME[mode]} — click for ${next} (${keys('⌘B', isMac)} shows or hides the bar, ${keys('⇧⌘B', isMac)} the full page)`
}

function BarModeButton({ mode, onCycle, className }: { mode: BarMode; onCycle: () => void; className: string }) {
  const label = barModeLabel(mode)
  return (
    <button
      type="button"
      data-bar-mode={mode}
      title={label}
      aria-label={label}
      onClick={onCycle}
      className={mode === 'hidden' ? className : `${className.replace('text-fg-muted', '').replace('hover:text-fg ', '')} text-accent`}
    >
      <BarModeIcon mode={mode} size={15} />
    </button>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={ICON}>
      {children}
    </button>
  )
}

/** Folds the bottom block to one row of icons and back; remembered. */
function FooterToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      title={open ? 'Collapse to icons' : 'Expand'}
      aria-label={open ? 'Collapse to icons' : 'Expand'}
      onClick={onToggle}
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] text-fg-faint transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none"
    >
      <span className={`flex transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : '-rotate-90'}`} aria-hidden>
        <ChevronIcon size={11} />
      </span>
    </button>
  )
}

/** Opens the theme picker: hover a palette to try it, click to keep it. */
function ThemeButton({ className, align }: { className: string; align?: 'left' | 'right' }) {
  const { mode } = useThemeMode()
  const light = THEMES.find((t) => t.id === mode)?.theme === 'light'
  return (
    <ThemeMenu label={`Theme: ${THEME_MODE_NAME[mode]}`} placement="up" align={align} className={className}>
      {light ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </ThemeMenu>
  )
}
