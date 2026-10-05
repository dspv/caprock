/**
 * The tab strip of the project in front, and every open terminal behind it
 * (WP-04). Terminals of every project stay mounted — switching a tab or a
 * project shows one that is already painted — and each pane tree renders
 * through one recursive view, so split panes (F15) add a layout, not a rewrite.
 */
import { memo, useState, type DragEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@/lib/api'
import { focusedLeaf, type PaneNode, type Tab } from '@/lib/tabs'
import { dotOf, sessionTitle } from '@/lib/sidebar'
import { TerminalPane, type PaneStatus } from './TerminalPane'
import { AgentGlyph, CloseIcon, InspectorIcon, PlusIcon, TerminalIcon } from './AppIcons'
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
}

export function TabStrip(props: TabStripProps) {
  const { tabs, activeTabId, sessions, permissions } = props
  const [dragging, setDragging] = useState<string | null>(null)
  const drop = (e: DragEvent, index: number) => {
    e.preventDefault()
    if (dragging) props.onMove(dragging, index)
    setDragging(null)
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
              draggable
              onDragStart={() => setDragging(t.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => drop(e, i)}
              onClick={() => props.onActivate(t.id)}
              onAuxClick={(e) => { if (e.button === 1) props.onDetach(t.id) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') props.onActivate(t.id) }}
              title={`${title}${i < 9 ? ` — ⌘${i + 1}` : ''}`}
              className={`group relative flex h-[32px] min-w-[112px] max-w-[232px] flex-1 basis-[180px] cursor-default select-none items-center gap-2 rounded-t-[9px] pl-3 pr-1.5 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
                active ? 'app-slab text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'
              }`}
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
      <div className="mb-1 flex shrink-0 items-center">
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
}: {
  tabs: Tab[]
  /** The tab shown, or undefined when the workspace itself is hidden. */
  visibleTabId?: string
  onPaneStatus?: (sessionId: string, s: PaneStatus) => void
}) {
  return (
    <div className="app-slab relative h-full w-full">
      {tabs.map((t) => (
        <div key={t.id} className="absolute inset-0" hidden={t.id !== visibleTabId} data-tab-panel={t.id}>
          <PaneView node={t.root} visible={t.id === visibleTabId} onPaneStatus={onPaneStatus} />
        </div>
      ))}
    </div>
  )
})

function PaneView({ node, visible, onPaneStatus }: { node: PaneNode; visible: boolean; onPaneStatus?: (sessionId: string, s: PaneStatus) => void }) {
  if (node.type === 'pane') {
    const id = node.target.sessionId
    return <TerminalPane sessionId={id} active={visible} onStatus={onPaneStatus ? (s) => onPaneStatus(id, s) : undefined} />
  }
  return (
    <div className={`flex h-full w-full ${node.direction === 'row' ? 'flex-row' : 'flex-col'}`}>
      {node.children.map((c, i) => (
        <div
          key={c.id}
          style={{ flexBasis: `${(node.sizes[i] ?? 1 / node.children.length) * 100}%` }}
          className={`relative min-h-0 min-w-0 grow-0 shrink ${i > 0 ? (node.direction === 'row' ? 'border-l' : 'border-t') + ' border-[var(--app-hairline-strong)]' : ''}`}
        >
          <PaneView node={c} visible={visible} onPaneStatus={onPaneStatus} />
        </div>
      ))}
    </div>
  )
}
