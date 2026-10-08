/**
 * The app's sidebar (WP-06): what is waiting on you, then every project with
 * its worktrees, sessions and shells, then the way into the dashboard.
 *
 * Keyboard: Tab reaches every row; ↑ and ↓ move between rows, → opens a
 * project and ← closes it, Enter opens what the row names.
 *
 * The list stays short: projects with nothing running for a week fold under
 * Quiet, and the ones hidden by hand under Hidden, both closed by default.
 */
import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { groupProjects, type InboxItem, type ProjectNode, type SessionNode, type SidebarModel, type WorktreeNode } from '@/lib/sidebar'
import type { ProjectSource } from '@/lib/projects'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { useTheme } from '@/lib/theme'
import { ProjectRow, StatusDot } from './ProjectRow'
import { AgentGlyph, CaprockMark, ChevronIcon, DashboardIcon, FolderPlusIcon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from './AppIcons'

const EXPANDED_KEY = 'caprock.app.expanded'
/** Project ids hidden by hand: this browser's, as the expanded set is. */
export const HIDDEN_KEY = 'caprock.app.hidden-projects'
/** Which of the folded groups are open. */
export const FOLDS_KEY = 'caprock.app.project-folds'

type Fold = 'quiet' | 'hidden'

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

function loadExpanded(): Set<string> | null {
  try {
    const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? 'null') as unknown
    return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : null
  } catch {
    return null
  }
}

export interface SidebarProps {
  model: SidebarModel
  source: ProjectSource
  activeProjectId: string
  activeSessionId?: string
  dashboardActive: boolean
  onSelectProject: (id: string) => void
  onOpenSession: (s: SessionNode, projectId: string) => void
  onOpenInbox: (item: InboxItem) => void
  onNewAgent: (projectId: string, cwd?: string) => void
  onNewShell: (projectId: string, cwd?: string) => void
  /** Right-click on a project or worktree row (F18's editor menu). */
  onFolderMenu?: (e: React.MouseEvent, path: string, label: string) => void
  onAddProject: () => void
  onDashboard: () => void
  onSettings?: () => void
  onPalette: () => void
  /** Opens a worktree's Changes view from its ±N; absent without the projects API. */
  onOpenChanges?: (projectId: string, w?: WorktreeNode) => void
}

export function Sidebar(props: SidebarProps) {
  const { model, activeProjectId, activeSessionId } = props
  const [expanded, setExpanded] = useState<Set<string> | null>(loadExpanded)
  const [hidden, setHidden] = useState<Set<string>>(() => loadIds(HIDDEN_KEY))
  const [folds, setFolds] = useState<Set<string>>(() => loadIds(FOLDS_KEY))
  const groups = useMemo(() => groupProjects(model.projects, { hidden, activeProjectId }), [model.projects, hidden, activeProjectId])
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
  // First run: open the projects where something is running, and the one in front.
  const isOpen = (id: string, live: number) => (expanded ? expanded.has(id) : live > 0 || id === activeProjectId)
  const toggle = useCallback((id: string) => {
    setExpanded((cur) => {
      const base = cur ?? new Set(model.projects.filter((n) => n.live > 0 || n.project.id === activeProjectId).map((n) => n.project.id))
      const next = new Set(base)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])) } catch { /* not kept */ }
      return next
    })
  }, [model.projects, activeProjectId])

  const row = (n: ProjectNode) => (
    <ProjectRow
      key={n.project.id}
      node={n}
      expanded={isOpen(n.project.id, n.live)}
      active={!props.dashboardActive && n.project.id === activeProjectId}
      activeSessionId={props.dashboardActive ? undefined : activeSessionId}
      onToggle={toggle}
      onSelect={props.onSelectProject}
      onOpenSession={props.onOpenSession}
      onNewAgent={props.onNewAgent}
      onNewShell={props.onNewShell}
      onOpenChanges={props.onOpenChanges}
      onFolderMenu={props.onFolderMenu}
      hidden={hidden.has(n.project.id)}
      onHide={onHide}
    />
  )

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement
    if (!target.matches('[data-nav-row]')) return
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-nav-row]'))
    const at = rows.indexOf(target)
    const project = target.dataset.projectRow
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (project && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      const open = target.getAttribute('aria-expanded') === 'true'
      if (open !== (e.key === 'ArrowRight')) toggle(project)
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
          className="flex h-[32px] w-full items-center gap-2 rounded-[8px] bg-accent pl-2.5 pr-2 text-left text-[13px] font-semibold text-panel shadow-[0_1px_0_rgba(0,0,0,0.08)] transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
        >
          <PlusIcon size={15} />
          <span className="flex-1">New agent</span>
          <kbd className="mono text-[10.5px] font-medium opacity-75">⇧⌘N</kbd>
        </button>
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
          <kbd className="mono text-[10.5px] text-fg-faint">⌘O</kbd>
        </button>
      </div>

      <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3" onKeyDown={onKeyDown}>
        <Inbox items={model.inbox} activeSessionId={activeSessionId} onOpen={props.onOpenInbox} />

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
            <Fold label="Quiet" title="Nothing running and no activity for a week" items={groups.quiet} open={folds.has('quiet')} onToggle={() => toggleFold('quiet')} row={row} />
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
            <kbd className="mono text-[10.5px] text-fg-faint">⇧⌘D</kbd>
          </button>
          {props.onSettings && <IconButton label="Settings (⌘,)" onClick={props.onSettings}><SettingsIcon size={15} /></IconButton>}
          <ThemeButton />
        </div>
      </div>
    </aside>
  )
}

function Inbox({ items, activeSessionId, onOpen }: { items: InboxItem[]; activeSessionId?: string; onOpen: (i: InboxItem) => void }) {
  const now = useNow(15_000)
  const [showOlder, setShowOlder] = useState(false)
  const fresh = items.filter((i) => !i.stale)
  const older = items.filter((i) => i.stale)
  const row = (it: InboxItem) => (
    <li key={it.session.session_id} className="app-fade-in">
      <button
        type="button"
        data-nav-row
        aria-current={it.session.session_id === activeSessionId ? 'true' : undefined}
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
  return (
    <section aria-label="Waiting on you" className="mb-2">
      <SectionHead
        label="Waiting on you"
        count={fresh.length}
        tone={fresh.length > 0 ? 'accent' : 'faint'}
      />
      {fresh.length === 0 ? (
        <p className="px-2 pb-1 text-[12px] text-fg-faint">Nothing is waiting on you.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-px">{fresh.map(row)}</ul>
      )}
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
