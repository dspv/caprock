/**
 * The workspace's tabs: which terminals are open, in which project, in which
 * order, and which one is in front (WP-04).
 *
 * A tab holds a tree of panes rather than one terminal, so split panes (F15)
 * slot in later without changing what is stored: today every tab is a single
 * leaf. The whole workspace is kept in localStorage and restored on relaunch;
 * what it restores is only which sessions were open — the terminals reconnect
 * and the daemon repaints them.
 */

/** What a pane shows: an agent session, or a shell (a session of kind `shell`). */
export interface TabTarget {
  kind: 'session' | 'shell'
  sessionId: string
}

export interface PaneLeaf {
  type: 'pane'
  id: string
  target: TabTarget
}

export interface PaneSplit {
  type: 'split'
  id: string
  direction: 'row' | 'column'
  children: PaneNode[]
  /** Fractions of the split, one per child, summing to 1. */
  sizes: number[]
}

export type PaneNode = PaneLeaf | PaneSplit

export interface Tab {
  id: string
  /** The project the tab belongs to (Project.id, or a derived key). */
  projectId: string
  root: PaneNode
  focusedPaneId: string
  /** The last title seen, so a restored tab has a name before the sessions list answers. */
  title: string
}

export interface Workspace {
  version: 1
  tabs: Tab[]
  /** The tab in front, per project. */
  activeByProject: Record<string, string>
  /** The project whose tabs are shown. */
  activeProject: string
}

export type WorkspaceAction =
  | { type: 'open'; target: TabTarget; projectId: string; title: string }
  | { type: 'close'; tabId: string }
  | { type: 'activate'; tabId: string }
  | { type: 'activate-index'; index: number }
  | { type: 'cycle'; delta: 1 | -1 }
  | { type: 'move'; tabId: string; toIndex: number }
  | { type: 'project'; projectId: string }
  | { type: 'retitle'; sessionId: string; title: string }
  | { type: 'drop-session'; sessionId: string }

export const EMPTY_WORKSPACE: Workspace = { version: 1, tabs: [], activeByProject: {}, activeProject: '' }

export const WORKSPACE_KEY = 'caprock.app.workspace.v1'

let counter = 0
function newId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** Every leaf under a node, left to right. */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(leaves)
}

/** The leaf a tab has focused, or its first one. */
export function focusedLeaf(tab: Tab): PaneLeaf {
  const all = leaves(tab.root)
  return all.find((l) => l.id === tab.focusedPaneId) ?? all[0]!
}

/** The tabs of one project, in strip order. */
export function tabsOf(ws: Workspace, projectId: string): Tab[] {
  return ws.tabs.filter((t) => t.projectId === projectId)
}

/** The tab in front for the shown project, if any. */
export function activeTab(ws: Workspace): Tab | undefined {
  const id = ws.activeByProject[ws.activeProject]
  return ws.tabs.find((t) => t.id === id && t.projectId === ws.activeProject)
}

/** The tab already showing a session, anywhere in the workspace. */
export function findTabBySession(ws: Workspace, sessionId: string): Tab | undefined {
  return ws.tabs.find((t) => leaves(t.root).some((l) => l.target.sessionId === sessionId))
}

function withActive(ws: Workspace, projectId: string, tabId: string | undefined): Workspace {
  const activeByProject = { ...ws.activeByProject }
  if (tabId) activeByProject[projectId] = tabId
  else delete activeByProject[projectId]
  return { ...ws, activeByProject }
}

export function workspaceReducer(ws: Workspace, a: WorkspaceAction): Workspace {
  switch (a.type) {
    case 'open': {
      const existing = findTabBySession(ws, a.target.sessionId)
      if (existing) return { ...withActive(ws, existing.projectId, existing.id), activeProject: existing.projectId }
      const pane: PaneLeaf = { type: 'pane', id: newId('pane'), target: a.target }
      const tab: Tab = { id: newId('tab'), projectId: a.projectId, root: pane, focusedPaneId: pane.id, title: a.title }
      return { ...withActive({ ...ws, tabs: [...ws.tabs, tab] }, a.projectId, tab.id), activeProject: a.projectId }
    }
    case 'close': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab) return ws
      const siblings = tabsOf(ws, tab.projectId)
      const at = siblings.findIndex((t) => t.id === tab.id)
      const tabs = ws.tabs.filter((t) => t.id !== tab.id)
      if (ws.activeByProject[tab.projectId] !== tab.id) return { ...ws, tabs }
      // The neighbour to the right takes the front, else the one to the left —
      // what every tabbed app does, so the hand already knows where it lands.
      const rest = siblings.filter((t) => t.id !== tab.id)
      const next = rest[Math.min(at, rest.length - 1)]
      return withActive({ ...ws, tabs }, tab.projectId, next?.id)
    }
    case 'activate': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab) return ws
      return { ...withActive(ws, tab.projectId, tab.id), activeProject: tab.projectId }
    }
    case 'activate-index': {
      const list = tabsOf(ws, ws.activeProject)
      // Cmd+9 is the last tab, however many there are, as in a browser.
      const tab = a.index === 8 ? list[list.length - 1] : list[a.index]
      return tab ? withActive(ws, tab.projectId, tab.id) : ws
    }
    case 'cycle': {
      const list = tabsOf(ws, ws.activeProject)
      if (list.length === 0) return ws
      const at = list.findIndex((t) => t.id === ws.activeByProject[ws.activeProject])
      const next = list[(Math.max(at, 0) + a.delta + list.length) % list.length]!
      return withActive(ws, next.projectId, next.id)
    }
    case 'move': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab) return ws
      const siblings = tabsOf(ws, tab.projectId).filter((t) => t.id !== tab.id)
      const to = Math.max(0, Math.min(a.toIndex, siblings.length))
      siblings.splice(to, 0, tab)
      const others = ws.tabs.filter((t) => t.projectId !== tab.projectId)
      return { ...ws, tabs: [...others, ...siblings] }
    }
    case 'project':
      return ws.activeProject === a.projectId ? ws : { ...ws, activeProject: a.projectId }
    case 'retitle': {
      let changed = false
      const tabs = ws.tabs.map((t) => {
        if (t.title === a.title || focusedLeaf(t).target.sessionId !== a.sessionId) return t
        changed = true
        return { ...t, title: a.title }
      })
      return changed ? { ...ws, tabs } : ws
    }
    case 'drop-session': {
      const tab = findTabBySession(ws, a.sessionId)
      return tab ? workspaceReducer(ws, { type: 'close', tabId: tab.id }) : ws
    }
  }
}

function isTarget(v: unknown): v is TabTarget {
  const t = v as TabTarget
  return !!t && (t.kind === 'session' || t.kind === 'shell') && typeof t.sessionId === 'string' && t.sessionId !== ''
}

function isPane(v: unknown): v is PaneNode {
  const n = v as PaneNode
  if (!n || typeof n.id !== 'string') return false
  if (n.type === 'pane') return isTarget(n.target)
  if (n.type === 'split') {
    return (n.direction === 'row' || n.direction === 'column') &&
      Array.isArray(n.children) && n.children.length > 0 && n.children.every(isPane) &&
      Array.isArray(n.sizes) && n.sizes.length === n.children.length
  }
  return false
}

/**
 * A stored workspace, checked field by field. Anything malformed — an older
 * shape, a hand edit, a half-written value — is dropped rather than trusted,
 * so a bad entry costs the open tabs, never the app.
 */
export function parseWorkspace(raw: string | null): Workspace {
  if (!raw) return EMPTY_WORKSPACE
  try {
    const v = JSON.parse(raw) as Partial<Workspace>
    if (v.version !== 1 || !Array.isArray(v.tabs)) return EMPTY_WORKSPACE
    const tabs = v.tabs.filter((t): t is Tab =>
      !!t && typeof t.id === 'string' && typeof t.projectId === 'string' && isPane(t.root) && typeof t.focusedPaneId === 'string',
    ).map((t) => ({ ...t, title: typeof t.title === 'string' ? t.title : '' }))
    const ids = new Set(tabs.map((t) => t.id))
    const activeByProject: Record<string, string> = {}
    for (const [p, id] of Object.entries(v.activeByProject ?? {})) {
      if (typeof id === 'string' && ids.has(id)) activeByProject[p] = id
    }
    return { version: 1, tabs, activeByProject, activeProject: typeof v.activeProject === 'string' ? v.activeProject : '' }
  } catch {
    return EMPTY_WORKSPACE
  }
}

export function loadWorkspace(): Workspace {
  try {
    return parseWorkspace(localStorage.getItem(WORKSPACE_KEY))
  } catch {
    return EMPTY_WORKSPACE
  }
}

export function saveWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(ws))
  } catch { /* private mode or full: the tabs simply are not restored */ }
}
