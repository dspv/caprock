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
import { Fragment, memo, useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@/lib/api'
import { type PaneLeaf, type PaneNode, type PaneSplit, type Tab } from '@/lib/tabs'
import { dotOf, sessionTitle } from '@/lib/sidebar'
import { tabLabels, type TabLabel } from '@/lib/tablabels'
import { TerminalPane, type PaneStatus } from './TerminalPane'
import { AgentGlyph } from './AgentMarks'
import { ChatIcon, CloseIcon, DashboardIcon, FileIcon, InspectorIcon, PlusIcon, TerminalIcon } from './AppIcons'
import { StatusDot } from './ProjectRow'
import { closeTitle, closeWord } from '@/lib/closeShell'

/** The pinned Dashboard tab: the dashboard's screens, in the strip with the terminals. */
export interface DashboardTab {
  /** It is the tab in front. */
  active: boolean
  /** Its label: "Dashboard", or the screen when that is not one of the dashboard's own (Settings). */
  label: string
  onActivate: () => void
  onClose: () => void
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
  onToggleInspector: () => void
  /** The tab in front shows its chat instead of its terminal (WP-14). */
  chatOpen?: boolean
  /** Absent when the tab in front has no conversation: a shell. */
  onToggleChat?: () => void
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
      <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden" data-tauri-drag-region>
        {props.dashboard && (
          <div
            role="tab"
            tabIndex={props.dashboard.active ? 0 : -1}
            aria-selected={props.dashboard.active}
            data-dashboard-tab
            onClick={props.dashboard.onActivate}
            onAuxClick={(e) => { if (e.button === 1) props.dashboard!.onClose() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') props.dashboard!.onActivate() }}
            title={`${props.dashboard.label} — ⇧⌘D`}
            className={`group relative flex h-[32px] shrink-0 cursor-default select-none items-center gap-2 rounded-t-[9px] pl-3 pr-1.5 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
              props.dashboard.active ? 'app-tab-front bg-bg text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
            }`}
          >
            <DashboardIcon size={13} className="text-fg-faint" />
            <span>{props.dashboard.label}</span>
            <button
              type="button"
              aria-label={`Close tab ${props.dashboard.label}`}
              title="Close the dashboard tab"
              onClick={(e) => { e.stopPropagation(); props.dashboard!.onClose() }}
              className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg ${props.dashboard.active ? '' : 'invisible group-hover:visible'}`}
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
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              data-tab-index={i}
              data-dragging={dragging === t.id || undefined}
              onPointerDown={press(t.id)}
              onClick={() => {
                if (dragged.current) { dragged.current = false; return }
                props.onActivate(t.id)
              }}
              onAuxClick={(e) => { if (e.button === 1) props.onDetach(t.id) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') props.onActivate(t.id) }}
              title={`${file ?? title}${label?.branch ? ` · ${label.branch}` : ''}${project ? ` · ${project}` : ''}${i < 9 ? ` — ⌘${i + 1}` : ''}`}
              data-project={t.projectId}
              className={`group relative flex h-[32px] min-w-[112px] max-w-[260px] flex-1 basis-[200px] cursor-default select-none items-center gap-2 rounded-t-[9px] pl-3 pr-1.5 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
                active ? (file !== undefined ? 'app-tab-front bg-bg text-fg' : 'app-tab-front app-slab text-fg') : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
              } ${dragging === t.id ? 'opacity-60' : ''}`}
            >
              {file !== undefined ? (
                <FileIcon size={13} className="text-fg-faint" />
              ) : (
                <>
                  <StatusDot dot={label?.dot ?? 'idle'} />
                  <AgentGlyph agent={s?.agent} shell={isShell} />
                </>
              )}
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {label?.branch && <span className="mono min-w-0 max-w-[10ch] shrink truncate text-[11px] text-fg-faint">{label.branch}</span>}
              {project && (
                <span data-project-chip className="flex min-w-0 max-w-[10ch] shrink items-center gap-1 text-[11px] text-fg-faint">
                  <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: `hsl(${projectHue(t.projectId)} 42% 56%)` }} />
                  <span className="truncate">{project}</span>
                </span>
              )}
              <button
                type="button"
                aria-label={`${closeWord(file !== undefined, isShell)} ${title}`}
                title={closeTitle(file !== undefined, isShell)}
                onClick={(e) => { e.stopPropagation(); props.onDetach(t.id) }}
                className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg ${active ? '' : 'invisible group-hover:visible'}`}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          )
        })}
        <div className="mb-1 ml-1 flex shrink-0 items-center gap-0.5">
          <StripButton label="New agent (⇧⌘N)" onClick={props.onNewAgent}><PlusIcon size={15} /></StripButton>
          <StripButton label="New shell (⌘T)" onClick={props.onNewShell}><TerminalIcon size={15} /></StripButton>
        </div>
      </div>
      <div className="mb-1 flex shrink-0 items-center gap-0.5">
        {props.paneTools !== false && props.onToggleChat && (
          <StripButton label={props.chatOpen ? 'Show the terminal' : 'Show the chat'} pressed={props.chatOpen} onClick={props.onToggleChat}><ChatIcon size={15} /></StripButton>
        )}
        {props.paneTools !== false && <StripButton label="Inspector (⌘I)" pressed={props.inspectorOpen} onClick={props.onToggleInspector}><InspectorIcon size={15} /></StripButton>}
      </div>
    </div>
  )
}

function StripButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex h-[28px] w-[28px] items-center justify-center rounded-[7px] transition-colors duration-100 motion-reduce:transition-none ${
        pressed ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

/** Every open tab's panes; only the tab in front is visible. */
export const TerminalStack = memo(function TerminalStack({
  tabs,
  visibleTabId,
  onPaneStatus,
  onPaneExit,
  sessions,
  permissions,
  onFocusPane,
  onClosePane,
  onResize,
  renderFile,
}: {
  tabs: Tab[]
  /** The tab shown, or undefined when the workspace itself is hidden. */
  visibleTabId?: string
  /** What a file tab shows (components/FileView.tsx); stable, as the stack is memoised. */
  renderFile?: (tab: Tab, leaf: PaneLeaf, visible: boolean) => ReactNode
  onPaneStatus?: (sessionId: string, s: PaneStatus) => void
  /** The session's program exited; the workspace replaces it with a shell. */
  onPaneExit?: (sessionId: string) => void
  /** For the header a pane gets once its tab is split (F15). */
  sessions?: ReadonlyMap<string, SessionSummary>
  permissions?: ReadonlySet<string>
  onFocusPane?: (tabId: string, paneId: string) => void
  onClosePane?: (tabId: string, paneId: string) => void
  onResize?: (tabId: string, splitId: string, sizes: number[]) => void
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
  return (
    // The terminal slab is each terminal tab's own ground; a file tab reads
    // on the page's, in the app's theme.
    <div className="relative h-full w-full">
      {tabs.map((t) => (
        <div key={t.id} className={`absolute inset-0 ${t.root.type === 'pane' && t.root.target.kind === 'file' ? 'bg-bg' : 'app-slab'}`} hidden={t.id !== visibleTabId} data-tab-panel={t.id}>
          {t.root.type === 'pane' && t.root.target.kind === 'file' ? renderFile?.(t, t.root, t.id === visibleTabId) : <PaneView
            node={t.root}
            visible={t.id === visibleTabId}
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
            }}
          />}
        </div>
      ))}
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
}

function PaneView({ node, visible, ctx }: { node: PaneNode; visible: boolean; ctx: PaneCtx }) {
  if (node.type === 'pane') {
    const id = node.target.sessionId
    const focused = ctx.tab.focusedPaneId === node.id || (!ctx.split)
    const term = <PaneTerminal id={id} visible={visible} focused={focused} onPaneStatus={ctx.onPaneStatus} onPaneExit={ctx.onPaneExit} />
    if (!ctx.split) return term
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
            aria-label={isShell ? `Close shell ${title}` : `Close pane ${title} — the agent keeps running`}
            title={isShell ? 'Close shell (⌘W)' : 'Close pane (⌘W) — the agent keeps running'}
            onClick={(e) => { e.stopPropagation(); ctx.onClosePane?.(node.id) }}
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
          >
            <CloseIcon size={11} />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          {term}
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
const PaneTerminal = memo(function PaneTerminal({ id, visible, focused, onPaneStatus, onPaneExit }: {
  id: string
  visible: boolean
  focused: boolean
  onPaneStatus?: (sessionId: string, s: PaneStatus) => void
  onPaneExit?: (sessionId: string) => void
}) {
  const onStatus = useMemo(() => onPaneStatus && ((s: PaneStatus) => onPaneStatus(id, s)), [onPaneStatus, id])
  const onExit = useMemo(() => onPaneExit && (() => onPaneExit(id)), [onPaneExit, id])
  return <TerminalPane sessionId={id} active={visible} focused={focused} onStatus={onStatus} onExit={onExit} />
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

