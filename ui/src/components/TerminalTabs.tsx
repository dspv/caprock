/**
 * The tab strip of the project in front, and every open terminal behind it
 * (WP-04). Terminals of every project stay mounted — switching a tab or a
 * project shows one that is already painted — and each pane tree renders
 * through one recursive view: a split tab (F15) shows its panes side by side
 * or stacked, each with a header, behind dividers that drag or take arrows.
 */
import { Fragment, memo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@/lib/api'
import { focusedLeaf, type PaneNode, type PaneSplit, type Tab } from '@/lib/tabs'
import { dotOf, sessionTitle } from '@/lib/sidebar'
import { TerminalPane, type PaneStatus } from './TerminalPane'
import { AgentGlyph, ChatIcon, CloseIcon, InspectorIcon, PlusIcon, TerminalIcon } from './AppIcons'
import { StatusDot } from './ProjectRow'

export interface TabStripProps {
  tabs: Tab[]
  activeTabId?: string
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
  const { tabs, activeTabId, sessions, permissions } = props
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
      className={`flex h-[40px] shrink-0 items-end gap-0.5 border-b border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] pr-2 ${props.sidebarOpen ? 'pl-2' : 'pl-[max(8px,calc(var(--caprock-traffic-lights-inset,0px)+2px))]'}`}
    >
      <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden" data-tauri-drag-region>
        {tabs.map((t, i) => {
          const leaf = focusedLeaf(t)
          const s = sessions.get(leaf.target.sessionId)
          const isShell = leaf.target.kind === 'shell' || s?.kind === 'shell'
          const title = s ? sessionTitle(s) : t.title || (isShell ? 'shell' : 'session')
          const active = t.id === activeTabId
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
              title={`${title}${i < 9 ? ` — ⌘${i + 1}` : ''}`}
              className={`group relative flex h-[32px] min-w-[112px] max-w-[232px] flex-1 basis-[180px] cursor-default select-none items-center gap-2 rounded-t-[9px] pl-3 pr-1.5 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
                active ? 'app-slab text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
              } ${dragging === t.id ? 'opacity-60' : ''}`}
            >
              <StatusDot dot={s ? dotOf(s, permissions.has(s.session_id)) : 'idle'} />
              <AgentGlyph agent={s?.agent} shell={isShell} />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <button
                type="button"
                aria-label={`Close tab ${title} — the session keeps running`}
                title="Close tab (⌘W) — the session keeps running"
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
        {props.onToggleChat && (
          <StripButton label={props.chatOpen ? 'Show the terminal' : 'Show the chat'} pressed={props.chatOpen} onClick={props.onToggleChat}><ChatIcon size={15} /></StripButton>
        )}
        <StripButton label="Inspector (⌘I)" pressed={props.inspectorOpen} onClick={props.onToggleInspector}><InspectorIcon size={15} /></StripButton>
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
  sessions,
  permissions,
  onFocusPane,
  onClosePane,
  onResize,
}: {
  tabs: Tab[]
  /** The tab shown, or undefined when the workspace itself is hidden. */
  visibleTabId?: string
  onPaneStatus?: (sessionId: string, s: PaneStatus) => void
  /** For the header a pane gets once its tab is split (F15). */
  sessions?: ReadonlyMap<string, SessionSummary>
  permissions?: ReadonlySet<string>
  onFocusPane?: (tabId: string, paneId: string) => void
  onClosePane?: (tabId: string, paneId: string) => void
  onResize?: (tabId: string, splitId: string, sizes: number[]) => void
}) {
  return (
    <div className="app-slab relative h-full w-full">
      {tabs.map((t) => (
        <div key={t.id} className="absolute inset-0" hidden={t.id !== visibleTabId} data-tab-panel={t.id}>
          <PaneView
            node={t.root}
            visible={t.id === visibleTabId}
            ctx={{
              tab: t,
              split: t.root.type === 'split',
              onPaneStatus,
              sessions,
              permissions,
              onFocusPane: onFocusPane && ((paneId: string) => onFocusPane(t.id, paneId)),
              onClosePane: onClosePane && ((paneId: string) => onClosePane(t.id, paneId)),
              onResize: onResize && ((splitId: string, sizes: number[]) => onResize(t.id, splitId, sizes)),
            }}
          />
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
  onFocusPane?: (paneId: string) => void
  onClosePane?: (paneId: string) => void
  onResize?: (splitId: string, sizes: number[]) => void
}

function PaneView({ node, visible, ctx }: { node: PaneNode; visible: boolean; ctx: PaneCtx }) {
  if (node.type === 'pane') {
    const id = node.target.sessionId
    const focused = ctx.tab.focusedPaneId === node.id || (!ctx.split)
    const term = <TerminalPane sessionId={id} active={visible} focused={focused} onStatus={ctx.onPaneStatus ? (s) => ctx.onPaneStatus!(id, s) : undefined} />
    if (!ctx.split) return term
    const s = ctx.sessions?.get(id)
    const isShell = node.target.kind === 'shell' || s?.kind === 'shell'
    const title = s ? sessionTitle(s) : isShell ? 'shell' : 'session'
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
            aria-label={`Close pane ${title} — the session keeps running`}
            title="Close pane (⌘W) — the session keeps running"
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
