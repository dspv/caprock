/**
 * The app workspace (WP-04, WP-06): sidebar, terminal tabs, inspector and
 * status strip — what the desktop app opens on (.ai/21-app.md § What the
 * user sees). Served at `#/app` or `?app=1`, and inside the Tauri shell.
 *
 * One tab strip holds every open tab of every project, and the dashboard's
 * screens open in a Dashboard tab pinned at its left, at their usual hash
 * routes; the terminals stay mounted behind them, so switching back is one
 * click, never repaints from nothing and never drops a socket that was in use.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api, ApiError, errText, type SessionSummary, type SpawnRequest } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { APP_ROUTE, isMacPlatform, isTauri, isWorkspaceHash } from '@/lib/appmode'
import { stepUiScale } from '@/lib/uiscale'
import { installExternalLinks } from '@/lib/externalLinks'
import { FIND_EVENT, keys, matchAppShortcut, type AppCommand } from '@/lib/appkeys'
import { parseHash } from '@/lib/router'
import { NotSupportedError, projectsApi, type Project } from '@/lib/projects'
import { buildSidebar, dotOf, OTHER_FOLDERS_ID, sessionTitle, type InboxItem, type ProjectNode, type WorktreeNode } from '@/lib/sidebar'
import {
  activeTab,
  focusedLeaf,
  leaves,
  loadWorkspace,
  saveWorkspace,
  workspaceReducer,
  type PaneLeaf,
  type Tab,
  type TabTarget,
} from '@/lib/tabs'
import { tabLabels } from '@/lib/tablabels'
import { isShellLeaf, liveShells, planChatClose, planClose, planProjectClose, shellNames, type ChatClosePlan, type ClosePlan, type ClosingShell, type ProjectShellsOutcome } from '@/lib/closeShell'
import { baseName, fileKey } from '@/lib/files'
import { useWorkspaceData } from '@/lib/useWorkspaceData'
import { useShellTray } from '@/lib/tray'
import { OPEN_SESSION_EVENT } from '@/lib/shell'
import { useOsNotifications } from '@/lib/notify'
import { useTheme } from '@/lib/theme'
import { useDaemonVersion } from '@/lib/useDaemonVersion'
import { hideSessionRow, Sidebar } from '@/components/Sidebar'
import { TabStrip, TerminalStack } from '@/components/TerminalTabs'
import { Inspector } from '@/components/Inspector'
import { SessionDeck } from '@/components/SessionDeck'
import { readDeck, saveDeck, type DeckPrefs } from '@/lib/deck'
import { StatusStrip } from '@/components/StatusStrip'
import { StarStrip } from '@/components/StarStrip'
import { SetupStrip } from '@/components/SetupStrip'
import { ShareMoment } from '@/components/Nudges'
import { ShareDialog } from '@/components/Share'
import { usePromptSync } from '@/lib/nudges'
import { AppUpdateToast } from '@/components/AppUpdateToast'
import { AppUpdateAsk } from '@/components/AppUpdateAsk'
import { appUpdate } from '@/lib/appupdate'
import { PermissionPrompt } from '@/components/PermissionPrompt'
import { ChatView } from '@/components/ChatView'
import { ChangesView } from '@/components/ChangesView'
import { AttemptsCompare } from '@/components/AttemptsCompare'
import { FileView } from '@/components/FileView'
import { attachable, ObservePane } from '@/components/ObservePane'
import { FilePicker } from '@/components/FilePicker'
import { NewAgentSheet } from '@/components/NewAgentSheet'
import type { HandoffTarget } from '@/components/AgentHandoff'
import { liveOwnedSession } from '@/lib/handoff'
import { CloseSettingsContext } from '@/lib/settingsClose'
import { SetupShellContext } from '@/lib/setupShell'
import { QuickChatSheet, quickChatRequest, quickChoiceLabel, rememberQuickChoice, rememberedQuickChoice, type QuickChoice } from '@/components/QuickChat'
import { dismissHint, hintDismissed, isQuickChat, quickChatHint, rememberStartedChat, startedChat } from '@/lib/quickchat'
import type { ChatPane } from '@/components/QuickChatPane'
import { useSpawnableAgents } from '@/components/AgentPicker'
import { AddProjectSheet } from '@/components/AddProjectSheet'
import { CommandPalette, type PaletteItem } from '@/components/CommandPalette'
import { BranchIcon, ChatIcon, DashboardIcon, DeckIcon, ExternalIcon, FileIcon, FolderIcon, FolderPlusIcon, InspectorIcon, PlusIcon, SearchIcon, SettingsIcon, SparkIcon, TerminalIcon } from '@/components/AppIcons'
import type { PaneStatus } from '@/components/TerminalPane'
import { EditorMenu, type EditorMenuAt } from '@/components/EditorMenu'
import { joinPath, preferredName, useEditors } from '@/lib/editors'
import { applyTerminalChrome, getTerminalPrefs, subscribeTerminalPrefs } from '@/lib/termprefs'
import { warmTerminal } from '@/lib/termwarm'
import { StatusDot, fmtCostShort } from '@/components/ProjectRow'
import { fmtAgo } from '@/lib/format'
import { RecentInProject } from '@/components/RecentInProject'
import { ProjectRepos } from '@/components/ProjectRepos'
import { isMultiRepo } from '@/lib/multirepo'
import { CloseChatConfirm, CloseShellConfirm } from '@/components/CloseShellConfirm'
import { ShortcutsSheet } from '@/components/ShortcutsSheet'
import { CopiesSheet } from '@/components/CopiesSheet'
import { CleanupLine } from '@/components/CleanupLine'
import { worktreeSlug } from '@/lib/slug'
import { openPhoneSettings, openSettingsAt } from '@/components/Pairing'
import { reloadSaved, savedFor, sendPrompt, useSavedPrompts, type SavedPrompt } from '@/lib/saved'
import { SAVED_SECTION_ID } from '@/components/SavedPromptsSetting'

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
  | {
      kind: 'agent'; projectId?: string; cwd?: string; prompt?: string; worktree?: string
      /** Start in `cwd` itself (This folder for the main checkout), not the remembered choice. */
      here?: boolean
      /** Open on the From GitHub picker: an open issue or pull request to start from. */
      fromGitHub?: boolean
      /** Runs once the agent has started: a handed-off prompt was delivered. */
      onStarted?: () => void
    }
  | { kind: 'project' }
  | { kind: 'palette' }
  | { kind: 'keys' }
  /** ⌘K "Share my numbers": the share sheet. */
  | { kind: 'share' }
  /** Quick chat's vendor and model chooser (components/QuickChat.tsx). */
  | { kind: 'quick-chat' }
  /** *Run saved…*: the palette narrowed to the saved prompts and commands (ADR-051). */
  | { kind: 'saved' }
  /** The palette's "Open file…": the files of one worktree. */
  | { kind: 'files'; projectId: string; worktree: string; title: string }
  /** *Clean up copies…*: a project's worktrees, their state and size (components/CopiesSheet). */
  | { kind: 'copies'; projectId: string; name: string; preselect?: string[] }
  | null


/** The dashboard's screens, reachable from the palette by name: [route, label, what is on it]. */
const SCREENS: [string, string, string][] = [
  ['now', 'Now', 'every session on the machine, live'],
  ['cost', 'Cost', 'spend by day, project and model'],
  ['history', 'Lifetime', 'every session, every day, in totals'],
  ['week', 'Week', 'one week, as a card'],
  ['notes', 'Memory', 'what the agents said, searchable'],
  ['tasks', 'Tasks', 'the board'],
  ['queue', 'Queue', 'what each agent is doing, what waits, roughly when it is done'],
]

/** The next session waiting on you after the one in front, wrapping; the first when the one in front is not waiting. Stale ones are skipped. */
export function nextWaiting(all: InboxItem[], currentSessionId?: string): InboxItem | undefined {
  const inbox = all.filter((i) => !i.stale)
  if (inbox.length === 0) return undefined
  const at = inbox.findIndex((i) => i.session.session_id === currentSessionId)
  return inbox[(at + 1) % inbox.length]
}

/**
 * The location hash, and a way to move it that the next render already sees.
 * `hashchange` arrives after React has rendered the click that changed the
 * hash; closing the front Dashboard tab rendered once more on the old hash,
 * and that render opened the tab again (the strip kept a "Settings" tab after
 * its × was clicked).
 */
function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(() => location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = useCallback((h: string) => {
    location.hash = h
    setHash(location.hash)
  }, [])
  return [hash, go]
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
  // Links meant for the browser open there, never in the webview.
  useEffect(() => installExternalLinks(), [])
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
  const [hash, goHash] = useHash()
  const workspaceShown = isWorkspaceHash(hash)
  const data = useWorkspaceData()
  const [ws, dispatch] = useReducer(workspaceReducer, undefined, loadWorkspace)
  const [prefs, setPrefs] = useState<UiPrefs>(loadPrefs)
  // The session deck under an agent's terminal: open or not, and its height (lib/deck.ts).
  const [deck, setDeck] = useState<DeckPrefs>(readDeck)
  useEffect(() => { saveDeck(deck) }, [deck])
  const [sheet, setSheet] = useState<SheetState>(null)
  // Offer answers live on the daemon so the app and a browser tab agree.
  usePromptSync()
  const [toast, setToast] = useState('')
  /** A close that waits on the question about a busy shell. */
  const [closing, setClosing] = useState<
    | { kind: 'tab'; tabId: string; paneId?: string; plan: ClosePlan; chats: readonly string[] }
    | { kind: 'chat'; tabId: string; paneId?: string; chat: ChatClosePlan }
    | { kind: 'project'; name: string; plan: ClosePlan; resolve: (o: ProjectShellsOutcome) => void }
    | null
  >(null)
  const [paneStatus, setPaneStatus] = useState<Record<string, PaneStatus>>({})
  // Quick chats whose agent exited in this window: their tab shows that, in place.
  const [endedChats, setEndedChats] = useState<ReadonlySet<string>>(() => new Set())
  // Sessions whose tab shows the chat over the terminal; the terminal stays
  // mounted behind it.
  const [chatOpen, setChatOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [changesView, setChangesView] = useState<ChangesTarget | null>(null)
  // Compare attempts (ADR-052): over the terminals, as the Changes view is.
  const [compare, setCompare] = useState<{ group: string; title: string } | null>(null)
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
  // The sidebar's per-project sparkline: one small query a minute, resting
  // while the window is hidden.
  const activity = useApi(() => api.activity(), [], { live: false, intervalMs: 60_000, keepUnchanged: true })
  const model = useMemo(
    () => buildSidebar({ projects: data.projects, sessions: data.sessions, permissions: data.permissions, costs: data.costs, openSessions, activity: activity.data?.sessions }),
    [data.projects, data.sessions, data.permissions, data.costs, openSessions, activity.data],
  )
  const sessionsById = useMemo(() => new Map(data.sessions.map((s) => [s.session_id, s])), [data.sessions])
  // From the model, so Other folders resolves like a project.
  const projectsById = useMemo(() => new Map(model.projects.map((n) => [n.project.id, n.project])), [model.projects])

  const activeProjectId = ws.activeProject && (projectsById.has(ws.activeProject) || ws.tabs.some((t) => t.projectId === ws.activeProject))
    ? ws.activeProject
    : model.projects[0]?.project.id ?? ''
  const shownWs = activeProjectId === ws.activeProject ? ws : { ...ws, activeProject: activeProjectId }
  // The strip shows every open tab of every project — a tab never leaves it
  // because another project was picked — and the sidebar lists the current
  // project's under the same names (lib/tablabels.ts).
  const tabs = ws.tabs
  const labels = useMemo(
    () => tabLabels(ws.tabs, sessionsById, data.permissions, (id) => projectsById.get(id)?.branch),
    [ws.tabs, sessionsById, data.permissions, projectsById],
  )
  const current = activeTab(shownWs)
  const focused = current ? focusedLeaf(current).target : undefined
  const focusedSession = focused ? sessionsById.get(focused.sessionId) : undefined
  // An agent's session is in front: what the session deck and the chat apply to.
  const frontIsAgent = !!focused && focused.kind === 'session' && focusedSession?.kind !== 'shell'
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

  // The Dashboard tab: in the strip from the moment a dashboard screen is
  // shown until it is closed, and it brings back the screen last shown in it.
  const lastDashboard = useRef('#/')
  if (!workspaceShown) lastDashboard.current = hash
  useEffect(() => {
    if (!workspaceShown && !ws.dashboard) dispatch({ type: 'dashboard', open: true })
  }, [workspaceShown, ws.dashboard])
  const dashboardRoute = parseHash(workspaceShown ? lastDashboard.current : hash)
  const closeDashboard = useCallback(() => {
    dispatch({ type: 'dashboard', open: false })
    lastDashboard.current = '#/'
    // In the same render as the dispatch: on the old hash the tab reopened.
    if (!isWorkspaceHash(location.hash)) goHash(APP_ROUTE)
  }, [goHash])
  const projectName = useCallback((id: string) => projectsById.get(id)?.name, [projectsById])
  /** A tab picked in the strip or in the sidebar's list. */
  const onActivateTab = useCallback((id: string) => {
    setChangesView(null)
    setCompare(null)
    dispatch({ type: 'activate', tabId: id })
    showWorkspace()
  }, [showWorkspace])

  const openTab = useCallback((target: TabTarget, projectId: string, title: string) => {
    setChangesView(null)
    setCompare(null)
    dispatch({ type: 'open', target, projectId, title })
    showWorkspace()
  }, [showWorkspace])

  /** Beside the focused pane of the tab in front (F15); a new tab when there is none. */
  const openSplit = useCallback((target: TabTarget, projectId: string, title: string, direction: 'row' | 'column' = 'row') => {
    setChangesView(null)
    setCompare(null)
    dispatch({ type: 'split', target, projectId, title, direction })
    showWorkspace()
  }, [showWorkspace])

  /** A project's file, read-only, in a tab of its own; the same file opens once. */
  const openFile = useCallback((projectId: string, worktree: string, path: string) => {
    openTab({ kind: 'file', sessionId: fileKey(projectId, worktree, path), path, worktree }, projectId, baseName(path))
  }, [openTab])

  /**
   * A session in a tab: its terminal when Caprock holds one; otherwise — one
   * started in another terminal, or one that ended — its conversation,
   * read-only, in a tab of its own (components/ObservePane.tsx; rule 7). It
   * opened the Dashboard tab on the session's page until 2026-10-13 (owner,
   * translated: "why am I taken to something like the web version of the
   * dashboard instead of into the session?").
   */
  const openSession = useCallback((s: SessionSummary, projectId: string) => {
    const kind = s.kind === 'shell' ? 'shell' : attachable(s) ? 'session' : 'observe'
    openTab({ kind, sessionId: s.session_id }, projectId, sessionTitle(s))
  }, [openTab])

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

  /**
   * Where the Changes view's prompts go (components/AgentHandoff.tsx): the
   * newest running session Caprock started in that worktree — the only kind
   * it may type into (rule 7) — else New agent opened in the worktree with
   * the prompt as its first message.
   */
  const changesHandoff = useMemo<HandoffTarget | undefined>(() => {
    if (!changesView) return undefined
    const node = model.projects.find((n) => n.project.id === changesView.projectId)
    const wt = node?.worktrees.find((w) => (changesView.worktree ? !w.isMain && w.key === changesView.worktree : w.isMain))
    if (!node || !wt) return undefined
    const live = liveOwnedSession(wt.sessions.map((x) => x.session))
    const projectId = node.project.id
    return {
      session: live ? { id: live.session_id, title: sessionTitle(live) } : undefined,
      startAgent: (prompt, onStarted) => setSheet({ kind: 'agent', projectId, cwd: wt.path, here: true, prompt, onStarted }),
      openSession: (id) => {
        const s = wt.sessions.find((x) => x.session.session_id === id)?.session
        if (s) openSession(s, projectId)
      },
    }
  }, [changesView, model.projects, openSession])
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
    const pid = projectId ?? activeProjectId
    const p: Project | undefined = projectsById.get(pid)
    // A folder is enough: a quick chat's tab has no project, but its folder takes a shell.
    if (!cwd && !p?.root) { setSheet({ kind: 'project' }); return }
    try {
      const projectNumber = Number(p?.id)
      const req = source === 'api' && !cwd && Number.isInteger(projectNumber)
        ? { project_id: projectNumber, cols: 120, rows: 32 }
        : { cwd: cwd ?? p!.root, cols: 120, rows: 32 }
      const shell = await projectsApi.startShell(req)
      if (split) openSplit({ kind: 'shell', sessionId: shell.id }, pid, 'shell', split)
      else openTab({ kind: 'shell', sessionId: shell.id }, pid, 'shell')
      refresh()
    } catch (e) {
      setToast(e instanceof NotSupportedError ? `${e.message} Start an agent with ${keys('⇧⌘N')} meanwhile.` : `Could not start a shell: ${errText(e)}`)
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
    // A quick chat's folder is Caprock's own, under its data directory: a
    // shell there is a terminal in a place nobody chose, and it looked just
    // like the chat (owner, 2026-10-12: "now I can't get out of there",
    // translated). The tab says the chat ended, with Close tab and Start again.
    if (isQuickChat(s) || startedChat(sessionId)) {
      setEndedChats((cur) => (cur.has(sessionId) ? cur : new Set(cur).add(sessionId)))
      return
    }
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

  /**
   * An agent's install or sign-in (ADR-046): a shell tab in the home folder —
   * or the current project, when the daemon did not say where home is — with
   * the command typed at the prompt and not run. The user reads it and
   * presses Enter.
   */
  const setupAgent = useCallback(async (command: string, home?: string) => {
    const p = projectsById.get(activeProjectId)
    const cwd = home || p?.root
    if (!cwd) { setToast(`Run this in a terminal: ${command}`); return }
    try {
      const shell = await projectsApi.startShell({ cwd, cols: 120, rows: 32, type: command })
      openTab({ kind: 'shell', sessionId: shell.id }, p?.id ?? activeProjectId, 'setup')
      refresh()
    } catch (e) {
      setToast(`Could not open a shell: ${errText(e)}. Run this in a terminal: ${command}`)
    }
  }, [projectsById, activeProjectId, openTab, refresh])
  const onSetupAgent = useCallback((command: string, home?: string) => { void setupAgent(command, home) }, [setupAgent])

  const onNewAgent = useCallback((projectId?: string, cwd?: string) => setSheet({ kind: 'agent', projectId: projectId ?? activeProjectId, cwd }), [activeProjectId])
  const onNewShell = useCallback((projectId?: string, cwd?: string) => { void newShell(projectId, cwd) }, [newShell])
  const onAddProject = useCallback(() => setSheet({ kind: 'project' }), [])
  const onPalette = useCallback(() => setSheet({ kind: 'palette' }), [])
  const onDashboard = useCallback(() => { location.hash = lastDashboard.current || '#/' }, [])
  /**
   * A session that needs no folder — the Now screen's Quick chat — in a tab
   * of the strip. The daemon finds it a home in its data directory; it shows
   * under Outside projects, its tab named "Quick chat · <model>"
   * (lib/quickchat.ts). Every way in, ⌥⌘N included, opens the chooser with
   * the last agent and model picked (components/QuickChat.tsx says why).
   * `replaces` is an ended chat whose tab the new one takes: Start again.
   */
  const spawnable = useSpawnableAgents()
  const startQuickChat = useCallback(async (choice: QuickChoice, replaces?: string) => {
    try {
      const { session_id } = await api.spawn(quickChatRequest(choice))
      rememberQuickChoice(choice)
      rememberStartedChat(session_id, { agent: choice.agent, model: choice.model, label: quickChoiceLabel(choice) })
      if (replaces) {
        dispatch({ type: 'replace-session', sessionId: replaces, target: { kind: 'session', sessionId: session_id }, title: 'Quick chat' })
        setEndedChats((cur) => { const next = new Set(cur); next.delete(replaces); return next })
      } else {
        openTab({ kind: 'session', sessionId: session_id }, OTHER_FOLDERS_ID, 'Quick chat')
      }
      refresh()
    } catch (e) {
      setToast(`Could not start a quick chat: ${errText(e)}`)
    }
  }, [openTab, refresh])
  const onQuickChatChooser = useCallback(() => setSheet({ kind: 'quick-chat' }), [])
  // What a quick chat's pane shows around its terminal (components/QuickChatPane.tsx).
  const [hintOff, setHintOff] = useState(hintDismissed)
  const onChatHintDismiss = useCallback(() => { dismissHint(); setHintOff(true) }, [])
  const chatPanesNow = new Map<string, ChatPane>()
  for (const t of ws.tabs) {
    for (const l of leaves(t.root)) {
      if (l.target.kind !== 'session') continue
      const id = l.target.sessionId
      const s = sessionsById.get(id)
      if (!isQuickChat(s) && !startedChat(id)) continue
      const ended = endedChats.has(id) || s?.status === 'ended'
      chatPanesNow.set(id, { ended, ...(hintOff ? {} : { hint: quickChatHint(s ?? { session_id: id }, keys('⌘W')) }) })
    }
  }
  // The same map until what it says changes: the terminal stack is memoised,
  // and the session list answers several times a second.
  const chatKey = JSON.stringify([...chatPanesNow])
  const chatPanesRef = useRef<{ key: string; map: ReadonlyMap<string, ChatPane> }>({ key: '', map: new Map() })
  if (chatPanesRef.current.key !== chatKey) chatPanesRef.current = { key: chatKey, map: chatPanesNow }
  const chatPanes = chatPanesRef.current.map
  /** An ended chat's Start again: the agent and model it was started on, else the last ones picked. */
  const onChatRestart = useCallback((sessionId: string) => {
    const was = startedChat(sessionId)
    const s = sessionsById.get(sessionId)
    const agent = (was?.agent ?? s?.agent ?? 'claude') as QuickChoice['agent']
    void startQuickChat(was ? { agent, model: was.model } : { ...rememberedQuickChoice(spawnable), agent }, sessionId)
  }, [sessionsById, startQuickChat, spawnable])
  // The strip's + menu (components/NewMenu.tsx): what opens a tab, with its key.
  const fileScopeRef = useRef<{ projectId: string; worktree: string; title: string } | undefined>(undefined)
  const newItems = useMemo(() => [
    { id: 'agent', label: 'New agent', hint: keys('⇧⌘N'), icon: <PlusIcon size={13} />, run: () => onNewAgent() },
    { id: 'quick-chat', label: 'Quick chat…', hint: keys('⌥⌘N'), icon: <ChatIcon size={13} />, run: onQuickChatChooser },
    { id: 'shell', label: 'New shell', hint: keys('⌘T'), icon: <TerminalIcon size={13} />, run: () => onNewShell() },
    { id: 'saved', label: 'Run saved…', icon: <SparkIcon size={13} />, run: () => setSheet({ kind: 'saved' }) },
    { id: 'file', label: 'Open file…', icon: <FileIcon size={13} />, run: () => { const f = fileScopeRef.current; if (f) setSheet({ kind: 'files', ...f }); else setToast('Open a project first: files are opened from one.') } },
    { id: 'project', label: 'Add project', hint: keys('⌘O'), icon: <FolderPlusIcon size={13} />, run: onAddProject },
  ], [onNewAgent, onQuickChatChooser, onNewShell, onAddProject])
  const onSettings = useCallback(() => { location.hash = '#/settings' }, [])

  /**
   * One prompt, N attempts (ADR-052). Each attempt opens in a tab, in order,
   * and the first comes to the front; Compare is a click away in ⌘K and the
   * inspector. An attempt that did not start is said, beside the ones that did.
   */
  const onAttempts = useCallback((ids: string[], projectId: string, title: string, error?: string) => {
    ids.forEach((id, i) => openTab({ kind: 'session', sessionId: id }, projectId, `attempt ${i + 1}/${ids.length} · ${title}`))
    if (ids[0]) openTab({ kind: 'session', sessionId: ids[0] }, projectId, `attempt 1/${ids.length} · ${title}`)
    refresh()
    setToast(error
      ? `${ids.length} attempts started; ${error}`
      : `${ids.length} attempts started, one copy each. Compare them from ${keys('⌘K')} or the inspector.`)
  }, [openTab, refresh])
  /** The comparison of a session's group of attempts. */
  const onCompare = useCallback((s: SessionSummary) => {
    if (!s.attempt_group) return
    setChangesView(null)
    setCompare({ group: s.attempt_group, title: sessionTitle({ ...s, attempts: 0 }) })
    showWorkspace()
  }, [showWorkspace])
  /** The project and worktree a session runs in, from the sidebar's model. */
  const placeOf = useCallback((id: string): { node: ProjectNode; w: WorktreeNode } | undefined => {
    for (const node of model.projects) {
      const w = node.worktrees.find((x) => x.sessions.some((y) => y.session.session_id === id))
      if (w) return { node, w }
    }
    return undefined
  }, [model.projects])

  /**
   * Saved prompts and commands (ADR-051). A prompt goes to the session in
   * front when Caprock started it and it runs — typed as the message field
   * types, then Enter; otherwise New agent opens with it as the first
   * message, never into a session Caprock did not start (rule 7). A command
   * runs in a new shell tab in the folder in front: the focused session's
   * worktree, else the project's root.
   */
  const saved = useSavedPrompts()
  // Asked again as a list of them opens: one may have been saved in another window.
  useEffect(() => { if (sheet?.kind === 'saved' || sheet?.kind === 'palette') void reloadSaved() }, [sheet?.kind])
  const runSaved = useCallback(async (v: SavedPrompt) => {
    const s = workspaceShown ? focusedSession : undefined
    const pid = current?.projectId ?? activeProjectId
    if (v.kind === 'command') {
      const cwd = s?.cwd || projectsById.get(pid)?.root
      if (!cwd) { setToast(`Open a project first: “${v.name}” runs in one.`); return }
      try {
        const shell = await projectsApi.startShell({ cwd, cols: 120, rows: 32, type: v.text, run: true })
        openTab({ kind: 'shell', sessionId: shell.id }, pid, 'shell')
        refresh()
      } catch (e) {
        setToast(`Could not run “${v.name}”: ${errText(e)}`)
      }
      return
    }
    if (s && s.owned && s.kind !== 'shell' && s.status !== 'ended' && !s.detached) {
      try {
        await sendPrompt(s.session_id, v.text)
        setToast(`Sent “${v.name}” to ${sessionTitle(s)}.`)
      } catch (e) {
        setToast(`“${v.name}” was not sent: ${errText(e)}`)
      }
      return
    }
    setSheet({ kind: 'agent', projectId: pid, prompt: v.text })
  }, [workspaceShown, focusedSession, current?.projectId, activeProjectId, projectsById, openTab, refresh])
  const savedItems = useMemo<PaletteItem[]>(() => {
    const scope = savedFor(saved.items, { dir: workspaceShown ? focusedSession?.cwd : undefined, projectId: current?.projectId ?? activeProjectId })
    return scope.map((v) => ({
      id: `saved-${v.id}`,
      group: 'Saved' as const,
      label: v.name,
      detail: v.kind === 'command' ? `run: ${v.text}` : v.text.replace(/\s+/g, ' '),
      icon: v.kind === 'command' ? <TerminalIcon size={14} /> : <ChatIcon size={14} />,
      run: () => { void runSaved(v) },
    }))
  }, [saved.items, workspaceShown, focusedSession?.cwd, current?.projectId, activeProjectId, runSaved])
  const manageSaved = useMemo<PaletteItem>(() => ({
    id: 'a-saved-manage', group: 'Actions', label: 'Add or edit saved prompts and commands', detail: 'Settings', icon: <SettingsIcon size={14} />, run: () => openSettingsAt(SAVED_SECTION_ID),
  }), [])
  const onPaneStatus = useCallback((sessionId: string, s: PaneStatus) => setPaneStatus((cur) => ({ ...cur, [sessionId]: s })), [])
  const onFocusPane = useCallback((tabId: string, paneId: string) => dispatch({ type: 'focus-pane', tabId, paneId }), [])
  const stopShells = useCallback((stop: readonly ClosingShell[]) => {
    if (stop.length === 0) return
    void Promise.all(stop.map((sh) => api.signal(sh.sessionId, 'kill').catch((e) => setToast(`Could not stop the shell: ${errText(e)}`))))
      .then(() => refresh())
  }, [refresh])
  /** End quick chats whose tab closed: the cockpit's *Stop the session* (`kill`), never asked twice. */
  const stopChats = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    void Promise.all(ids.map((id) => api.signal(id, 'kill').catch((e) => setToast(`Could not stop the chat: ${errText(e)}`))))
      .then(() => refresh())
  }, [refresh])
  const finishClose = useCallback((tabId: string, paneId: string | undefined, stop: readonly ClosingShell[], chats: readonly string[] = []) => {
    dispatch(paneId ? { type: 'close-pane', tabId, paneId } : { type: 'close', tabId })
    stopShells(stop)
    stopChats(chats)
  }, [stopShells, stopChats])
  // What requestClose reads, kept current without making it, and so every
  // close button, a new function on each poll.
  const closeCtx = useRef({ tabs: ws.tabs, sessionsById, sessions: data.sessions, labels, model, endedChats })
  closeCtx.current = { tabs: ws.tabs, sessionsById, sessions: data.sessions, labels, model, endedChats }
  /** The daemon's shells now, id to program; the last poll's when it cannot answer. */
  const liveNow = useCallback(async () => {
    try {
      return liveShells(await projectsApi.shells())
    } catch {
      return liveShells(closeCtx.current.sessions.filter((s) => s.kind === 'shell').map((s) => ({ id: s.session_id, program: s.program })))
    }
  }, [])
  /** The shells' half of a close, once the quick chats' is decided: `chats` end with the tab. */
  const closeShells = useCallback(async (tabId: string, paneId: string | undefined, chats: readonly string[]) => {
    const { tabs, sessionsById, labels } = closeCtx.current
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const panes = paneId ? leaves(tab.root).filter((l) => l.id === paneId) : leaves(tab.root)
    if (!panes.some((l) => isShellLeaf(l, sessionsById))) { finishClose(tabId, paneId, [], chats); return }
    const plan = planClose(tab, paneId, sessionsById, await liveNow(), labels.get(tabId)?.shellName)
    if (plan.busy.length === 0) finishClose(tabId, paneId, plan.stop, chats)
    else setClosing({ kind: 'tab', tabId, paneId, plan, chats })
  }, [finishClose, liveNow])
  /**
   * Close a tab, or one pane of it (.ai/21-app.md § Shell tabs, § Quick
   * chat). An agent runs on: closing its tab never stops it — except a quick
   * chat Caprock started, which has nothing to come back to and ends with its
   * tab (idle at once; still answering, after one question). A shell is
   * closed for real, as in any terminal app: idle, it ends with its tab;
   * running a program, it asks first. The daemon's shell list is read at this
   * moment, so the answer is about now, not the last poll; only shells on
   * that list and chats Caprock owns are ever stopped (rule 7).
   */
  const requestClose = useCallback(async (tabId: string, paneId?: string) => {
    const { tabs, sessionsById, endedChats } = closeCtx.current
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    // A chat whose agent already exited (its tab says so) has nothing to stop.
    const chat = planChatClose(tab, paneId, sessionsById, (s) => !endedChats.has(s.session_id) && (isQuickChat(s) || !!startedChat(s.session_id)), (id) => !endedChats.has(id) && !!startedChat(id))
    if (chat.busy.length > 0) { setClosing({ kind: 'chat', tabId, paneId, chat }); return }
    await closeShells(tabId, paneId, chat.stop)
  }, [closeShells])
  /**
   * *Close project* ends the project's shells too, tab or no tab, the way a
   * shell's tab does: idle ones without asking, busy ones after one question
   * listing them all. Its agents are not touched. The sidebar then closes
   * the tabs and decides whether to hide the project.
   */
  const onStopProjectShells = useCallback(async (projectId: string): Promise<ProjectShellsOutcome> => {
    const { tabs, labels, model } = closeCtx.current
    const node = model.projects.find((n) => n.project.id === projectId)
    const ids = (node?.worktrees ?? []).flatMap((w) => w.sessions).filter((x) => x.isShell && x.session.status !== 'ended').map((x) => x.session.session_id)
    if (!node || ids.length === 0) return { cancelled: false, stopped: 0 }
    const plan = planProjectClose(ids, await liveNow(), shellNames(tabs, labels))
    if (plan.busy.length === 0) {
      stopShells(plan.stop)
      return { cancelled: false, stopped: plan.stop.length }
    }
    return new Promise((resolve) => setClosing({ kind: 'project', name: node.project.name, plan, resolve }))
  }, [liveNow, stopShells])
  const onClosePane = useCallback((tabId: string, paneId: string) => { void requestClose(tabId, paneId) }, [requestClose])
  /** A tab's ×, in the strip and in the sidebar alike. */
  const onCloseTab = useCallback((tabId: string) => { void requestClose(tabId) }, [requestClose])
  const onResizePanes = useCallback((tabId: string, splitId: string, sizes: number[]) => dispatch({ type: 'resize', tabId, splitId, sizes }), [])

  // ⌘W closes the focused pane of a split tab, else the tab.
  const detach = useCallback(() => {
    if (!current) return
    void requestClose(current.id, current.root.type === 'split' ? focusedLeaf(current).id : undefined)
  }, [current, requestClose])
  /** A new shell beside the focused pane, in the same folder, as a terminal's split does. */
  const splitShell = useCallback((direction: 'row' | 'column') => {
    if (!current) { onNewShell(); return }
    const cwd = focusedSession?.cwd || undefined
    void newShell(current.projectId, cwd, direction)
  }, [current, focusedSession, newShell, onNewShell])

  // ⇧⌘G opens the diff of the session in front; what that is is known further
  // down (focusedWorktree), so it is reached through a ref set there.
  const openChangesRef = useRef<(() => void) | undefined>(undefined)
  const run = useCallback((c: AppCommand) => {
    switch (c.kind) {
      // In the folder of the session in front — its worktree, not the project's root.
      case 'new-shell': if (workspaceShown && current) onNewShell(current.projectId, focusedSession?.cwd || undefined); else onNewShell(); break
      case 'new-agent': onNewAgent(); break
      case 'quick-chat': onQuickChatChooser(); break
      case 'add-project': onAddProject(); break
      case 'detach-tab': if (workspaceShown) detach(); break
      case 'palette': onPalette(); break
      case 'inspector': setPrefs((p) => ({ ...p, inspector: !p.inspector })); showWorkspace(); break
      case 'sidebar': setPrefs((p) => ({ ...p, sidebar: !p.sidebar })); break
      case 'deck':
        // A shell has no deck: say so rather than flip a setting that shows nothing.
        if (workspaceShown && !frontIsAgent && !deck.open) { setToast('The session deck shows an agent’s figures: bring an agent’s tab to the front.'); break }
        setDeck((d) => ({ ...d, open: !d.open }))
        showWorkspace()
        break
      case 'changes':
        if (openChangesRef.current) openChangesRef.current()
        else setToast('Changes shows a git project’s diff: bring a session in one to the front.')
        break
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
      case 'zoom': stepUiScale(c.step); break
    }
  }, [onNewShell, onNewAgent, onQuickChatChooser, onAddProject, workspaceShown, detach, onPalette, showWorkspace, onDashboard, splitShell, jumpToWaiting, current, focusedSession?.cwd, onSettings, frontIsAgent, deck.open])

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
      // In a browser ⌘+ and ⌘− are the browser's own zoom.
      if (c.kind === 'zoom' && !isTauri()) return
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

  // The project menu (components/ProjectMenu.tsx).
  const tabCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of ws.tabs) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1)
    return m
  }, [ws.tabs])
  /** Closes the tabs only: every session and shell in them keeps running (rule 7). */
  const onCloseProjectTabs = useCallback((projectId: string) => {
    setChangesView((cur) => (cur?.projectId === projectId ? null : cur))
    dispatch({ type: 'close-project', projectId })
  }, [])
  const onOpenProjectInEditor = useCallback((path: string, label: string, editorId: string) => openInEditor(path, label, editorId), [openInEditor])
  const { archiveLocal } = data
  /** Unlists a project — the daemon's list, or this page's when it keeps none. Its files are never touched. */
  const onRemoveProject = useCallback(async (projectId: string) => {
    const p = projectsById.get(projectId)
    if (!p) return
    if (source === 'api') await projectsApi.unlist(projectId)
    else archiveLocal(p.root)
    onCloseProjectTabs(projectId)
    setToast(`${p.name} is off the list. Its files and sessions are untouched; Add project brings it back.`)
    refresh()
  }, [projectsById, source, archiveLocal, onCloseProjectTabs, refresh])
  /** *Clean up copies…* for a repository: its worktrees, what each would lose and its size. */
  const onCleanCopies = useCallback((projectId: string) => {
    const p = projectsById.get(projectId)
    if (p?.kind === 'repo') setSheet({ kind: 'copies', projectId, name: p.name })
  }, [projectsById])
  /** *Review* on the cleanup line: the copies sheet with the finished ones ticked. */
  const onReviewCopies = useCallback((projectId: string, preselect: string[]) => {
    const p = projectsById.get(projectId)
    if (p?.kind === 'repo') setSheet({ kind: 'copies', projectId, name: p.name, preselect })
  }, [projectsById])
  /** Copies were cleaned up: a tab on a session that ran in one closes
   * (nothing runs there: a copy with a live session is never finished). */
  const onCopiesRemoved = useCallback((paths: string[]) => {
    const inside = (cwd?: string) => !!cwd && paths.some((p) => cwd === p || cwd.startsWith(`${p}/`) || cwd.startsWith(`${p}\\`))
    for (const x of data.sessions) {
      if (openSessions.has(x.session_id) && inside(x.cwd)) dispatch({ type: 'drop-session', sessionId: x.session_id })
    }
  }, [data.sessions, openSessions])
  const onRoute = useCallback((h: string) => { location.hash = h }, [])

  // The worktree "Open file…" lists: the file tab's in front, else the
  // focused session's, else the shown project's main checkout.
  const fileScope = useMemo(() => {
    if (source !== 'api') return undefined
    const scope = (n: ProjectNode, w?: WorktreeNode) => {
      const t = changesTargetOf(n, w)
      return { projectId: t.projectId, worktree: t.worktree, title: t.title }
    }
    if (focused?.kind === 'file' && current) {
      const n = model.projects.find((x) => x.project.id === current.projectId)
      const wt = focused.worktree ?? ''
      if (n) return scope(n, wt ? n.worktrees.find((w) => !w.isMain && w.key === wt) : undefined)
    }
    if (focused) {
      for (const n of model.projects) {
        const w = n.worktrees.find((x) => x.sessions.some((y) => y.session.session_id === focused.sessionId))
        if (w) return scope(n, w)
      }
    }
    const n = model.projects.find((x) => x.project.id === activeProjectId)
    return n?.project.root ? scope(n) : undefined
  }, [source, focused, current, model.projects, activeProjectId])
  fileScopeRef.current = fileScope

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
      { id: 'a-agent', group: 'Actions', label: 'New agent', hint: keys('⇧⌘N'), icon: <PlusIcon size={14} />, run: () => onNewAgent() },
      { id: 'a-agent-issue', group: 'Actions', label: 'New agent from issue…', detail: 'an open GitHub issue or pull request: its own copy, its text as the first message', icon: <BranchIcon size={14} />, run: () => setSheet({ kind: 'agent', projectId: activeProjectId, fromGitHub: true }) },
      { id: 'a-shell', group: 'Actions', label: 'New shell', hint: keys('⌘T'), icon: <TerminalIcon size={14} />, run: () => onNewShell() },
      { id: 'a-quick-chat', group: 'Actions', label: 'Quick chat…', detail: 'pick the agent and model; Enter starts the last one used', hint: keys('⌥⌘N'), icon: <ChatIcon size={14} />, run: onQuickChatChooser },
      { id: 'a-project', group: 'Actions', label: 'Add a project', hint: keys('⌘O'), icon: <FolderPlusIcon size={14} />, run: onAddProject },
      { id: 'a-deck', group: 'Actions', label: deck.open ? 'Hide the session deck' : 'Show the session deck', detail: 'The agent’s live figures under its terminal', hint: keys('⌘B'), icon: <DeckIcon size={14} />, run: () => run({ kind: 'deck' }) },
      { id: 'a-inspector', group: 'Actions', label: prefs.inspector ? 'Hide the inspector' : 'Show the inspector', hint: keys('⌘I'), icon: <InspectorIcon size={14} />, run: () => run({ kind: 'inspector' }) },
      ...(fileScope ? [{ id: 'a-open-file', group: 'Actions' as const, label: 'Open file…', detail: fileScope.title, icon: <FileIcon size={14} />, run: () => setSheet({ kind: 'files', ...fileScope }) }] : []),
      ...(source === 'api' && activeProject?.kind === 'repo'
        ? [{ id: 'a-copies', group: 'Actions' as const, label: 'Clean up copies…', detail: `${activeProject.name}: worktrees, sizes, merged`, icon: <BranchIcon size={14} />, run: () => onCleanCopies(activeProject.id) }]
        : []),
      { id: 'a-dashboard', group: 'Actions', label: 'Open the dashboard', hint: keys('⌘0'), icon: <DashboardIcon size={14} />, run: onDashboard },
      { id: 'a-settings', group: 'Actions', label: 'Settings', detail: 'permission mode, theme, terminal, notifications, phone', hint: keys('⌘,'), icon: <SettingsIcon size={14} />, run: onSettings },
      { id: 'a-phone', group: 'Actions', label: 'Open Caprock on your phone', detail: 'pair with a QR code, then add it to the home screen', icon: <SettingsIcon size={14} />, run: openPhoneSettings },
      { id: 'a-telegram', group: 'Actions', label: 'Connect Telegram', detail: 'messages when a session needs you; reply from the chat', icon: <SettingsIcon size={14} />, run: () => openSettingsAt('telegram') },
      { id: 'a-keys', group: 'Actions', label: 'Keyboard shortcuts', detail: 'every key the app answers to', icon: <SearchIcon size={14} />, run: () => setSheet({ kind: 'keys' }) },
      { id: 'a-theme', group: 'Actions', label: 'Switch theme', icon: <SparkIcon size={14} />, run: toggleTheme },
      ...(isTauri() ? [{ id: 'a-zoom-reset', group: 'Actions' as const, label: 'Interface size: back to the default', hint: isMacPlatform() ? keys('⇧⌘0') : undefined, icon: <SparkIcon size={14} />, run: () => stepUiScale(0) }] : []),
      { id: 'a-share', group: 'Actions', label: 'Share my numbers', detail: 'a card of your figures: copy, save or post to X', icon: <SparkIcon size={14} />, run: () => setSheet({ kind: 'share' }) },
      ...SCREENS.map(([route, label, detail]) => ({ id: `a-screen-${route}`, group: 'Actions' as const, label, detail, icon: <DashboardIcon size={14} />, run: () => { location.hash = `#/${route}` } })),
      { id: 'a-waiting', group: 'Actions', label: 'Next session waiting on you', hint: keys('⌘J'), icon: <SparkIcon size={14} />, run: jumpToWaiting },
      { id: 'a-saved', group: 'Actions', label: 'Run saved…', detail: 'a saved prompt or command', icon: <SparkIcon size={14} />, run: () => setSheet({ kind: 'saved' }) },
      manageSaved,
      ...savedItems,
    )
    // F20: the app's own updater; the answer shows in the status strip.
    if (isTauri()) items.push({ id: 'a-update', group: 'Actions', label: 'Check for updates', icon: <SparkIcon size={14} />, run: () => { void appUpdate.check() } })
    if (current) {
      items.push(
        { id: 'a-find', group: 'Actions', label: focused?.kind === 'file' ? 'Find in the file' : 'Find in the terminal', hint: keys('⌘F'), icon: <SearchIcon size={14} />, run: () => window.dispatchEvent(new Event(FIND_EVENT)) },
        { id: 'a-split-right', group: 'Actions', label: 'Split right: a new shell beside', hint: keys('⌘E'), icon: <TerminalIcon size={14} />, run: () => splitShell('row') },
        { id: 'a-split-down', group: 'Actions', label: 'Split down: a new shell below', hint: keys('⇧⌘E'), icon: <TerminalIcon size={14} />, run: () => splitShell('column') },
      )
    }
    if (split) {
      items.push(
        { id: 'a-pane-next', group: 'Actions', label: 'Focus the next pane', hint: keys('⌘]'), icon: <TerminalIcon size={14} />, run: () => dispatch({ type: 'cycle-pane', delta: 1 }) },
        { id: 'a-pane-close', group: 'Actions', label: 'Close the pane', hint: keys('⌘W'), icon: <TerminalIcon size={14} />, run: detach },
      )
    }
    if (editors) {
      const name = preferredName(editors)
      const folder = focusedSession?.cwd
      if (folder) items.push({ id: 'a-editor-cwd', group: 'Actions', label: `Open this folder in ${name}`, detail: folder, icon: <ExternalIcon size={14} />, run: () => openInEditor(folder, 'the folder') })
    }
    // Compare attempts (ADR-052): one row per group the session list holds.
    const groups = new Map<string, SessionSummary[]>()
    for (const x of data.sessions) {
      if (!x.attempt_group || !x.attempts || x.attempts < 2) continue
      groups.set(x.attempt_group, [...(groups.get(x.attempt_group) ?? []), x])
    }
    for (const [group, list] of groups) {
      const first = [...list].sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))[0]!
      items.push({ id: `cmp-${group}`, group: 'Actions', label: `Compare attempts: ${sessionTitle({ ...first, attempts: 0 })}`, detail: `${first.attempts} attempts${first.project ? ` · ${first.project}` : ''}`, icon: <BranchIcon size={14} />, run: () => onCompare(first) })
    }
    for (const t of ws.tabs) {
      const leaf = focusedLeaf(t)
      const s = sessionsById.get(leaf.target.sessionId)
      const file = leaf.target.kind === 'file' ? leaf.target.path : undefined
      items.push({ id: `t-${t.id}`, group: 'Tabs', label: s ? sessionTitle(s) : t.title, detail: file ?? projectsById.get(t.projectId)?.name, icon: file ? <FileIcon size={14} /> : <TerminalIcon size={14} />, run: () => { dispatch({ type: 'activate', tabId: t.id }); showWorkspace() } })
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
  }, [data.sessions, onCompare, savedItems, manageSaved, ws.tabs, model.projects, model.inbox, sessionsById, projectsById, openSessions, prefs.inspector, deck.open, current, onNewAgent, onNewShell, onQuickChatChooser, onAddProject, onDashboard, toggleTheme, onSettings, run, showWorkspace, openSession, openSplit, onSelectProject, onOpenInbox, jumpToWaiting, splitShell, detach, editors, focusedSession?.cwd, openInEditor, source, onOpenChanges, fileScope, focused?.kind, activeProject, activeProjectId, onCleanCopies])

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

  useEffect(() => {
    openChangesRef.current = focusedWorktree?.repo
      ? () => onOpenChanges(focusedWorktree.projectId, focusedWorktree.w)
      : undefined
  }, [focusedWorktree, onOpenChanges])

  // The deck's PR rows: the focused session's project's checkouts and the
  // live agents in each, so a row says who is on its branch.
  const deckWorktrees = useMemo(() => {
    if (!focused) return undefined
    const n = model.projects.find((x) => x.worktrees.some((w) => w.sessions.some((y) => y.session.session_id === focused.sessionId)))
    return n?.worktrees.map((w) => ({ branch: w.branch, path: w.path, agents: w.sessions.filter((y) => !y.isShell).map((y) => ({ session: y.session, dot: y.dot })) }))
  }, [focused, model.projects])
  const deckProjectId = focusedWorktree?.projectId ?? activeProjectId
  const onDeckOpenSession = useCallback((s: SessionSummary) => openSession(s, deckProjectId), [openSession, deckProjectId])
  const onDeckStartAgent = useCallback(async (req: SpawnRequest, title: string) => {
    const { session_id } = await api.spawn(req)
    openTab({ kind: 'session', sessionId: session_id }, deckProjectId, title)
    data.refresh()
  }, [openTab, deckProjectId, data])

  // The project the focused session is listed under, named as the sidebar names it.
  const focusedProject = useMemo(() => {
    if (!focused) return undefined
    const p = model.projects.find((n) => n.worktrees.some((w) => w.sessions.some((x) => x.session.session_id === focused.sessionId)))?.project
    // "Other folders" is a heading, not a project: the session's own folder names it.
    return p && p.id !== OTHER_FOLDERS_ID ? p : undefined
  }, [focused, model.projects])

  const focusedIsAgent = frontIsAgent
  const showChat = focusedIsAgent && !!focused && chatOpen.has(focused.sessionId)
  // The permission card shows for the focused agent whether or not its
  // terminal is in front. 0.78.2 hid it behind the terminal as a duplicate
  // (owner, 2026-10-06); the next day he wanted it back — it names the call
  // in full, its keys (Y, A, N) work from the terminal, and it is the only
  // surface with a working "don't ask again" by key. Other tabs are reached
  // through their badge, the Inbox, the menu bar and the notification.
  const promptCard = focusedIsAgent && !!focused
  const toggleDeck = useCallback(() => setDeck((d) => ({ ...d, open: !d.open })), [])
  const closeDeck = useCallback(() => setDeck((d) => ({ ...d, open: false })), [])
  const onResizeDeck = useCallback((height: number) => setDeck((d) => ({ ...d, height })), [])
  const toggleChat = useCallback(() => {
    if (!focused) return
    const id = focused.sessionId
    setChatOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [focused])

  /** The folder a worktree's files live in, for "Open in editor". */
  const folderOf = useCallback((projectId: string, worktree: string): string | undefined => {
    const n = model.projects.find((x) => x.project.id === projectId)
    if (!n) return undefined
    const w = n.worktrees.find((x) => (worktree ? !x.isMain && x.key === worktree : x.isMain))
    return w?.path || (worktree ? undefined : n.project.root || undefined)
  }, [model.projects])
  const renderFile = useCallback((tab: Tab, leaf: PaneLeaf, visible: boolean) => {
    const wt = leaf.target.worktree ?? ''
    const path = leaf.target.path ?? ''
    const folder = folderOf(tab.projectId, wt)
    return (
      <FileView
        projectId={tab.projectId}
        worktree={wt}
        path={path}
        visible={visible}
        onOpenFile={(p) => openFile(tab.projectId, wt, p)}
        editor={editors && folder ? { name: preferredName(editors), open: () => openInEditor(joinPath(folder, path), path) } : undefined}
      />
    )
  }, [folderOf, openFile, editors, openInEditor])
  const focusedFile = focused?.kind === 'file'

  // A watched session that Caprock now holds a terminal for — continued here
  // under its own id — becomes an ordinary session tab, in the same place.
  useEffect(() => {
    for (const t of ws.tabs) {
      for (const l of leaves(t.root)) {
        if (l.target.kind !== 'observe') continue
        const s = sessionsById.get(l.target.sessionId)
        if (s && s.kind !== 'shell' && attachable(s)) dispatch({ type: 'replace-session', sessionId: s.session_id, target: { kind: 'session', sessionId: s.session_id }, title: sessionTitle(s) })
      }
    }
  }, [ws.tabs, sessionsById])
  const renderObserve = useCallback((tab: Tab, leaf: PaneLeaf, visible: boolean) => {
    // Only the tab in front reads the conversation: a tab behind costs nothing.
    if (!visible) return null
    const id = leaf.target.sessionId
    return (
      <ObservePane
        sessionId={id}
        session={sessionsById.get(id)}
        title={tab.title}
        hasPermission={data.permissions.has(id)}
        onContinued={(newId, title, sameId) => {
          if (sameId) dispatch({ type: 'replace-session', sessionId: id, target: { kind: 'session', sessionId: id }, title })
          else openTab({ kind: 'session', sessionId: newId }, tab.projectId, title)
          refresh()
        }}
        onOpenDashboard={() => { location.hash = `#/session/${encodeURIComponent(id)}` }}
        onHide={() => { dispatch({ type: 'close', tabId: tab.id }); hideSessionRow(id) }}
        onClose={() => dispatch({ type: 'close', tabId: tab.id })}
      />
    )
  }, [sessionsById, data.permissions, openTab, refresh])

  return (
    <div className="flex h-dvh flex-col text-fg">
      <div className="flex min-h-0 flex-1">
        {prefs.sidebar && (
          <div className="h-full shrink-0" style={{ width: 'var(--app-sidebar-w)' }}>
            <Sidebar
              model={model}
              source={data.source}
              activeProjectId={activeProjectId}
              dashboardActive={!workspaceShown}
              tabs={ws.tabs}
              tabLabels={labels}
              activeTabId={current?.id}
              activeByProject={ws.activeByProject}
              onActivateTab={onActivateTab}
              onCloseTab={onCloseTab}
              onOpenLive={openSession}
              onSelectProject={onSelectProject}
              onOpenInbox={onOpenInbox}
              onNewAgent={onNewAgent}
              onNewShell={onNewShell}
              onQuickChat={onQuickChatChooser}
              onFolderMenu={editors ? onFolderMenu : undefined}
              onAddProject={onAddProject}
              onDashboard={onDashboard}
              onSettings={onSettings}
              onPalette={onPalette}
              summary={data.summary}
              loaded={data.loaded}
              onRoute={onRoute}
              tabCounts={tabCounts}
              onCloseProjectTabs={onCloseProjectTabs}
              onStopProjectShells={onStopProjectShells}
              editors={editors}
              onOpenInEditor={editors ? onOpenProjectInEditor : undefined}
              onRemoveProject={onRemoveProject}
              onCleanCopies={source === 'api' ? onCleanCopies : undefined}
            />
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--app-chrome-bg)]">
          <TabStrip
              tabs={tabs}
              activeTabId={workspaceShown ? current?.id : undefined}
              labels={labels}
              projectName={projectName}
              dashboard={ws.dashboard || !workspaceShown ? {
                active: !workspaceShown,
                label: dashboardRoute.name === 'settings' ? 'Settings' : 'Dashboard',
                onActivate: onDashboard,
                onClose: closeDashboard,
              } : undefined}
              paneTools={workspaceShown}
              sessions={sessionsById}
              permissions={data.permissions}
              inspectorOpen={prefs.inspector}
              sidebarOpen={prefs.sidebar}
              onActivate={onActivateTab}
              onDetach={onCloseTab}
              onMove={(id, to) => dispatch({ type: 'move', tabId: id, toIndex: to })}
              onNewAgent={() => onNewAgent()}
              onNewShell={() => onNewShell()}
              newItems={newItems}
              onToggleInspector={() => setPrefs((p) => ({ ...p, inspector: !p.inspector }))}
              chatOpen={showChat}
              onToggleChat={focusedIsAgent ? toggleChat : undefined}
              deckOpen={deck.open}
              onToggleDeck={focusedIsAgent ? toggleDeck : undefined}
            />
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
                    renderFile={renderFile}
                    renderObserve={renderObserve}
                    chats={chatPanes}
                    onChatClose={onClosePane}
                    onChatRestart={onChatRestart}
                    onChatHintDismiss={onChatHintDismiss}
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
                      onOpenFile={(p) => openFile(changesView.projectId, changesView.worktree, p)}
                      handoff={changesHandoff}
                      className="absolute inset-0 z-20"
                    />
                  )}
                  {compare && (
                    <AttemptsCompare
                      key={compare.group}
                      group={compare.group}
                      title={compare.title}
                      dotFor={(id) => { const x = sessionsById.get(id); return x ? dotOf(x, data.permissions.has(id)) : undefined }}
                      onClose={() => setCompare(null)}
                      onOpen={(v) => {
                        const at = placeOf(v.session_id)
                        const s = sessionsById.get(v.session_id)
                        if (s) openSession(s, at?.node.project.id ?? activeProjectId)
                        else location.hash = `#/session/${encodeURIComponent(v.session_id)}`
                      }}
                      onReview={source === 'api' ? (v) => {
                        const at = placeOf(v.session_id)
                        if (!at) { setToast('Its copy is not in the sidebar any more.'); return }
                        setCompare(null)
                        onOpenChanges(at.node.project.id, at.w)
                      } : undefined}
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
                      repos={source === 'api' && activeProject && isMultiRepo(activeProject) ? (
                        <ProjectRepos project={activeProject} projects={model.projects.map((n) => n.project)} />
                      ) : undefined}
                      cleanup={source === 'api' && activeProject?.kind === 'repo' ? (
                        <CleanupLine
                          projectId={activeProject.id}
                          refreshKey={worktreesKey(activeProject)}
                          onReview={(paths) => onReviewCopies(activeProject.id, paths)}
                          onRemoved={onCopiesRemoved}
                          className="px-3"
                        />
                      ) : undefined}
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
                {/* Under the terminal, never over it: opening it lifts the
                  * terminal's bottom, and the prompt with it, off the
                  * window's edge. Not mounted while closed or while the
                  * dashboard is in front. */}
                {deck.open && workspaceShown && focusedIsAgent && focused && focusedSession && (
                  <SessionDeck
                    s={focusedSession}
                    sessionId={focused.sessionId}
                    hasPermission={data.permissions.has(focused.sessionId)}
                    summary={data.summary}
                    changed={focusedWorktree?.w.changed}
                    branch={focusedWorktree?.w.branch}
                    ahead={focusedWorktree?.w.ahead}
                    onReviewChanges={focusedWorktree?.repo ? () => onOpenChanges(focusedWorktree.projectId, focusedWorktree.w) : undefined}
                    height={deck.height}
                    onResize={onResizeDeck}
                    onClose={closeDeck}
                    onToast={setToast}
                    worktrees={deckWorktrees}
                    onOpenSession={onDeckOpenSession}
                    onStartAgent={onDeckStartAgent}
                    cleanup={focusedWorktree?.repo && projectsById.get(focusedWorktree.projectId) ? (
                      <CleanupLine
                        projectId={focusedWorktree.projectId}
                        refreshKey={worktreesKey(projectsById.get(focusedWorktree.projectId))}
                        onReview={(paths) => onReviewCopies(focusedWorktree.projectId, paths)}
                        onRemoved={onCopiesRemoved}
                        compact
                      />
                    ) : undefined}
                  />
                )}
                {promptCard && !prefs.inspector && focused && (
                  <div className="shrink-0 border-t border-[var(--app-hairline)] px-3 empty:hidden [&>*]:mb-2">
                    <PermissionPrompt sessionId={focused.sessionId} />
                  </div>
                )}
              </div>
              {!workspaceShown && (
                <div className="app-scroll absolute inset-0 overflow-y-auto bg-bg">
                  {/* Settings' own × and Escape close it as its tab's × does (lib/settingsClose.ts). */}
                  <CloseSettingsContext.Provider value={closeDashboard}>
                    {/* Settings → Subscriptions types a sign-in into a shell tab (ADR-048). */}
                    <SetupShellContext.Provider value={onSetupAgent}>
                      <Suspense fallback={null}>
                        <Dashboard route={parseHash(hash)} inApp />
                      </Suspense>
                    </SetupShellContext.Provider>
                  </CloseSettingsContext.Provider>
                </div>
              )}
            </div>
            {workspaceShown && prefs.inspector && (
              <div className="h-full shrink-0" style={{ width: 'var(--app-inspector-w)' }}>
                <Inspector
                  session={focusedSession}
                  project={focusedProject}
                  sessionId={focusedFile ? undefined : focused?.sessionId}
                  hasPermission={!!focused && data.permissions.has(focused.sessionId)}
                  showPrompt={promptCard}
                  onClose={() => setPrefs((p) => ({ ...p, inspector: false }))}
                  onDetach={detach}
                  editors={editors}
                  onOpenInEditor={openInEditor}
                  onReviewChanges={focusedWorktree?.repo ? () => onOpenChanges(focusedWorktree.projectId, focusedWorktree.w) : undefined}
                  onOpenFile={focusedWorktree?.repo ? (p) => openFile(focusedWorktree.projectId, focusedWorktree.w.isMain ? '' : focusedWorktree.w.key, p) : undefined}
                  summary={data.summary}
                  onCompare={focusedSession?.attempt_group ? () => onCompare(focusedSession) : undefined}
                />
              </div>
            )}
          </div>
        </main>
      </div>
      {/* With the sidebar open its Today strip carries the plan windows and the day's spend, so the strip leaves them out. */}
      {/* The GitHub star ask sits above the status strip, never over a
        * terminal; the share toast floats (lib/nudges.ts, one at a time). */}
      <SetupStrip app />
      <StarStrip app />
      <ShareMoment />
      <StatusStrip summary={data.summary} pane={focused ? paneStatus[focused.sessionId] : undefined} session={focused?.kind === 'session' && workspaceShown ? focusedSession : undefined} version={version} figures={!prefs.sidebar} />
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
          here={sheet.here}
          fromGitHub={sheet.fromGitHub}
          onClose={() => setSheet(null)}
          onSetup={onSetupAgent}
          onProjectAdded={() => refresh()}
          onStarted={(id, projectId, title) => { sheet.onStarted?.(); openTab({ kind: 'session', sessionId: id }, projectId, title); data.refresh() }}
          onAttempts={onAttempts}
        />
      )}
      {sheet?.kind === 'quick-chat' && (
        <QuickChatSheet
          agents={spawnable}
          onClose={closeSheet}
          onSetup={onSetupAgent}
          onStart={(c) => { setSheet(null); void startQuickChat(c) }}
        />
      )}
      {sheet?.kind === 'project' && (
        <AddProjectSheet
          source={data.source}
          projects={model.projects.map((n) => n.project)}
          ops={data.ops}
          onClose={closeSheet}
          onAdded={onProjectAdded}
          onAddLocal={(p) => { data.addLocal(p); dispatch({ type: 'project', projectId: `dir:${p.root}` }) }}
        />
      )}
      {folderMenu && <EditorMenu at={folderMenu} editors={editors} onClose={closeFolderMenu} onError={setToast} />}
      {sheet?.kind === 'copies' && <CopiesSheet key={sheet.projectId} projectId={sheet.projectId} name={sheet.name} preselect={sheet.preselect} onClose={closeSheet} onChanged={refresh} />}
      {sheet?.kind === 'keys' && <ShortcutsSheet isMac={isMac} onClose={closeSheet} />}
      {sheet?.kind === 'share' && <ShareDialog onClose={closeSheet} />}
      {sheet?.kind === 'files' && (
        <FilePicker
          target={sheet}
          title={sheet.title}
          onClose={closeSheet}
          onOpen={(p) => openFile(sheet.projectId, sheet.worktree, p)}
        />
      )}
      {closing?.kind === 'tab' && (
        <CloseShellConfirm
          busy={closing.plan.busy}
          onStop={() => { setClosing(null); finishClose(closing.tabId, closing.paneId, [...closing.plan.stop, ...closing.plan.busy], closing.chats) }}
          onKeep={() => { setClosing(null); finishClose(closing.tabId, closing.paneId, closing.plan.stop, closing.chats) }}
          onCancel={() => setClosing(null)}
        />
      )}
      {closing?.kind === 'chat' && (
        <CloseChatConfirm
          onStop={() => { setClosing(null); void closeShells(closing.tabId, closing.paneId, [...closing.chat.stop, ...closing.chat.busy]) }}
          onKeep={() => { setClosing(null); void closeShells(closing.tabId, closing.paneId, closing.chat.stop) }}
          onCancel={() => setClosing(null)}
        />
      )}
      {closing?.kind === 'project' && (
        <CloseShellConfirm
          busy={closing.plan.busy}
          project={closing.name}
          onStop={() => {
            const all = [...closing.plan.stop, ...closing.plan.busy]
            setClosing(null); stopShells(all); closing.resolve({ cancelled: false, stopped: all.length })
          }}
          onKeep={() => { setClosing(null); stopShells(closing.plan.stop); closing.resolve({ cancelled: false, stopped: closing.plan.stop.length }) }}
          onCancel={() => { setClosing(null); closing.resolve({ cancelled: true, stopped: 0 }) }}
        />
      )}
      {sheet?.kind === 'palette' && <CommandPalette items={paletteItems} fallback={paletteFallback} search={paletteSearch} onClose={closeSheet} />}
      {sheet?.kind === 'saved' && <CommandPalette label="Run saved" placeholder="Run a saved prompt or command…" items={[...savedItems, { ...manageSaved, group: 'Saved' }]} onClose={closeSheet} />}
    </div>
  )
}

/** A project's worktrees as one string: the cleanup line asks again when it changes. */
function worktreesKey(p?: Project): string {
  return (p?.worktrees ?? []).map((w) => `${w.path}@${w.branch}:${w.changed ?? 0}`).join('|')
}

function EmptyWorkspace({
  project,
  hasProjects,
  onNewAgent,
  onNewShell,
  onAddProject,
  repos,
  recent,
  cleanup,
}: {
  project?: Project
  hasProjects: boolean
  onNewAgent: () => void
  onNewShell: () => void
  onAddProject: () => void
  /** A multi-repo project's repositories and their split (ADR-055). */
  repos?: React.ReactNode
  /** The project's recent sessions, to carry one on from here. */
  recent?: React.ReactNode
  /** Finished copies: "3 copies done · Clean up" (components/CleanupLine). */
  cleanup?: React.ReactNode
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
          {project && <EmptyAction icon={<PlusIcon size={15} />} label="New agent" hint={keys('⇧⌘N')} onClick={onNewAgent} />}
          {project && <EmptyAction icon={<TerminalIcon size={15} />} label="New shell" hint={keys('⌘T')} onClick={onNewShell} />}
          <EmptyAction icon={<FolderPlusIcon size={15} />} label="Add a project" hint={keys('⌘O')} onClick={onAddProject} />
        </div>
        {repos}
        {cleanup}
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
