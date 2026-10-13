/**
 * The app's sidebar (WP-06): New agent, Quick chat and Add project, the Today
 * strip (spend, agents running and waiting, the plan windows), then the
 * projects, then the way into the dashboard. There is no separate Waiting on
 * you block (owner, 2026-10-11, translated: "not needed at all — everything
 * is already visible in Projects"): what waits is marked on its own row under
 * its project, and the Today strip's Waiting count opens the first of them.
 *
 * The projects are an accordion (owner, 2026-10-09: "which one is active,
 * which to pick, unclear", translated): under each project every agent
 * session it has, working, waiting or idle, and nothing else — no shells,
 * files or "+N more" line (owner, 2026-10-13; ProjectRow decides it). The
 * one highlighted row in the sidebar is the tab in front.
 *
 * Keyboard: Tab reaches every row; ↑ and ↓ move between rows, Enter opens
 * what the row names, ⌥⇧↑ ⌥⇧↓ move a session row within its project. A
 * row with a tab shows the tab's ⌘1–⌘9, as the strip does; projects have
 * no digit. ⌥⌘← ⌥⌘→ step to the project before or after, ⌥⌘↑ ⌥⌘↓ to the session
 * above or below in the project in front (lib/appkeys.ts, AppShell).
 *
 * Rows keep their places (owner, 2026-10-13): projects by pin, the order set
 * by hand and name; the rows under a project by the order set by hand (drag,
 * or ⌥⇧↑ ⌥⇧↓) and then when each session started (lib/rowOrder.ts).
 *
 * The list stays short: projects in play (running, waiting, a tab open,
 * pinned, current) are listed; the rest, the projects hidden by hand and
 * the session rows hidden by hand wait behind one quiet More… at the end of
 * the list, which opens them as one list (owner, 2026-10-13, translated:
 * "'More projects' and 'Hidden' I'd hide in one button like 'More…', and
 * it opens a list right away"): a project there opens on a click, a hidden
 * one or a hidden session comes back. Hidden wins over running; the project
 * in front stays listed even while hidden, and one comes back by itself
 * when it needs you again (lib/sidebar.ts projectHidden).
 * A project's × closes it: its tabs close and it moves under More…,
 * unless something still runs in it (components/ProjectRow.tsx). Each
 * project's ⋯ menu (or a right-click, or Shift+F10 on its row) hides it,
 * closes its tabs, opens it in an editor or removes it from Caprock. Every
 * session row can be closed or hidden from its own ×.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { groupProjects, rowHidden, type HiddenProjects, type HiddenSessions, type InboxItem, type ProjectNode, type SidebarModel } from '@/lib/sidebar'
import type { Tab } from '@/lib/tabs'
import type { SettingsSection } from '@/lib/router'
import type { TabLabel } from '@/lib/tablabels'
import type { ProjectSource } from '@/lib/projects'
import type { ProjectShellsOutcome } from '@/lib/closeShell'
import type { EditorList, SessionSummary, Summary } from '@/lib/api'
import { buildToday } from '@/lib/today'
import { useNow } from '@/lib/useNow'
import { THEME_MODE_NAME, useThemeMode } from '@/lib/theme'
import { THEMES } from '@/lib/themes'
import { ThemeMenu } from './ThemePicker'
import { FLAT_ORDER, flatRows, keepsProject, leadKey, ProjectRow, SessionList } from './ProjectRow'
import { ProjectMenu, type ProjectMenuAt } from './ProjectMenu'
import { MenuBox, MenuItem, MenuSeparator, type MenuAt } from './RowMenu'
import { TodayStrip } from './TodayStrip'
import { FeedbackButton } from './Feedback'
import { CaprockMark, ChatIcon, ChevronIcon, DashboardIcon, EyeIcon, FolderIcon, FolderPlusIcon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from './AppIcons'
import { keys } from '@/lib/appkeys'
import { loadRowOrders, ROW_ORDER_EVENT, saveRowOrder, type RowOrders } from '@/lib/rowOrder'

/** Project ids hidden by hand, with when: this browser's. An older plain list of ids still reads. */
export const HIDDEN_KEY = 'caprock.app.hidden-projects'
/** Session rows hidden by hand under their project, with when: this browser's (ProjectRow). */
export const HIDDEN_SESSIONS_KEY = 'caprock.app.hidden-sessions'
/** How many hidden rows are remembered; the oldest go first. Ended sessions are not listed anyway. */
const HIDDEN_SESSIONS_MAX = 300
/** Which of the folded groups are open, and `footer` when the bottom block is collapsed. */
export const FOLDS_KEY = 'caprock.app.project-folds'

/** `footer`: the bottom block (feedback, Dashboard, Settings) collapsed to one row of icons. */
type Fold = 'footer'

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

export function loadHiddenProjects(): Map<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null') as unknown
    // Before 2026-10-13 a plain list, with no time: hidden as of now, so a
    // turn that had already ended does not bring it back.
    if (Array.isArray(v)) {
      const at = Date.now()
      return new Map(v.filter((x): x is string => typeof x === 'string').map((id) => [id, at]))
    }
    if (!v || typeof v !== 'object') return new Map()
    return new Map(Object.entries(v as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number'))
  } catch {
    return new Map()
  }
}

/** Said on window when a project is hidden or shown again, so ⌘1–⌘9 count again (AppShell). */
export const HIDDEN_PROJECTS_EVENT = 'caprock:hidden-projects'

function saveHiddenProjects(m: HiddenProjects) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(Object.fromEntries(m))) } catch { /* not kept */ }
  window.dispatchEvent(new Event(HIDDEN_PROJECTS_EVENT))
}

export function loadHiddenSessions(): Map<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY) ?? 'null') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return new Map()
    return new Map(Object.entries(v as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number'))
  } catch {
    return new Map()
  }
}

function saveHiddenSessions(m: ReadonlyMap<string, number>) {
  const kept = [...m].sort((a, b) => b[1] - a[1]).slice(0, HIDDEN_SESSIONS_MAX)
  try { localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify(Object.fromEntries(kept))) } catch { /* not kept */ }
  window.dispatchEvent(new Event(HIDDEN_PROJECTS_EVENT))
}

/** Says a session row was hidden from outside the sidebar (a watched session's tab, ObservePane). */
export const HIDE_SESSION_EVENT = 'caprock:hide-session'

/**
 * Hides a session's row from the sidebar from anywhere — the sidebar may be
 * closed, so the list is written here and the sidebar, when it is mounted,
 * reads it again. Unlists only: nothing is sent to the session (rule 7).
 */
export function hideSessionRow(sessionId: string) {
  const next = loadHiddenSessions()
  next.set(sessionId, Date.now())
  saveHiddenSessions(next)
  window.dispatchEvent(new CustomEvent(HIDE_SESSION_EVENT, { detail: sessionId }))
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
  /** Closes a tab, as ⌘W and the strip's × do; what runs in it keeps running. */
  onCloseTab?: (tabId: string) => void
  /** Opens, as a tab, a live session or shell of the current project that has none. */
  onOpenLive?: (s: SessionSummary, projectId: string) => void
  onSelectProject: (id: string) => void
  /** Opens what waits on you: the Today strip's Waiting count opens the first. */
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
  /** Settings on the phone or Telegram section: the row's "phone, Telegram"
   *  words, and the row itself (owner, 2026-10-13). Absent: plain Settings. */
  onSettingsSection?: (section: SettingsSection) => void
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
  /**
   * Before *Close project* closes the tabs: end the project's shells — idle
   * ones at once, busy ones after asking (lib/closeShell). Resolves with
   * whether the user cancelled and how many shells were stopped.
   */
  onStopProjectShells?: (projectId: string) => Promise<ProjectShellsOutcome>
  /** The editors found on this machine, for the menu's "Open in …"; null when none can be asked. */
  editors?: EditorList | null
  onOpenInEditor?: (path: string, label: string, editorId: string) => void
  /** Removes a project from Caprock's list; never touches its files. */
  onRemoveProject?: (projectId: string) => Promise<void> | void
  /** Opens Clean up copies for a repository (components/CopiesSheet). */
  onCleanCopies?: (projectId: string) => void
  /**
   * Sessions under their projects (the default), or every session in one
   * flat list; AppShell keeps it per viewer.
   */
  grouped?: boolean
  onToggleGrouped?: () => void
  /** Each tab's ⌘1–⌘9, by tab id, as the strip shows it: drawn on that tab's row too. */
  tabDigits?: ReadonlyMap<string, number>
  /** The flat list's tabbed rows, dragged into this order: the strip takes it (AppShell). */
  onOrderTabs?: (tabIds: string[]) => void
}

export function Sidebar(props: SidebarProps) {
  const { model, activeProjectId } = props
  const [hidden, setHidden] = useState<HiddenProjects>(() => loadHiddenProjects())
  const [folds, setFolds] = useState<Set<string>>(() => loadIds(FOLDS_KEY))
  const [hiddenSessions, setHiddenSessions] = useState<HiddenSessions>(() => loadHiddenSessions())
  // Hiding a row unlists it here and nowhere else: nothing is signalled, so
  // it is safe on a session another terminal started (rule 7).
  const onHideSession = useCallback((sessionId: string, hide: boolean) => {
    setHiddenSessions((cur) => {
      const next = new Map(cur)
      if (hide) next.set(sessionId, Date.now())
      else next.delete(sessionId)
      saveHiddenSessions(next)
      return next
    })
  }, [])
  useEffect(() => {
    const reload = () => setHiddenSessions(loadHiddenSessions())
    window.addEventListener(HIDE_SESSION_EVENT, reload)
    return () => window.removeEventListener(HIDE_SESSION_EVENT, reload)
  }, [])
  // The rows' order set by hand, per project (lib/rowOrder.ts).
  const [rowOrders, setRowOrders] = useState<RowOrders>(() => loadRowOrders())
  useEffect(() => {
    const reload = () => setRowOrders(loadRowOrders())
    window.addEventListener(ROW_ORDER_EVENT, reload)
    return () => window.removeEventListener(ROW_ORDER_EVENT, reload)
  }, [])
  const onReorder = useCallback((projectId: string, keys: string[]) => saveRowOrder(projectId, keys), [])
  const allTabs = props.tabs
  const tabbed = useMemo(() => new Set((allTabs ?? []).map((t) => t.projectId)), [allTabs])
  const groups = useMemo(() => groupProjects(model.projects, { hidden, activeProjectId, tabbed }), [model.projects, hidden, activeProjectId, tabbed])
  // The project in front is listed even while hidden or among the rest.
  const listed = useMemo(() => {
    const front = [...groups.more, ...groups.hidden].find((n) => n.project.id === activeProjectId)
    return front ? [...groups.shown, front] : groups.shown
  }, [groups, activeProjectId])
  const moreProjects = groups.more.filter((n) => n.project.id !== activeProjectId)
  const hiddenProjects = groups.hidden.filter((n) => n.project.id !== activeProjectId)
  // Session rows hidden by hand that are still live: More… shows them again.
  const hiddenRows = useMemo(() => model.projects.flatMap((n) => n.worktrees.flatMap((w) => w.sessions)
    .filter((x) => !x.isShell && x.session.status !== 'ended' && rowHidden(x, hiddenSessions))
    .map((x) => ({ x, project: n.project.name }))), [model.projects, hiddenSessions])
  const moreCount = moreProjects.length + hiddenProjects.length + hiddenRows.length
  const moreTitle = [
    moreProjects.length ? `${moreProjects.length} more ${moreProjects.length === 1 ? 'project' : 'projects'}` : '',
    hiddenProjects.length + hiddenRows.length ? `${hiddenProjects.length + hiddenRows.length} hidden` : '',
  ].filter(Boolean).join(' · ')
  const [moreAt, setMoreAt] = useState<MenuAt | null>(null)
  // Flat (the default since 2026-10-14) or Tree (lib/sidebarMode.ts): Flat
  // is every listed project's sessions as one list in the tabs' order
  // (owner, 2026-10-13, translated: "make a switch like 'group by
  // projects' or not … that frees lots of room").
  const grouped = props.grouped ?? true
  const flat = useMemo(
    () => (grouped ? [] : flatRows(listed, allTabs ?? [], props.tabLabels ?? new Map(), rowOrders, hiddenSessions)),
    [grouped, listed, allTabs, props.tabLabels, rowOrders, hiddenSessions],
  )
  // A row moved in the flat list moves its tab in the strip, which the list
  // follows; the rows with no tab keep an order of their own after them.
  const onFlatReorder = useCallback((_: string, keys: string[]) => {
    const byKey = new Map(flat.map((r) => [leadKey(r), r] as const))
    const rows = keys.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => !!r)
    const tabIds = rows.flatMap((r) => (r.tab ? [r.tab.id] : []))
    if (tabIds.length) props.onOrderTabs?.(tabIds)
    saveRowOrder(FLAT_ORDER, rows.filter((r) => !r.tab).map(leadKey))
  }, [flat, props.onOrderTabs])
  const real = model.projects.filter((n) => n.project.root !== '')
  const projectCount = real.length
  const busyCount = real.filter((n) => n.live > 0 || n.waiting > 0).length
  // Every project's tabs: the current one lists them, and so does any
  // project where something runs or waits (ProjectRow decides it is open).
  const tabsByProject = useMemo(() => {
    const m = new Map<string, Tab[]>()
    for (const t of allTabs ?? []) {
      const list = m.get(t.projectId)
      if (list) list.push(t)
      else m.set(t.projectId, [t])
    }
    return m
  }, [allTabs])
  const noLabels = useMemo(() => new Map<string, TabLabel>(), [])
  const noTabs = useMemo<Tab[]>(() => [], [])
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
      const next = new Map(cur)
      if (hide) next.set(id, Date.now())
      else next.delete(id)
      saveHiddenProjects(next)
      return next
    })
  }, [])
  // The Settings row and its "phone" word land on the phone section; without
  // a section handler, plain Settings as before.
  const toPhone = () => (props.onSettingsSection ? props.onSettingsSection('phone') : props.onSettings?.())
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
  /**
   * A project's ×: its tabs close, and it moves under Hidden — unless
   * something still runs or waits in it, which hiding would lose: then it
   * stays, its dot green. Its shells end first, as a shell's tab does —
   * idle ones at once, busy ones after one question (`onStopProjectShells`);
   * its agents are never stopped. Closing the project
   * in front moves the front to the next tab, else the next project listed.
   */
  const { onCloseProjectTabs, onStopProjectShells, onActivateTab, onSelectProject, dashboardActive } = props
  const onCloseProject = useCallback((id: string) => {
    const node = model.projects.find((n) => n.project.id === id)
    if (!node) return
    const close = (stopped: number) => {
      onCloseProjectTabs?.(id)
      if (keepsProject(node, stopped)) return
      onHide(id, true)
      if (id !== activeProjectId || dashboardActive) return
      const nextTab = (allTabs ?? []).find((t) => t.projectId !== id)
      if (nextTab && onActivateTab) { onActivateTab(nextTab.id); return }
      const nextProject = groups.shown.find((n) => n.project.id !== id && n.project.root !== '')
      if (nextProject) onSelectProject(nextProject.project.id)
    }
    if (!onStopProjectShells) { close(0); return }
    void onStopProjectShells(id).then((o) => { if (!o.cancelled) close(o.stopped) })
  }, [model.projects, onCloseProjectTabs, onStopProjectShells, onHide, activeProjectId, dashboardActive, allTabs, onActivateTab, groups.shown, onSelectProject])
  const row = (n: ProjectNode) => {
    const current = n.project.id === activeProjectId
    return (
      <ProjectRow
        key={n.project.id}
        node={n}
        current={current}
        tabs={tabsByProject.get(n.project.id) ?? noTabs}
        tabDigits={props.tabDigits}
        rowOrder={rowOrders[n.project.id]}
        onReorder={onReorder}
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
        onCloseProject={onCloseProject}
        onCloseTab={props.onCloseTab}
        onMenu={onMenu}
        hiddenSessions={hiddenSessions}
        onHideSession={onHideSession}
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
        <IconButton label={`Search projects, sessions and actions (${keys('⌘K')})`} onClick={props.onPalette}><SearchIcon size={15} /></IconButton>
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
          title={`Start an agent in the project in front (${keys('⇧⌘N')})`}
          className="app-primary flex h-[32px] w-full items-center gap-2 rounded-[8px] border pl-2.5 pr-2 text-left text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
        >
          <PlusIcon size={15} />
          <span className="flex-1">New agent</span>
          <kbd className="app-kbd">{keys('⇧⌘N')}</kbd>
        </button>
        {props.onQuickChat && (
          <button
            type="button"
            onClick={props.onQuickChat}
            aria-label="Quick chat"
            aria-keyshortcuts="Alt+Meta+N"
            title={`Ask Claude something without picking a folder (${keys('⌥⌘N')})`}
            className="mt-1 flex h-[26px] w-full items-center gap-2 rounded-[7px] pl-2.5 pr-2 text-left text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
          >
            <ChatIcon size={14} />
            <span className="flex-1">Quick chat</span>
            <kbd className="app-kbd">{keys('⌥⌘N')}</kbd>
          </button>
        )}
        <button
          type="button"
          onClick={props.onAddProject}
          aria-label="Add project"
          aria-keyshortcuts="Meta+O"
          title={`Add a project — a folder, a new one, or a clone (${keys('⌘O')})`}
          className="mt-1 flex h-[26px] w-full items-center gap-2 rounded-[7px] pl-2.5 pr-2 text-left text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          <FolderPlusIcon size={14} />
          <span className="flex-1">Add project</span>
          <kbd className="app-kbd">{keys('⌘O')}</kbd>
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

        {/* How many, and how many have something running, so the heading
          * says something (owner, 2026-10-11: "nothing on the right"). */}
        <SectionHead label={grouped ? 'Projects' : 'Sessions'} action={projectCount > 0 ? (
          <span className="flex items-center gap-1">
            <span className="num text-[11.5px] text-fg-faint" title={`${projectCount} ${projectCount === 1 ? 'project' : 'projects'}, ${busyCount} with something running`}>
              {busyCount > 0 && <><span aria-hidden className="mr-1 inline-block h-[6px] w-[6px] rounded-full bg-ok align-middle" />{busyCount} of </>}{projectCount}
            </span>
            {props.onToggleGrouped && (
              <button
                type="button"
                data-group-toggle
                aria-pressed={grouped}
                aria-label="Group by project"
                title={grouped ? 'Tree: sessions under their projects. Turn off for one list in the tabs’ order (also in Settings → Appearance).' : 'Flat: one list in the tabs’ order. Turn on to list sessions under their projects (also in Settings → Appearance).'}
                onClick={props.onToggleGrouped}
                className={`flex h-[20px] w-[20px] items-center justify-center rounded-[5px] hover:bg-[var(--app-row-hover)] ${grouped ? 'text-fg-muted' : 'text-fg-faint'}`}
              >
                <FolderIcon size={13} />
              </button>
            )}
          </span>
        ) : undefined} />
        {model.projects.length === 0 ? (
          <div className="px-2 py-2 text-[12.5px] leading-relaxed text-fg-muted">
            No projects yet.{' '}
            <button type="button" onClick={props.onAddProject} className="text-accent hover:underline">Add a folder</button>{' '}
            or start an agent anywhere.
          </div>
        ) : (
          <>
            {grouped ? <ul className="grid grid-cols-1 gap-px">{listed.map(row)}</ul> : flat.length > 0 ? (
              <SessionList
                items={flat}
                orderId={FLAT_ORDER}
                ariaLabel="Sessions"
                digits={props.tabDigits}
                activeTabId={props.dashboardActive ? undefined : props.activeTabId}
                onActivateTab={props.onActivateTab ?? noop}
                onCloseTab={props.onCloseTab}
                onOpenLive={props.onOpenLive}
                onHideSession={onHideSession}
                onReorder={onFlatReorder}
              />
            ) : (
              <p className="px-2 py-1 text-[12px] text-fg-faint">No agent sessions running.</p>
            )}
            {/* One quiet line for the rest: other projects, and what was
              * hidden by hand (owner, 2026-10-13). */}
            {moreCount > 0 && (
              <button
                type="button"
                data-nav-row
                data-sidebar-more
                aria-haspopup="menu"
                aria-expanded={!!moreAt}
                title={moreTitle}
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMoreAt({ x: r.left, y: r.bottom + 2 }) }}
                className="mt-1 flex h-[26px] w-full items-center rounded-[6px] pl-[22px] pr-2 text-left text-[12px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg-muted"
              >
                More…
              </button>
            )}
          </>
        )}
        {props.source === 'derived' && model.projects.length > 0 && (
          <p className="px-2 pt-3 text-[11px] leading-snug text-fg-faint">
            Listed from where your sessions ran. Git state and clone arrive with the projects API.
          </p>
        )}
      </div>

      {folds.has('footer') ? (
        /* Collapsed (owner, 2026-10-11, translated: "can this block fold and
         * unfold"): the same four actions as icons, plus the way back. */
        <div className="flex shrink-0 items-center gap-1 border-t border-[var(--app-hairline)] px-2 py-1.5">
          <FeedbackButton variant="icon" />
          <IconButton label={`Dashboard (${keys('⌘0')})`} onClick={props.onDashboard}>
            <DashboardIcon size={15} />
          </IconButton>
          {props.onSettings && (
            <IconButton label={`Settings: phone, Telegram (${keys('⌘,')})`} onClick={toPhone}>
              <SettingsIcon size={15} />
            </IconButton>
          )}
          <ThemeButton />
          <span className="flex-1" />
          <FooterToggle open={false} onToggle={() => toggleFold('footer')} />
        </div>
      ) : (
      <div className="grid shrink-0 gap-1.5 border-t border-[var(--app-hairline)] px-2 py-2">
        {/* Feedback on a labelled row of its own: on screen whatever tab is in
          * front, where the header's button is only on the dashboard. As a bare
          * icon beside Settings and the theme switch it read as a volume
          * control. */}
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1"><FeedbackButton variant="row" /></div>
          <FooterToggle open onToggle={() => toggleFold('footer')} />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-nav-row
            aria-current={props.dashboardActive ? 'true' : undefined}
            onClick={props.onDashboard}
            className="app-row flex h-[32px] min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] px-2 text-left text-[13px] text-fg"
          >
            <DashboardIcon size={15} className="text-fg-muted" />
            <span className="flex-1">Dashboard</span>
            <kbd className="app-kbd-key">{keys('⌘0')}</kbd>
          </button>
          {!props.onSettings && <ThemeButton />}
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
          <div className="flex items-center gap-1">
            <div className="app-row relative flex h-[32px] min-w-0 flex-1 items-center gap-1 rounded-[8px] border border-[var(--app-hairline-strong)] pr-2 text-[13px] text-fg">
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
            <ThemeButton />
          </div>
        )}
      </div>
      )}
      {moreAt && (
        <MenuBox at={moreAt} label="More projects and hidden rows" width={260} onClose={() => setMoreAt(null)}>
          {moreProjects.map((n) => (
            <MenuItem key={n.project.id} icon={<FolderIcon size={14} />} label={n.project.name} hint="open" onClick={() => { setMoreAt(null); props.onSelectProject(n.project.id) }} />
          ))}
          {moreProjects.length > 0 && hiddenProjects.length + hiddenRows.length > 0 && <MenuSeparator />}
          {hiddenProjects.map((n) => (
            <MenuItem key={n.project.id} icon={<EyeIcon size={14} />} label={n.project.name} hint="show" onClick={() => { setMoreAt(null); onHide(n.project.id, false) }} />
          ))}
          {hiddenRows.map(({ x, project }) => (
            <MenuItem key={x.session.session_id} icon={<EyeIcon size={14} />} label={`${x.title} · ${project}`} hint="show" onClick={() => { setMoreAt(null); onHideSession(x.session.session_id, false) }} />
          ))}
        </MenuBox>
      )}
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
          onCopies={props.onCleanCopies && menuNode.project.kind === 'repo' ? () => props.onCleanCopies!(menuNode.project.id) : undefined}
          copies={menuNode.project.worktrees?.length ?? 0}
          onRemove={props.onRemoveProject ? () => props.onRemoveProject!(menuNode.project.id) : undefined}
          onClose={closeMenu}
        />
      )}
    </aside>
  )
}

/** A folded group at the bottom of the projects: Quiet or Hidden, closed until opened. */
function SectionHead({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="flex h-[28px] items-center gap-1.5 px-2 pt-1.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">{label}</h2>
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
function ThemeButton() {
  const { mode } = useThemeMode()
  const light = THEMES.find((t) => t.id === mode)?.theme === 'light'
  return (
    <ThemeMenu label={`Theme: ${THEME_MODE_NAME[mode]}`} placement="up"
      className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none">
      {light ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </ThemeMenu>
  )
}
