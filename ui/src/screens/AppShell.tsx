/**
 * The app workspace (WP-04, WP-06): sidebar, terminal tabs, inspector and
 * status strip — what the desktop app opens on (.ai/21-app.md § What the
 * user sees). Served at `#/app` or `?app=1`, and inside the Tauri shell.
 *
 * The dashboard's screens open inside it at their usual hash routes; the
 * terminals stay mounted behind them, so switching back never repaints from
 * nothing and never drops a socket that was in use.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { api, ApiError, errText, type SessionSummary } from '@/lib/api'
import { APP_ROUTE, isMacPlatform, isTauri, isWorkspaceHash } from '@/lib/appmode'
import { matchAppShortcut, type AppCommand } from '@/lib/appkeys'
import { parseHash } from '@/lib/router'
import { NotSupportedError, projectsApi, type Project } from '@/lib/projects'
import { buildSidebar, sessionTitle, type InboxItem, type SessionNode } from '@/lib/sidebar'
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
<<<<<<< HEAD
import { useShellTray } from '@/lib/tray'
import { OPEN_SESSION_EVENT } from '@/lib/shell'
=======
import { useOsNotifications } from '@/lib/notify'
>>>>>>> 2a21082 (feat(notify): notify frame beside Telegram and OS notifications in the app (WP-09))
import { useTheme } from '@/lib/theme'
import { Sidebar } from '@/components/Sidebar'
import { TabStrip, TerminalStack } from '@/components/TerminalTabs'
import { Inspector } from '@/components/Inspector'
import { StatusStrip } from '@/components/StatusStrip'
import { PermissionPrompt } from '@/components/PermissionPrompt'
import { NewAgentSheet } from '@/components/NewAgentSheet'
import { AddProjectSheet, splitPath } from '@/components/AddProjectSheet'
import { CommandPalette, type PaletteItem } from '@/components/CommandPalette'
import { DashboardIcon, FolderIcon, FolderPlusIcon, InspectorIcon, PlusIcon, SparkIcon, TerminalIcon } from '@/components/AppIcons'
import type { PaneStatus } from '@/components/TerminalPane'

const Dashboard = lazy(() => import('@/App').then((m) => ({ default: m.Dashboard })))
const PairScreen = lazy(() => import('@/screens/Pair').then((m) => ({ default: m.PairScreen })))

const UI_KEY = 'caprock.app.ui'

interface UiPrefs {
  sidebar: boolean
  inspector: boolean
}

function loadPrefs(): UiPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as Partial<UiPrefs>
    return { sidebar: v.sidebar !== false, inspector: v.inspector === true }
  } catch {
    return { sidebar: true, inspector: false }
  }
}

type SheetState =
  | { kind: 'agent'; projectId?: string; cwd?: string }
  | { kind: 'project' }
  | { kind: 'palette' }
  | null

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
  const [version, setVersion] = useState<string | undefined>(undefined)
  const [, toggleTheme] = useTheme()

  useEffect(() => { saveWorkspace(ws) }, [ws])
  // The sidebar and tab strip lay out around the macOS traffic lights and
  // carry their own drag regions, so the shell's padding and strip go
  // (app/README.md § Title bar).
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-caprock-chrome', '')
    return () => root.removeAttribute('data-caprock-chrome')
  }, [])
  useEffect(() => {
    try { localStorage.setItem(UI_KEY, JSON.stringify(prefs)) } catch { /* not kept */ }
  }, [prefs])
  useEffect(() => {
    api.status().then((s) => setVersion(s.version)).catch(() => { /* the strip shows none */ })
  }, [])
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
    dispatch({ type: 'open', target, projectId, title })
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
    dispatch({ type: 'project', projectId: id })
    showWorkspace()
  }, [showWorkspace])

  const { source, refresh } = data
  const closeSheet = useCallback(() => setSheet(null), [])
  const onProjectAdded = useCallback((projectId: string) => { refresh(); dispatch({ type: 'project', projectId }) }, [refresh])
  const newShell = useCallback(async (projectId?: string, cwd?: string) => {
    const p: Project | undefined = projectsById.get(projectId ?? activeProjectId)
    if (!p || (!p.root && !cwd)) { setSheet({ kind: 'project' }); return }
    try {
      const projectNumber = Number(p.id)
      const req = source === 'api' && !cwd && Number.isInteger(projectNumber)
        ? { project_id: projectNumber, cols: 120, rows: 32 }
        : { cwd: cwd ?? p.root, cols: 120, rows: 32 }
      const shell = await projectsApi.startShell(req)
      openTab({ kind: 'shell', sessionId: shell.id }, p.id, 'shell')
      refresh()
    } catch (e) {
      setToast(e instanceof NotSupportedError ? `${e.message} Start an agent with ⇧⌘N meanwhile.` : `Could not start a shell: ${errText(e)}`)
    }
  }, [projectsById, activeProjectId, source, refresh, openTab])

  const onNewAgent = useCallback((projectId?: string, cwd?: string) => setSheet({ kind: 'agent', projectId: projectId ?? activeProjectId, cwd }), [activeProjectId])
  const onNewShell = useCallback((projectId?: string, cwd?: string) => { void newShell(projectId, cwd) }, [newShell])
  const onAddProject = useCallback(() => setSheet({ kind: 'project' }), [])
  const onPalette = useCallback(() => setSheet({ kind: 'palette' }), [])
  const onDashboard = useCallback(() => { location.hash = '#/' }, [])
  const onPaneStatus = useCallback((sessionId: string, s: PaneStatus) => setPaneStatus((cur) => ({ ...cur, [sessionId]: s })), [])

  const detach = useCallback(() => { if (current) dispatch({ type: 'close', tabId: current.id }) }, [current])

  const run = useCallback((c: AppCommand) => {
    switch (c.kind) {
      case 'new-shell': onNewShell(); break
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
    }
  }, [onNewShell, onNewAgent, onAddProject, workspaceShown, detach, onPalette, showWorkspace, onDashboard])

  // The app's keys, before anything else on the page sees them. The terminal
  // already lets them through (xtermInput), and they are never its keys.
  useEffect(() => {
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

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      { id: 'a-agent', group: 'Actions', label: 'New agent', hint: '⇧⌘N', icon: <PlusIcon size={14} />, run: () => onNewAgent() },
      { id: 'a-shell', group: 'Actions', label: 'New shell', hint: '⌘T', icon: <TerminalIcon size={14} />, run: () => onNewShell() },
      { id: 'a-project', group: 'Actions', label: 'Add a project', hint: '⌘O', icon: <FolderPlusIcon size={14} />, run: onAddProject },
      { id: 'a-inspector', group: 'Actions', label: prefs.inspector ? 'Hide the inspector' : 'Show the inspector', hint: '⌘I', icon: <InspectorIcon size={14} />, run: () => run({ kind: 'inspector' }) },
      { id: 'a-dashboard', group: 'Actions', label: 'Open the dashboard', hint: '⇧⌘D', icon: <DashboardIcon size={14} />, run: onDashboard },
      { id: 'a-theme', group: 'Actions', label: 'Switch theme', icon: <SparkIcon size={14} />, run: toggleTheme },
    ]
    for (const t of ws.tabs) {
      const s = sessionsById.get(focusedLeaf(t).target.sessionId)
      items.push({ id: `t-${t.id}`, group: 'Tabs', label: s ? sessionTitle(s) : t.title, detail: projectsById.get(t.projectId)?.name, icon: <TerminalIcon size={14} />, run: () => { dispatch({ type: 'activate', tabId: t.id }); showWorkspace() } })
    }
    for (const n of model.projects) {
      for (const w of n.worktrees) {
        for (const x of w.sessions) {
          if (x.dot === 'ended' || openSessions.has(x.session.session_id)) continue
          items.push({ id: `s-${x.session.session_id}`, group: 'Sessions', label: x.title, detail: `${n.project.name} · ${w.branch}`, icon: <SparkIcon size={14} />, run: () => openSession(x.session, n.project.id) })
        }
      }
      items.push({ id: `p-${n.project.id}`, group: 'Projects', label: n.project.name, detail: n.project.root, icon: <FolderIcon size={14} />, run: () => onSelectProject(n.project.id) })
    }
    return items
  }, [ws.tabs, model.projects, sessionsById, projectsById, openSessions, prefs.inspector, onNewAgent, onNewShell, onAddProject, onDashboard, toggleTheme, run, showWorkspace, openSession, onSelectProject])

  const focusedIsAgent = !!focused && focused.kind === 'session' && focusedSession?.kind !== 'shell'

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
              onAddProject={onAddProject}
              onDashboard={onDashboard}
              onPalette={onPalette}
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
              onActivate={(id) => dispatch({ type: 'activate', tabId: id })}
              onDetach={(id) => dispatch({ type: 'close', tabId: id })}
              onMove={(id, to) => dispatch({ type: 'move', tabId: id, toIndex: to })}
              onNewAgent={() => onNewAgent()}
              onNewShell={() => onNewShell()}
              onToggleInspector={() => setPrefs((p) => ({ ...p, inspector: !p.inspector }))}
            />
          )}
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <div className="absolute inset-0 flex flex-col" hidden={!workspaceShown}>
                <div className="relative min-h-0 flex-1">
                  <TerminalStack tabs={ws.tabs} visibleTabId={workspaceShown ? current?.id : undefined} onPaneStatus={onPaneStatus} />
                  {!current && (
                    <EmptyWorkspace
                      project={activeProject}
                      hasProjects={model.projects.length > 0}
                      onNewAgent={() => onNewAgent()}
                      onNewShell={() => onNewShell()}
                      onAddProject={onAddProject}
                    />
                  )}
                </div>
                {focusedIsAgent && !prefs.inspector && focused && (
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
                  onClose={() => setPrefs((p) => ({ ...p, inspector: false }))}
                  onDetach={detach}
                />
              </div>
            )}
          </div>
        </main>
      </div>
      <StatusStrip summary={data.summary} pane={focused ? paneStatus[focused.sessionId] : undefined} version={version} />

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
      {sheet?.kind === 'palette' && <CommandPalette items={paletteItems} onClose={() => setSheet(null)} />}
    </div>
  )
}

function EmptyWorkspace({
  project,
  hasProjects,
  onNewAgent,
  onNewShell,
  onAddProject,
}: {
  project?: Project
  hasProjects: boolean
  onNewAgent: () => void
  onNewShell: () => void
  onAddProject: () => void
}) {
  return (
    <div className="app-slab absolute inset-0 flex items-center justify-center px-8">
      <div className="grid w-full max-w-[440px] gap-6">
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
