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
import { api, ApiError, errText, isPairedDevice, type SessionSummary, type SpawnRequest } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { APP_ROUTE, isMacPlatform, isTauri, isWorkspaceHash } from '@/lib/appmode'
import { stepUiScale } from '@/lib/uiscale'
import { installExternalLinks } from '@/lib/externalLinks'
import { pageTitle } from '@/lib/pagetitle'
import { TabPageBar } from '@/components/WhereAmI'
import { DASHBOARD_KEY, FIND_EVENT, PIPELINE_KEY, THEME_KEY, THEME_MENU_EVENT, WORK_KEY, isArrowCommand, keys, matchAppShortcut, tabDigit, type AppCommand } from '@/lib/appkeys'
import { loadRowOrders, ROW_ORDER_EVENT, tabRowKey } from '@/lib/rowOrder'
import { href, parseHash, type SettingsSection } from '@/lib/router'
import { goHomeTop, isHomeHash } from '@/lib/screenPlace'
import { NotSupportedError, projectsApi, type Project } from '@/lib/projects'
import { useTemplateJob } from '@/lib/useTemplateJob'
import { TemplateProjectSheet } from '@/components/TemplateProjectSheet'
import { buildSidebar, dotOf, groupProjects, numberedProjects, OTHER_FOLDERS_ID, sessionTitle, type InboxItem, type ProjectNode, type WorktreeNode } from '@/lib/sidebar'
import {
  activeTab,
  findTabBySession,
  focusedLeaf,
  leaves,
  loadWorkspace,
  pipelineInStore,
  saveWorkspace,
  WORKSPACE_KEY,
  tabsOf,
  workspaceReducer,
  type PaneLeaf,
  type Tab,
  type TabTarget,
} from '@/lib/tabs'
import { tabLabels } from '@/lib/tablabels'
import { AGENT_SAVED_TOAST, isShellLeaf, liveShells, planAgentClose, planChatClose, planClose, planProjectClose, shellNames, type AgentClosePlan, type ChatClosePlan, type ClosePlan, type ClosingShell, type ProjectShellsOutcome } from '@/lib/closeShell'
import { baseName, fileKey } from '@/lib/files'
import { useWorkspaceData } from '@/lib/useWorkspaceData'
import { useShellTray } from '@/lib/tray'
import { OPEN_SESSION_EVENT } from '@/lib/shell'
import { useOsNotifications } from '@/lib/notify'
import { useTheme } from '@/lib/theme'
import { useDaemonVersion } from '@/lib/useDaemonVersion'
import { HIDDEN_PROJECTS_EVENT, hideSessionRow, loadHiddenProjects, loadHiddenSessions, Sidebar } from '@/components/Sidebar'
import { TabStrip, TerminalStack } from '@/components/TerminalTabs'
import { Inspector } from '@/components/Inspector'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SessionDeck } from '@/components/SessionDeck'
import { readDeck, saveDeck, type DeckPrefs } from '@/lib/deck'
import { FeedbackDialog } from '@/components/Feedback'
import { currentScreen } from '@/lib/feedback'
import { StatusStrip } from '@/components/StatusStrip'
import { openCaprockDoctor } from '@/components/FootprintPanel'
import { StarStrip } from '@/components/StarStrip'
import { MailStrip } from '@/components/MailStrip'
import { OfferStrip } from '@/components/OfferStrip'
import { BrainCaptureHost } from '@/components/BrainCapture'
import { BrainGlyph } from '@/components/BrainDrop'
import { openBrainCapture } from '@/lib/brain'
import { SetupStrip } from '@/components/SetupStrip'
import { ShareMoment } from '@/components/Nudges'
import { ShareDialog } from '@/components/Share'
import { usePromptSync } from '@/lib/nudges'
import { AppUpdateToast } from '@/components/AppUpdateToast'
import { ComputerAsks } from '@/components/ComputerAsks'
import { AppUpdateAsk } from '@/components/AppUpdateAsk'
import { AppAutoUpdate } from '@/components/AppAutoUpdate'
import { checkByHand } from '@/lib/checkbanner'
import { PermissionPrompt } from '@/components/PermissionPrompt'
import { ChatView } from '@/components/ChatView'
import { ChangesView } from '@/components/ChangesView'
import { AttemptsCompare } from '@/components/AttemptsCompare'
import { FileView } from '@/components/FileView'
import { attachable, ObservePane } from '@/components/ObservePane'
import { PipelineHostContext, type PipelineHost } from '@/lib/pipelineHost'
import { ScreenShown } from '@/lib/refresh'
import { FilePicker } from '@/components/FilePicker'
import { NewAgentSheet } from '@/components/NewAgentSheet'
import type { HandoffTarget } from '@/components/AgentHandoff'
import { liveOwnedSession } from '@/lib/handoff'
import { locateFile, OPEN_PATH_EVENT, type FileRoot, type OpenPathDetail } from '@/lib/mdreader'
import type { SendTarget } from '@/components/FileTools'
import { CloseSettingsContext } from '@/lib/settingsClose'
import { SetupShellContext } from '@/lib/setupShell'
import { QuickChatSheet, quickChatRequest, quickChoiceLabel, rememberQuickChoice, rememberedQuickChoice, type QuickChoice } from '@/components/QuickChat'
import { dismissHint, hintDismissed, isQuickChat, quickChatHint, rememberStartedChat, startedChat } from '@/lib/quickchat'
import type { ChatPane } from '@/components/QuickChatPane'
import { useSpawnableAgents } from '@/components/AgentPicker'
import { AddProjectSheet } from '@/components/AddProjectSheet'
import { CommandPalette, type PaletteItem } from '@/components/CommandPalette'
import { BranchIcon, ChatIcon, DashboardIcon, DeckIcon, MailIcon, ExternalIcon, FileIcon, FolderIcon, FolderPlusIcon, InspectorIcon, PlusIcon, SearchIcon, SettingsIcon, SparkIcon, TerminalIcon } from '@/components/AppIcons'
import type { PaneStatus } from '@/components/TerminalPane'
import { EditorMenu, type EditorMenuAt } from '@/components/EditorMenu'
import { joinPath, preferredName, useEditors } from '@/lib/editors'
import { applyTerminalChrome, getTerminalPrefs, subscribeTerminalPrefs } from '@/lib/termprefs'
import { warmTerminal } from '@/lib/termwarm'
import { StatusDot, fmtCostShort, leadKey, projectRows, type SidebarRow } from '@/components/ProjectRow'
import { fmtAgo } from '@/lib/format'
import { RecentInProject } from '@/components/RecentInProject'
import { ProjectRepos } from '@/components/ProjectRepos'
import { ProjectWizard } from '@/components/ProjectWizard'
import { ProjectInstructions } from '@/components/ProjectInstructions'
import { isMultiRepo } from '@/lib/multirepo'
import { CloseAgentChoice, CloseChatConfirm, CloseShellConfirm } from '@/components/CloseShellConfirm'
import { ShortcutsSheet } from '@/components/ShortcutsSheet'
import { KeysHint } from '@/components/KeysHint'
import { loadAgentClose } from '@/lib/agentClose'
import { useSidebarMode } from '@/lib/sidebarMode'
import { CopiesSheet } from '@/components/CopiesSheet'
import { CleanupLine } from '@/components/CleanupLine'
import { worktreeSlug } from '@/lib/slug'
import { openPhoneSettings, openSettingsAt, openSettingsSection } from '@/components/Pairing'
import { reloadSaved, savedFor, sendPrompt, useSavedPrompts, type SavedPrompt } from '@/lib/saved'
import { SAVED_SECTION_ID } from '@/components/SavedPromptsSetting'

export { worktreeSlug }

const Dashboard = lazy(() => import('@/App').then((m) => ({ default: m.Dashboard })))
const MailScreen = lazy(() => import('@/screens/mail/MailScreen').then((m) => ({ default: m.MailScreen })))
const PipelineScreen = lazy(() => import('@/screens/Pipeline').then((m) => ({ default: m.PipelineScreen })))
const PairScreen = lazy(() => import('@/screens/Pair').then((m) => ({ default: m.PairScreen })))

const UI_KEY = 'caprock.app.ui'

/** A route that is a pinned system tab of its own (Mail, Pipeline), not a dashboard screen. */
function isSystemTabHash(h: string): boolean {
  const name = parseHash(h).name
  return name === 'mail' || name === 'pipeline'
}

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
  /** New project, tap-tap-tap (components/ProjectWizard.tsx); `prompt` is a first message typed in New agent before it, handed back. */
  | { kind: 'new-project'; prompt?: string }
  /** New project from a template (components/TemplateProjectSheet.tsx, ADR-065); the job it starts lives on in `tplJob`. */
  | { kind: 'template' }
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
  ['home', 'Home', 'every session on the machine, live'],
  ['work', 'Open Work', 'every piece of work on its way to a release'],
  ['cost', 'Cost', 'spend by day, project and model'],
  ['history', 'Lifetime', 'every session, every day, in totals'],
  ['week', 'Week', 'one week, as a card'],
  ['notes', 'Memory', 'what the agents said, searchable'],
  ['brain', 'Second Brain', 'what your sessions decided and found, as a graph'],
  ['tasks', 'Tasks', 'the board'],
  ['queue', 'Queue', 'what each agent is doing, what waits, roughly when it is done'],
  ['mail', 'Mail', 'every inbox in one place, on this machine'],
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
  // Mail is a tab of its own, not the Dashboard tab's (owner, 2026-10-14):
  // #/mail brings the Mail tab to the front.
  const mailShown = !workspaceShown && parseHash(hash).name === 'mail'
  // So is the Pipeline (owner, 2026-10-15, translated: "I want the Pipeline
  // shown in the dashboard too, and as a separate page with its own tab —
  // among the system tabs, next to the dashboard"): #/pipeline brings the
  // Pipeline tab to the front, from the dashboard's nav and Home's card too.
  const pipelineShown = !workspaceShown && parseHash(hash).name === 'pipeline'
  const dashboardShown = !workspaceShown && !mailShown && !pipelineShown
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
  // Send feedback opened by its key (⇧⌘F): the screen it was asked from, or null.
  const [feedbackAt, setFeedbackAt] = useState<string | null>(null)
  /** A close that waits on the question about a busy shell. */
  const [closing, setClosing] = useState<
    | { kind: 'tab'; tabId: string; paneId?: string; plan: ClosePlan; chats: readonly string[] }
    | { kind: 'chat'; tabId: string; paneId?: string; chat: ChatClosePlan }
    | { kind: 'agent'; tabId: string; paneId?: string; chats: readonly string[]; agents: AgentClosePlan; title: string }
    | { kind: 'agent-busy'; tabId: string; paneId?: string; chats: readonly string[]; agents: AgentClosePlan }
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
  const inspectedId = focused?.sessionId
  const inspectedSession = focusedSession
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
  const lastDashboard = useRef<string>('#/')
  if (dashboardShown) lastDashboard.current = hash
  useEffect(() => {
    if (dashboardShown && !ws.dashboard) dispatch({ type: 'dashboard', open: true })
  }, [dashboardShown, ws.dashboard])
  const dashboardRoute = parseHash(dashboardShown ? hash : lastDashboard.current ?? '#/')
  const closeDashboard = useCallback(() => {
    dispatch({ type: 'dashboard', open: false })
    lastDashboard.current = '#/'
    // In the same render as the dispatch: on the old hash the tab reopened.
    if (!isWorkspaceHash(location.hash) && !isSystemTabHash(location.hash)) goHash(APP_ROUTE)
  }, [goHash])
  // The Mail tab: in the strip from the first time Mail is opened (the
  // sidebar's Mail row, ⇧⌘M, the dashboard's Mail, the palette) until its ×.
  useEffect(() => {
    if (mailShown && !ws.mail) dispatch({ type: 'mail', open: true })
  }, [mailShown, ws.mail])
  const onMail = useCallback(() => { if (parseHash(location.hash).name !== 'mail') goHash('#/mail') }, [goHash])
  const closeMail = useCallback(() => {
    dispatch({ type: 'mail', open: false })
    if (parseHash(location.hash).name === 'mail') goHash(APP_ROUTE)
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
  /** A click on a project in the sidebar: its page, whatever tab it had in front. */
  const onOpenProjectView = useCallback((id: string) => {
    setChangesView((cur) => (cur && cur.projectId !== id ? null : cur))
    setCompare(null)
    dispatch({ type: 'project', projectId: id, view: true })
    showWorkspace()
  }, [showWorkspace])

  // Tabs are the navigation (owner, 2026-10-14): ⌘N is the strip's Nth tab,
  // the strip is in the order the tabs were opened — a new one goes last
  // and takes the next number; only a close or a drag changes the numbers
  // — every tab shows its N, and the sidebar row of that tab shows the same
  // N. The Flat sidebar lists the tabs in the strip's order; Tree lists
  // them under their projects, numbers and all. Projects have no digit.
  // Hiding a project or a row, or ordering rows by hand, says so on
  // window, and all of it is asked again.
  const [orderTick, setOrderTick] = useState(0)
  useEffect(() => {
    const bump = () => setOrderTick((n) => n + 1)
    window.addEventListener(HIDDEN_PROJECTS_EVENT, bump)
    window.addEventListener(ROW_ORDER_EVENT, bump)
    return () => {
      window.removeEventListener(HIDDEN_PROJECTS_EVENT, bump)
      window.removeEventListener(ROW_ORDER_EVENT, bump)
    }
  }, [])
  // Flat by default; Tree from the folder toggle or Settings → Appearance.
  const [sidebarMode, setSidebarMode] = useSidebarMode()
  const grouped = sidebarMode === 'tree'
  const onGroupedChange = useCallback((g: boolean) => setSidebarMode(g ? 'tree' : 'flat'), [setSidebarMode])
  const tabbedProjects = useMemo(() => new Set(ws.tabs.map((t) => t.projectId)), [ws.tabs])
  // What the sidebar lists, as it lists it (components/Sidebar.tsx `listed`).
  const sidebarState = useMemo(() => {
    const groups = groupProjects(model.projects, { hidden: loadHiddenProjects(), activeProjectId, tabbed: tabbedProjects })
    const front = [...groups.more, ...groups.hidden].find((n) => n.project.id === activeProjectId)
    return { numbered: numberedProjects(groups), listed: front ? [...groups.shown, front] : groups.shown, orders: loadRowOrders(), hiddenRows: loadHiddenSessions() }
    // orderTick: the hidden lists and the orders live in localStorage, read again when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.projects, activeProjectId, tabbedProjects, orderTick])
  const { numbered } = sidebarState
  /** A project's rows as the sidebar lists them. */
  const rowsOf = useCallback((pid: string) => {
    const node = model.projects.find((n) => n.project.id === pid)
    return node ? projectRows(node, tabsOf(ws, pid), labels, sidebarState.orders[pid], sidebarState.hiddenRows) : []
  }, [model.projects, ws, labels, sidebarState])
  // Every tab's ⌘N, by its place in the strip: 1–8, and 9 on the last.
  const stripDigits = useMemo(() => {
    const m = new Map<string, number>()
    ws.tabs.forEach((t, i) => {
      const d = tabDigit(i, ws.tabs.length)
      if (d) m.set(t.id, d)
    })
    return m
  }, [ws.tabs])
  /** A sidebar row brought to the front: its tab, or a tab for it, as a click does. */
  const openRow = useCallback((r: SidebarRow) => {
    if (r.tab) onActivateTab(r.tab.id)
    else if (r.node) openSession(r.node.session, r.projectId)
  }, [onActivateTab, openSession])
  /** ⌘1–⌘9: the strip's tab at that place, ⌘9 the last; nothing past the end. */
  const focusTab = useCallback((index: number) => {
    const t = index === 8 ? ws.tabs[ws.tabs.length - 1] : ws.tabs[index]
    if (t) onActivateTab(t.id)
  }, [ws.tabs, onActivateTab])
  /** ⌥⌘← ⌥⌘→: the project before or after the one in front, round the end. */
  const stepProject = useCallback((delta: 1 | -1) => {
    const n = numbered.length
    if (n === 0) return
    const at = numbered.indexOf(activeProjectId)
    const next = at < 0 ? (delta === 1 ? 0 : n - 1) : (at + delta + n) % n
    onSelectProject(numbered[next]!)
  }, [numbered, activeProjectId, onSelectProject])
  /**
   * ⌥⌘↓ ⌥⌘↑: the row below or above under the project in front (the front
   * tab's), round the end, in either sidebar mode. A tab comes to the
   * front; a session with no tab opens in one, as a click on its row does.
   */
  const stepSession = useCallback((delta: 1 | -1) => {
    const rows = rowsOf(activeProjectId)
    if (rows.length === 0) { setToast(`Nothing is open in ${projectsById.get(activeProjectId)?.name ?? 'this project'}.`); return }
    const front = workspaceShown && current ? tabRowKey(current) : undefined
    const at = rows.findIndex((r) => leadKey(r) === front)
    const n = rows.length
    openRow(rows[at < 0 ? (delta === 1 ? 0 : n - 1) : (at + delta + n) % n]!)
  }, [rowsOf, activeProjectId, projectsById, workspaceShown, current, openRow])
  /** A tab dragged in the strip: it takes that place, and the numbers follow. */
  const onStripMove = useCallback((id: string, to: number) => dispatch({ type: 'move', tabId: id, toIndex: to }), [])
  /**
   * Tabbed rows dragged in the Flat sidebar, in their new order: they take
   * the strip's places the same tabs held, so a shell or file tab the list
   * does not show keeps its own.
   */
  const onOrderTabs = useCallback((ids: string[]) => {
    const moved = new Set(ids)
    let k = 0
    dispatch({ type: 'order', ids: ws.tabs.map((t) => (moved.has(t.id) ? ids[k++]! : t.id)) })
  }, [ws.tabs])

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

  // New project from a template (ADR-065): the job outlives its sheet
  // (lib/useTemplateJob.ts); its agent starts in a tab, as a first task's does.
  const sheetKind = useRef(sheet?.kind)
  sheetKind.current = sheet?.kind
  const tpl = useTemplateJob(data.ops, {
    onStarted: (sessionId, projectId, job) => { openTab({ kind: 'session', sessionId }, projectId, job.name); refresh() },
    onMade: (projectId) => { refresh(); dispatch({ type: 'project', projectId }) },
    toast: setToast,
    sheetOpen: () => sheetKind.current === 'template',
    closeSheet: () => setSheet((s) => (s?.kind === 'template' ? null : s)),
  })
  const onFromTemplate = useCallback(() => setSheet({ kind: 'template' }), [])

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
  // The wizard needs the projects API (scan); without it, the plain sheet.
  const onAddProject = useCallback(() => setSheet(source === 'api' ? { kind: 'new-project' } : { kind: 'project' }), [source])
  const onPalette = useCallback(() => setSheet({ kind: 'palette' }), [])
  /**
   * To the dashboard where it was left (lib/screenPlace.ts); from the
   * dashboard itself, Home at its top — the quick way home (owner,
   * 2026-10-14, translated: "at worst, be able to quickly go back to the main
   * screen").
   */
  const dashScroll = useRef<HTMLDivElement>(null)
  const getDashScroll = useCallback(() => dashScroll.current, [])
  const onDashboard = useCallback(() => {
    if (!isWorkspaceHash(location.hash) && !isSystemTabHash(location.hash)) goHomeTop(goHash)
    else goHash(lastDashboard.current || '#/')
  }, [goHash])
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
  // The sidebar's "phone" shows the pairing code at once; "Telegram" only
  // scrolls (owner, 2026-10-13).
  const onSettingsSection = useCallback((section: SettingsSection) => openSettingsSection(section, { showCode: section === 'phone' }), [])

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
  /**
   * End the quick chats and agents whose tab closed: `end`, a SIGTERM first,
   * so Claude Code writes its transcript and the conversation can be
   * continued (--resume); killed only if it will not stop. Never asked twice.
   */
  const stopChats = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    void Promise.all(ids.map((id) => api.signal(id, 'end').catch((e) => setToast(`Could not stop the session: ${errText(e)}`))))
      .then(() => refresh())
  }, [refresh])
  const finishClose = useCallback((tabId: string, paneId: string | undefined, stop: readonly ClosingShell[], chats: readonly string[] = []) => {
    dispatch(paneId ? { type: 'close-pane', tabId, paneId } : { type: 'close', tabId })
    stopShells(stop)
    stopChats(chats)
  }, [stopShells, stopChats])
  // What requestClose reads, kept current without making it, and so every
  // close button, a new function on each poll.
  const closeCtx = useRef({ tabs: ws.tabs, sessionsById, sessions: data.sessions, labels, model, endedChats, permissions: data.permissions })
  closeCtx.current = { tabs: ws.tabs, sessionsById, sessions: data.sessions, labels, model, endedChats, permissions: data.permissions }
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
  /** Closes the tab and ends `ended` of its agents, saying the conversation is kept. */
  const closeEnding = useCallback(async (tabId: string, paneId: string | undefined, chats: readonly string[], ended: readonly string[]) => {
    await closeShells(tabId, paneId, [...chats, ...ended])
    if (ended.length > 0) setToast(AGENT_SAVED_TOAST)
  }, [closeShells])
  /** Ends the chosen agents with their tab (*End the agent* in Settings): one more question when any is still answering. */
  const endAgents = useCallback((tabId: string, paneId: string | undefined, chats: readonly string[], agents: AgentClosePlan) => {
    if (agents.busy.length > 0) setClosing({ kind: 'agent-busy', tabId, paneId, chats, agents })
    else void closeEnding(tabId, paneId, chats, agents.all)
  }, [closeEnding])
  /**
   * The agents' half of a close, once the quick chats' is decided
   * (lib/agentClose.ts). One decision at most (owner, 2026-10-15,
   * translated: "I never understand whether data is kept and which button
   * to pick — one button"): an agent Caprock started that is idle ends with
   * its tab, no question, and a toast says the conversation is saved; one
   * working or waiting on you gets one sentence and *Close tab* (it keeps
   * working) or *Stop it instead*. Settings → Closing a tab can make it
   * always keep or always end. An agent another terminal started only
   * loses its tab (rule 7).
   */
  const closeAgents = useCallback(async (tabId: string, paneId: string | undefined, chats: readonly string[]) => {
    const { tabs, sessionsById, endedChats, labels, permissions } = closeCtx.current
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const agents = planAgentClose(tab, paneId, sessionsById, (s) => endedChats.has(s.session_id) || isQuickChat(s) || !!startedChat(s.session_id), (id) => permissions.has(id))
    const how = agents.all.length > 0 ? loadAgentClose() : 'keep'
    if (how === 'keep') { await closeShells(tabId, paneId, chats); return }
    if (how === 'end') { endAgents(tabId, paneId, chats, agents); return }
    if (agents.active.length === 0) { await closeEnding(tabId, paneId, chats, agents.all); return }
    setClosing({ kind: 'agent', tabId, paneId, chats, agents, title: labels.get(tabId)?.title ?? tab.title })
  }, [closeShells, closeEnding, endAgents])
  /**
   * Close a tab, or one pane of it (.ai/21-app.md § Shell tabs, § Quick
   * chat). An agent Caprock started is asked about (closeAgents): *Close
   * tab*, the default, leaves it running; *Close and end the agent* stops it.
   * One another terminal started runs on, never signalled. A quick
   * chat Caprock started has nothing to come back to and ends with its
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
    await closeAgents(tabId, paneId, chat.stop)
  }, [closeAgents])
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
  // ⌘P: the Pipeline page, and from it back — set further down, where both
  // are known (openPipeline, pipelineBack). ⇧⌘W the same for Work.
  const expandRef = useRef<(() => void) | undefined>(undefined)
  const workRef = useRef<(() => void) | undefined>(undefined)
  const run = useCallback((c: AppCommand) => {
    switch (c.kind) {
      // In the folder of the session in front — its worktree, not the project's root.
      case 'new-shell': if (workspaceShown && current) onNewShell(current.projectId, focusedSession?.cwd || undefined); else onNewShell(); break
      case 'new-agent': onNewAgent(); break
      case 'quick-chat': onQuickChatChooser(); break
      case 'brain-capture': openBrainCapture(); break
      case 'add-project': onAddProject(); break
      case 'detach-tab': if (workspaceShown) detach(); break
      case 'palette': onPalette(); break
      case 'inspector': setPrefs((p) => ({ ...p, inspector: !p.inspector })); showWorkspace(); break
      case 'sidebar': setPrefs((p) => ({ ...p, sidebar: !p.sidebar })); break
      case 'deck':
        // A shell has no deck: say so rather than flip a setting that shows nothing.
        if (workspaceShown && !frontIsAgent && !deck.open) { setToast('The Pipeline bar shows under an agent’s terminal: bring an agent’s tab to the front.'); break }
        setDeck((d) => ({ ...d, open: !d.open }))
        showWorkspace()
        break
      case 'pipeline':
        expandRef.current?.()
        break
      case 'work':
        workRef.current?.()
        break
      // The picker at the foot of the sidebar (SidebarFooter's ThemeButton):
      // the sidebar is shown first when it was hidden, so the picker has
      // somewhere to open from.
      case 'theme':
        if (!prefs.sidebar) {
          setPrefs((p) => ({ ...p, sidebar: true }))
          window.setTimeout(() => window.dispatchEvent(new Event(THEME_MENU_EVENT)), 0)
        } else window.dispatchEvent(new Event(THEME_MENU_EVENT))
        break
      case 'changes':
        if (openChangesRef.current) openChangesRef.current()
        else setToast('Changes shows a git project’s diff: bring a session in one to the front.')
        break
      // From a terminal or the Mail tab to the dashboard, where it was left;
      // there, to Home at its top; from Home at its top, back to the terminals.
      case 'dashboard':
        if (dashboardShown && isHomeHash(location.hash) && (dashScroll.current?.scrollTop ?? 0) < 4) goHash(APP_ROUTE)
        else onDashboard()
        break
      case 'next-tab': dispatch({ type: 'cycle', delta: 1 }); showWorkspace(); break
      case 'prev-tab': dispatch({ type: 'cycle', delta: -1 }); showWorkspace(); break
      case 'tab': focusTab(c.index); break
      case 'step-project': stepProject(c.delta); break
      case 'session': stepSession(c.delta); break
      case 'split': if (workspaceShown) splitShell(c.direction); break
      case 'next-pane': dispatch({ type: 'cycle-pane', delta: 1 }); break
      case 'prev-pane': dispatch({ type: 'cycle-pane', delta: -1 }); break
      case 'next-waiting': jumpToWaiting(); break
      case 'find': if (workspaceShown) window.dispatchEvent(new Event(FIND_EVENT)); break
      case 'settings': onSettings(); break
      case 'feedback': setFeedbackAt(currentScreen(location.hash, true)); break
      case 'mail': onMail(); break
      case 'zoom': stepUiScale(c.step); break
    }
  }, [onNewShell, onNewAgent, onQuickChatChooser, onAddProject, workspaceShown, detach, onPalette, showWorkspace, onDashboard, splitShell, jumpToWaiting, current, focusedSession?.cwd, onSettings, frontIsAgent, deck.open, focusTab, stepProject, stepSession, onMail, dashboardShown, goHash, prefs.sidebar])

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
      if (e.type !== 'keydown') return
      const c = matchAppShortcut(e, isMac)
      if (!c) return
      // Held down, only the digits and the arrow chords repeat.
      if (e.repeat && c.kind !== 'tab' && !isArrowCommand(c)) return
      // In a text field the arrow chords select by word and line there
      // (Alt+Shift+← off macOS): the field keeps them. The terminal's own
      // textarea is not a text field here.
      if (isArrowCommand(c) && isTextField(e.target)) return
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
      ...(source === 'api' && !isPairedDevice()
        ? [{ id: 'a-project-template', group: 'Actions' as const, label: 'New project from a template…', detail: 'a GitHub template repository or a folder, your brief, an agent', icon: <FolderPlusIcon size={14} />, run: onFromTemplate }]
        : []),
      { id: 'a-brain', group: 'Actions', label: 'Add to Second Brain…', detail: 'keep a line of your own', hint: keys('⇧⌘H'), icon: <BrainGlyph size={14} />, run: () => openBrainCapture() },
      { id: 'a-pipeline', group: 'Actions', label: 'Open Pipeline', detail: 'in its own tab: every pull request on its way — open, CI, merged, released', hint: keys(PIPELINE_KEY), icon: <DeckIcon size={14} />, run: () => run({ kind: 'pipeline' }) },
      { id: 'a-deck', group: 'Actions', label: deck.open ? 'Pipeline bar: Off' : 'Pipeline bar: On', detail: deck.open ? 'hide the bar under the agent’s terminal' : 'show the bar under the agent’s terminal', hint: keys('⌘B'), icon: <DeckIcon size={14} />, run: () => run({ kind: 'deck' }) },
      { id: 'a-inspector', group: 'Actions', label: prefs.inspector ? 'Hide the inspector' : 'Show the inspector', hint: keys('⌘I'), icon: <InspectorIcon size={14} />, run: () => run({ kind: 'inspector' }) },
      ...(fileScope ? [{ id: 'a-open-file', group: 'Actions' as const, label: 'Open file…', detail: fileScope.title, icon: <FileIcon size={14} />, run: () => setSheet({ kind: 'files', ...fileScope }) }] : []),
      ...(source === 'api' && activeProject?.kind === 'repo'
        ? [{ id: 'a-copies', group: 'Actions' as const, label: 'Clean up copies…', detail: `${activeProject.name}: worktrees, sizes, merged`, icon: <BranchIcon size={14} />, run: () => onCleanCopies(activeProject.id) }]
        : []),
      { id: 'a-dashboard', group: 'Actions', label: 'Open the dashboard', hint: keys(DASHBOARD_KEY), icon: <DashboardIcon size={14} />, run: onDashboard },
      { id: 'a-mail', group: 'Actions', label: 'Open Mail', detail: 'every inbox in one place, in its own tab', hint: keys('⇧⌘M'), icon: <MailIcon size={14} />, run: onMail },
      { id: 'a-settings', group: 'Actions', label: 'Settings', detail: 'permission mode, theme, terminal, notifications, phone', hint: keys('⌘,'), icon: <SettingsIcon size={14} />, run: onSettings },
      { id: 'a-phone', group: 'Actions', label: 'Open Caprock on your phone', detail: 'pair with a QR code, then add it to the home screen', icon: <SettingsIcon size={14} />, run: openPhoneSettings },
      { id: 'a-telegram', group: 'Actions', label: 'Connect Telegram', detail: 'messages when a session needs you; reply from the chat', icon: <SettingsIcon size={14} />, run: () => openSettingsSection('telegram') },
      // `caprock doctor` in the window: the status strip's panel. No chord (rule 12).
      { id: 'a-doctor', group: 'Actions', label: 'Caprock doctor', detail: 'what Caprock costs this computer: memory, disk, duplicates', icon: <SparkIcon size={14} />, run: openCaprockDoctor },
      { id: 'a-keys', group: 'Actions', label: 'Keyboard shortcuts', detail: 'every key the app answers to', icon: <SearchIcon size={14} />, run: () => setSheet({ kind: 'keys' }) },
      { id: 'a-theme', group: 'Actions', label: 'Switch theme', icon: <SparkIcon size={14} />, run: toggleTheme },
      { id: 'a-theme-pick', group: 'Actions', label: 'Choose a theme…', detail: 'the eight palettes: hover one to try it', hint: keys(THEME_KEY), icon: <SparkIcon size={14} />, run: () => run({ kind: 'theme' }) },
      ...(isTauri() ? [{ id: 'a-zoom-reset', group: 'Actions' as const, label: 'Interface size: back to the default', hint: isMacPlatform() ? keys('⇧⌘0') : undefined, icon: <SparkIcon size={14} />, run: () => stepUiScale(0) }] : []),
      { id: 'a-share', group: 'Actions', label: 'Share my numbers', detail: 'a card of your figures: copy, save or post to X', icon: <SparkIcon size={14} />, run: () => setSheet({ kind: 'share' }) },
      ...SCREENS.map(([route, label, detail]) => ({ id: `a-screen-${route}`, group: 'Actions' as const, label, detail, ...(route === 'work' ? { hint: keys(WORK_KEY) } : {}), icon: route === 'brain' ? <BrainGlyph size={14} /> : <DashboardIcon size={14} />, run: () => { location.hash = `#/${route}` } })),
      { id: 'a-waiting', group: 'Actions', label: 'Next session waiting on you', hint: keys('⌘J'), icon: <SparkIcon size={14} />, run: jumpToWaiting },
      { id: 'a-saved', group: 'Actions', label: 'Run saved…', detail: 'a saved prompt or command', icon: <SparkIcon size={14} />, run: () => setSheet({ kind: 'saved' }) },
      manageSaved,
      ...savedItems,
    )
    // F20: the app's own updater; the answer shows in the status strip.
    if (isTauri()) items.push({ id: 'a-update', group: 'Actions', label: 'Check for updates', icon: <SparkIcon size={14} />, run: () => { void checkByHand() } })
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
  }, [data.sessions, onCompare, savedItems, manageSaved, ws.tabs, model.projects, model.inbox, sessionsById, projectsById, openSessions, prefs.inspector, deck.open, current, onNewAgent, onNewShell, onQuickChatChooser, onAddProject, onDashboard, onMail, toggleTheme, onSettings, run, showWorkspace, openSession, openSplit, onSelectProject, onOpenInbox, jumpToWaiting, splitShell, detach, editors, focusedSession?.cwd, openInEditor, source, onOpenChanges, fileScope, focused?.kind, activeProject, activeProjectId, onCleanCopies, onFromTemplate])

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
        if (w.sessions.some((x) => x.session.session_id === inspectedId)) return { projectId: n.project.id, w, repo: n.project.kind === 'repo' }
      }
    }
    return undefined
  }, [focused, inspectedId, model.projects, source])

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
    const p = model.projects.find((n) => n.worktrees.some((w) => w.sessions.some((x) => x.session.session_id === inspectedId)))?.project
    // "Other folders" is a heading, not a project: the session's own folder names it.
    return p && p.id !== OTHER_FOLDERS_ID ? p : undefined
  }, [focused, inspectedId, model.projects])

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
  /**
   * The sessions a file's reference may be typed into from its tab: agents
   * Caprock started that still run (rule 7), newest first. The same array
   * until what it lists changes, as the session list answers often.
   */
  const sendRows: { t: SendTarget; at: number }[] = []
  for (const n of model.projects) {
    for (const w of n.worktrees) {
      for (const x of w.sessions) {
        if (x.isShell || !attachable(x.session)) continue
        sendRows.push({ t: { id: x.session.session_id, title: x.title, where: w.isMain ? n.project.name : `${n.project.name} · ${w.branch || w.key}` }, at: x.session.worked_at ?? 0 })
      }
    }
  }
  sendRows.sort((a, b) => b.at - a.at)
  const sendKey = JSON.stringify(sendRows.map(({ t }) => [t.id, t.title, t.where]))
  const sendTargetsRef = useRef<{ key: string; list: readonly SendTarget[] }>({ key: '', list: [] })
  if (sendTargetsRef.current.key !== sendKey) sendTargetsRef.current = { key: sendKey, list: sendRows.map(({ t }) => t) }
  const sendTargets = sendTargetsRef.current.list
  /** A reference typed into a session from a file tab: that session comes to the front, its prompt waiting. */
  const onSentRef = useCallback((sessionId: string) => {
    const s = sessionsById.get(sessionId)
    const pid = model.projects.find((n) => n.worktrees.some((w) => w.sessions.some((x) => x.session.session_id === sessionId)))?.project.id
    if (s && pid) openSession(s, pid)
  }, [sessionsById, model.projects, openSession])
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
        absPath={folder ? joinPath(folder, path) : undefined}
        sendTargets={sendTargets}
        onSent={onSentRef}
      />
    )
  }, [folderOf, openFile, editors, openInEditor, sendTargets, onSentRef])

  // A `.md` path an agent printed, clicked in its chat or terminal: open it
  // in a file tab when it lies inside a project Caprock knows (lib/mdreader).
  const openPathCtx = useRef({ projects: model.projects, sessionsById })
  openPathCtx.current = { projects: model.projects, sessionsById }
  useEffect(() => {
    const onOpenPath = (e: Event) => {
      const d = (e as CustomEvent<OpenPathDetail>).detail
      if (!d?.path) return
      const { projects, sessionsById: byId } = openPathCtx.current
      const roots: FileRoot[] = []
      for (const n of projects) {
        if (n.project.root) roots.push({ projectId: n.project.id, worktree: '', folder: n.project.root })
        for (const w of n.worktrees) if (w.path) roots.push({ projectId: n.project.id, worktree: w.isMain ? '' : w.key, folder: w.path })
      }
      const hit = locateFile(d.path, byId.get(d.sessionId)?.cwd ?? '', roots)
      if (hit) openFile(hit.projectId, hit.worktree, hit.path)
      else setToast(`${d.path} is not inside a project Caprock knows, so it cannot open in a tab.`)
    }
    window.addEventListener(OPEN_PATH_EVENT, onOpenPath)
    return () => window.removeEventListener(OPEN_PATH_EVENT, onOpenPath)
  }, [openFile])
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

  // The Pipeline (screens/Pipeline.tsx, .ai/04-ui.md § Pipeline): a pinned
  // system tab of its own, right after the Dashboard tab, at #/pipeline. The
  // dashboard keeps its nav entry and Home's card; both lead here, so the
  // page is drawn once.
  const projectOfSession = useCallback((id: string) => model.projects.find((n) => n.worktrees.some((w) => w.sessions.some((y) => y.session.session_id === id))), [model.projects])
  const wsRef = useRef(ws)
  wsRef.current = ws
  // ⌘P (⇧⌘B until 2026-10-15) is the Pipeline one keystroke away (owner, 2026-10-14, translated:
  // "it feels like quick access to the CI/CD page is missing"): it brings
  // the Pipeline tab to the front — for the agent in front, else where it
  // was left — and, from there, goes back to the tab or screen before it,
  // however the Pipeline was reached (the key, the nav, Home's card).
  const pipelineBackRef = useRef<{ tab?: string; hash: string } | undefined>(undefined)
  if (!pipelineShown) pipelineBackRef.current = { tab: workspaceShown ? current?.id : undefined, hash }
  // The Pipeline tab brings back the repository and pull request last shown
  // in it; a Pipeline pane tab stored before 2026-10-15 comes back as this
  // tab, at that agent's repository (lib/tabs pipelineInStore).
  const lastPipeline = useRef<string | null>(null)
  if (lastPipeline.current === null) {
    let stored: string | null = null
    try { stored = localStorage.getItem(WORKSPACE_KEY) } catch { /* nothing stored */ }
    lastPipeline.current = pipelineInStore(stored) ?? '#/pipeline'
  }
  if (pipelineShown) lastPipeline.current = hash
  useEffect(() => {
    if (pipelineShown && !ws.pipeline) dispatch({ type: 'pipeline', open: true })
  }, [pipelineShown, ws.pipeline])
  const pipelineRoute = parseHash(pipelineShown ? hash : lastPipeline.current)
  const openPipeline = useCallback((of?: SessionSummary) => {
    const target = of ?? (workspaceShown && frontIsAgent ? focusedSession : undefined)
    goHash(target ? href({ name: 'pipeline', of: target.session_id }) : lastPipeline.current || '#/pipeline')
  }, [workspaceShown, frontIsAgent, focusedSession, goHash])
  // Back from the Pipeline: the tab or screen before it, else the terminals
  // (Home when no tab is open).
  const pipelineBack = useCallback(() => {
    const back = pipelineBackRef.current
    if (back?.tab && wsRef.current.tabs.some((t) => t.id === back.tab)) {
      dispatch({ type: 'activate', tabId: back.tab })
      goHash(isWorkspaceHash(back.hash) ? back.hash : APP_ROUTE)
      return
    }
    if (back && parseHash(back.hash).name !== 'pipeline' && !(isWorkspaceHash(back.hash) && wsRef.current.tabs.length === 0)) { goHash(back.hash); return }
    goHash(wsRef.current.tabs.length > 0 ? APP_ROUTE : '#/')
  }, [goHash])
  // Its ×: out of the strip, and back to where it was opened from.
  const closePipeline = useCallback(() => {
    dispatch({ type: 'pipeline', open: false })
    lastPipeline.current = '#/pipeline'
    if (parseHash(location.hash).name === 'pipeline') pipelineBack()
  }, [pipelineBack])
  // Work (⇧⌘W) the same way: the Dashboard tab at #/work, and from it back
  // to the tab or screen it was pressed on.
  const workBackRef = useRef<{ tab?: string; hash: string } | undefined>(undefined)
  const workShown = dashboardShown && shownRoute.name === 'work'
  const openWork = useCallback(() => {
    if (!workShown) workBackRef.current = { tab: workspaceShown ? current?.id : undefined, hash: location.hash }
    goHash(href({ name: 'work' }))
  }, [workShown, workspaceShown, current?.id, goHash])
  const workBack = useCallback(() => {
    const back = workBackRef.current
    workBackRef.current = undefined
    if (back?.tab && wsRef.current.tabs.some((t) => t.id === back.tab)) {
      dispatch({ type: 'activate', tabId: back.tab })
      goHash(isWorkspaceHash(back.hash) ? back.hash : APP_ROUTE)
      return
    }
    if (back && parseHash(back.hash).name !== 'work') { goHash(back.hash); return }
    goHash(wsRef.current.tabs.length > 0 ? APP_ROUTE : '#/')
  }, [goHash])
  // In a layout effect, so a key pressed right after a switch acts on what is now in front.
  useLayoutEffect(() => {
    expandRef.current = pipelineShown ? pipelineBack : () => openPipeline()
    workRef.current = workShown ? workBack : openWork
  }, [pipelineShown, pipelineBack, openPipeline, workShown, workBack, openWork])
  const onPipelineButton = useCallback(() => run({ kind: 'pipeline' }), [run])
  // A session row on Work or Home's Work strip: its tab, brought forward
  // (opened when it has none); a session not in the list, its page.
  const openSessionById = useCallback((id: string) => {
    const s = sessionsById.get(id)
    if (!s) { goHash(`#/session/${encodeURIComponent(id)}`); return }
    openSession(s, placeOf(id)?.node.project.id ?? activeProjectId)
  }, [sessionsById, openSession, placeOf, activeProjectId, goHash])
  // *End* on a Home row (lib/sessionJump.ts): what *Close and end the agent*
  // does — the cockpit's `kill` — and a tab that shows only this session
  // closes with it. Only a session Caprock started is ever offered (rule 7).
  const endSessionFromRow = useCallback((id: string) => {
    const s = sessionsById.get(id)
    if (!s?.owned) return
    const t = findTabBySession(wsRef.current, id)
    if (t && leaves(t.root).length === 1) dispatch({ type: 'close', tabId: t.id })
    stopChats([id])
  }, [sessionsById, stopChats])
  // What the page gets from the app (lib/pipelineHost): the sessions already
  // held, an agent's worktrees for its fix actions, a toast, and the way back.
  const pipelineHost = useMemo<PipelineHost>(() => ({
    sessions: data.sessions,
    worktreesOf: (of) => projectOfSession(of)?.worktrees.map((w) => ({ branch: w.branch, path: w.path, agents: w.sessions.filter((y) => !y.isShell).map((y) => ({ session: y.session, dot: y.dot })) })),
    onStartAgent: async (req, title, of) => {
      const { session_id } = await api.spawn(req)
      openTab({ kind: 'session', sessionId: session_id }, projectOfSession(of)?.project.id ?? activeProjectId, title)
      data.refresh()
    },
    onToast: setToast,
    onBack: pipelineBack,
    onOpenSession: openSessionById,
    tabDigitOf: (id) => {
      const t = findTabBySession(ws, id)
      return t ? stripDigits.get(t.id) ?? null : undefined
    },
    onEndSession: endSessionFromRow,
  }), [data, projectOfSession, openTab, activeProjectId, pipelineBack, openSessionById, ws, stripDigits, endSessionFromRow])

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
              mailActive={mailShown}
              onMail={onMail}
              tabs={ws.tabs}
              tabLabels={labels}
              activeTabId={current?.id}
              onActivateTab={onActivateTab}
              onCloseTab={onCloseTab}
              onOpenLive={openSession}
              onSelectProject={onOpenProjectView}
              onOpenInbox={onOpenInbox}
              onNewAgent={onNewAgent}
              onNewShell={onNewShell}
              onQuickChat={onQuickChatChooser}
              onFolderMenu={editors ? onFolderMenu : undefined}
              onAddProject={onAddProject}
              onDashboard={onDashboard}
              onSettings={onSettings}
              onSettingsSection={onSettingsSection}
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
              grouped={grouped}
              onGroupedChange={onGroupedChange}
              tabDigits={stripDigits}
              onOrderTabs={onOrderTabs}
              onPipeline={onPipelineButton}
              pipelineActive={pipelineShown}
            />
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--app-chrome-bg)]">
          <TabStrip
              tabs={tabs}
              activeTabId={workspaceShown ? current?.id : undefined}
              labels={labels}
              projectName={projectName}
              dashboard={ws.dashboard || dashboardShown ? {
                active: dashboardShown,
                label: dashboardRoute.name === 'settings' ? 'Settings' : 'Dashboard',
                // A tab click brings it back where it was; ⌘0 and the sidebar's row go on to Home.
                onActivate: () => { if (!dashboardShown) goHash(lastDashboard.current || '#/') },
                onClose: closeDashboard,
              } : undefined}
              pipeline={ws.pipeline || pipelineShown ? { active: pipelineShown, onActivate: () => { if (!pipelineShown) goHash(lastPipeline.current || '#/pipeline') }, onClose: closePipeline } : undefined}
              mail={ws.mail || mailShown ? { active: mailShown, onActivate: onMail, onClose: closeMail } : undefined}
              paneTools={workspaceShown}
              sessions={sessionsById}
              permissions={data.permissions}
              inspectorOpen={prefs.inspector}
              sidebarOpen={prefs.sidebar}
              onActivate={onActivateTab}
              onDetach={onCloseTab}
              digits={stripDigits}
              onMove={onStripMove}
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
                    covered={showChat || !!changesView || !!compare}
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
                      instructions={source === 'api' && activeProject?.root ? (
                        <ProjectInstructions key={activeProject.id} project={activeProject} />
                      ) : undefined}
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
                  <ErrorBoundary key={focused.sessionId} label="The deck">
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
                    onToast={setToast}
                    onOpenPipeline={() => openPipeline(focusedSession)}
                    onHide={() => setDeck((d) => ({ ...d, open: false }))}
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
                  </ErrorBoundary>
                )}
                {promptCard && !prefs.inspector && focused && (
                  <div className="shrink-0 border-t border-[var(--app-hairline)] px-3 empty:hidden [&>*]:mb-2">
                    <PermissionPrompt sessionId={focused.sessionId} />
                  </div>
                )}
              </div>
              {mailShown && (
                /* Mail fills its tab: no dashboard header, its own three
                  * columns, under the bar that says where this is and leads
                  * back (components/WhereAmI.tsx). */
                <div data-mail-view className="absolute inset-0 flex flex-col bg-bg">
                  <TabPageBar title="Mail" onDashboard={onDashboard} />
                  <div className="relative min-h-0 flex-1">
                    <ErrorBoundary label="Mail">
                      <Suspense fallback={null}>
                        <MailScreen fill />
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                </div>
              )}
              {/* The Pipeline fills its tab: no dashboard header, the page
                * at the dashboard's width. Kept mounted while its tab is in
                * the strip, so it comes back where it was left; hidden, it
                * asks nothing (ScreenShown, PipelineView's visible). */}
              {(ws.pipeline || pipelineShown) && (
                <div data-pipeline-view className="app-scroll absolute inset-0 overflow-y-auto bg-bg" hidden={!pipelineShown}>
                  {/* No dashboard header here: the bar says where this is and leads back. */}
                  <TabPageBar title={pageTitle(pipelineRoute)} onDashboard={onDashboard} />
                  <ErrorBoundary label="Pipeline">
                    <ScreenShown.Provider value={pipelineShown}>
                      <PipelineHostContext.Provider value={pipelineHost}>
                        <div className="mx-auto w-full max-w-[1600px] p-3">
                          <Suspense fallback={null}>
                          <PipelineScreen
                            repo={pipelineRoute.name === 'pipeline' ? pipelineRoute.repo : undefined}
                            of={pipelineRoute.name === 'pipeline' ? pipelineRoute.of : undefined}
                            pr={pipelineRoute.name === 'pipeline' ? pipelineRoute.pr : undefined}
                          />
                          </Suspense>
                        </div>
                      </PipelineHostContext.Provider>
                    </ScreenShown.Provider>
                  </ErrorBoundary>
                </div>
              )}
              {/* Kept mounted behind the terminals once opened, so it comes
                * back where it was left (lib/screenPlace.ts); hidden, it asks
                * nothing and its clocks stop. */}
              {(ws.dashboard || dashboardShown) && (
                <div ref={dashScroll} data-dashboard-view className="app-scroll absolute inset-0 overflow-y-auto bg-bg" hidden={!dashboardShown}>
                  {/* Settings' own × and Escape close it as its tab's × does (lib/settingsClose.ts). */}
                  <CloseSettingsContext.Provider value={closeDashboard}>
                    {/* Settings → Subscriptions types a sign-in into a shell tab (ADR-048). */}
                    <SetupShellContext.Provider value={onSetupAgent}>
                      <Suspense fallback={null}>
                        <PipelineHostContext.Provider value={pipelineHost}>
                          <Dashboard route={dashboardRoute} inApp shown={dashboardShown} scroller={getDashScroll} />
                        </PipelineHostContext.Provider>
                      </Suspense>
                    </SetupShellContext.Provider>
                  </CloseSettingsContext.Provider>
                </div>
              )}
            </div>
            {workspaceShown && prefs.inspector && (
              <div className="h-full shrink-0" style={{ width: 'var(--app-inspector-w)' }}>
                <Inspector
                  session={inspectedSession}
                  project={focusedProject}
                  sessionId={focusedFile ? undefined : inspectedId}
                  hasPermission={!!inspectedId && data.permissions.has(inspectedId)}
                  showPrompt={promptCard}
                  onClose={() => setPrefs((p) => ({ ...p, inspector: false }))}
                  onDetach={detach}
                  editors={editors}
                  onOpenInEditor={openInEditor}
                  onReviewChanges={focusedWorktree?.repo ? () => onOpenChanges(focusedWorktree.projectId, focusedWorktree.w) : undefined}
                  onOpenFile={focusedWorktree?.repo ? (p) => openFile(focusedWorktree.projectId, focusedWorktree.w.isMain ? '' : focusedWorktree.w.key, p) : undefined}
                  summary={data.summary}
                  onCompare={inspectedSession?.attempt_group ? () => onCompare(inspectedSession) : undefined}
                  onOpenPRs={inspectedSession && inspectedSession.kind !== 'shell' ? () => openPipeline(inspectedSession) : undefined}
                />
              </div>
            )}
          </div>
        </main>
      </div>
      {/* With the sidebar open its Today strip carries the plan windows and the day's spend, so the strip leaves them out. */}
      {/* The GitHub star ask sits above the status strip, never over a
        * terminal; the share toast floats (lib/nudges.ts, one at a time). */}
      {/* How to move around, once, while tabs are open: a line in the flow
        * above the strips, so it covers neither a terminal nor a banner. */}
      {workspaceShown && ws.tabs.length > 0 && <KeysHint isMac={isMac} onAllKeys={() => setSheet({ kind: 'keys' })} />}
      <SetupStrip app />
      <MailStrip />
      {/* A survey question, never while a session waits on a permission prompt (ADR-062). */}
      <OfferStrip busy={data.permissions.size > 0} />
      <StarStrip app />
      <BrainCaptureHost />
      <ShareMoment />
      <StatusStrip summary={data.summary} pane={focused ? paneStatus[focused.sessionId] : undefined} session={focused?.kind === 'session' && workspaceShown ? focusedSession : undefined} version={version} figures={!prefs.sidebar} sessions={data.sessions} onOpenSession={openSessionById} />
      <AppUpdateToast />
      {/* Another computer asking to control this one (ADR-067). */}
      <ComputerAsks />
      {isTauri() && <AppUpdateAsk />}
      {isTauri() && <AppAutoUpdate />}

      {feedbackAt !== null && <FeedbackDialog screen={feedbackAt} onClose={() => setFeedbackAt(null)} />}
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
          onNewProject={source === 'api' ? (prompt) => setSheet({ kind: 'new-project', prompt }) : undefined}
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
      {sheet?.kind === 'new-project' && (
        <ProjectWizard
          projects={model.projects.map((n) => n.project)}
          onClose={closeSheet}
          onCreated={(id) => { refresh(); dispatch({ type: 'project', projectId: id }) }}
          onStartAgent={(id) => setSheet({ kind: 'agent', projectId: id, prompt: sheet.prompt })}
          onMoreWays={() => setSheet({ kind: 'project' })}
          onFromTemplate={isPairedDevice() ? undefined : onFromTemplate}
        />
      )}
      {sheet?.kind === 'template' && (
        <TemplateProjectSheet
          projects={model.projects.map((n) => n.project)}
          job={tpl.job}
          op={tpl.op}
          onClose={closeSheet}
          onSubmitted={tpl.submit}
          onOp={tpl.setOp}
          onStartAgent={(job) => { tpl.reset(); setSheet({ kind: 'agent', projectId: job.projectId, cwd: job.cwd, here: true, prompt: job.prompt }) }}
          onReset={tpl.reset}
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
          onStop={() => { setClosing(null); void closeAgents(closing.tabId, closing.paneId, [...closing.chat.stop, ...closing.chat.busy]) }}
          onKeep={() => { setClosing(null); void closeAgents(closing.tabId, closing.paneId, closing.chat.stop) }}
          onCancel={() => setClosing(null)}
        />
      )}
      {closing?.kind === 'agent' && (
        <CloseAgentChoice
          title={closing.title}
          many={closing.agents.active.length > 1}
          onKeep={() => {
            // The ones working or waiting keep on; an idle one beside them in a split ends.
            setClosing(null); void closeEnding(closing.tabId, closing.paneId, closing.chats, closing.agents.all.filter((id) => !closing.agents.active.includes(id)))
          }}
          onEnd={() => { setClosing(null); void closeEnding(closing.tabId, closing.paneId, closing.chats, closing.agents.all) }}
          onCancel={() => setClosing(null)}
        />
      )}
      {closing?.kind === 'agent-busy' && (
        <CloseChatConfirm
          agent
          onStop={() => { setClosing(null); void closeEnding(closing.tabId, closing.paneId, closing.chats, closing.agents.all) }}
          onKeep={() => { setClosing(null); void closeShells(closing.tabId, closing.paneId, closing.chats) }}
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
  instructions,
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
  /** What the project's agents are told: Caprock's instructions and the repository's own files. */
  instructions?: React.ReactNode
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
        {instructions}
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

/** A field the user types text into, other than a terminal's own input. */
function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.classList.contains('xterm-helper-textarea')) return false
  return t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(t.type))
}

/** Whether the sidebar groups sessions by project ('on', the default) or lists them flat ('off'): this viewer's. */
