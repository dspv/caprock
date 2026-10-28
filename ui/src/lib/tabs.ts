/**
 * The workspace's tabs: which terminals are open, in which project, in which
 * order, and which one is in front (WP-04).
 *
 * One strip holds every open tab of every project, in the order they were
 * opened (2026-10-09; it was one strip per project, and picking another
 * project hid every tab of the one before, which read as closing them). A tab
 * still belongs to a project: picking a project brings its last tab to the
 * front, and a project with none shows its empty state with the strip intact.
 *
 * A tab holds a tree of panes rather than one terminal: split panes (F15)
 * are a split node in that tree, so they changed nothing about what is
 * stored. A tab's title, the inspector and the status strip follow the
 * focused pane. The whole workspace is kept in localStorage and restored on relaunch;
 * what it restores is only which sessions were open — the terminals reconnect
 * and the daemon repaints them.
 */

/**
 * What a pane shows: an agent session, a shell (a session of kind `shell`),
 * one of the project's files, read-only, a session Caprock cannot type
 * into — one started in another terminal, or one that ended — shown as its
 * conversation, read-only (`observe`, components/ObservePane.tsx; rule 7).
 * A file's `sessionId` is its key (lib/files.ts fileKey), so each opens once,
 * as a session does. The Pipeline was a pane too (`prs`) until 2026-10-15; it
 * is a pinned system tab of its own now (`Workspace.pipeline`), and a stored
 * one is read as that tab (parseWorkspace, pipelineInStore).
 *
 * A browser tab (`page`, the in-app browser, ADR-075; lib/browsertab.ts,
 * components/BrowserView.tsx) is a tab of its own too, keyed `page:…`. It is
 * never an agent: it has no sidebar row and no ⌘1–⌘9, and the strip keeps
 * every browser tab after every other tab, so pages never sit among the
 * agents.
 *
 * The Files tab (`files`, ADR-089; components/FilesCommander.tsx) is a tab of
 * its own, one per project, keyed `files:<project>`; `worktree` is the folder
 * its right panel opened on. Never split, as a file tab is.
 */
export interface TabTarget {
  kind: 'session' | 'shell' | 'file' | 'observe' | 'page' | 'files'
  sessionId: string
  /** A file: its path relative to the worktree. */
  path?: string
  /** A file: the linked worktree's name; '' or absent for the main checkout. */
  worktree?: string
  /** A page: the address it shows, kept as it navigates so a restart reopens it there; '' for a new tab not yet sent anywhere. */
  url?: string
  /** A page: the session whose link opened it, if one did. */
  of?: string
  /**
   * A page: a phone preview (lib/devservers). It may sit in a split beside a
   * terminal, opens in Phone mode, and shows with the in-app browser
   * setting off — the click that asked for it is the consent.
   */
  preview?: boolean
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
  /** Every open tab of every project, in strip order: the order opened (a new tab goes last), changed only by a drag or a close. Kept across restarts. */
  tabs: Tab[]
  /** The tab last in front, per project: what picking the project shows. */
  activeByProject: Record<string, string>
  /** The project in front; its remembered tab is the one shown. */
  activeProject: string
  /**
   * The Dashboard tab is in the strip, pinned at its left. Absent in a
   * workspace stored before it existed, which reads as false.
   */
  dashboard?: boolean
  /**
   * The Mail tab is in the strip, pinned after the Dashboard tab: there from
   * the first time Mail is opened until it is closed. Absent reads as false.
   */
  mail?: boolean
  /**
   * The Pipeline tab is in the strip, pinned right after the Dashboard tab:
   * there from the first time the Pipeline is opened until it is closed.
   * Absent reads as false.
   */
  pipeline?: boolean
}

export type WorkspaceAction =
  | { type: 'open'; target: TabTarget; projectId: string; title: string }
  | { type: 'close'; tabId: string }
  /** Every tab of a project, splits included; the sessions and shells in them keep running. */
  | { type: 'close-project'; projectId: string }
  | { type: 'activate'; tabId: string }
  | { type: 'activate-index'; index: number }
  | { type: 'cycle'; delta: 1 | -1 }
  | { type: 'move'; tabId: string; toIndex: number }
  /** The strip in this order (a drag in the flat sidebar list, AppShell); tabs not named keep theirs after. */
  | { type: 'order'; ids: string[] }
  /** The project in front; `view` shows its page instead of its last tab (a click on its sidebar row). */
  | { type: 'project'; projectId: string; view?: boolean }
  /** Puts the pinned Dashboard tab in the strip, or takes it out. */
  | { type: 'dashboard'; open: boolean }
  /** Puts the pinned Mail tab in the strip, or takes it out. */
  | { type: 'mail'; open: boolean }
  /** Puts the pinned Pipeline tab in the strip, or takes it out. */
  | { type: 'pipeline'; open: boolean }
  | { type: 'retitle'; sessionId: string; title: string }
  /** A page moved on or named itself: its address and title, as the shell reports them. */
  | { type: 'page-nav'; sessionId: string; url?: string; title?: string }
  | { type: 'drop-session'; sessionId: string }
  /**
   * Put another session in the place this one holds, keeping the tab, its
   * position in the strip and its place in a split. What a dead agent's tab
   * becomes: a shell in the same folder, rather than a tab showing a process
   * that has exited.
   */
  | { type: 'replace-session'; sessionId: string; target: TabTarget; title: string }
  /** Show a session beside the focused pane of the tab in front. */
  | { type: 'split'; target: TabTarget; direction: 'row' | 'column'; projectId: string; title: string }
  | { type: 'focus-pane'; tabId: string; paneId: string }
  | { type: 'cycle-pane'; delta: 1 | -1 }
  | { type: 'close-pane'; tabId: string; paneId: string }
  | { type: 'resize'; tabId: string; splitId: string; sizes: number[] }

/** Panes in one tab, at most: past four a terminal is too small to read. */
export const MAX_PANES = 4

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

/** The leaf a tab is named after: its first agent, else the focused pane.
 *  Named after the focused pane, an agent's tab read "shell" the moment a
 *  shell was split beside it, and two tabs said the same word. */
export function namingLeaf(tab: Tab): PaneLeaf {
  const all = leaves(tab.root)
  // A phone preview beside a terminal never names the tab: the terminal does.
  const named = all.find((l) => l.target.kind !== 'shell' && (l.target.kind !== 'page' || all.length === 1))
  if (named) return named
  const f = focusedLeaf(tab)
  return f.target.kind === 'page' ? all.find((l) => l.target.kind !== 'page') ?? f : f
}

/** Whether a tab shows a web page: a browser tab (ADR-075). */
export function isPageTab(t: Tab): boolean {
  return t.root.type === 'pane' && t.root.target.kind === 'page'
}

/** The tabs that take ⌘1–⌘9: every tab but the pages, in strip order. */
export function numberedTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((t) => !isPageTab(t))
}

/** The tabs of one project, in strip order (the strip itself is `ws.tabs`). */
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

/**
 * The tree with `paneId` split into itself and `leaf`. A split of the same
 * direction gains a sibling instead of nesting, and every child gets an
 * equal share, as in iTerm and Ghostty.
 */
function splitAt(node: PaneNode, paneId: string, leaf: PaneLeaf, direction: 'row' | 'column'): PaneNode {
  if (node.type === 'pane') {
    if (node.id !== paneId) return node
    return { type: 'split', id: newId('split'), direction, children: [node, leaf], sizes: [0.5, 0.5] }
  }
  const at = node.children.findIndex((c) => c.type === 'pane' && c.id === paneId)
  if (at >= 0 && node.direction === direction) {
    const children = [...node.children.slice(0, at + 1), leaf, ...node.children.slice(at + 1)]
    return { ...node, children, sizes: children.map(() => 1 / children.length) }
  }
  return { ...node, children: node.children.map((c) => splitAt(c, paneId, leaf, direction)) }
}

/** The tree without `paneId`, a split left with one child collapsing into it; null when nothing is left. */
function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'pane') return node.id === paneId ? null : node
  const kept: { child: PaneNode; size: number }[] = []
  node.children.forEach((c, i) => {
    const next = removePane(c, paneId)
    if (next) kept.push({ child: next, size: node.sizes[i] ?? 0 })
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]!.child
  const total = kept.reduce((a, k) => a + k.size, 0) || 1
  return { ...node, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size / total) }
}

function resizeSplit(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.type === 'pane') return node
  if (node.id === splitId) return { ...node, sizes }
  return { ...node, children: node.children.map((c) => resizeSplit(c, splitId, sizes)) }
}

/** Sizes that are usable: one per child, each at least 10%, summing to 1. */
function sane(sizes: number[], n: number): number[] | null {
  if (sizes.length !== n || sizes.some((v) => !Number.isFinite(v) || v < 0.1)) return null
  const total = sizes.reduce((a, v) => a + v, 0)
  return sizes.map((v) => v / total)
}

function findSplit(node: PaneNode, splitId: string): PaneSplit | undefined {
  if (node.type === 'pane') return undefined
  if (node.id === splitId) return node
  for (const c of node.children) {
    const hit = findSplit(c, splitId)
    if (hit) return hit
  }
  return undefined
}

function replaceTab(ws: Workspace, tab: Tab): Workspace {
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tab.id ? tab : t)) }
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
      // A page goes last; anything else goes last before the pages.
      const at = a.target.kind === 'page' ? -1 : ws.tabs.findIndex(isPageTab)
      const tabs = at < 0 ? [...ws.tabs, tab] : [...ws.tabs.slice(0, at), tab, ...ws.tabs.slice(at)]
      return { ...withActive({ ...ws, tabs }, a.projectId, tab.id), activeProject: a.projectId }
    }
    case 'close': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab) return ws
      const tabs = ws.tabs.filter((t) => t.id !== tab.id)
      // The neighbour to the right takes the front, else the one to the left —
      // what every tabbed app does, so the hand already knows where it lands.
      // In the one strip that neighbour may be another project's tab, and the
      // project in front follows it.
      if (activeTab(ws)?.id === tab.id) {
        const at = ws.tabs.findIndex((t) => t.id === tab.id)
        const next = tabs[Math.min(at, tabs.length - 1)]
        const left = withActive({ ...ws, tabs }, tab.projectId, undefined)
        return next ? { ...withActive(left, next.projectId, next.id), activeProject: next.projectId } : left
      }
      if (ws.activeByProject[tab.projectId] !== tab.id) return { ...ws, tabs }
      // A tab remembered for a project not in front: the project remembers
      // its nearest sibling instead.
      const siblings = tabsOf(ws, tab.projectId)
      const at = siblings.findIndex((t) => t.id === tab.id)
      const rest = siblings.filter((t) => t.id !== tab.id)
      return withActive({ ...ws, tabs }, tab.projectId, rest[Math.min(at, rest.length - 1)]?.id)
    }
    case 'close-project': {
      if (!ws.tabs.some((t) => t.projectId === a.projectId)) return ws
      return withActive({ ...ws, tabs: ws.tabs.filter((t) => t.projectId !== a.projectId) }, a.projectId, undefined)
    }
    case 'activate': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab) return ws
      return { ...withActive(ws, tab.projectId, tab.id), activeProject: tab.projectId }
    }
    case 'activate-index': {
      const list = numberedTabs(ws.tabs)
      // Cmd+9 is the last tab, however many there are, as in a browser.
      const tab = a.index === 8 ? list[list.length - 1] : list[a.index]
      return tab ? { ...withActive(ws, tab.projectId, tab.id), activeProject: tab.projectId } : ws
    }
    case 'cycle': {
      const list = ws.tabs
      if (list.length === 0) return ws
      const shown = activeTab(ws)
      // Nothing in front (a project with no tabs): forward starts at the first.
      const at = shown ? list.indexOf(shown) : a.delta === 1 ? -1 : 0
      const next = list[(at + a.delta + list.length) % list.length]!
      return { ...withActive(ws, next.projectId, next.id), activeProject: next.projectId }
    }
    case 'move': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab) return ws
      const rest = ws.tabs.filter((t) => t.id !== tab.id)
      // Within its own group: a page among the pages, any other tab before them.
      const firstPage = rest.findIndex(isPageTab)
      const [lo, hi] = isPageTab(tab) ? [firstPage < 0 ? rest.length : firstPage, rest.length] : [0, firstPage < 0 ? rest.length : firstPage]
      const to = Math.max(lo, Math.min(a.toIndex, hi))
      rest.splice(to, 0, tab)
      return { ...ws, tabs: rest }
    }
    case 'order': {
      const byId = new Map(ws.tabs.map((x) => [x.id, x] as const))
      const first = a.ids.map((id) => byId.get(id)).filter((x): x is Tab => !!x)
      const named = new Set(first.map((x) => x.id))
      const rest = ws.tabs.filter((x) => !named.has(x.id))
      // Pages stay after every other tab, whatever the order names.
      const tabs = [...first.filter((x) => !isPageTab(x)), ...rest.filter((x) => !isPageTab(x)), ...first.filter(isPageTab), ...rest.filter(isPageTab)]
      return tabs.every((x, i) => x === ws.tabs[i]) ? ws : { ...ws, tabs }
    }
    case 'project':
      if (a.view) return { ...withActive(ws, a.projectId, undefined), activeProject: a.projectId }
      return ws.activeProject === a.projectId ? ws : { ...ws, activeProject: a.projectId }
    case 'dashboard': {
      if (!!ws.dashboard === a.open) return ws
      if (a.open) return { ...ws, dashboard: true }
      const rest = { ...ws }
      delete rest.dashboard
      return rest
    }
    case 'mail': {
      if (!!ws.mail === a.open) return ws
      if (a.open) return { ...ws, mail: true }
      const rest = { ...ws }
      delete rest.mail
      return rest
    }
    case 'pipeline': {
      if (!!ws.pipeline === a.open) return ws
      if (a.open) return { ...ws, pipeline: true }
      const rest = { ...ws }
      delete rest.pipeline
      return rest
    }
    case 'retitle': {
      let changed = false
      const tabs = ws.tabs.map((t) => {
        if (t.title === a.title || focusedLeaf(t).target.sessionId !== a.sessionId) return t
        changed = true
        return { ...t, title: a.title }
      })
      return changed ? { ...ws, tabs } : ws
    }
    case 'page-nav': {
      let changed = false
      const tabs = ws.tabs.map((t) => {
        if (t.root.type === 'split') {
          // A phone preview in a split: its address moves on; the tab keeps the terminal's name.
          const leaf = leaves(t.root).find((l) => l.target.kind === 'page' && l.target.sessionId === a.sessionId)
          if (!leaf || a.url === undefined || !pageAddress(a.url) || a.url === leaf.target.url) return t
          changed = true
          return { ...t, root: mapLeaf(t.root, leaf.id, (l) => ({ ...l, target: { ...l.target, url: a.url } })) }
        }
        if (t.root.target.kind !== 'page' || t.root.target.sessionId !== a.sessionId) return t
        const url = a.url !== undefined && pageAddress(a.url) ? a.url : t.root.target.url
        const title = a.title !== undefined ? a.title : t.title
        if (url === t.root.target.url && title === t.title) return t
        changed = true
        return { ...t, title, root: { ...t.root, target: { ...t.root.target, url } } }
      })
      return changed ? { ...ws, tabs } : ws
    }
    case 'drop-session': {
      const tab = findTabBySession(ws, a.sessionId)
      const leaf = tab && leaves(tab.root).find((l) => l.target.sessionId === a.sessionId)
      return tab && leaf ? workspaceReducer(ws, { type: 'close-pane', tabId: tab.id, paneId: leaf.id }) : ws
    }
    case 'replace-session': {
      const tab = findTabBySession(ws, a.sessionId)
      if (!tab) return ws
      const swap = (n: PaneNode): PaneNode =>
        n.type === 'pane'
          ? (n.target.sessionId === a.sessionId ? { ...n, target: a.target } : n)
          : { ...n, children: n.children.map(swap) }
      const titled = tab.root.type === 'pane' ? a.title : tab.title
      return { ...ws, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, root: swap(t.root), title: titled } : t)) }
    }
    case 'split': {
      const tab = activeTab(ws)
      // Already open somewhere: show it where it is rather than twice. A file
      // and a watched session are tabs of their own: neither split nor split beside.
      // A phone preview is the one page that splits beside a terminal.
      const own = ownTab(a.target) && !(a.target.kind === 'page' && a.target.preview)
      if (!tab || findTabBySession(ws, a.target.sessionId) || own || ownTab(focusedLeaf(tab).target)) {
        return workspaceReducer(ws, { type: 'open', target: a.target, projectId: a.projectId, title: a.title })
      }
      if (leaves(tab.root).length >= MAX_PANES) {
        return a.target.kind === 'page' ? workspaceReducer(ws, { type: 'open', target: a.target, projectId: a.projectId, title: a.title }) : ws
      }
      const leaf: PaneLeaf = { type: 'pane', id: newId('pane'), target: a.target }
      const focused = focusedLeaf(tab)
      return replaceTab(ws, { ...tab, root: splitAt(tab.root, focused.id, leaf, a.direction), focusedPaneId: leaf.id })
    }
    case 'focus-pane': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab || tab.focusedPaneId === a.paneId || !leaves(tab.root).some((l) => l.id === a.paneId)) return ws
      return replaceTab(ws, { ...tab, focusedPaneId: a.paneId })
    }
    case 'cycle-pane': {
      const tab = activeTab(ws)
      if (!tab) return ws
      const all = leaves(tab.root)
      if (all.length < 2) return ws
      const at = all.findIndex((l) => l.id === focusedLeaf(tab).id)
      const next = all[(at + a.delta + all.length) % all.length]!
      return replaceTab(ws, { ...tab, focusedPaneId: next.id })
    }
    case 'close-pane': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      if (!tab) return ws
      const all = leaves(tab.root)
      const at = all.findIndex((l) => l.id === a.paneId)
      if (at < 0) return ws
      const root = removePane(tab.root, a.paneId)
      if (!root) return workspaceReducer(ws, { type: 'close', tabId: tab.id })
      // The focus goes where the closed pane's neighbour is, as with tabs.
      const rest = leaves(root)
      const focusedPaneId = tab.focusedPaneId === a.paneId ? rest[Math.min(at, rest.length - 1)]!.id : tab.focusedPaneId
      return replaceTab(ws, { ...tab, root, focusedPaneId })
    }
    case 'resize': {
      const tab = ws.tabs.find((t) => t.id === a.tabId)
      const split = tab && findSplit(tab.root, a.splitId)
      const sizes = split && sane(a.sizes, split.children.length)
      if (!tab || !sizes) return ws
      return replaceTab(ws, { ...tab, root: resizeSplit(tab.root, a.splitId, sizes) })
    }
  }
}

function isTarget(v: unknown): v is TabTarget {
  const t = v as TabTarget
  if (!t || typeof t.sessionId !== 'string' || t.sessionId === '') return false
  if (t.kind === 'file') return typeof t.path === 'string' && t.path !== '' && (t.worktree === undefined || typeof t.worktree === 'string')
  if (t.kind === 'files') return t.worktree === undefined || typeof t.worktree === 'string'
  if (t.kind === 'page') return typeof t.url === 'string' && (t.url === '' || pageAddress(t.url)) && (t.of === undefined || typeof t.of === 'string') && (t.preview === undefined || typeof t.preview === 'boolean')
  return t.kind === 'session' || t.kind === 'shell' || t.kind === 'observe'
}

/** Replaces the leaf `id` under `node` with what `f` makes of it. */
function mapLeaf(node: PaneNode, id: string, f: (l: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.type === 'pane') return node.id === id ? f(node) : node
  return { ...node, children: node.children.map((c) => mapLeaf(c, id, f)) }
}

/** A pane that is a whole tab, never split: a file, a session watched read-only, or a web page (a phone preview aside). */
export function ownTab(t: TabTarget): boolean {
  return t.kind === 'file' || t.kind === 'files' || t.kind === 'observe' || t.kind === 'page'
}

/** An address a page tab may hold: http or https with a host. A stored one is checked as a typed one is. */
export function pageAddress(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
  } catch {
    return false
  }
}

/** A stored Pipeline tab (before 2026-10-15): the agent session it was opened from. */
function storedPipeline(t: unknown): string | undefined {
  const root = (t as { root?: { type?: string; target?: { kind?: string; of?: unknown } } } | null)?.root
  if (root?.type !== 'pane' || root.target?.kind !== 'prs') return undefined
  return typeof root.target.of === 'string' ? root.target.of : ''
}

/**
 * Where the Pipeline tab opens when the stored workspace had a Pipeline pane
 * tab (before 2026-10-15): the Pipeline, for the agent the last one was
 * opened from. Undefined when it had none.
 */
export function pipelineInStore(raw: string | null): string | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw) as { tabs?: unknown[] }
    const ofs = (Array.isArray(v.tabs) ? v.tabs : []).map(storedPipeline).filter((x): x is string => x !== undefined)
    if (ofs.length === 0) return undefined
    const of = ofs[ofs.length - 1]
    return of ? `#/pipeline?of=${encodeURIComponent(of)}` : '#/pipeline'
  } catch {
    return undefined
  }
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
      // A page is a tab of its own: one stored inside a split is not kept,
      // unless it is a phone preview beside its terminal.
      .filter((t) => t.root.type === 'pane' || leaves(t.root).every((l) => l.target.kind !== 'page' || l.target.preview === true))
      .sort((a, b) => Number(isPageTab(a)) - Number(isPageTab(b)))
    // A Pipeline pane tab (before 2026-10-15) is not restored as a pane: the
    // pinned Pipeline tab takes its place.
    const hadPipeline = v.tabs.some((t) => storedPipeline(t) !== undefined)
    const ids = new Set(tabs.map((t) => t.id))
    const activeByProject: Record<string, string> = {}
    for (const [p, id] of Object.entries(v.activeByProject ?? {})) {
      if (typeof id === 'string' && ids.has(id)) activeByProject[p] = id
    }
    // A workspace from before the one strip (per-project strips) has the
    // same fields and reads as it is: its tabs are already one list, in the
    // order they were opened; only `dashboard` is new, and absent means shut.
    const ws: Workspace = { version: 1, tabs, activeByProject, activeProject: typeof v.activeProject === 'string' ? v.activeProject : '' }
    if (v.dashboard === true) ws.dashboard = true
    if (v.mail === true) ws.mail = true
    if (v.pipeline === true || hadPipeline) ws.pipeline = true
    return ws
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
