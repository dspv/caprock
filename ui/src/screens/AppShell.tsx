/**
 * The app workspace (WP-04, WP-06): sidebar, terminal tabs, inspector and
 * status strip — what the desktop app opens on (.ai/21-app.md § What the
 * user sees). Served at `#/app` or `?app=1`, and inside the Tauri shell.
 *
 * The dashboard's screens open inside it at their usual hash routes; the
 * terminals stay mounted behind them, so switching back never repaints from
 * nothing and never drops a socket that was in use.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useState } from 'react'
import { api, ApiError, errText, type SessionSummary } from '@/lib/api'
import { APP_ROUTE, isMacPlatform, isTauri, isWorkspaceHash } from '@/lib/appmode'
import { FIND_EVENT, matchAppShortcut, type AppCommand } from '@/lib/appkeys'
import { parseHash } from '@/lib/router'
import { NotSupportedError, projectsApi, type Project } from '@/lib/projects'
import { buildSidebar, dotOf, sessionTitle, type InboxItem, type ProjectNode, type SessionNode, type WorktreeNode } from '@/lib/sidebar'
import {
  activeTab,
  focusedLeaf,
  leaves,
  loadWorkspace,
  saveWorkspace,
  tabsOf,
  workspaceReducer,
  type TabTarget,
} from '@/lib/tabs'
import { useWorkspaceData } from '@/lib/useWorkspaceData'
import { useShellTray } from '@/lib/tray'
import { OPEN_SESSION_EVENT } from '@/lib/shell'
import { useOsNotifications } from '@/lib/notify'
import { useTheme } from '@/lib/theme'
import { useDaemonVersion } from '@/lib/useDaemonVersion'
import { Sidebar } from '@/components/Sidebar'
import { TabStrip, TerminalStack } from '@/components/TerminalTabs'
import { Inspector } from '@/components/Inspector'
import { StatusStrip } from '@/components/StatusStrip'
import { AppUpdateToast } from '@/components/AppUpdateToast'
import { AppUpdateAsk } from '@/components/AppUpdateAsk'
import { appUpdate } from '@/lib/appupdate'
import { PermissionPrompt } from '@/components/PermissionPrompt'
import { ChatView } from '@/components/ChatView'
import { ChangesView } from '@/components/ChangesView'
import { NewAgentSheet } from '@/components/NewAgentSheet'
import { AddProjectSheet, splitPath } from '@/components/AddProjectSheet'
import { CommandPalette, type PaletteItem } from '@/components/CommandPalette'
import { BranchIcon, DashboardIcon, ExternalIcon, FolderIcon, FolderPlusIcon, InspectorIcon, PlusIcon, SearchIcon, SettingsIcon, SparkIcon, TerminalIcon } from '@/components/AppIcons'
import type { PaneStatus } from '@/components/TerminalPane'
import { EditorMenu, type EditorMenuAt } from '@/components/EditorMenu'
import { preferredName, useEditors } from '@/lib/editors'
import { applyTerminalChrome, getTerminalPrefs, subscribeTerminalPrefs } from '@/lib/termprefs'
import { warmTerminal } from '@/lib/termwarm'
import { StatusDot, fmtCostShort } from '@/components/ProjectRow'
import { fmtAgo } from '@/lib/format'
import { RecentInProject } from '@/components/RecentInProject'
import { ShortcutsSheet } from '@/components/ShortcutsSheet'
import { worktreeSlug } from '@/lib/slug'

export { worktreeSlug }

const Dashboard = lazy(() => import('@/App').then((m) => ({ default: m.Dashboard })))
const PairScreen = lazy(() => import('@/screens/Pair').then((m) => ({ default: m.PairScreen })))

const UI_KEY = 'caprock.app.ui'

interface UiPrefs {
  sidebar: boolean
  inspector: boolean
}

/** What is kept: `cockpit` is the inspector's open state since it became the
 *  agent cockpit, open by default. The older `inspector` flag (closed by
 *  default, so stored false by nearly everyone) is no longer read. */
interface StoredPrefs { sidebar?: boolean; cockpit?: boolean }

export function loadPrefs(): UiPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as StoredPrefs
    return { sidebar: v.sidebar !== false, inspector: v.cockpit !== false }
  } catch {
    return { sidebar: true, inspector: true }
  }
}

/** The worktree whose Changes view covers the terminals. */
interface ChangesTarget {
  projectId: string
  /** git's name for a linked worktree; '' for the main checkout. */
  worktree: string
  title: string
  /** Its latest agent session, for "Use the agent's summary". */
  sessionId?: string
}

/** The Changes target for a worktree of a project in the sidebar: the main checkout when none is named. */
export function changesTargetOf(node: ProjectNode, w?: WorktreeNode): ChangesTarget {
  const wt = w ?? node.worktrees.find((x) => x.isMain)
  const latest = wt?.sessions.find((x) => !x.isShell)
  const branch = wt?.branch || node.project.branch || ''
  return {
    projectId: node.project.id,
    worktree: wt && !wt.isMain ? wt.key : '',
    title: branch ? `${node.project.name} · ${branch}` : node.project.name,
    sessionId: latest?.session.session_id,
  }
}

type SheetState =
  | { kind: 'agent'; projectId?: string; cwd?: string; prompt?: string; worktree?: string }
  | { kind: 'project' }
  | { kind: 'palette' }
  | { kind: 'keys' }
  | null


/** The dashboard's screens, reachable from the palette by name: [route, label, what is on it]. */
const SCREENS: [string, string, string][] = [
  ['now', 'Now', 'every session on the machine, live'],
  ['cost', 'Cost', 'spend by day, project and model'],
  ['history', 'Lifetime', 'every session, every day, in totals'],
  ['week', 'Week', 'one week, as a card'],
  ['notes', 'Memory', 'what the agents said, searchable'],
  ['tasks', 'Tasks', 'the board'],
]

/** The next session waiting on you after the one in front, wrapping; the first when the one in front is not waiting. Stale ones are skipped. */
export function nextWaiting(all: InboxItem[], currentSessionId?: string): InboxItem | undefined {
  const inbox = all.filter((i) => !i.stale)
  if (inbox.length === 0) return undefined
  const at = inbox.findIndex((i) => i.session.session_id === currentSessionId)
  return inbox[(at + 1) % inbox.length]
}

function useHash(): string {
  const [hash, setHash] = useState(() => location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

/** Asks, as the dashboard does, whether this browser may see anything at all. */
export default function AppRoot() {
  const [access, setAccess] = useState<'checking' | 'ok' | 'needs-pairing'>('checking')
  useEffect(() => {
    let alive = true
    api.status()
      .then(() => alive && setAccess('ok'))
      .catch((e: unknown) => alive && setAccess(e instanceof ApiError && e.status === 401 ? 'needs-pairing' : 'ok'))
    return () => { alive = false }
  }, [])
  // The first tab of a launch opens on a warm terminal (lib/termwarm.ts).
  useEffect(() => warmTerminal(), [])
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-app', '')
    if (isTauri()) root.setAttribute('data-tauri', '')
    return () => {
      root.removeAttribute('data-app')
      root.removeAttribute('data-tauri')
    }
  }, [])
  if (access === 'checking') return null
  if (access === 'needs-pairing') return <Suspense fallback={null}><PairScreen /></Suspense>
  return <AppShell />
}

export function AppShell() {
  const isMac = isMacPlatform()
  const hash = useHash()
  const workspaceShown = isWorkspaceHash(hash)
  const data = useWorkspaceData()
  const [ws, dispatch] = useReducer(workspaceReducer, undefined, loadWorkspace)
  const [prefs, setPrefs] = useState<UiPrefs>(loadPrefs)
  const [sheet, setSheet] = useState<SheetState>(null)
  const [toast, setToast] = useState('')
  const [paneStatus, setPaneStatus] = useState<Record<string, PaneStatus>>({})
  // Sessions whose tab shows the chat over the terminal; the terminal stays
  // mounted behind it.
  const [chatOpen, setChatOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [changesView, setChangesView] = useState<ChangesTarget | null>(null)
  const version = useDaemonVersion()
  const [, toggleTheme] = useTheme()
  const editors = useEditors()
  const [folderMenu, setFolderMenu] = useState<EditorMenuAt | null>(null)

  useEffect(() => { saveWorkspace(ws) }, [ws])
  // The slab around the terminals follows their palette (Settings → Terminal).
  useEffect(() => {
    applyTerminalChrome(getTerminalPrefs())
    return subscribeTerminalPrefs((p) => applyTerminalChrome(p))
  }, [])
  // The sidebar and tab strip lay out around the macOS traffic lights and
  // carry their own drag regions, so the shell's padding and strip go
  // (app/README.md § Title bar).
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-caprock-chrome', '')
    return () => root.removeAttribute('data-caprock-chrome')
  }, [])
  useEffect(() => {
    const stored: StoredPrefs = { sidebar: prefs.sidebar, cockpit: prefs.inspector }
    try { localStorage.setItem(UI_KEY, JSON.stringify(stored)) } catch { /* not kept */ }
  }, [prefs])
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 6000)
    return () => window.clearTimeout(id)
  }, [toast])

  const openSessions = useMemo(() => new Set(ws.tabs.flatMap((t) => leaves(t.root).map((l) => l.target.sessionId))), [ws.tabs])
  const model = useMemo(
    () => buildSidebar({ projects: data.projects, sessions: data.sessions, permissions: data.permissions, costs: data.costs, openSessions }),
    [data.projects, data.sessions, data.permissions, data.costs, openSessions],
  )
  const sessionsById = useMemo(() => new Map(data.sessions.map((s) => [s.session_id, s])), [data.sessions])
  // From the model, so Other folders resolves like a project.
  const projectsById = useMemo(() => new Map(model.projects.map((n) => [n.project.id, n.project])), [model.projects])

  const activeProjectId = ws.activeProject && (projectsById.has(ws.activeProject) || ws.tabs.some((t) => t.projectId === ws.activeProject))
    ? ws.activeProject
    : model.projects[0]?.project.id ?? ''
  const shownWs = activeProjectId === ws.activeProject ? ws : { ...ws, activeProject: activeProjectId }
  const tabs = tabsOf(shownWs, activeProjectId)
  const current = activeTab(shownWs)
  const focused = current ? focusedLeaf(current).target : undefined
  const focusedSession = focused ? sessionsById.get(focused.sessionId) : undefined
  const activeProject = projectsById.get(activeProjectId)
  const shownRoute = parseHash(hash)
  // OS notifications in the Tauri shell (WP-09), quiet for the session in front.
  useOsNotifications(workspaceShown ? focused?.sessionId : shownRoute.name === 'session' ? shownRoute.id : undefined)

  // Keep tab titles current, so a restored tab is named before the list answers.
  useEffect(() => {
    for (const t of ws.tabs) {
      const s = sessionsById.get(focusedLeaf(t).target.sessionId)
      if (s && sessionTitle(s) !== t.title) dispatch({ type: 'retitle', sessionId: s.session_id, title: sessionTitle(s) })
    }
  }, [sessionsById, ws.tabs])

  const showWorkspace = useCallback(() => {
    if (!isWorkspaceHash(location.hash)) location.hash = APP_ROUTE
  }, [])

  const openTab = useCallback((target: TabTarget, projectId: string, title: string) => {
    setChangesView(null)
    dispatch({ type: 'open', target, projectId, title })
    showWorkspace()
  }, [showWorkspace])

  /** Beside the focused pane of the tab in front (F15); a new tab when there is none. */
  const openSplit = useCallback((target: TabTarget, projectId: string, title: string, direction: 'row' | 'column' = 'row') => {
    setChangesView(null)
    dispatch({ type: 'split', target, projectId, title, direction })
    showWorkspace()
  }, [showWorkspace])

  /** A session's terminal when Caprock holds one; its details otherwise (rule 7). */
  const openSession = useCallback((s: SessionSummary, projectId: string) => {
    const attachable = s.owned && s.status !== 'ended' && !s.detached
    if (!attachable && !openSessions.has(s.session_id)) {
      location.hash = `#/session/${encodeURIComponent(s.session_id)}`
      return
    }
    openTab({ kind: s.kind === 'shell' ? 'shell' : 'session', sessionId: s.session_id }, projectId, sessionTitle(s))
  }, [openSessions, openTab])

  const onOpenNode = useCallback((n: SessionNode, projectId: string) => openSession(n.session, projectId), [openSession])
  const onOpenInbox = useCallback((i: InboxItem) => openSession(i.session, i.projectId), [openSession])
  const jumpToWaiting = useCallback(() => {
    const item = nextWaiting(model.inbox, focused?.sessionId)
    if (item) onOpenInbox(item)
    else setToast('Nothing is waiting on you.')
  }, [model.inbox, focused?.sessionId, onOpenInbox])

  // The menu bar or tray and the badge (WP-10); a waiting session clicked
  // there arrives as an event from the shell.
  useShellTray(model.inbox)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail
      if (typeof id !== 'string') return
      const item = model.inbox.find((i) => i.session.session_id === id)
      if (item) onOpenInbox(item)
      else location.hash = `#/session/${encodeURIComponent(id)}`
    }
    window.addEventListener(OPEN_SESSION_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SESSION_EVENT, onOpen)
  }, [model.inbox, onOpenInbox])
  const onSelectProject = useCallback((id: string) => {
    setChangesView((cur) => (cur && cur.projectId !== id ? null : cur))
    dispatch({ type: 'project', projectId: id })
    showWorkspace()
  }, [showWorkspace])

  const { source, refresh } = data
  /** The Changes view of a worktree (the main checkout when none is named); needs the projects API. */
  const onOpenChanges = useCallback((projectId: string, w?: WorktreeNode) => {
    const node = model.projects.find((n) => n.project.id === projectId)
    if (!node || source !== 'api') return
    setChangesView(changesTargetOf(node, w))
    dispatch({ type: 'project', projectId })
    showWorkspace()
  }, [model.projects, source, showWorkspace])
  const closeSheet = useCallback(() => setSheet(null), [])
  const onProjectAdded = useCallback((projectId: string, first?: { root: string; task: string }) => {
    refresh()
    dispatch({ type: 'project', projectId })
    if (!first) return
    // A first task starts an agent on the new project straight away, in a tab.
    api.spawn({ cwd: first.root, prompt: first.task })
      .then(({ session_id }) => { openTab({ kind: 'session', sessionId: session_id }, projectId, first.task.slice(0, 60)); refresh() })
      .catch((e) => setToast(`The project is added, but the agent did not start: ${errText(e)}`))
  }, [refresh, openTab])
  const newShell = useCallback(async (projectId?: string, cwd?: string, split?: 'row' | 'column') => {
    const p: Project | undefined = projectsById.get(projectId ?? activeProjectId)
    if (!p || (!p.root && !cwd)) { setSheet({ kind: 'project' }); return }
    try {
      const projectNumber = Number(p.id)
      const req = source === 'api' && !cwd && Number.isInteger(projectNumber)
        ? { project_id: projectNumber, cols: 120, rows: 32 }
        : { cwd: cwd ?? p.root, cols: 120, rows: 32 }
      const shell = await projectsApi.startShell(req)
      if (split) openSplit({ kind: 'shell', sessionId: shell.id }, p.id, 'shell', split)
      else openTab({ kind: 'shell', sessionId: shell.id }, p.id, 'shell')
      refresh()
    } catch (e) {
      setToast(e instanceof NotSupportedError ? `${e.message} Start an agent with ⇧⌘N meanwhile.` : `Could not start a shell: ${errText(e)}`)
    }
  }, [projectsById, activeProjectId, source, refresh, openTab, openSplit])

  /**
   * A session's program exited — `/exit`, `exit`, a crash. The tab is the
   * user's place to work, so it becomes a shell in the same folder instead of
   * a terminal showing a process that is gone. The tab keeps its position,
   * and a shell that was already a shell is simply left closed. Every
   * window showing the tab asks (the app, a browser, a phone); `replaces`
   * makes the daemon start one shell for them all.
   */
  const onPaneExit = useCallback(async (sessionId: string) => {
    const s = sessionsById.get(sessionId)
    const cwd = s?.cwd
    if (!cwd || s?.kind === 'shell') { dispatch({ type: 'drop-session', sessionId }); return }
    try {
      const shell = await projectsApi.startShell({ cwd, cols: 120, rows: 32, replaces: sessionId })
      dispatch({ type: 'replace-session', sessionId, target: { kind: 'shell', sessionId: shell.id }, title: 'shell' })
      refresh()
    } catch {
      // Nothing to put in its place; closing beats a tab that cannot talk to
      // anything, and the session's record is on the dashboard either way.
      dispatch({ type: 'drop-session', sessionId })
    }
  }, [sessionsById, refresh])

  const onNewAgent = useCallback((projectId?: string, cwd?: string) => setSheet({ kind: 'agent', projectId: projectId ?? activeProjectId, cwd }), [activeProjectId])
  const onNewShell = useCallback((projectId?: string, cwd?: string) => { void newShell(projectId, cwd) }, [newShell])
  const onAddProject = useCallback(() => setSheet({ kind: 'project' }), [])
  const onPalette = useCallback(() => setSheet({ kind: 'palette' }), [])
  const onDashboard = useCallback(() => { location.hash = '#/' }, [])
  const onSettings = useCallback(() => { location.hash = '#/settings' }, [])
  const onPaneStatus = useCallback((sessionId: string, s: PaneStatus) => setPaneStatus((cur) => ({ ...cur, [sessionId]: s })), [])
  const onFocusPane = useCallback((tabId: string, paneId: string) => dispatch({ type: 'focus-pane', tabId, paneId }), [])
  const onClosePane = useCallback((tabId: string, paneId: string) => dispatch({ type: 'close-pane', tabId, paneId }), [])
  const onResizePanes = useCallback((tabId: string, splitId: string, sizes: number[]) => dispatch({ type: 'resize', tabId, splitId, sizes }), [])

  // ⌘W closes the focused pane of a split tab, else the tab; the session runs on either way.
  const detach = useCallback(() => {
    if (!current) return
    if (current.root.type === 'split') dispatch({ type: 'close-pane', tabId: current.id, paneId: focusedLeaf(current).id })
    else dispatch({ type: 'close', tabId: current.id })
  }, [current])
  /** A new shell beside the focused pane, in the same folder, as a terminal's split does. */
  const splitShell = useCallback((direction: 'row' | 'column') => {
    if (!current) { onNewShell(); return }
    const cwd = focusedSession?.cwd || undefined
    void newShell(current.projectId, cwd, direction)
  }, [current, focusedSession, newShell, onNewShell])

  const run = useCallback((c: AppCommand) => {
    switch (c.kind) {
      // In the folder of the session in front — its worktree, not the project's root.
      case 'new-shell': if (workspaceShown && current) onNewShell(current.projectId, focusedSession?.cwd || undefined); else onNewShell(); break
      case 'new-agent': onNewAgent(); break
      case 'add-project': onAddProject(); break
      case 'detach-tab': if (workspaceShown) detach(); break
      case 'palette': onPalette(); break
      case 'inspector': setPrefs((p) => ({ ...p, inspector: !p.inspector })); showWorkspace(); break
      case 'sidebar': setPrefs((p) => ({ ...p, sidebar: !p.sidebar })); break
      case 'dashboard': if (workspaceShown) onDashboard(); else location.hash = APP_ROUTE; break
      case 'next-tab': dispatch({ type: 'cycle', delta: 1 }); showWorkspace(); break
      case 'prev-tab': dispatch({ type: 'cycle', delta: -1 }); showWorkspace(); break
      case 'tab': dispatch({ type: 'activate-index', index: c.index }); showWorkspace(); break
      case 'split': if (workspaceShown) splitShell(c.direction); break
      case 'next-pane': dispatch({ type: 'cycle-pane', delta: 1 }); break
      case 'prev-pane': dispatch({ type: 'cycle-pane', delta: -1 }); break
      case 'next-waiting': jumpToWaiting(); break
      case 'find': if (workspaceShown) window.dispatchEvent(new Event(FIND_EVENT)); break
      case 'settings': onSettings(); break
    }
  }, [onNewShell, onNewAgent, onAddProject, workspaceShown, detach, onPalette, showWorkspace, onDashboard, splitShell, jumpToWaiting, current, focusedSession?.cwd, onSettings])

  // The app's keys, before anything else on the page sees them. The terminal
  // already lets them through (xtermInput), and they are never its keys.
  //
  // A layout effect, so the listener is swapped in the same commit that paints
  // new state. As a passive effect it ran a beat after the paint, and a key
  // pressed in that beat acted on the state before it: ⌘J with the waiting
  // session already in the sidebar said "Nothing is waiting on you", and ⌘T
  // with a project on screen asked to add one. A busy main thread (a terminal
  // streaming) widens the beat.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.type !== 'keydown' || e.repeat && !/^[1-9]$/.test(e.key)) return
      const c = matchAppShortcut(e, isMac)
      if (!c) return
      // A sheet owns the keyboard, except to close itself or switch to the palette.
      if (sheet && c.kind !== 'palette') return
      e.preventDefault()
      e.stopPropagation()
      run(c)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isMac, run, sheet])

  // The dashboard's "open the terminal" links land on a tab here instead.
  useEffect(() => {
    const r = parseHash(hash)
    if (r.name !== 'session' || r.tab !== 'terminal') return
    const s = sessionsById.get(r.id)
    if (!s || !s.owned || s.status === 'ended') return
    const node = model.projects.find((n) => n.worktrees.some((w) => w.sessions.some((x) => x.session.session_id === s.session_id)))
    openTab({ kind: s.kind === 'shell' ? 'shell' : 'session', sessionId: s.session_id }, node?.project.id ?? activeProjectId, sessionTitle(s))
  }, [hash, sessionsById, model.projects, activeProjectId, openTab])

  const openInEditor = useCallback((path: string, label: string, editor?: string, line?: number) => {
    api.openInEditor({ path, editor, line: line || undefined }).catch((e: unknown) => setToast(`Could not open ${label}: ${errText(e)}`))
  }, [])
  const onFolderMenu = useCallback((e: React.MouseEvent, path: string, label: string) => {
    if (!editors) return
    e.preventDefault()
    setFolderMenu({ x: e.clientX, y: e.clientY, path, label })
  }, [editors])
  const closeFolderMenu = useCallback(() => setFolderMenu(null), [])

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = model.inbox.map((i) => ({
      id: `w-${i.session.session_id}`,
      group: 'Waiting' as const,
      label: i.title,
      detail: `${i.projectName} · ${i.reason === 'permission' ? 'asks for permission' : 'your turn'}`,
      icon: <StatusDot dot="waiting" />,
      run: () => onOpenInbox(i),
    }))
    const split = current && current.root.type === 'split'
    items.push(
      { id: 'a-agent', group: 'Actions', label: 'New agent', hint: '⇧⌘N', icon: <PlusIcon size={14} />, run: () => onNewAgent() },
      { id: 'a-shell', group: 'Actions', label: 'New shell', hint: '⌘T', icon: <TerminalIcon size={14} />, run: () => onNewShell() },
      { id: 'a-project', group: 'Actions', label: 'Add a project', hint: '⌘O', icon: <FolderPlusIcon size={14} />, run: onAddProject },
      { id: 'a-inspector', group: 'Actions', label: prefs.inspector ? 'Hide the inspector' : 'Show the inspector', hint: '⌘I', icon: <InspectorIcon size={14} />, run: () => run({ kind: 'inspector' }) },
      { id: 'a-dashboard', group: 'Actions', label: 'Open the dashboard', hint: '⇧⌘D', icon: <DashboardIcon size={14} />, run: onDashboard },
      { id: 'a-settings', group: 'Actions', label: 'Settings', detail: 'permission mode, theme, terminal, notifications, phone', hint: '⌘,', icon: <SettingsIcon size={14} />, run: onSettings },
      { id: 'a-keys', group: 'Actions', label: 'Keyboard shortcuts', detail: 'every key the app answers to', icon: <SearchIcon size={14} />, run: () => setSheet({ kind: 'keys' }) },
      { id: 'a-theme', group: 'Actions', label: 'Switch theme', icon: <SparkIcon size={14} />, run: toggleTheme },
      ...SCREENS.map(([route, label, detail]) => ({ id: `a-screen-${route}`, group: 'Actions' as const, label, detail, icon: <DashboardIcon size={14} />, run: () => { location.hash = `#/${route}` } })),
      { id: 'a-waiting', group: 'Actions', label: 'Next session waiting on you', hint: '⌘J', icon: <SparkIcon size={14} />, run: jumpToWaiting },
    )
    // F20: the app's own updater; the answer shows in the status strip.
    if (isTauri()) items.push({ id: 'a-update', group: 'Actions', label: 'Check for updates', icon: <SparkIcon size={14} />, run: () => { void appUpdate.check() } })
    if (current) {
      items.push(
        { id: 'a-find', group: 'Actions', label: 'Find in the terminal', hint: '⌘F', icon: <SearchIcon size={14} />, run: () => window.dispatchEvent(new Event(FIND_EVENT)) },
        { id: 'a-split-right', group: 'Actions', label: 'Split right: a new shell beside', hint: '⌘E', icon: <TerminalIcon size={14} />, run: () => splitShell('row') },
        { id: 'a-split-down', group: 'Actions', label: 'Split down: a new shell below', hint: '⇧⌘E', icon: <TerminalIcon size={14} />, run: () => splitShell('column') },
      )
    }
    if (split) {
      items.push(
        { id: 'a-pane-next', group: 'Actions', label: 'Focus the next pane', hint: '⌘]', icon: <TerminalIcon size={14} />, run: () => dispatch({ type: 'cycle-pane', delta: 1 }) },
        { id: 'a-pane-close', group: 'Actions', label: 'Close the pane', hint: '⌘W', icon: <TerminalIcon size={14} />, run: detach },
      )
    }
    if (editors) {
      const name = preferredName(editors)
      const folder = focusedSession?.cwd
      if (folder) items.push({ id: 'a-editor-cwd', group: 'Actions', label: `Open this folder in ${name}`, detail: folder, icon: <ExternalIcon size={14} />, run: () => openInEditor(folder, 'the folder') })
    }
    for (const t of ws.tabs) {
      const s = sessionsById.get(focusedLeaf(t).target.sessionId)
      items.push({ id: `t-${t.id}`, group: 'Tabs', label: s ? sessionTitle(s) : t.title, detail: projectsById.get(t.projectId)?.name, icon: <TerminalIcon size={14} />, run: () => { dispatch({ type: 'activate', tabId: t.id }); showWorkspace() } })
    }
    for (const n of model.projects) {
      for (const w of n.worktrees) {
        for (const x of w.sessions) {
          if (x.dot === 'ended' || openSessions.has(x.session.session_id)) continue
          const attachable = x.session.owned && !x.session.detached
          items.push({
            id: `s-${x.session.session_id}`, group: 'Sessions', label: x.title, detail: `${n.project.name} · ${w.branch}`, icon: <SparkIcon size={14} />,
            run: () => openSession(x.session, n.project.id),
            runAlt: attachable && current ? () => openSplit({ kind: x.isShell ? 'shell' : 'session', sessionId: x.session.session_id }, n.project.id, x.title) : undefined,
          })
        }
      }
      items.push({ id: `p-${n.project.id}`, group: 'Projects', label: n.project.name, detail: n.project.root, icon: <FolderIcon size={14} />, run: () => onSelectProject(n.project.id) })
      if (source === 'api' && n.project.kind === 'repo') {
        const wts = n.worktrees.length > 0 ? n.worktrees : [undefined]
        for (const w of wts) {
          const t = changesTargetOf(n, w)
          const changed = w?.changed ?? n.project.changed ?? 0
          items.push({ id: `pc-${n.project.id}-${t.worktree}`, group: 'Projects', label: `Review changes: ${t.title}`, detail: changed ? `±${changed}` : 'clean', icon: <BranchIcon size={14} />, run: () => onOpenChanges(n.project.id, w) })
        }
      }
      if (n.project.root) {
        items.push({ id: `pa-${n.project.id}`, group: 'Projects', label: `New agent in ${n.project.name}`, detail: n.project.branch, icon: <PlusIcon size={14} />, run: () => onNewAgent(n.project.id) })
        if (editors) {
          const root = n.project.root
          items.push({ id: `pe-${n.project.id}`, group: 'Projects', label: `Open ${n.project.name} in ${preferredName(editors)}`, detail: root, icon: <ExternalIcon size={14} />, run: () => openInEditor(root, n.project.name) })
        }
      }
    }
    return items
  }, [ws.tabs, model.projects, model.inbox, sessionsById, projectsById, openSessions, prefs.inspector, current, onNewAgent, onNewShell, onAddProject, onDashboard, toggleTheme, onSettings, run, showWorkspace, openSession, openSplit, onSelectProject, onOpenInbox, jumpToWaiting, splitShell, detach, editors, focusedSession?.cwd, openInEditor, source, onOpenChanges])

  // Every session the daemon knows, by what it was about; one that is open or
  // live is already in the list above under its own id.
  const paletteSearch = useCallback(async (q: string): Promise<PaletteItem[]> => {
    const { items } = await api.sessionsWithTotal(false, q, 20)
    const live = new Set(model.projects.flatMap((n) => n.worktrees.flatMap((w) => w.sessions.map((x) => x.session.session_id))))
    return items
      .filter((s) => s.kind !== 'shell' && !live.has(s.session_id) && !openSessions.has(s.session_id))
      .map((s) => {
        const project = model.projects.find((n) => n.project.root && (s.cwd === n.project.root || s.cwd.startsWith(`${n.project.root}/`)))
        const cost = fmtCostShort(s.stats?.cost_usd ?? 0)
        return {
          id: `s-${s.session_id}`,
          group: 'History' as const,
          label: sessionTitle(s),
          detail: [s.project, fmtAgo(s.worked_at || s.last_event_at), cost].filter(Boolean).join(' · '),
          icon: <StatusDot dot={dotOf(s, false)} />,
          run: () => openSession(s, project?.project.id ?? activeProjectId),
        }
      })
  }, [model.projects, openSessions, openSession, activeProjectId])

  // Orca's "new task": text that matches nothing starts an agent on it, in a worktree named after it.
  const paletteFallback = useCallback((q: string): PaletteItem | undefined => {
    const project = projectsById.get(activeProjectId)
    if (!project?.root) return undefined
    const worktree = worktreeSlug(q)
    return {
      id: 'new-task', group: 'Actions', label: `New agent on “${q}”`,
      detail: worktree ? `${project.name} · new worktree ${worktree}` : project.name,
      icon: <PlusIcon size={14} />,
      run: () => setSheet({ kind: 'agent', projectId: project.id, prompt: q, worktree: worktree || undefined }),
    }
  }, [projectsById, activeProjectId])

  // The worktree the focused session runs in, for the inspector's "Review and commit".
  const focusedWorktree = useMemo(() => {
    if (!focused || source !== 'api') return undefined
    for (const n of model.projects) {
      for (const w of n.worktrees) {
        if (w.sessions.some((x) => x.session.session_id === focused.sessionId)) return { projectId: n.project.id, w, repo: n.project.kind === 'repo' }
      }
    }
    return undefined
  }, [focused, model.projects, source])

  const focusedIsAgent = !!focused && focused.kind === 'session' && focusedSession?.kind !== 'shell'
  const showChat = focusedIsAgent && !!focused && chatOpen.has(focused.sessionId)
  // The permission card shows for the focused agent whether or not its
  // terminal is in front. 0.78.2 hid it behind the terminal as a duplicate
  // (owner, 2026-10-06); the next day he wanted it back — it names the call
  // in full, its keys (Y, A, N) work from the terminal, and it is the only
  // surface with a working "don't ask again" by key. Other tabs are reached
  // through their badge, the Inbox, the menu bar and the notification.
  const promptCard = focusedIsAgent && !!focused
  const toggleChat = useCallback(() => {
    if (!focused) return
    const id = focused.sessionId
    setChatOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [focused])

  return (
    <div className="flex h-dvh flex-col text-fg">
      <div className="flex min-h-0 flex-1">
        {prefs.sidebar && (
          <div className="h-full shrink-0" style={{ width: 'var(--app-sidebar-w)' }}>
            <Sidebar
              model={model}
              source={data.source}
              activeProjectId={activeProjectId}
              activeSessionId={focused?.sessionId}
              dashboardActive={!workspaceShown}
              onSelectProject={onSelectProject}
              onOpenSession={onOpenNode}
              onOpenInbox={onOpenInbox}
              onNewAgent={onNewAgent}
              onNewShell={onNewShell}
              onFolderMenu={editors ? onFolderMenu : undefined}
              onAddProject={onAddProject}
              onDashboard={onDashboard}
              onSettings={onSettings}
              onPalette={onPalette}
              onOpenChanges={data.source === 'api' ? onOpenChanges : undefined}
            />
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--app-chrome-bg)]">
          {workspaceShown && (
            <TabStrip
              tabs={tabs}
              activeTabId={current?.id}
              sessions={sessionsById}
              permissions={data.permissions}
              inspectorOpen={prefs.inspector}
              sidebarOpen={prefs.sidebar}
              onActivate={(id) => { setChangesView(null); dispatch({ type: 'activate', tabId: id }) }}
              onDetach={(id) => dispatch({ type: 'close', tabId: id })}
              onMove={(id, to) => dispatch({ type: 'move', tabId: id, toIndex: to })}
              onNewAgent={() => onNewAgent()}
              onNewShell={() => onNewShell()}
              onToggleInspector={() => setPrefs((p) => ({ ...p, inspector: !p.inspector }))}
              chatOpen={showChat}
              onToggleChat={focusedIsAgent ? toggleChat : undefined}
            />
          )}
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <div className="absolute inset-0 flex flex-col" hidden={!workspaceShown}>
                <div className="relative min-h-0 flex-1">
                  <TerminalStack
                    tabs={ws.tabs}
                    visibleTabId={workspaceShown ? current?.id : undefined}
                    onPaneStatus={onPaneStatus}
                    onPaneExit={onPaneExit}
                    sessions={sessionsById}
                    permissions={data.permissions}
                    onFocusPane={onFocusPane}
                    onClosePane={onClosePane}
                    onResize={onResizePanes}
                  />
                  {showChat && focused && (
                    <ChatView
                      key={focused.sessionId}
                      sessionId={focused.sessionId}
                      canType={!!focusedSession && focusedSession.owned && focusedSession.status !== 'ended' && !focusedSession.detached}
                      className="app-slab absolute inset-0 z-10"
                    />
                  )}
                  {changesView && (
                    <ChangesView
                      key={`${changesView.projectId}:${changesView.worktree}`}
                      target={changesView}
                      title={changesView.title}
                      sessionId={changesView.sessionId}
                      onClose={() => setChangesView(null)}
                      className="absolute inset-0 z-20"
                    />
                  )}
                  {!current && (
                    <EmptyWorkspace
                      project={activeProject}
                      hasProjects={model.projects.length > 0}
                      onNewAgent={() => onNewAgent()}
                      onNewShell={() => onNewShell()}
                      onAddProject={onAddProject}
                      recent={activeProject?.root ? (
                        <RecentInProject
                          key={`${activeProject.root}:${data.sessions.length}`}
                          root={activeProject.root}
                          permissions={data.permissions}
                          onOpen={(s) => openSession(s, activeProject.id)}
                          onContinued={(id, title) => { openTab({ kind: 'session', sessionId: id }, activeProject.id, title); data.refresh() }}
                        />
                      ) : undefined}
                    />
                  )}
                </div>
                {promptCard && !prefs.inspector && focused && (
                  <div className="shrink-0 border-t border-[var(--app-hairline)] px-3 empty:hidden [&>*]:mb-2">
                    <PermissionPrompt sessionId={focused.sessionId} />
                  </div>
                )}
              </div>
              {!workspaceShown && (
                <div
                  className={`app-scroll absolute inset-0 overflow-y-auto bg-bg ${prefs.sidebar ? '' : 'pt-[var(--caprock-titlebar-inset,0px)]'}`}
                >
                  <Suspense fallback={null}>
                    <Dashboard route={parseHash(hash)} />
                  </Suspense>
                </div>
              )}
            </div>
            {workspaceShown && prefs.inspector && (
              <div className="h-full shrink-0" style={{ width: 'var(--app-inspector-w)' }}>
                <Inspector
                  session={focusedSession}
                  sessionId={focused?.sessionId}
                  hasPermission={!!focused && data.permissions.has(focused.sessionId)}
                  showPrompt={promptCard}
                  onClose={() => setPrefs((p) => ({ ...p, inspector: false }))}
                  onDetach={detach}
                  editors={editors}
                  onOpenInEditor={openInEditor}
                  onReviewChanges={focusedWorktree?.repo ? () => onOpenChanges(focusedWorktree.projectId, focusedWorktree.w) : undefined}
                  summary={data.summary}
                />
              </div>
            )}
          </div>
        </main>
      </div>
      <StatusStrip summary={data.summary} pane={focused ? paneStatus[focused.sessionId] : undefined} version={version} />
      <AppUpdateToast />
      {isTauri() && <AppUpdateAsk />}

      {toast && (
        <div role="status" className="app-fade-in pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center px-4">
          <p className="pointer-events-auto max-w-[560px] rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel px-4 py-2.5 text-[12.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">{toast}</p>
        </div>
      )}
      {sheet?.kind === 'agent' && (
        <NewAgentSheet
          projects={model.projects.map((n) => n.project).filter((p) => p.root || p.id === sheet.projectId)}
          projectId={sheet.projectId}
          cwd={sheet.cwd}
          prompt={sheet.prompt}
          worktree={sheet.worktree}
          onClose={() => setSheet(null)}
          onStarted={(id, projectId, title) => { openTab({ kind: 'session', sessionId: id }, projectId, title); data.refresh() }}
        />
      )}
      {sheet?.kind === 'project' && (
        <AddProjectSheet
          source={data.source}
          defaultParent={activeProject?.root ? splitPath(activeProject.root).parent : ''}
          ops={data.ops}
          onClose={closeSheet}
          onAdded={onProjectAdded}
          onAddLocal={(p) => { data.addLocal(p); dispatch({ type: 'project', projectId: `dir:${p.root}` }) }}
        />
      )}
      {folderMenu && <EditorMenu at={folderMenu} editors={editors} onClose={closeFolderMenu} onError={setToast} />}
      {sheet?.kind === 'keys' && <ShortcutsSheet isMac={isMac} onClose={closeSheet} />}
      {sheet?.kind === 'palette' && <CommandPalette items={paletteItems} fallback={paletteFallback} search={paletteSearch} onClose={closeSheet} />}
    </div>
  )
}

function EmptyWorkspace({
  project,
  hasProjects,
  onNewAgent,
  onNewShell,
  onAddProject,
  recent,
}: {
  project?: Project
  hasProjects: boolean
  onNewAgent: () => void
  onNewShell: () => void
  onAddProject: () => void
  /** The project's recent sessions, to carry one on from here. */
  recent?: React.ReactNode
}) {
  return (
    <div className="app-slab app-scroll absolute inset-0 flex items-center justify-center overflow-y-auto px-8 py-8">
      <div className="grid w-full max-w-[520px] grid-cols-[minmax(0,1fr)] gap-6">
        <div className="grid gap-1.5">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-fg">
            {project ? project.name : hasProjects ? 'Pick a project' : 'Add a project to begin'}
          </h1>
          <p className="mono truncate text-[12px] text-fg-faint">
            {project ? `${project.root}${project.branch ? ` · ${project.branch}` : ''}` : 'Every folder you work in, its branches and its sessions, in one place.'}
          </p>
        </div>
        <div className="grid gap-1">
          {project && <EmptyAction icon={<PlusIcon size={15} />} label="New agent" hint="⇧⌘N" onClick={onNewAgent} />}
          {project && <EmptyAction icon={<TerminalIcon size={15} />} label="New shell" hint="⌘T" onClick={onNewShell} />}
          <EmptyAction icon={<FolderPlusIcon size={15} />} label="Add a project" hint="⌘O" onClick={onAddProject} />
        </div>
        {recent}
      </div>
    </div>
  )
}

function EmptyAction({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="app-row flex h-[38px] items-center gap-3 rounded-[8px] px-3 text-left text-[13.5px] text-fg">
      <span className="text-fg-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      <kbd className="mono text-[11.5px] text-fg-faint">{hint}</kbd>
    </button>
  )
}
