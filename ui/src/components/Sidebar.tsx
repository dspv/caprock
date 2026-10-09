/**
 * The app's sidebar (WP-06): New agent, Quick chat and Add project, the Today
 * strip (spend, agents running and waiting, the plan windows), what is
 * waiting on you when something is, then the projects, then the way into the
 * dashboard.
 *
 * The projects are an accordion (owner, 2026-10-09: "which one is active,
 * which to pick, unclear", translated): only the current project is open,
 * and under it exactly the tabs the strip shows for it. Picking another
 * project makes it current; nothing is expanded or collapsed by hand. The
 * one highlighted row in the sidebar is the tab in front.
 *
 * Keyboard: Tab reaches every row; ↑ and ↓ move between rows, Enter opens
 * what the row names.
 *
 * The list stays short: projects in play (running, waiting, a tab open,
 * pinned, current) come first; the rest fold under More projects, and the
 * ones hidden by hand under Hidden, both closed by default.
 * Each project's ⋯ menu (or a right-click, or Shift+F10 on its row) hides it,
 * closes its tabs, opens it in an editor or removes it from Caprock.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { groupProjects, type InboxItem, type ProjectNode, type SidebarModel } from '@/lib/sidebar'
import type { Tab } from '@/lib/tabs'
import type { TabLabel } from '@/lib/tablabels'
import type { ProjectSource } from '@/lib/projects'
import type { EditorList, SessionSummary, Summary } from '@/lib/api'
import { buildToday } from '@/lib/today'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { useTheme } from '@/lib/theme'
import { ProjectRow, StatusDot } from './ProjectRow'
import { ProjectMenu, type ProjectMenuAt } from './ProjectMenu'
import { TodayStrip } from './TodayStrip'
import { AgentGlyph, CaprockMark, ChatIcon, ChevronIcon, DashboardIcon, FolderPlusIcon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from './AppIcons'

/** Project ids hidden by hand: this browser's. */
export const HIDDEN_KEY = 'caprock.app.hidden-projects'
/** Which of the folded groups are open. */
export const FOLDS_KEY = 'caprock.app.project-folds'

type Fold = 'more' | 'hidden'

function loadIds(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveIds(key: string, ids: ReadonlySet<string>) {
  try { localStorage.setItem(key, JSON.stringify([...ids])) } catch { /* not kept */ }
}

export interface SidebarProps {
  model: SidebarModel
  source: ProjectSource
  /** The current project: the one open, its tabs listed under it. */
  activeProjectId: string
  dashboardActive: boolean
  /** Every open tab, in strip order; the current project's are listed under it. */
  tabs?: readonly Tab[]
  /** What each tab is called: the strip's own labels (lib/tablabels.ts). */
  tabLabels?: ReadonlyMap<string, TabLabel>
  /** The tab in front: the one highlighted row. */
  activeTabId?: string
  onActivateTab?: (tabId: string) => void
  /** Opens, as a tab, a live session or shell of the current project that has none. */
  onOpenLive?: (s: SessionSummary, projectId: string) => void
  onSelectProject: (id: string) => void
  onOpenInbox: (item: InboxItem) => void
  onNewAgent: (projectId: string, cwd?: string) => void
  onNewShell: (projectId: string, cwd?: string) => void
  /** Starts a Claude session that needs no folder, in a tab (⌥⌘N). */
  onQuickChat?: () => void
  /** Right-click on a project row with no menu (F18's editor menu). */
  onFolderMenu?: (e: React.MouseEvent, path: string, label: string) => void
  onAddProject: () => void
  onDashboard: () => void
  onSettings?: () => void
  onPalette: () => void
  /** The day's summary, for the Today strip; absent until it answers. */
  summary?: Summary
  /** The session list has answered once. */
  loaded?: boolean
  /** Opens a dashboard screen by its hash route ("#/cost"). */
  onRoute?: (hash: string) => void
  /** Tabs open per project, for the menu's "Close its tabs". */
  tabCounts?: ReadonlyMap<string, number>
  /** Closes every tab of a project; the sessions keep running. */
  onCloseProjectTabs?: (projectId: string) => void
  /** The editors found on this machine, for the menu's "Open in …"; null when none can be asked. */
  editors?: EditorList | null
  onOpenInEditor?: (path: string, label: string, editorId: string) => void
  /** Removes a project from Caprock's list; never touches its files. */
  onRemoveProject?: (projectId: string) => Promise<void> | void
}

export function Sidebar(props: SidebarProps) {
  const { model, activeProjectId } = props
  const [hidden, setHidden] = useState<Set<string>>(() => loadIds(HIDDEN_KEY))
  const [folds, setFolds] = useState<Set<string>>(() => loadIds(FOLDS_KEY))
  const allTabs = props.tabs
  const tabbed = useMemo(() => new Set((allTabs ?? []).map((t) => t.projectId)), [allTabs])
  const groups = useMemo(() => groupProjects(model.projects, { hidden, activeProjectId, tabbed }), [model.projects, hidden, activeProjectId, tabbed])
  const currentTabs = useMemo(() => (allTabs ?? []).filter((t) => t.projectId === activeProjectId), [allTabs, activeProjectId])
  const noLabels = useMemo(() => new Map<string, TabLabel>(), [])
  const now = useNow(30_000)
  const today = useMemo(() => buildToday(model, props.summary, now), [model, props.summary, now])
  const [menuAt, setMenuAt] = useState<ProjectMenuAt | null>(null)
  const menuFrom = useRef<HTMLElement | null>(null)
  const onMenu = useCallback((projectId: string, at: { x: number; y: number }, from: HTMLElement | null) => {
    menuFrom.current = from
    setMenuAt({ projectId, ...at })
  }, [])
  const closeMenu = useCallback(() => {
    setMenuAt(null)
    // Focus goes back to what opened it, unless a choice moved it elsewhere.
    const from = menuFrom.current
    menuFrom.current = null
    if (!from) return
    requestAnimationFrame(() => {
      const at = document.activeElement
      if (from.isConnected && (!at || at === document.body)) from.focus()
    })
  }, [])
  const menuNode = menuAt ? model.projects.find((n) => n.project.id === menuAt.projectId) : undefined
  const onHide = useCallback((id: string, hide: boolean) => {
    setHidden((cur) => {
      const next = new Set(cur)
      if (hide) next.add(id)
      else next.delete(id)
      saveIds(HIDDEN_KEY, next)
      return next
    })
  }, [])
  const toggleFold = (f: Fold) => {
    setFolds((cur) => {
      const next = new Set(cur)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      saveIds(FOLDS_KEY, next)
      return next
    })
  }
  const noop = useCallback(() => {}, [])
  const row = (n: ProjectNode) => {
    const current = n.project.id === activeProjectId
    return (
      <ProjectRow
        key={n.project.id}
        node={n}
        current={current}
        tabs={current ? currentTabs : []}
        labels={props.tabLabels ?? noLabels}
        activeTabId={props.dashboardActive ? undefined : props.activeTabId}
        onSelect={props.onSelectProject}
        onActivateTab={props.onActivateTab ?? noop}
        onOpenLive={props.onOpenLive}
        onNewAgent={props.onNewAgent}
        onNewShell={props.onNewShell}
        onFolderMenu={props.onFolderMenu}
        hidden={hidden.has(n.project.id)}
        onHide={onHide}
        onMenu={onMenu}
      />
    )
  }

  // The one that has waited longest: the Inbox's order (permission prompts first).
  const firstWaiting = model.inbox.find((i) => !i.stale)

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement
    if (!target.matches('[data-nav-row]')) return
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-nav-row]'))
    const at = rows.indexOf(target)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    }
  }

  return (
    <aside className="app-sidebar flex h-full min-h-0 flex-col border-r border-[var(--app-hairline)]" aria-label="Projects">
      <div
        data-tauri-drag-region
        className={`flex h-[44px] shrink-0 items-center gap-2 pr-2 pl-[max(14px,calc(var(--caprock-traffic-lights-inset,0px)+2px))]`}
      >
        <span data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
          <CaprockMark size={15} />
          <span data-tauri-drag-region className="text-[13px] font-semibold tracking-[-0.01em] text-fg">Caprock</span>
        </span>
        <IconButton label="Search projects, sessions and actions (⌘K)" onClick={props.onPalette}><SearchIcon size={15} /></IconButton>
      </div>

      {/* The app's main action, where the eye lands first: starting an agent
          was a 13px plus that appears on hover, and adding a project a word
          in a section header. */}
      <div className="shrink-0 px-2 pb-2">
        <button
          type="button"
          onClick={() => props.onNewAgent(activeProjectId)}
          aria-label="New agent"
          aria-keyshortcuts="Shift+Meta+N"
          title="Start an agent in the project in front (⇧⌘N)"
          className="app-primary flex h-[32px] w-full items-center gap-2 rounded-[8px] border pl-2.5 pr-2 text-left text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
        >
          <PlusIcon size={15} />
          <span className="flex-1">New agent</span>
          <kbd className="app-kbd">⇧⌘N</kbd>
        </button>
        {props.onQuickChat && (
          <button
            type="button"
            onClick={props.onQuickChat}
            aria-label="Quick chat"
            aria-keyshortcuts="Alt+Meta+N"
            title="Ask Claude something without picking a folder (⌥⌘N)"
            className="mt-1 flex h-[26px] w-full items-center gap-2 rounded-[7px] pl-2.5 pr-2 text-left text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
          >
            <ChatIcon size={14} />
            <span className="flex-1">Quick chat</span>
            <kbd className="app-kbd">⌥⌘N</kbd>
          </button>
        )}
        <button
          type="button"
          onClick={props.onAddProject}
          aria-label="Add project"
          aria-keyshortcuts="Meta+O"
          title="Add a project — a folder, a new one, or a clone (⌘O)"
          className="mt-1 flex h-[26px] w-full items-center gap-2 rounded-[7px] pl-2.5 pr-2 text-left text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          <FolderPlusIcon size={14} />
          <span className="flex-1">Add project</span>
          <kbd className="app-kbd">⌘O</kbd>
        </button>
      </div>

      <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3" onKeyDown={onKeyDown}>
        {props.onRoute && (
          <TodayStrip
            today={today}
            loaded={props.loaded ?? true}
            onSpend={() => props.onRoute!('#/cost')}
            onWindows={() => props.onRoute!('#/cost?section=limits')}
            onRunning={() => props.onRoute!('#/now')}
            onWaiting={firstWaiting ? () => props.onOpenInbox(firstWaiting) : undefined}
          />
        )}
        <Inbox items={model.inbox} onOpen={props.onOpenInbox} />

        <SectionHead label="Projects" />
        {model.projects.length === 0 ? (
          <div className="px-2 py-2 text-[12.5px] leading-relaxed text-fg-muted">
            No projects yet.{' '}
            <button type="button" onClick={props.onAddProject} className="text-accent hover:underline">Add a folder</button>{' '}
            or start an agent anywhere.
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-px">{groups.shown.map(row)}</ul>
            <Fold label="More projects" title="Nothing running and no tab open" items={groups.more} open={folds.has('more')} onToggle={() => toggleFold('more')} row={row} />
            <Fold label="Hidden" title="Hidden by hand; a project shows again while something runs in it" items={groups.hidden} open={folds.has('hidden')} onToggle={() => toggleFold('hidden')} row={row} />
          </>
        )}
        {props.source === 'derived' && model.projects.length > 0 && (
          <p className="px-2 pt-3 text-[11px] leading-snug text-fg-faint">
            Listed from where your sessions ran. Git state and clone arrive with the projects API.
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--app-hairline)] px-2 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-nav-row
            aria-current={props.dashboardActive ? 'true' : undefined}
            onClick={props.onDashboard}
            className="app-row flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left text-[13px] text-fg"
          >
            <DashboardIcon size={15} className="text-fg-muted" />
            <span className="flex-1">Dashboard</span>
            <kbd className="app-kbd">⇧⌘D</kbd>
          </button>
          {props.onSettings && <IconButton label="Settings (⌘,)" onClick={props.onSettings}><SettingsIcon size={15} /></IconButton>}
          <ThemeButton />
        </div>
      </div>
      {menuAt && menuNode && (
        <ProjectMenu
          at={menuAt}
          name={menuNode.project.name}
          root={menuNode.project.root}
          hidden={hidden.has(menuNode.project.id)}
          tabs={props.tabCounts?.get(menuNode.project.id) ?? 0}
          editors={props.editors ?? null}
          onHide={(hide) => onHide(menuNode.project.id, hide)}
          onCloseTabs={() => props.onCloseProjectTabs?.(menuNode.project.id)}
          onOpenInEditor={props.onOpenInEditor ? (editorId) => props.onOpenInEditor!(menuNode.project.root, menuNode.project.name, editorId) : undefined}
          onRemove={props.onRemoveProject ? () => props.onRemoveProject!(menuNode.project.id) : undefined}
          onClose={closeMenu}
        />
      )}
    </aside>
  )
}

/** What waits on you; nothing at all when nothing does. */
function Inbox({ items, onOpen }: { items: InboxItem[]; onOpen: (i: InboxItem) => void }) {
  const now = useNow(15_000)
  const [showOlder, setShowOlder] = useState(false)
  const fresh = items.filter((i) => !i.stale)
  const older = items.filter((i) => i.stale)
  const row = (it: InboxItem) => (
    <li key={it.session.session_id} className="app-fade-in">
      <button
        type="button"
        data-nav-row
        onClick={() => onOpen(it)}
        className="app-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[7px] py-1.5 pl-2 pr-2 text-left"
      >
        <StatusDot dot={it.stale ? 'idle' : 'waiting'} />
        <span className={`min-w-0 truncate text-[12.5px] font-medium ${it.stale ? 'text-fg-muted' : 'text-fg'}`}>{it.title}</span>
        <span className="num text-[10.5px] text-fg-faint">{fmtAgo(it.since, now)}</span>
        <span />
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg-muted">
          <AgentGlyph agent={it.session.agent} />
          <span className="truncate">{it.projectName}</span>
        </span>
        <span className={`text-[10.5px] font-medium ${it.reason === 'permission' ? 'text-accent' : 'text-fg-faint'}`}>
          {it.reason === 'permission' ? 'asks' : 'your turn'}
        </span>
      </button>
    </li>
  )
  if (items.length === 0) return null
  return (
    <section aria-label="Waiting on you" className="mb-2">
      <SectionHead
        label="Waiting on you"
        count={fresh.length}
        tone={fresh.length > 0 ? 'accent' : 'faint'}
      />
      {fresh.length > 0 && <ul className="grid grid-cols-1 gap-px">{fresh.map(row)}</ul>}
      {older.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showOlder}
            onClick={() => setShowOlder((v) => !v)}
            className="flex h-[24px] w-full items-center gap-1.5 rounded-[6px] px-2 text-left text-[11.5px] text-fg-faint hover:text-fg-muted"
          >
            <span className={`inline-block transition-transform motion-reduce:transition-none ${showOlder ? 'rotate-90' : ''}`} aria-hidden>›</span>
            Older, put down more than 12h ago ({older.length})
          </button>
          {showOlder && <ul className="grid grid-cols-1 gap-px">{older.map(row)}</ul>}
        </>
      )}
    </section>
  )
}

/** A folded group at the bottom of the projects: Quiet or Hidden, closed until opened. */
function Fold({ label, title, items, open, onToggle, row }: {
  label: string
  title: string
  items: ProjectNode[]
  open: boolean
  onToggle: () => void
  row: (n: ProjectNode) => ReactNode
}) {
  if (items.length === 0) return null
  return (
    <section aria-label={label} className="mt-1">
      <button
        type="button"
        data-nav-row
        aria-expanded={open}
        title={title}
        onClick={onToggle}
        className="flex h-[26px] w-full items-center gap-1.5 rounded-[6px] pl-1.5 pr-2 text-left text-[11.5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg-muted"
      >
        <span className={`flex h-4 w-4 items-center justify-center transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden>
          <ChevronIcon size={11} />
        </span>
        <span className="font-medium">{label} <span className="num font-normal">· {items.length}</span></span>
      </button>
      {open && <ul className="grid grid-cols-1 gap-px">{items.map(row)}</ul>}
    </section>
  )
}

function SectionHead({ label, count, tone = 'faint', action }: { label: string; count?: number; tone?: 'accent' | 'faint'; action?: ReactNode }) {
  return (
    <div className="flex h-[28px] items-center gap-1.5 px-2 pt-1.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">{label}</h2>
      {count !== undefined && count > 0 && (
        <span className={`num text-[11px] font-semibold ${tone === 'accent' ? 'text-accent' : 'text-fg-faint'}`}>{count}</span>
      )}
      <span className="ml-auto">{action}</span>
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none"
    >
      {children}
    </button>
  )
}

function ThemeButton() {
  const [theme, toggle] = useTheme()
  const dark = theme === 'dark'
  return (
    <IconButton label={dark ? 'Paper theme' : 'Graphite theme'} onClick={toggle}>
      {dark ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </IconButton>
  )
}
