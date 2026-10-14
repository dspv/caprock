/**
 * The one tab strip — every open tab of every project, each with its
 * project's chip, behind a pinned Dashboard tab when that is open — and every
 * open terminal behind it (WP-04). A tab never leaves the strip because
 * another project was picked. Its name is the one the sidebar gives it under
 * its project (lib/tablabels.ts). Terminals of
 * every project stay mounted — switching a tab or a project shows one that
 * is already painted — and each pane tree renders
 * through one recursive view: a split tab (F15) shows its panes side by side
 * or stacked, each with a header, behind dividers that drag or take arrows.
 */
import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@/lib/api'
import { ownTab, type PaneLeaf, type PaneNode, type PaneSplit, type Tab } from '@/lib/tabs'
import { dotOf, sessionAbout, sessionTitle } from '@/lib/sidebar'
import { renamable } from '@/lib/sessionNames'
import { InlineRename } from './InlineRename'
import { tabLabels, type TabLabel } from '@/lib/tablabels'
import { TerminalPane, type PaneComposer, type PaneStatus } from './TerminalPane'
import { composerFits, useComposerEnabled } from '@/lib/composer'
import { AgentGlyph, agentGlyphLabel } from './AgentMarks'
import { ChatIcon, CloseIcon, DashboardIcon, DeckIcon, MailIcon, SettingsIcon, FileIcon, InspectorIcon, PlusIcon, TerminalIcon } from './AppIcons'
import { sessionHealth } from '@/lib/sessionLabels'
import { StatusDot } from './ProjectRow'
import { HotMark } from './ResourceMeter'
import { closeTitle, closeWord } from '@/lib/closeShell'
import { NewMenu, type NewMenuItem } from './NewMenu'
import { keys, stripKey, tabKey } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { ChatEnded, ChatHint, type ChatPane } from './QuickChatPane'

/** The pinned Dashboard tab: the dashboard's screens, in the strip with the terminals. */
export interface DashboardTab {
  /** It is the tab in front. */
  active: boolean
  /** Its label: "Dashboard", or the screen when that is not one of the dashboard's own (Settings). */
  label: string
  onActivate: () => void
  onClose: () => void
}


/** A pinned tab of the app's own (Mail): front or not, and how to bring or close it. */
export interface SystemTab {
  active: boolean
  onActivate: () => void
  onClose: () => void
}

/** The Mail tab's key as the strip draws it: ⇧⌘M, Ctrl⇧M off macOS. */
export function mailStripKey(isMac = isMacPlatform()): string {
  return isMac ? '⇧⌘M' : 'Ctrl⇧M'
}

/**
 * A project's mark on its tabs: a hue from its id, muted, so tabs of one
 * project share a colour without the strip turning into a rainbow.
 */
export function projectHue(projectId: string): number {
  let h = 0
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0
  return h % 360
}

export interface TabStripProps {
  /** Every open tab of every project, in strip order. */
  tabs: Tab[]
  activeTabId?: string
  /** The name each tab's project chip shows; a tab with none shows no chip. */
  projectName?: (projectId: string) => string | undefined
  /** What each tab is called, shared with the sidebar (lib/tablabels.ts); worked out here when absent. */
  labels?: ReadonlyMap<string, TabLabel>
  /** The Dashboard tab, when it is open. */
  dashboard?: DashboardTab
  /** The Mail tab, when it is open: after the Dashboard tab, before the terminals. */
  mail?: SystemTab
  /** The terminals are in front, so the chat and inspector buttons apply. */
  paneTools?: boolean
  sessions: ReadonlyMap<string, SessionSummary>
  permissions: ReadonlySet<string>
  inspectorOpen: boolean
  sidebarOpen: boolean
  onActivate: (id: string) => void
  onDetach: (id: string) => void
  onMove: (id: string, toIndex: number) => void
  onNewAgent: () => void
  onNewShell: () => void
  /** The + menu's rows; New agent and New shell when absent. */
  newItems?: readonly NewMenuItem[]
  onToggleInspector: () => void
  /** Each tab's ⌘1–⌘9, by its place: 1–8, and 9 on the last. */
  digits?: ReadonlyMap<string, number>
  /** The tab in front shows its chat instead of its terminal (WP-14). */
  chatOpen?: boolean
  /** Absent when the tab in front has no conversation: a shell. */
  onToggleChat?: () => void
  /** The session deck under the agent's terminal is open. */
  deckOpen?: boolean
  /** Absent when the tab in front is not an agent's: a shell has no deck. */
  onToggleDeck?: () => void
}

/** What a tab's edge says, in its tooltip: the only states a tab shows. */
const ALERT_WORD = { waiting: 'waiting on you', error: 'failed' } as const

/** How fast a cut project name scrolls on hover, in px per second. */
const PROJECT_SCROLL_PX_S = 40

/**
 * A tab's project name, after its title. It takes its whole width first and
 * the title gives way before it (owner, 2026-10-14, translated: "the repo
 * name on the right doesn't fit — it must fit … give it more space"). Cut
 * only when the tab is too narrow even for that, it ends in an ellipsis at
 * rest and, under the pointer, slides the hidden part into view inside its
 * own box (`data-overflow`, tokens.css) — never wider, so nothing in the
 * strip moves; with reduced motion it stays cut and the tooltip names it.
 */
export function TabProject({ name, hue }: { name: string; hue: number }) {
  const box = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const [hidden, setHidden] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    // The text's own width, which a transform never changes, against the
    // box: measured at rest and on every resize, never because of a hover.
    const measure = () => {
      const over = Math.ceil((text.current?.offsetWidth ?? 0) - el.clientWidth)
      setHidden(over > 1 ? over : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [name])
  const style = {
    color: `hsl(${hue} 42% 50%)`,
    '--tab-project-shift': `${hidden}px`,
    '--tab-project-time': `${Math.max(1.2, hidden / PROJECT_SCROLL_PX_S).toFixed(2)}s`,
  } as CSSProperties
  return (
    <span ref={box} data-tab-project data-overflow={hidden > 0 || undefined} aria-hidden className="min-w-0 shrink truncate text-[11px]" style={style}>
      <span ref={text}>{name}</span>
    </span>
  )
}

export function TabStrip(props: TabStripProps) {
  const { tabs, activeTabId } = props
  const labels = props.labels ?? tabLabels(tabs, props.sessions, props.permissions, () => undefined)
  // Reordered by pointer events, not HTML5 drag and drop: in the desktop app
  // the shell's native drop handler takes every drag over the window (so a
  // dropped file arrives with its real path), and the page never sees a
  // dragover or a drop (.ai/21-app.md § Dropping a file). A press that moves
  // past a few pixels is a drag; released over another tab, the tab moves
  // there, and the click that follows the release is not an activation.
  const [dragging, setDragging] = useState<string | null>(null)
  // The tab whose name is being typed (double-click on an agent's tab).
  const [renaming, setRenaming] = useState<string | null>(null)
  const dragged = useRef(false)
  const press = (id: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    const x0 = e.clientX
    const y0 = e.clientY
    dragged.current = false
    const onMove = (m: PointerEvent) => {
      if (!dragged.current && Math.hypot(m.clientX - x0, m.clientY - y0) > 4) {
        dragged.current = true
        setDragging(id)
      }
    }
    const onUp = (u: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragging(null)
      if (!dragged.current) return
      const over = document.elementFromPoint(u.clientX, u.clientY)?.closest<HTMLElement>('[data-tab-index]')
      const to = over ? Number(over.dataset.tabIndex) : NaN
      if (Number.isInteger(to)) props.onMove(id, to)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      data-tauri-drag-region
      role="tablist"
      aria-label="Terminals"
      className={`app-strip flex h-[40px] shrink-0 items-end gap-0.5 bg-[var(--app-chrome-bg)] pr-2 ${props.sidebarOpen ? 'pl-2' : 'pl-[max(8px,calc(var(--caprock-traffic-lights-inset,0px)+2px))]'}`}
    >
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-hidden" data-tauri-drag-region>
        {props.dashboard && (
          <div
            role="tab"
            tabIndex={props.dashboard.active ? 0 : -1}
            aria-selected={props.dashboard.active}
            data-dashboard-tab
            onClick={props.dashboard.onActivate}
            onAuxClick={(e) => { if (e.button === 1) props.dashboard!.onClose() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') props.dashboard!.onActivate() }}
            title={props.dashboard.label === 'Settings' ? `Settings — ${keys('⌘,')}` : `Dashboard — ${keys('⌘0')}; ${keys('⌘0')} again: Home, at its top`}
            aria-label={props.dashboard.label}
            aria-keyshortcuts={props.dashboard.label === 'Settings' ? undefined : (isMacPlatform() ? 'Meta+0' : 'Control+Shift+0')}
            className={`group relative flex h-[32px] shrink-0 cursor-default select-none items-center gap-1 rounded-t-[9px] px-2 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
              props.dashboard.active ? 'app-tab-front app-tab-dash bg-bg font-medium text-fg' : 'app-tab-dash text-fg hover:text-fg'
            }`}
          >
            {/* Folded to its icon and its key, so the session tabs keep
              * their names (owner, 2026-10-13, translated: "shrink Dashboard
              * to a collapsed state"); its name is in the tooltip, and its ×
              * shows while it is in front. The key is always drawn, as on
              * every tab (2026-10-14, translated: "I must always see the key
              * combinations next to the tabs"). */}
            {props.dashboard.label === 'Settings'
              ? <SettingsIcon size={15} className="text-accent" />
              : <DashboardIcon size={15} className="text-accent" />}
            <kbd data-tab-key aria-hidden className="app-kbd-sm">{stripKey(props.dashboard.label === 'Settings' ? ',' : '0')}</kbd>
            <button
              type="button"
              aria-label={`Close tab ${props.dashboard.label}`}
              title="Close the dashboard tab"
              onClick={(e) => { e.stopPropagation(); props.dashboard!.onClose() }}
              className={`h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg ${props.dashboard.active ? 'flex' : 'hidden'}`}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
        {props.mail && (
          /* Mail's own tab (owner, 2026-10-14): in the strip from the first
           * time Mail is opened until its × is clicked; its icon and its
           * key, like the Dashboard tab. */
          <div
            role="tab"
            tabIndex={props.mail.active ? 0 : -1}
            aria-selected={props.mail.active}
            data-mail-tab
            onClick={props.mail.onActivate}
            onAuxClick={(e) => { if (e.button === 1) props.mail!.onClose() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') props.mail!.onActivate() }}
            title={`Mail — ${keys('⇧⌘M')}`}
            aria-label="Mail"
            aria-keyshortcuts={isMacPlatform() ? 'Shift+Meta+M' : 'Control+Shift+M'}
            className={`group relative flex h-[32px] shrink-0 cursor-default select-none items-center gap-1 rounded-t-[9px] px-2 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
              props.mail.active ? 'app-tab-front app-tab-dash bg-bg font-medium text-fg' : 'app-tab-dash text-fg hover:text-fg'
            }`}
          >
            <MailIcon size={15} className="text-accent" />
            <kbd data-tab-key aria-hidden className="app-kbd-sm">{mailStripKey()}</kbd>
            <button
              type="button"
              aria-label="Close tab Mail"
              title="Close the Mail tab"
              onClick={(e) => { e.stopPropagation(); props.mail!.onClose() }}
              className={`h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg ${props.mail.active ? 'flex' : 'hidden'}`}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
        {tabs.map((t, i) => {
          const label = labels.get(t.id)
          // A file tab is named by the file; its tooltip is the whole path.
          const file = label?.file
          const s = label?.session
          const isShell = !!label?.isShell
          const title = label?.title ?? t.title
          const active = t.id === activeTabId
          const project = props.projectName?.(t.projectId)
          const digit = props.digits?.get(t.id)
          // A tab is named by its session — the name is what matters (owner,
          // 2026-10-13, translated: "the session name is very important … I
          // don't care which agent it is"). The project is its short name
          // after the title, in the project's colour; the agent is in the
          // tooltip only. A file tab keeps the file name; a quick chat has
          // no project. No dots (2026-10-14, translated: "the indicators
          // tell me nothing at all, literally zero"): state shows only when
          // it asks something of you — an amber edge while the session
          // waits on you, a red one when it failed; working and idle show
          // nothing.
          const named = file === undefined && !label?.chat && project !== undefined
          const alert = file !== undefined || !s ? undefined : label?.dot === 'waiting' ? 'waiting' : sessionHealth(s) === 'error' ? 'error' : undefined
          const agent = file === undefined ? agentGlyphLabel(s?.agent, isShell) : undefined
          const tip = [file ?? title, agent, label?.branch, project].filter(Boolean).join(' · ') + (alert ? ` — ${ALERT_WORD[alert]}` : '') + (digit ? ` — ${keys(`⌘${digit}`)}` : '')
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              data-tab-index={i}
              aria-label={project && file === undefined ? `${title} · ${project}` : undefined}
              aria-description={alert ? ALERT_WORD[alert] : undefined}
              data-dragging={dragging === t.id || undefined}
              onPointerDown={press(t.id)}
              onClick={() => {
                if (dragged.current) { dragged.current = false; return }
                props.onActivate(t.id)
              }}
              onAuxClick={(e) => { if (e.button === 1) props.onDetach(t.id) }}
              onDoubleClick={file === undefined && renamable(s, isShell) ? () => setRenaming(t.id) : undefined}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') props.onActivate(t.id) }}
              title={tip}
              data-project={t.projectId}
              className={`group relative flex h-[32px] min-w-[112px] max-w-[340px] flex-1 basis-[220px] cursor-default select-none items-center gap-1 rounded-t-[9px] pl-2 pr-1 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
                active ? (file !== undefined ? 'app-tab-front bg-bg font-medium text-fg' : 'app-tab-front app-slab font-medium text-fg') : 'app-tab-back text-fg-muted hover:text-fg'
              } ${dragging === t.id ? 'opacity-60' : ''}`}
            >
              {file !== undefined && <FileIcon size={13} className="text-fg-faint" />}
              {alert && <span data-tab-alert={alert} aria-hidden className={`pointer-events-none absolute inset-x-2 top-0 h-[3px] rounded-b-full ${alert === 'waiting' ? 'bg-accent' : 'bg-danger'}`} />}
              {renaming === t.id && renamable(s, isShell)
                ? <InlineRename sessionId={s.session_id} initial={s.name?.trim() || sessionAbout(s)} current={s.name ?? ''} onDone={() => setRenaming(null)} />
                : <span data-row-title className="min-w-[4ch] flex-1 truncate">{title}</span>}
              {/* Its project, faint after the name: fixed, never edited
                * (owner, 2026-10-14). Whole while the tab has room — the
                * title is cut first, down to a few letters — and it scrolls
                * on hover when even that is not enough. */}
              {named && <TabProject name={project} hue={projectHue(t.projectId)} />}
              {file === undefined && <HotMark sessionId={s?.session_id} />}
              {/* The jump key and the × share one slot at the right end, so
                * nothing moves the title: the key at rest, the × on hover.
                * The tab in front shows both, side by side: every tab says
                * its key (owner, 2026-10-14, translated: "not every tab
                * shows the key combination"). */}
              <span data-tab-end className="relative flex h-[20px] min-w-[20px] shrink-0 items-center justify-end gap-0.5">
                {digit && (
                  <kbd data-tab-key aria-hidden className={`app-kbd-sm ${active ? '' : 'group-hover:invisible group-focus-within:invisible'}`}>{tabKey(digit)}</kbd>
                )}
                <button
                  type="button"
                  aria-label={`${closeWord(file !== undefined, isShell)} ${title}`}
                  title={closeTitle(file !== undefined, isShell, !!label?.chat, !!label?.session?.owned && label.session.status !== 'ended')}
                  onClick={(e) => { e.stopPropagation(); props.onDetach(t.id) }}
                  className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg ${active ? '' : 'absolute right-0 top-0 invisible group-hover:visible group-focus-within:visible'}`}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            </div>
          )
        })}
        <div className="mb-[5px] ml-1.5 flex shrink-0 items-center">
          <NewMenu items={props.newItems ?? [
            { id: 'agent', label: 'New agent', hint: keys('⇧⌘N'), icon: <PlusIcon size={13} />, run: props.onNewAgent },
            { id: 'shell', label: 'New shell', hint: keys('⌘T'), icon: <TerminalIcon size={13} />, run: props.onNewShell },
          ]} />
        </div>
      </div>
      <div className="mb-1 flex shrink-0 items-center gap-0.5">
        {props.paneTools !== false && props.onToggleChat && (
          // Worded, as Deck is: the bare bubble said nothing (owner,
          // 2026-10-14, translated: "it opens who knows what"). The word
          // stays *Chat* in both states; pressed is the way back.
          <button type="button" data-chat-toggle aria-label="Chat" aria-pressed={!!props.chatOpen} onClick={props.onToggleChat}
            title={props.chatOpen
              ? 'Back to the terminal'
              : 'Read this session as a chat: your prompts, the agent\'s replies, one line per tool call, and a field that types into it. The terminal keeps running.'}
            className={`flex h-[28px] items-center gap-1.5 rounded-[7px] px-1.5 text-[12px] transition-colors duration-100 motion-reduce:transition-none ${
              props.chatOpen ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
            }`}>
            <ChatIcon size={15} />
            <span>Chat</span>
          </button>
        )}
        {props.paneTools !== false && props.onToggleDeck && (
          // Labelled, with its key, so the deck is found (owner, 2026-10-11:
          // "it is not clear that it exists").
          <button type="button" data-deck-toggle title={`Session deck: live figures under the terminal (${keys('⌘B')})`} aria-label={`Session deck (${keys('⌘B')})`}
            aria-pressed={props.deckOpen} onClick={props.onToggleDeck}
            className={`flex h-[28px] items-center gap-1.5 rounded-[7px] px-1.5 text-[12px] transition-colors duration-100 motion-reduce:transition-none ${
              props.deckOpen ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
            }`}>
            <DeckIcon size={15} />
            <span>Deck</span>
            <kbd aria-hidden className="app-kbd-key">{keys('⌘B')}</kbd>
          </button>
        )}
        {props.paneTools !== false && <StripButton label={`Inspector (${keys('⌘I')})`} pressed={props.inspectorOpen} onClick={props.onToggleInspector} shortcut={keys('⌘I')}><InspectorIcon size={15} /></StripButton>}
      </div>
    </div>
  )
}

/** A strip button; one with a `shortcut` draws its key beside the icon, as Deck does. */
function StripButton({ label, onClick, pressed, shortcut, children }: { label: string; onClick: () => void; pressed?: boolean; shortcut?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex h-[28px] items-center justify-center gap-1.5 rounded-[7px] transition-colors duration-100 motion-reduce:transition-none ${shortcut ? 'px-1.5' : 'w-[28px]'} ${
        pressed ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
      }`}
    >
      {children}
      {shortcut && <kbd data-strip-key aria-hidden className="app-kbd-key">{shortcut}</kbd>}
    </button>
  )
}

/** Every open tab's panes; only the tab in front is visible. */
export const TerminalStack = memo(function TerminalStack({
  tabs,
  visibleTabId,
  covered = false,
  onPaneStatus,
  onPaneExit,
  sessions,
  permissions,
  onFocusPane,
  onClosePane,
  onResize,
  renderFile,
  renderObserve,
  renderPRs,
  chats,
  onChatClose,
  onChatRestart,
  onChatHintDismiss,
}: {
  tabs: Tab[]
  /** The tab shown, or undefined when the workspace itself is hidden. */
  visibleTabId?: string
  /**
   * A view covers the tab shown (the chat, Changes, a comparison): its panel
   * is hidden as if another tab were in front — output held, no WebGL canvas
   * drawn under the cover — and shown again the same way when it goes.
   */
  covered?: boolean
  /** What a file tab shows (components/FileView.tsx); stable, as the stack is memoised. */
  renderFile?: (tab: Tab, leaf: PaneLeaf, visible: boolean) => ReactNode
  /** What a watched session's tab shows (components/ObservePane.tsx): its conversation, read-only, no terminal. */
  renderObserve?: (tab: Tab, leaf: PaneLeaf, visible: boolean) => ReactNode
  /** What a Pipeline page shows (components/PRsCITab.tsx): the deck's cell, large. */
  renderPRs?: (tab: Tab, leaf: PaneLeaf, visible: boolean) => ReactNode
  onPaneStatus?: (sessionId: string, s: PaneStatus) => void
  /** The session's program exited; the workspace replaces it with a shell. */
  onPaneExit?: (sessionId: string) => void
  /** For the header a pane gets once its tab is split (F15). */
  sessions?: ReadonlyMap<string, SessionSummary>
  permissions?: ReadonlySet<string>
  onFocusPane?: (tabId: string, paneId: string) => void
  onClosePane?: (tabId: string, paneId: string) => void
  onResize?: (tabId: string, splitId: string, sizes: number[]) => void
  /** Quick chats among the panes, by session id: the hint above, the ended state over (components/QuickChatPane.tsx). */
  chats?: ReadonlyMap<string, ChatPane>
  /** An ended chat's Close tab. */
  onChatClose?: (tabId: string, paneId: string) => void
  /** An ended chat's Start again: a new chat in its place. */
  onChatRestart?: (sessionId: string) => void
  onChatHintDismiss?: () => void
}) {
  // The panes' callbacks, stable for the life of the stack: the workspace
  // hands new ones whenever its session list changes (several times a second
  // with agents at work), and a new callback would redraw every terminal pane
  // of every tab for nothing (PaneTerminal).
  const statusRef = useRef(onPaneStatus)
  statusRef.current = onPaneStatus
  const exitRef = useRef(onPaneExit)
  exitRef.current = onPaneExit
  const paneStatus = useCallback((id: string, s: PaneStatus) => statusRef.current?.(id, s), [])
  const paneExit = useCallback((id: string) => exitRef.current?.(id), [])
  const chatRef = useRef({ onChatClose, onChatRestart, onChatHintDismiss })
  chatRef.current = { onChatClose, onChatRestart, onChatHintDismiss }
  const chatClose = useCallback((tabId: string, paneId: string) => chatRef.current.onChatClose?.(tabId, paneId), [])
  const chatRestart = useCallback((id: string) => chatRef.current.onChatRestart?.(id), [])
  const hintDismiss = useCallback(() => chatRef.current.onChatHintDismiss?.(), [])
  const [composer] = useComposerEnabled()
  return (
    // The terminal slab is each terminal tab's own ground; a file tab reads
    // on the page's, in the app's theme.
    <div className="relative h-full w-full">
      {tabs.map((t) => {
        const shown = t.id === visibleTabId && !covered
        return (
        <div key={t.id} className={`absolute inset-0 ${t.root.type === 'pane' && ownTab(t.root.target) ? 'bg-bg' : 'app-slab'}`} hidden={!shown} data-tab-panel={t.id}>
          {t.root.type === 'pane' && t.root.target.kind === 'file' ? renderFile?.(t, t.root, shown)
            : t.root.type === 'pane' && t.root.target.kind === 'observe' ? renderObserve?.(t, t.root, shown)
            : t.root.type === 'pane' && t.root.target.kind === 'prs' ? renderPRs?.(t, t.root, shown) : <PaneView
            node={t.root}
            visible={shown}
            ctx={{
              tab: t,
              split: t.root.type === 'split',
              onPaneStatus: onPaneStatus && paneStatus,
              onPaneExit: onPaneExit && paneExit,
              sessions,
              permissions,
              onFocusPane: onFocusPane && ((paneId: string) => onFocusPane(t.id, paneId)),
              onClosePane: onClosePane && ((paneId: string) => onClosePane(t.id, paneId)),
              onResize: onResize && ((splitId: string, sizes: number[]) => onResize(t.id, splitId, sizes)),
              chats,
              onChatClose: (paneId: string) => chatClose(t.id, paneId),
              onChatRestart: chatRestart,
              onChatHintDismiss: hintDismiss,
              composer,
            }}
          />}
        </div>
        )
      })}
    </div>
  )
})

interface PaneCtx {
  tab: Tab
  /** The tab holds more than one pane: each gets a header and the focused one a ring. */
  split: boolean
  onPaneStatus?: (sessionId: string, s: PaneStatus) => void
  sessions?: ReadonlyMap<string, SessionSummary>
  permissions?: ReadonlySet<string>
  /** The session's program exited; the workspace replaces it with a shell. */
  onPaneExit?: (sessionId: string) => void
  onFocusPane?: (paneId: string) => void
  onClosePane?: (paneId: string) => void
  onResize?: (splitId: string, sizes: number[]) => void
  chats?: ReadonlyMap<string, ChatPane>
  onChatClose?: (paneId: string) => void
  onChatRestart?: (sessionId: string) => void
  onChatHintDismiss?: () => void
  /** The composer is switched on (Settings → Terminal). */
  composer?: boolean
}

function PaneView({ node, visible, ctx }: { node: PaneNode; visible: boolean; ctx: PaneCtx }) {
  if (node.type === 'pane') {
    const id = node.target.sessionId
    const focused = ctx.tab.focusedPaneId === node.id || (!ctx.split)
    // The composer: switched on, and an agent Caprock started (rule 7).
    const cs = ctx.composer ? ctx.sessions?.get(id) : undefined
    const withComposer = !!cs && node.target.kind !== 'shell' && composerFits(cs)
    const term = <PaneTerminal id={id} visible={visible} focused={focused} onPaneStatus={ctx.onPaneStatus} onPaneExit={ctx.onPaneExit}
      composer={withComposer} agent={cs?.agent} asking={withComposer && !!ctx.permissions?.has(id)} />
    const chat = ctx.chats?.get(id)
    const ended = chat?.ended && (
      <ChatEnded visible={visible && focused} onClose={() => ctx.onChatClose?.(node.id)} onRestart={() => ctx.onChatRestart?.(id)} />
    )
    // One shape whether or not the pane is a chat: the terminal's place in
    // the tree never changes, so learning that it is one (the session list
    // answers after the tab opens) does not remount and reconnect it.
    if (!ctx.split) {
      return (
        <div className="flex h-full w-full flex-col">
          {chat?.hint && !chat.ended && <ChatHint text={chat.hint} onDismiss={() => ctx.onChatHintDismiss?.()} />}
          <div className="relative min-h-0 flex-1">
            {term}
            {ended}
          </div>
        </div>
      )
    }
    const s = ctx.sessions?.get(id)
    const isShell = node.target.kind === 'shell' || s?.kind === 'shell'
    const title = `${s ? sessionTitle(s) : isShell ? 'shell' : 'session'}${isShell && s?.program ? ` · ${s.program}` : ''}`
    return (
      <div
        className="flex h-full w-full flex-col"
        data-pane={node.id}
        data-focused={focused || undefined}
        onFocusCapture={() => { if (!focused) ctx.onFocusPane?.(node.id) }}
        onMouseDown={() => { if (!focused) ctx.onFocusPane?.(node.id) }}
      >
        <div className={`flex h-[24px] shrink-0 items-center gap-1.5 bg-term-bg pl-3 pr-1 text-[11.5px] ${focused ? 'text-fg' : 'text-fg-faint'}`}>
          <StatusDot dot={s ? dotOf(s, !!ctx.permissions?.has(s.session_id)) : 'idle'} />
          <AgentGlyph agent={s?.agent} shell={isShell} />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <button
            type="button"
            aria-label={isShell ? `Close shell ${title}` : `Close pane ${title} — ${s?.owned && s.status !== 'ended' ? 'keep the agent running or end it' : 'the agent keeps running'}`}
            title={isShell ? `Close shell (${keys('⌘W')})` : `Close pane (${keys('⌘W')}) — ${s?.owned && s.status !== 'ended' ? 'keep the agent running or end it' : 'the agent keeps running'}`}
            onClick={(e) => { e.stopPropagation(); ctx.onClosePane?.(node.id) }}
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
          >
            <CloseIcon size={11} />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          {term}
          {ended}
          {/* The focused pane carries a ring; the others dim a little, as in Ghostty. */}
          <div aria-hidden className={`pointer-events-none absolute inset-0 ${focused ? 'shadow-[inset_0_0_0_1px_rgba(231,187,99,0.45)]' : 'bg-black/15'}`} />
        </div>
      </div>
    )
  }
  return <SplitView node={node} visible={visible} ctx={ctx} />
}

/**
 * A pane's terminal, redrawn only when what it shows changes: its session,
 * whether its tab is in front, whether it has the keyboard. The stack's
 * callbacks are stable (TerminalStack), so a new session list — the sidebar's
 * dots moving — does not reach a terminal.
 */
const PaneTerminal = memo(function PaneTerminal({ id, visible, focused, onPaneStatus, onPaneExit, composer = false, agent, asking = false }: {
  id: string
  visible: boolean
  focused: boolean
  onPaneStatus?: (sessionId: string, s: PaneStatus) => void
  onPaneExit?: (sessionId: string) => void
  /** Primitives, so the memo still holds while the session list moves. */
  composer?: boolean
  agent?: string
  asking?: boolean
}) {
  const onStatus = useMemo(() => onPaneStatus && ((s: PaneStatus) => onPaneStatus(id, s)), [onPaneStatus, id])
  const onExit = useMemo(() => onPaneExit && (() => onPaneExit(id)), [onPaneExit, id])
  const box = useMemo<PaneComposer | undefined>(() => (composer ? { agent, asking } : undefined), [composer, agent, asking])
  return <TerminalPane sessionId={id} active={visible} focused={focused} onStatus={onStatus} onExit={onExit} composer={box} />
})

/** A split's children with a divider between each pair, dragged or moved with the arrow keys. */
function SplitView({ node, visible, ctx }: { node: PaneSplit; visible: boolean; ctx: PaneCtx }) {
  const box = useRef<HTMLDivElement>(null)
  // While dragging, the sizes live here and reach the workspace on release.
  const [draft, setDraft] = useState<number[] | null>(null)
  const sizes = draft ?? node.sizes
  const row = node.direction === 'row'
  const moved = (i: number, at: number): number[] | null => {
    const before = sizes.slice(0, i - 1).reduce((a, v) => a + v, 0)
    const pair = sizes[i - 1]! + sizes[i]!
    const left = Math.min(pair - 0.1, Math.max(0.1, at - before))
    const next = sizes.slice()
    next[i - 1] = left
    next[i] = pair - left
    return next
  }
  const drag = (i: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = box.current
    if (!el) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    let last: number[] | null = null
    const onMove = (m: PointerEvent) => {
      const at = row ? (m.clientX - r.left) / r.width : (m.clientY - r.top) / r.height
      last = moved(i, at)
      setDraft(last)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (last) ctx.onResize?.(node.id, last)
      setDraft(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const nudge = (i: number) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[e.key]
    if (step === undefined) return
    e.preventDefault()
    const at = sizes.slice(0, i).reduce((a, v) => a + v, 0) + step
    const next = moved(i, at)
    if (next) ctx.onResize?.(node.id, next)
  }
  return (
    <div ref={box} className={`flex h-full w-full ${row ? 'flex-row' : 'flex-col'}`}>
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && (
            <div
              role="separator"
              aria-orientation={row ? 'vertical' : 'horizontal'}
              aria-label="Resize panes"
              aria-valuenow={Math.round(sizes.slice(0, i).reduce((a, v) => a + v, 0) * 100)}
              tabIndex={0}
              onPointerDown={drag(i)}
              onKeyDown={nudge(i)}
              className={`group relative z-10 shrink-0 bg-[var(--app-hairline-strong)] outline-none focus-visible:bg-accent ${row ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'}`}
            >
              <span aria-hidden className={`absolute ${row ? '-left-[3px] -right-[3px] inset-y-0' : '-top-[3px] -bottom-[3px] inset-x-0'}`} />
            </div>
          )}
          <div style={{ flex: `${sizes[i] ?? 1 / node.children.length} 1 0px` }} className="relative min-h-0 min-w-0">
            <PaneView node={c} visible={visible} ctx={ctx} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

