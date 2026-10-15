/**
 * The app sidebar's bottom block (.ai/04-ui.md § App sidebar footer): Send
 * feedback, then one row of Dashboard with two square buttons beside it — the
 * Pipeline view's mode and the theme — then Settings.
 *
 * The Pipeline button (owner, 2026-10-14, translated: "it feels like quick
 * access to the CI/CD page is missing"): a click opens the Pipeline page — on
 * the dashboard since 2026-10-15 — and from it, back — as ⌘P does. Until
 * then the button cycled the bar's modes (Hidden, Bar, Full page); the bar
 * now has its own × and ⌘B.
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
 *
 * Its keys are named after what they open (owner, 2026-10-15, translated:
 * "bind shortcuts to the names"): Dashboard ⌘D (⌘0 still works), Pipeline
 * ⌘P (⇧⌘B before), the theme ⇧⌘T, which opens the picker from this button.
 */
import type { ReactNode } from 'react'
import type { SettingsSection } from '@/lib/router'
import { THEME_MODE_NAME, useThemeMode } from '@/lib/theme'
import { THEMES } from '@/lib/themes'
import { DASHBOARD_KEY, PIPELINE_KEY, THEME_KEY, THEME_MENU_EVENT, keys } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { ThemeMenu } from './ThemePicker'
import { FEEDBACK_KEY, FeedbackButton } from './Feedback'
import { ChevronIcon, PipelineIcon, DashboardIcon, MailIcon, MoonIcon, SettingsIcon, SunIcon } from './AppIcons'

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
  /** Opens the Pipeline page (⌘P); absent, no Pipeline button. */
  onPipeline?: () => void
  /** The Pipeline tab is in front. */
  pipelineActive?: boolean
}

/** Mail's key, in macOS spelling; `keys()` writes it for this OS. */
export const MAIL_KEY = '⇧⌘M'

export { DASHBOARD_KEY, PIPELINE_KEY, THEME_KEY }

/** Every button in the footer's icon rows: one size, one hover. */
const SQUARE = 'flex shrink-0 items-center justify-center text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none'
/** A labelled 32px row: Mail, Dashboard, the two halves under it, Settings. */
const ROW = 'app-row flex h-[32px] min-w-0 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg'
/**
 * A row whose key chip shows only where it fits whole: the row wraps, its
 * first line is 30px, and a chip pushed onto a second line is clipped. The
 * name keeps its width (never truncated for the chip); the key stays in the
 * tooltip. A half of the split row is 110–150px (sidebar 240–320): *Pipeline*
 * and ⌘P fit from about 250px, the palette's name and ⇧⌘T only where the
 * name is short (Book, Light).
 */
const FIT_ROW = ROW.replace('gap-2', 'flex-wrap content-start gap-x-1.5 gap-y-0 overflow-hidden')
const FIT_NAME = 'min-w-0 flex-none truncate leading-[30px]'
/** The chip: a tab's compact key in a half (a full key fits a half only
 *  from about 300px of sidebar), the full key on a row of its own. */
const fitChip = (half?: boolean) => `${half ? 'app-kbd-sm' : 'app-kbd-key'} ml-auto shrink-0 self-center`

/** The folded row's icons: as wide as their column, 32px tall. */
const ICON = `${SQUARE} h-[32px] w-full rounded-[7px]`
/** The folded row's glyphs, one size up from the rows' 15 (owner,
 *  2026-10-14, translated: "the icons can be one size bigger"). */
const GLYPH = 18

/**
 * How the folded row draws its keys: above every icon, or above the one
 * under the pointer. Measured at the 260px sidebar (240–320 checked): a
 * column is 33–44px and a macOS chip (⇧⌘M, ⌘,) 26–30px, so on a Mac every
 * key fits over its icon. Off macOS the same keys are Ctrl+Shift+M and
 * Ctrl+Alt+Shift+F, 75–105px, three columns wide: there a key shows on hover
 * and keyboard focus only.
 */
export function foldedKeys(isMac = isMacPlatform()): 'shown' | 'hover' {
  return isMac ? 'shown' : 'hover'
}

/**
 * Whether Pipeline and the theme share a row as two halves. A half is
 * 110–150px (sidebar 240–320), where a chip shows only when it fits whole
 * beside the name (FIT_ROW). Off macOS the chips are Ctrl+Shift+P and
 * Ctrl+Alt+Shift+T, so there each of the two takes a row of its own.
 */
export function splitModeRow(isMac = isMacPlatform()): boolean {
  return isMac
}

export function SidebarFooter(props: SidebarFooterProps) {
  const toPhone = () => (props.onSettingsSection ? props.onSettingsSection('phone') : props.onSettings?.())
  const hasBar = !!props.onPipeline
  if (props.folded) {
    const chips = foldedKeys()
    return (
      /* Collapsed (owner, 2026-10-11, translated: "can this block fold and
       * unfold"): the same actions as icons, plus the way back. Each icon has
       * its key above it (owner, 2026-10-14, translated: "I'd put the key
       * combos above them"). */
      <div data-sidebar-footer data-folded-keys={chips} className="flex shrink-0 items-end gap-0.5 border-t border-[var(--app-hairline)] px-1.5 pb-1.5 pt-1">
        <KeySlot keyLabel={keys(FEEDBACK_KEY)} chips={chips} edge="left">
          <FeedbackButton variant="icon" className={ICON} iconSize={GLYPH} />
        </KeySlot>
        {props.onMail && (
          <KeySlot keyLabel={keys(MAIL_KEY)} chips={chips} edge="left">
            <IconButton label={`Mail (${keys(MAIL_KEY)})`} onClick={props.onMail}>
              <MailIcon size={GLYPH} className="text-accent" />
            </IconButton>
          </KeySlot>
        )}
        <KeySlot keyLabel={keys(DASHBOARD_KEY)} chips={chips} edge="left">
          <IconButton label={`Dashboard (${keys(DASHBOARD_KEY)})`} onClick={props.onDashboard}>
            <DashboardIcon size={GLYPH} />
          </IconButton>
        </KeySlot>
        {props.onSettings && (
          <KeySlot keyLabel={keys('⌘,')} chips={chips} edge="right">
            <IconButton label={`Settings: phone, Telegram (${keys('⌘,')})`} onClick={toPhone}>
              <SettingsIcon size={GLYPH} />
            </IconButton>
          </KeySlot>
        )}
        {hasBar && (
          <KeySlot keyLabel={keys(PIPELINE_KEY)} chips={chips} edge="right">
            <PipelineButton active={props.pipelineActive} onClick={props.onPipeline!} className={ICON} />
          </KeySlot>
        )}
        {/* Opening rightwards: from here a leftward picker left the window. */}
        <KeySlot keyLabel={keys(THEME_KEY)} chips={chips} edge="right">
          <ThemeButton className={ICON} boxClassName="w-full" align="left" />
        </KeySlot>
        <FooterToggle open={false} onToggle={props.onToggleFold} />
      </div>
    )
  }
  const split = splitModeRow() && hasBar
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
          className={ROW}
        >
          <MailIcon size={15} className="text-accent" />
          <span className="min-w-0 flex-1 truncate">Mail</span>
          <kbd className="app-kbd-key shrink-0">{keys(MAIL_KEY)}</kbd>
        </button>
      )}
      <button
        type="button"
        data-nav-row
        aria-current={props.dashboardActive ? 'true' : undefined}
        onClick={props.onDashboard}
        title={`The dashboard, where you left it (${keys(DASHBOARD_KEY)}, or ${keys('⌘0')}); again: Home, at its top`}
        className={ROW}
      >
        <DashboardIcon size={15} className="text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">Dashboard</span>
        <kbd className="app-kbd-key shrink-0">{keys(DASHBOARD_KEY)}</kbd>
      </button>
      {/* Pipeline and the theme: two halves of one row, each with its name
        * (owner, 2026-10-14, translated: "move them onto a separate row and
        * split it into two parts — two buttons in one row, neat, so it's
        * clear what's there"). The theme on the right: its picker opens up
        * and to the left, and from the left half it would leave the sidebar.
        * Off macOS each takes a row (splitModeRow). */}
      <div data-mode-row className={`grid gap-1 ${split ? 'grid-cols-2' : 'grid-cols-[minmax(0,1fr)]'}`}>
        {hasBar && <PipelineButton active={props.pipelineActive} onClick={props.onPipeline!} labelled half={split} />}
        <ThemeButton className={`${FIT_ROW} w-full hover:bg-[var(--app-row-hover)]`} boxClassName="min-w-0" labelled half={split} />
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
            className="flex h-full min-w-fit flex-1 items-center gap-2 rounded-[8px] pl-2 text-left"
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
          <kbd className="app-kbd shrink-0">{keys('⌘,')}</kbd>
        </div>
      )}
    </div>
  )
}

/**
 * One column of the folded row: the key's chip, then the icon. `shown`: the
 * chip sits above the icon, and a column with no key keeps an empty slot of
 * the same height. `hover`: the chip floats above the column under the
 * pointer or focus, held to the `edge` side so it stays inside the sidebar.
 */
function KeySlot({ keyLabel, chips, edge, children }: { keyLabel?: string; chips: 'shown' | 'hover'; edge: 'left' | 'right'; children: ReactNode }) {
  return (
    <div data-key-slot className="group relative flex min-w-[32px] max-w-[44px] flex-1 flex-col items-center">
      {chips === 'shown' ? (
        <kbd aria-hidden className={`app-kbd-faint mb-[3px] ${keyLabel ? '' : 'invisible'}`}>{keyLabel ?? '·'}</kbd>
      ) : keyLabel ? (
        <kbd aria-hidden className={`app-kbd-faint app-kbd-float pointer-events-none invisible absolute bottom-[calc(100%+3px)] z-10 group-hover:visible group-focus-within:visible ${edge === 'left' ? 'left-0' : 'right-0'}`}>{keyLabel}</kbd>
      ) : null}
      {children}
    </div>
  )
}

/** What the Pipeline button's tooltip and name say. */
export function pipelineLabel(active?: boolean, isMac?: boolean): string {
  return active
    ? `Pipeline is in front — click to go back to where you were (${keys(PIPELINE_KEY, isMac)})`
    : `Pipeline: every pull request on its way — open, CI, merged, released — on the dashboard (${keys(PIPELINE_KEY, isMac)})`
}

/**
 * The Pipeline button. Labelled, its ⌘P chip shows where it fits whole
 * beside the word (FIT_ROW); where it does not, the key is in the tooltip.
 */
function PipelineButton({ active, onClick, className, labelled, half }: { active?: boolean; onClick: () => void; className?: string; labelled?: boolean; half?: boolean }) {
  const label = pipelineLabel(active)
  const tone = active ? 'text-accent' : ''
  if (labelled) {
    return (
      <button type="button" data-pipeline-button aria-current={active ? 'true' : undefined} title={label} aria-label={label} onClick={onClick} className={`${FIT_ROW} hover:bg-[var(--app-row-hover)]`}>
        <PipelineIcon size={15} className={`shrink-0 self-center ${tone || 'text-fg-muted'}`} />
        <span className={FIT_NAME}>Pipeline</span>
        <kbd className={fitChip(half)}>{keys(PIPELINE_KEY)}</kbd>
      </button>
    )
  }
  return (
    <button
      type="button"
      data-pipeline-button
      aria-current={active ? 'true' : undefined}
      title={label}
      aria-label={label}
      onClick={onClick}
      className={tone ? `${className!.replace('text-fg-muted', '').replace('hover:text-fg ', '')} ${tone}` : className}
    >
      <PipelineIcon size={GLYPH} />
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
      className={`flex ${open ? 'h-[26px] w-[26px]' : 'h-[32px] w-[22px]'} shrink-0 items-center justify-center rounded-[6px] text-fg-faint transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none`}
    >
      <span className={`flex transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : '-rotate-90'}`} aria-hidden>
        <ChevronIcon size={11} />
      </span>
    </button>
  )
}

/** Opens the theme picker: hover a palette to try it, click to keep it.
 *  `labelled`: the palette's name beside the sun or moon. */
function ThemeButton({ className, boxClassName, align, labelled, half }: { className: string; boxClassName?: string; align?: 'left' | 'right'; labelled?: boolean; half?: boolean }) {
  const { mode } = useThemeMode()
  const light = THEMES.find((t) => t.id === mode)?.theme === 'light'
  const size = labelled ? 15 : GLYPH
  const tone = labelled ? 'shrink-0 self-center text-fg-muted' : undefined
  return (
    <ThemeMenu label={`Theme: ${THEME_MODE_NAME[mode]} (${keys(THEME_KEY)})`} placement="up" align={align} className={className} boxClassName={boxClassName} openOn={THEME_MENU_EVENT}>
      {light ? <SunIcon size={size} className={tone} /> : <MoonIcon size={size} className={tone} />}
      {labelled && <span className={FIT_NAME}>{THEME_MODE_NAME[mode]}</span>}
      {labelled && <kbd aria-hidden className={fitChip(half)}>{keys(THEME_KEY)}</kbd>}
    </ThemeMenu>
  )
}
