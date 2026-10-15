/**
 * The app sidebar's bottom block (.ai/04-ui.md § App sidebar footer): Send
 * feedback, then one row of Dashboard with two square buttons beside it — the
 * Pipeline view's mode and the theme — then Settings.
 *
 * The Pipeline button (owner, 2026-10-14, translated: "it feels like quick
 * access to the CI/CD page is missing"): a click opens the Pipeline page as a
 * tab, or brings it to the front — and from it, back — as ⇧⌘B does. Until
 * then the button cycled the bar's modes (Hidden, Bar, Full page); the bar
 * now has its own × and ⌘B, and the page is just a tab.
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
 * Every key is drawn at the New agent chip's size (owner, 2026-10-15,
 * translated: "these buttons fold down; the shortcuts there are tiny, you
 * can't see a damn thing"). Where one does not fit — beside a row's words,
 * or over a folded icon — it is left out whole, measured (lib/keyChipFit),
 * and the key stays in the tooltip; it is never drawn smaller.
 */
import type { ReactNode, RefObject } from 'react'
import type { SettingsSection } from '@/lib/router'
import { THEME_MODE_NAME, useThemeMode } from '@/lib/theme'
import { THEMES } from '@/lib/themes'
import { keys } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { useChipFit, useFoldedChipFit } from '@/lib/keyChipFit'
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
  /** Opens the Pipeline page (⇧⌘B); absent, no Pipeline button. */
  onPipeline?: () => void
  /** The Pipeline tab is in front. */
  pipelineActive?: boolean
}

/** Mail's key, in macOS spelling; `keys()` writes it for this OS. */
export const MAIL_KEY = '⇧⌘M'

/** The Pipeline button's key, in macOS spelling. */
export const PIPELINE_KEY = '⇧⌘B'

/** Every button in the footer's icon rows: one size, one hover. */
const SQUARE = 'flex shrink-0 items-center justify-center text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none'
/** A labelled 32px row: Mail, Dashboard, the two halves under it, Settings. */
const ROW = 'app-row flex h-[32px] min-w-0 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg'
/** The folded row's icons: as wide as their column, 32px tall, never under 32px. */
const ICON = `${SQUARE} h-[32px] w-full min-w-[32px] rounded-[7px]`
/** The folded row's glyphs, one size up from the rows' 15 (owner,
 *  2026-10-14, translated: "the icons can be one size bigger"). */
const GLYPH = 18

/**
 * How the folded row draws its keys: above every icon, or above the one
 * under the pointer. A macOS chip at the New agent size is 32px (⌘0, ⌘,)
 * or 40px (⇧⌘F, ⇧⌘M, ⇧⌘B), so on a Mac a column widens to its chip and
 * all five fit the 260px sidebar; a narrower one leaves out the widest
 * first (useFoldedChipFit). Off macOS the same keys are Ctrl+Shift+M and
 * Ctrl+Alt+Shift+F, 63–141px, three columns wide: there a key shows on hover
 * and keyboard focus only.
 */
export function foldedKeys(isMac = isMacPlatform()): 'shown' | 'hover' {
  return isMac ? 'shown' : 'hover'
}

/**
 * Whether Pipeline and the theme share a row as two halves. A half is
 * 110–150px (sidebar 240–320): "Pipeline" (~50px) and the ⇧⌘B chip (40px)
 * do not both fit at 260, so there the half leaves the chip out, measured,
 * and keeps the words; the key stays in its tooltip. Off macOS the chip is
 * Ctrl+Alt+Shift+B, which has room on a full row, so there each of the two
 * takes a row of its own and keeps its chip.
 */
export function splitModeRow(isMac = isMacPlatform()): boolean {
  return isMac
}

export function SidebarFooter(props: SidebarFooterProps) {
  const toPhone = () => (props.onSettingsSection ? props.onSettingsSection('phone') : props.onSettings?.())
  const hasBar = !!props.onPipeline
  if (props.folded) return <FoldedFooter {...props} />
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
        <KeyRow
          data-mail-button
          aria-current={props.mailActive ? 'true' : undefined}
          aria-keyshortcuts={isMacPlatform() ? 'Shift+Meta+M' : 'Control+Shift+M'}
          title={`Mail: every inbox in one place (${keys(MAIL_KEY)})`}
          onClick={props.onMail}
          icon={<MailIcon size={15} className="shrink-0 text-accent" />}
          label="Mail"
          keyLabel={keys(MAIL_KEY)}
        />
      )}
      <KeyRow
        aria-current={props.dashboardActive ? 'true' : undefined}
        onClick={props.onDashboard}
        title={`The dashboard, where you left it (${keys('⌘0')}); again: Home, at its top`}
        icon={<DashboardIcon size={15} className="shrink-0 text-fg-muted" />}
        label="Dashboard"
        keyLabel={keys('⌘0')}
      />
      {/* Pipeline and the theme: two halves of one row, each with its name
        * (owner, 2026-10-14, translated: "move them onto a separate row and
        * split it into two parts — two buttons in one row, neat, so it's
        * clear what's there"). The theme on the right: its picker opens up
        * and to the left, over the main area (ThemeMenu keeps it whole).
        * Off macOS each takes a row (splitModeRow). */}
      <div data-mode-row className={`grid gap-1 ${split ? 'grid-cols-2' : 'grid-cols-[minmax(0,1fr)]'}`}>
        {hasBar && <PipelineButton active={props.pipelineActive} onClick={props.onPipeline!} labelled />}
        <ThemeButton className={`${ROW} w-full hover:bg-[var(--app-row-hover)]`} boxClassName="min-w-0" labelled />
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
      {props.onSettings && <SettingsRow onPhone={toPhone} onSettingsSection={props.onSettingsSection} />}
    </div>
  )
}

/** The class a key chip takes: drawn, or left out unseen but still measurable. */
function chipClass(fits: boolean): string {
  return `app-kbd-key shrink-0 ${fits ? '' : 'pointer-events-none invisible absolute right-2'}`
}

/** A labelled 32px row with its key at the end, left out when it does not fit. */
function KeyRow({ icon, label, keyLabel, ...rest }: { icon: ReactNode; label: string; keyLabel: string; title: string; onClick: () => void; 'aria-current'?: 'true'; 'aria-keyshortcuts'?: string; 'data-mail-button'?: boolean }) {
  const [ref, fits] = useChipFit<HTMLButtonElement>([keyLabel])
  return (
    <button ref={ref} type="button" data-nav-row {...rest} className={`${ROW} relative`}>
      {icon}
      <span data-key-label className="min-w-0 flex-1 truncate">{label}</span>
      <kbd data-key-chip data-dropped={fits ? undefined : ''} className={chipClass(fits)}>{keyLabel}</kbd>
    </button>
  )
}

/**
 * Settings as a row with its name, not a bare icon (owner, 2026-10-11,
 * translated: "I don't see Settings from here"). The words "phone" and
 * "Telegram" are links of their own, each landing on its section; the row
 * lands on the phone (owner, 2026-10-13). Buttons beside the row's button,
 * never inside it: a button in a button is invalid and one swallows the
 * other's click. They give way first; then the key is left out.
 */
function SettingsRow({ onPhone, onSettingsSection }: { onPhone: () => void; onSettingsSection?: (section: SettingsSection) => void }) {
  const [ref, fits] = useChipFit<HTMLDivElement>()
  return (
    <div ref={ref} className="app-row relative flex h-[32px] min-w-0 items-center gap-1 rounded-[8px] border border-[var(--app-hairline-strong)] pr-2 text-[13px] text-fg">
      <button
        type="button"
        data-nav-row
        onClick={onPhone}
        title={`Settings (${keys('⌘,')})`}
        className="flex h-full min-w-fit flex-1 items-center gap-2 rounded-[8px] pl-2 text-left"
      >
        <SettingsIcon size={15} className="shrink-0 text-fg-muted" />
        <span data-key-label className="flex-1 whitespace-nowrap">Settings</span>
      </button>
      {onSettingsSection && (
        <span data-key-give className="flex min-w-0 shrink items-center truncate text-[11px] text-fg-faint">
          <button type="button" onClick={onPhone} className="rounded-sm hover:text-accent hover:underline" title="Settings → Use on your phone">phone</button>
          <span aria-hidden>,&nbsp;</span>
          <button type="button" onClick={() => onSettingsSection('telegram')} className="rounded-sm hover:text-accent hover:underline" title="Settings → Telegram">Telegram</button>
        </span>
      )}
      <kbd data-key-chip data-dropped={fits ? undefined : ''} className={chipClass(fits)}>{keys('⌘,')}</kbd>
    </div>
  )
}

/**
 * The folded block: one row of icons with their keys above them (owner,
 * 2026-10-11, translated: "can this block fold and unfold"; 2026-10-14:
 * "I'd put the key combos above them"), the same actions and the way back.
 * On a Mac a column is as wide as its chip; the ones that do not fit are
 * left out, the widest first, and a row with none left draws no key line.
 */
function FoldedFooter(props: SidebarFooterProps) {
  const toPhone = () => (props.onSettingsSection ? props.onSettingsSection('phone') : props.onSettings?.())
  const hasBar = !!props.onPipeline
  const chips = foldedKeys()
  const slots: { key?: string; edge: 'left' | 'right'; node: ReactNode }[] = [
    { key: keys(FEEDBACK_KEY), edge: 'left', node: <FeedbackButton variant="icon" className={ICON} iconSize={GLYPH} /> },
    ...(props.onMail ? [{
      key: keys(MAIL_KEY), edge: 'left' as const,
      node: <IconButton label={`Mail (${keys(MAIL_KEY)})`} onClick={props.onMail}><MailIcon size={GLYPH} className="text-accent" /></IconButton>,
    }] : []),
    { key: keys('⌘0'), edge: 'left', node: <IconButton label={`Dashboard (${keys('⌘0')})`} onClick={props.onDashboard}><DashboardIcon size={GLYPH} /></IconButton> },
    ...(props.onSettings ? [{
      key: keys('⌘,'), edge: 'right' as const,
      node: <IconButton label={`Settings: phone, Telegram (${keys('⌘,')})`} onClick={toPhone}><SettingsIcon size={GLYPH} /></IconButton>,
    }] : []),
    ...(hasBar ? [{ key: keys(PIPELINE_KEY), edge: 'right' as const, node: <PipelineButton active={props.pipelineActive} onClick={props.onPipeline!} className={ICON} /> }] : []),
    // No key of its own. Opening rightwards: from here a leftward picker left the window.
    { edge: 'right', node: <ThemeButton className={ICON} boxClassName="w-full" align="left" /> },
  ]
  const [ref, fit] = useFoldedChipFit<HTMLDivElement>(slots.length, chips === 'shown')
  const anyShown = chips === 'shown' && slots.some((s, i) => s.key && fit[i] !== false)
  return (
    <div ref={ref as RefObject<HTMLDivElement>} data-sidebar-footer data-folded-keys={chips} className="flex shrink-0 items-end gap-0.5 border-t border-[var(--app-hairline)] px-1 pb-1.5 pt-1">
      {slots.map((s, i) => (
        <KeySlot key={i} keyLabel={s.key} chips={chips} edge={s.edge} fits={fit[i] !== false} line={anyShown}>{s.node}</KeySlot>
      ))}
      <FooterToggle open={false} onToggle={props.onToggleFold} />
    </div>
  )
}

/**
 * One column of the folded row: the key's chip, then the icon. `shown`: the
 * chip sits above the icon, and a column with no key keeps an empty slot of
 * the same height. `hover`: the chip floats above the column under the
 * pointer or focus, held to the `edge` side so it stays inside the sidebar.
 */
function KeySlot({ keyLabel, chips, edge, fits, line, children }: { keyLabel?: string; chips: 'shown' | 'hover'; edge: 'left' | 'right'; fits: boolean; line: boolean; children: ReactNode }) {
  return (
    <div data-key-slot className={`group relative flex max-w-[48px] flex-1 flex-col items-center ${chips === 'shown' && keyLabel && fits ? 'min-w-min' : 'min-w-[32px]'}`}>
      {chips === 'shown' ? (
        keyLabel ? (
          <kbd aria-hidden data-key-chip data-dropped={fits ? undefined : ''} className={fits ? 'app-kbd-key mb-[3px]' : 'app-kbd-key pointer-events-none invisible absolute bottom-full'}>{keyLabel}</kbd>
        ) : line ? (
          <kbd aria-hidden className="app-kbd-key invisible mb-[3px]">·</kbd>
        ) : null
      ) : keyLabel ? (
        <kbd aria-hidden className={`app-kbd-key app-kbd-float pointer-events-none invisible absolute bottom-[calc(100%+3px)] z-10 group-hover:visible group-focus-within:visible ${edge === 'left' ? 'left-0' : 'right-0'}`}>{keyLabel}</kbd>
      ) : null}
      {children}
    </div>
  )
}

/** What the Pipeline button's tooltip and name say. */
export function pipelineLabel(active?: boolean, isMac?: boolean): string {
  return active
    ? `Pipeline is in front — click to go back to the tab before it (${keys(PIPELINE_KEY, isMac)})`
    : `Pipeline: every pull request on its way — open, CI, merged, released — in a tab (${keys(PIPELINE_KEY, isMac)})`
}

/**
 * The Pipeline button. In a half of the split row (240–320px sidebar, a
 * half 110–150px) "Pipeline" and the ⇧⌘B chip need ~140px with the glyph:
 * at 260 the chip is left out and the key is in the tooltip; on a row of its
 * own (off macOS) the chip shows. Measured, not assumed.
 */
function PipelineButton({ active, onClick, className, labelled }: { active?: boolean; onClick: () => void; className?: string; labelled?: boolean }) {
  const label = pipelineLabel(active)
  const tone = active ? 'text-accent' : ''
  if (labelled) return <PipelineRow label={label} tone={tone} active={active} onClick={onClick} />
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

function PipelineRow({ label, tone, active, onClick }: { label: string; tone: string; active?: boolean; onClick: () => void }) {
  const [ref, fits] = useChipFit<HTMLButtonElement>()
  return (
    <button ref={ref} type="button" data-pipeline-button aria-current={active ? 'true' : undefined} title={label} aria-label={label} onClick={onClick} className={`${ROW} relative hover:bg-[var(--app-row-hover)]`}>
      <PipelineIcon size={15} className={`shrink-0 ${tone || 'text-fg-muted'}`} />
      <span data-key-label className="min-w-0 flex-1 truncate">Pipeline</span>
      <kbd data-key-chip data-dropped={fits ? undefined : ''} className={chipClass(fits)}>{keys(PIPELINE_KEY)}</kbd>
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
function ThemeButton({ className, boxClassName, align, labelled }: { className: string; boxClassName?: string; align?: 'left' | 'right'; labelled?: boolean }) {
  const { mode } = useThemeMode()
  const light = THEMES.find((t) => t.id === mode)?.theme === 'light'
  const size = labelled ? 15 : GLYPH
  const tone = labelled ? 'shrink-0 text-fg-muted' : undefined
  return (
    <ThemeMenu label={`Theme: ${THEME_MODE_NAME[mode]}`} placement="up" align={align} className={className} boxClassName={boxClassName}>
      {light ? <SunIcon size={size} className={tone} /> : <MoonIcon size={size} className={tone} />}
      {labelled && <span className="min-w-0 flex-1 truncate">{THEME_MODE_NAME[mode]}</span>}
    </ThemeMenu>
  )
}
