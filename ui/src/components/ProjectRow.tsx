/**
 * One project in the app's sidebar (WP-06), as an accordion (owner,
 * 2026-10-09: "which one is active, which to pick, unclear", translated).
 *
 * A project is one line: its name, a green dot with how many sessions and
 * shells run in it, and how many wait on you. Under it, every agent session
 * of the project, working, waiting or idle (owner, 2026-10-13, translated:
 * "show ONLY the agent sessions there; let the user hide or close them
 * himself; but don't move anything, don't add any of these extra
 * elements"): its tabs and its live sessions with no tab, one row each.
 * Shells and files have no row (they are in the tab strip), an ended
 * session drops off, and one hidden by hand is gone until it is shown
 * again from the sidebar's More… (or it next waits on you). It replaced,
 * the same day, only the active rows with the rest behind "+N more", and
 * before that one row per project. Rows sit in a fixed order
 * (lib/rowOrder.ts): by hand, then by when the session started, so picking
 * a row, opening it as a tab or a new event never moves it, and a new
 * session lands last. A row is dragged, or moved with ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift
 * off macOS), to set the order. Rows keep the strip's names
 * (lib/tablabels.ts). A muted row runs with no tab; a click opens it as a
 * tab, or one started in another terminal read-only
 * (components/ObservePane.tsx). The tab in front is the one highlighted row
 * in the whole sidebar. Each tab's row carries the tab's ⌘1–⌘9 (projects
 * have no digit); a click on the project row opens its page; ⌥⌘↑ ⌥⌘↓
 * walk its rows (sessionStops). The chevron folds a project by hand.
 *
 * What waits on you is marked on its own row — an amber edge and tint, and
 * the word "waiting" (or "asks", at a permission prompt) — since the
 * separate Waiting on you block is gone (owner, 2026-10-11, translated:
 * "not needed at all, everything is already visible in Projects"). A
 * project folded by hand still lists what waits in it.
 *
 * Every nested row can be got rid of (owner, 2026-10-11, translated: "in the
 * project list with nested items nothing can be done … I can't close it or
 * hide it"). A tab row's × closes the tab, as ⌘W and the strip's × do — an
 * agent keeps running; a shell closes with it, after a question when it runs
 * a program (lib/closeShell). A row with no tab has a × that hides it from
 * the list — nothing is signalled, so it is the one action offered on a
 * session another terminal started (rule 7) — and, on what Caprock started,
 * ■, which stops it after the cockpit's confirmation. Hidden rows wait last
 * inside "+N more", muted, each with an open eye that shows it again (the
 * separate "N hidden · show" line went on 2026-10-13), and each comes back
 * by itself when it next waits on you (lib/sidebar.ts rowHidden). The same actions are in each
 * row's menu: a right-click, Shift+F10 or the context-menu key. The buttons
 * show on hover and focus, always on the tab in front, and always on a touch
 * screen, where there is no hover. A project's × closes its tabs and moves
 * it under Hidden, unless something still runs or waits in it: then only
 * its tabs close and it stays, its dot green. Delete and Backspace close
 * nothing.
 */
import { Fragment, memo, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { SessionSummary } from '@/lib/api'
import { rowHidden, type HiddenSessions, type ProjectNode, type SessionNode } from '@/lib/sidebar'
import type { Dot } from '@/lib/sidebar'
import { branchLabel } from '@/lib/sessionLabels'
import type { Tab } from '@/lib/tabs'
import type { TabLabel } from '@/lib/tablabels'
import { closeTitle, closeWord } from '@/lib/closeShell'
import { fmtUSD } from '@/lib/format'
import { agentGlyphLabel } from './AgentMarks'
import { projectHue } from './TerminalTabs'
import { CloseIcon, EyeIcon, EyeOffIcon, FileIcon, MoreIcon, PencilIcon, PlusIcon, StopIcon, TerminalIcon } from './AppIcons'
import { InlineRename } from './InlineRename'
import { renamable } from '@/lib/sessionNames'
import { sessionAbout } from '@/lib/sidebar'
import { MenuBox, MenuItem, type MenuAt } from './RowMenu'
import { StopConfirm, stopLabel, type StopWhat } from './StopConfirm'
import { keys, tabKey } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { moveKey, orderRows, tabRowKey } from '@/lib/rowOrder'
import { namingLeaf } from '@/lib/tabs'
import { HotMark } from './ResourceMeter'

const DOT_CLASS: Record<Dot, string> = {
  working: 'bg-ok',
  waiting: 'bg-accent app-ring',
  looping: 'bg-danger',
  idle: 'bg-fg-faint/70',
  ended: 'border border-fg-faint/70 bg-transparent',
}

const DOT_LABEL: Record<Dot, string> = {
  working: 'working',
  waiting: 'waiting on you',
  looping: 'looping',
  idle: 'idle',
  ended: 'ended',
}

export function StatusDot({ dot }: { dot: Dot }) {
  return <span role="img" aria-label={DOT_LABEL[dot]} className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${DOT_CLASS[dot]}`} />
}

/** The one word a row says about its state. */
const STATE_WORD: Record<Dot, string> = {
  working: 'working',
  waiting: 'waiting',
  looping: 'looping',
  idle: 'idle',
  ended: 'done',
}

const STATE_CLASS: Record<Dot, string> = {
  working: 'text-ok',
  waiting: 'font-semibold text-accent',
  looping: 'text-danger',
  idle: 'text-fg-faint',
  ended: 'text-fg-faint',
}

/** A short cost: "$0.42", "$12", "$1.2k". Nothing at all below a cent. */
export function fmtCostShort(v: number): string {
  if (!(v >= 0.005)) return ''
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (v >= 100) return `$${Math.round(v)}`
  return fmtUSD(v)
}

/** "2 running", "1 running". Sessions and shells alike: both are work in the project. */
export function runningLabel(n: number): string {
  return `${n} running`
}

/** Whether a project's × only closes its tabs: something runs or waits in it, and hiding it would lose it. */
export function keepsProject(node: ProjectNode, stopped = 0): boolean {
  return node.live - stopped > 0 || node.waiting > 0
}

/**
 * Room at a nested row's right for its buttons, so they never sit on the
 * title: none, one or two 26px buttons. On hover and focus only, or always
 * (the tab in front; a touch screen, which has no hover).
 */
const PAD_ON_HOVER = [
  'pr-2',
  'pr-2 group-hover/row:pr-[36px] group-focus-within/row:pr-[36px] pointer-coarse:pr-[36px]',
  'pr-2 group-hover/row:pr-[64px] group-focus-within/row:pr-[64px] pointer-coarse:pr-[64px]',
] as const
const PAD_ALWAYS = ['pr-2', 'pr-[36px]', 'pr-[64px]'] as const
const ACTIONS_ON_HOVER = 'hidden group-hover/row:flex group-focus-within/row:flex pointer-coarse:flex'

type RowMenuState = MenuAt & { from: HTMLElement | null; kind: 'tab' | 'live'; id: string }

export interface ProjectRowProps {
  node: ProjectNode
  /** The project in front: open, its name bold. */
  current: boolean
  /** Its tabs, in strip order, with their labels; drawn when the project is open (current, or something runs or waits in it). */
  tabs: readonly Tab[]
  /** Each tab's ⌘1–⌘9, by tab id, drawn on its row as the strip draws it. */
  tabDigits?: ReadonlyMap<string, number>
  /** The rows' order set by hand, as row keys (lib/rowOrder.ts). */
  rowOrder?: readonly string[]
  /** Keeps a new order set by hand: every row's key, top to bottom. Absent, rows cannot be moved. */
  onReorder?: (projectId: string, keys: string[]) => void
  labels: ReadonlyMap<string, TabLabel>
  /** The tab in front, when the terminals are on screen. */
  activeTabId?: string
  onSelect: (id: string) => void
  onActivateTab: (tabId: string) => void
  /** Closes a tab exactly as ⌘W and the strip's × do; what runs in it keeps running. */
  onCloseTab?: (tabId: string) => void
  /** Opens, as a tab, a live session or shell of the project that has none. */
  onOpenLive?: (s: SessionSummary, projectId: string) => void
  onNewAgent: (projectId: string, cwd?: string) => void
  onNewShell: (projectId: string, cwd?: string) => void
  /** Right-click on a project row with no menu: the folder, for the editor menu (F18). */
  onFolderMenu?: (e: React.MouseEvent, path: string, label: string) => void
  /** Hidden by hand: its row action shows it again instead of closing it. */
  hidden?: boolean
  /** Shows a hidden project in the list again; absent, no such action. */
  onHide?: (id: string, hide: boolean) => void
  /** The project's ×: closes its tabs, and hides it when nothing runs in it. */
  onCloseProject?: (id: string) => void
  /** Opens the project menu at a point; `from` gets focus back when it closes. Absent, no menu. */
  onMenu?: (id: string, at: { x: number; y: number }, from: HTMLElement | null) => void
  /** Session rows hidden by hand, and when (lib/sidebar.ts rowHidden). */
  hiddenSessions?: HiddenSessions
  /** Hides a session's row from the list, or shows it again. Never signals anything (rule 7). Absent, no such action. */
  onHideSession?: (sessionId: string, hide: boolean) => void
}

export const ProjectRow = memo(function ProjectRow({
  node,
  current,
  tabs,
  tabDigits,
  rowOrder,
  onReorder,
  labels,
  activeTabId,
  onSelect,
  onActivateTab,
  onCloseTab,
  onOpenLive,
  onNewAgent,
  onNewShell,
  onFolderMenu,
  hidden = false,
  onHide,
  onCloseProject,
  onMenu,
  hiddenSessions,
  onHideSession,
}: ProjectRowProps) {
  const p = node.project
  const id = p.id
  // Every agent session of the project, in one fixed order (see above);
  // folded by hand, only what waits on you, so a fold never hides it.
  const [folded, setFolded] = useFolded(id)
  const live = useMemo(() => liveWithoutTab(node, hiddenSessions), [node, hiddenSessions])
  const nodes = useMemo(() => new Map(node.worktrees.flatMap((w) => w.sessions).map((x) => [x.session.session_id, x] as const)), [node])
  const items = useMemo(() => agentRows(tabs, labels, nodes, live, rowOrder, hiddenSessions).map((it) => ({ ...it, projectId: id, ownBranch: p.branch })), [tabs, labels, nodes, live, rowOrder, hiddenSessions, id, p.branch])
  const open = !folded
  const waitingOnly = folded && node.waiting > 0
  const visible = waitingOnly ? items.filter((it) => !!it.node?.waiting) : items
  // Other folders is a group, not a folder: no menu, no new agent in it.
  const isGroup = p.root === ''
  const menu = !isGroup && onMenu
  // Its shells end with it; only agents and what waits keep it listed.
  const keeps = node.agents > 0 || node.waiting > 0
  const openMenuFrom = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    onMenu?.(id, { x: r.right - 4, y: r.bottom + 2 }, el)
  }
  return (
    <li className="grid grid-cols-1" data-project={id}>
      <div className="group relative">
        {/* The chevron folds it by hand: one line, what waits still listed. */}
        {items.length > 0 && (
          <button
            type="button"
            data-project-fold
            aria-label={`${folded ? 'Unfold' : 'Fold'} ${p.name}`}
            title={folded ? 'Unfold: list its sessions' : 'Fold: one line, what runs in it keeps running'}
            aria-expanded={!folded}
            onClick={() => setFolded(!folded)}
            className="absolute left-0 top-1/2 z-[1] flex h-[26px] w-[20px] -translate-y-1/2 items-center justify-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
          >
            <Chevron open={open} />
          </button>
        )}
        <button
          type="button"
          data-nav-row
          data-project-row={id}
          data-current={current || undefined}
          aria-expanded={items.length > 0 ? open : undefined}
          onClick={() => onSelect(id)}
          onContextMenu={menu
            ? (e) => { e.preventDefault(); onMenu(id, { x: e.clientX, y: e.clientY }, e.currentTarget) }
            : onFolderMenu && p.root ? (e) => onFolderMenu(e, p.root, p.name) : undefined}
          onKeyDown={menu ? (e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenuFrom(e.currentTarget) }
          } : undefined}
          aria-haspopup={menu ? 'menu' : undefined}
          aria-keyshortcuts={menu ? 'Shift+F10' : undefined}
          className={`app-row flex h-[32px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] text-left ${isGroup ? 'pr-2 pointer-coarse:pr-[36px]' : 'pr-9 pointer-coarse:pr-[64px]'}`}
          title={`${isGroup ? 'Sessions in folders you have not added as a project. Add one with Add project.' : p.repos?.length ? `${p.root} · ${p.repos.map((r) => r.name).join(', ')}` : p.root || p.name}`}
        >
          <span className={`min-w-0 flex-1 truncate text-[13px] ${current ? 'font-semibold text-fg' : 'text-fg-muted'}`}>
            {p.name}
            {/* A multi-repo project (ADR-055) says how many it holds. */}
            {!!p.repos?.length && <span className="ml-1.5 text-[11px] font-normal text-fg-faint">{p.repos.length} repos</span>}
          </span>
          {node.activity && <Spark values={node.activity} working={node.working > 0} />}
          {node.live > 0 && (
            <span className="num inline-flex shrink-0 items-center gap-[4px] text-[11px] text-fg-muted group-hover:invisible" aria-label={runningLabel(node.live)} title={runningLabel(node.live)}>
              <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full bg-ok" />
              {node.live}
            </span>
          )}
          {node.waiting > 0 && (
            <span
              className="num inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-panel group-hover:invisible"
              aria-label={`${node.waiting} waiting on you`}
            >
              {node.waiting}
            </span>
          )}
        </button>
        {/* New agent here, in reach without a hover: the one action asked for
          * from the row itself (owner, 2026-10-11). The hover strip covers it.
          * On a touch screen, which has no hover, the menu sits beside it. */}
        {!isGroup && (
          <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 group-hover:invisible">
            {menu && (
              <span className="hidden pointer-coarse:flex">
                <RowAction label={`Project menu for ${p.name}`} title={`${p.name}: hide, close its tabs, remove`} popup onClick={(el) => openMenuFrom(el)}><MoreIcon size={15} /></RowAction>
              </span>
            )}
            <button type="button" data-project-new aria-label={`New agent in ${p.name}`} title={`New agent in ${p.name}`} onClick={() => onNewAgent(id)}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-accent">
              <PlusIcon size={14} />
            </button>
          </span>
        )}
        {/* Outside projects is a group, not a folder: only hide and show,
          * so it can leave the list like any project (owner, 2026-10-11). */}
        {isGroup && onHide && (
          <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex pointer-coarse:flex">
            {hidden
              ? <RowAction label={`Show ${p.name} in the list again`} onClick={() => onHide(id, false)}><EyeIcon size={14} /></RowAction>
              : <RowAction label={`Hide ${p.name}: it moves under Hidden; what runs there keeps running`} onClick={() => onHide(id, true)}><EyeOffIcon size={14} /></RowAction>}
          </span>
        )}
        {/* Actions on hover or focus, where the figures sit: the row stays one line. */}
        {!isGroup && (
          <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex">
            <RowAction label={`New agent in ${p.name}`} onClick={() => onNewAgent(id)}><PlusIcon size={14} /></RowAction>
            <RowAction label={`New shell in ${p.name}`} onClick={() => onNewShell(id)}><TerminalIcon size={14} /></RowAction>
            {!hidden && onHide && !isGroup && (
              <RowAction label={`Hide ${p.name}: it moves under Hidden; what runs in it keeps running`} onClick={() => onHide(id, true)}><EyeOffIcon size={14} /></RowAction>
            )}
            {menu && (
              <RowAction label={`More for ${p.name}: hide, close its tabs, remove`} popup onClick={(el) => openMenuFrom(el)}><MoreIcon size={15} /></RowAction>
            )}
            {hidden ? (
              onHide && <RowAction label={`Show ${p.name} in the list again`} onClick={() => onHide(id, false)}><EyeIcon size={14} /></RowAction>
            ) : onCloseProject && (
              <RowAction
                label={`Close project ${p.name}`}
                title={keeps
                  ? `Close project: its tabs and shells close. Its agents keep running, so it stays in the list (${runningLabel(Math.max(node.agents, node.waiting))}).`
                  : 'Close project: its tabs and shells close and it moves under Hidden. A shell running a program asks first.'}
                onClick={() => onCloseProject(id)}
              >
                <CloseIcon size={14} />
              </RowAction>
            )}
          </span>
        )}
      </div>
      {visible.length > 0 && (open || waitingOnly) && (
        <SessionList
          items={items}
          visible={visible}
          orderId={id}
          ariaLabel={`${p.name}: sessions`}
          activeTabId={activeTabId}
          onActivateTab={onActivateTab}
          onCloseTab={onCloseTab}
          onOpenLive={onOpenLive}
          onHideSession={onHideSession}
          onReorder={onReorder}
          digits={tabDigits}
        />
      )}
    </li>
  )
})

/** A session row with the project it belongs to: what SessionList draws. */
export type SidebarRow = LeadItem & {
  projectId: string
  /** The project's own branch: a row names its branch only when it differs. */
  ownBranch?: string
  /** Drawn after the title in the flat list (a dot in the project's hue and its name). */
  projectName?: string
}

/**
 * Session rows, one line each (28px), in their fixed order: under a
 * project, or every project's in one flat list (the sidebar's *Group by
 * project* off). A row opens on a click, closes its tab or hides itself
 * from its ×, has a menu (right-click, Shift+F10) with Stop…, and moves by
 * hand: dragged onto another (pointer events, as the strip's tabs, since
 * the desktop shell takes HTML5 drops) or with ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift off
 * macOS) on a focused row; the order is kept under `orderId`.
 */
export function SessionList({ items, visible = items, orderId, ariaLabel, activeTabId, onActivateTab, onCloseTab, onOpenLive, onHideSession, onReorder, digits }: {
  items: readonly SidebarRow[]
  /** The rows on screen; `items` when absent. Moving keeps the whole order. */
  visible?: readonly SidebarRow[]
  /** Where the order set by hand is kept: a project's id, or '*' for the flat list. */
  orderId: string
  ariaLabel: string
  activeTabId?: string
  onActivateTab: (tabId: string) => void
  onCloseTab?: (tabId: string) => void
  onOpenLive?: (s: SessionSummary, projectId: string) => void
  onHideSession?: (sessionId: string, hide: boolean) => void
  onReorder?: (orderId: string, keys: string[]) => void
  /** Each tab's ⌘ digit, by tab id, as the strip numbers it; a row with no tab has none. */
  digits?: ReadonlyMap<string, number>
}) {
  const allKeys = useMemo(() => items.map(leadKey), [items])
  const [dragKey, setDragKey] = useState<string | null>(null)
  const dragged = useRef(false)
  const reorder = (key: string, target: string, where: 'before' | 'after') => {
    const next = moveKey(allKeys, key, target, where)
    if (next.join('\n') !== allKeys.join('\n')) onReorder?.(orderId, next)
  }
  const pressRow = (key: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (!onReorder || e.button !== 0 || (e.target as Element).closest('[data-row-actions]')) return
    const y0 = e.clientY
    dragged.current = false
    const onMove = (m: PointerEvent) => {
      if (!dragged.current && Math.abs(m.clientY - y0) > 4) { dragged.current = true; setDragKey(key) }
    }
    const onUp = (u: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragKey(null)
      if (!dragged.current) return
      const over = document.elementFromPoint(u.clientX, u.clientY)?.closest<HTMLElement>('[data-row-key]')
      if (!over || over.dataset.rowProject !== orderId || !over.dataset.rowKey) return
      reorder(key, over.dataset.rowKey, u.clientY > y0 ? 'after' : 'before')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // The click that ends a drag opens nothing.
  const onClickCapture = (e: React.MouseEvent) => {
    if (dragged.current) { dragged.current = false; e.preventDefault(); e.stopPropagation() }
  }
  // ⌥⇧↑ ⌥⇧↓ on macOS; Ctrl+Shift off it, where Alt+Shift arrows are the app's (lib/appkeys.ts).
  const onMoveKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const mods = isMacPlatform() ? e.altKey && !e.ctrlKey : e.ctrlKey && !e.altKey
    if (!onReorder || !mods || !e.shiftKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-row-key]')?.dataset.rowKey
    if (!key) return
    e.preventDefault()
    e.stopPropagation()
    const on = visible.map(leadKey)
    const at = on.indexOf(key)
    const to = on[at + (e.key === 'ArrowUp' ? -1 : 1)]
    if (at < 0 || !to) return
    reorder(key, to, e.key === 'ArrowUp' ? 'before' : 'after')
  }
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)
  const [stopping, setStopping] = useState<{ sessionId: string; what: StopWhat } | null>(null)
  const closeRowMenu = () => {
    const from = rowMenu?.from
    setRowMenu(null)
    if (from?.isConnected) requestAnimationFrame(() => { if (document.activeElement === document.body) from.focus() })
  }
  const confirm = (sessionId: string) => stopping?.sessionId === sessionId && (
    <li className="py-1 pl-[22px] pr-1">
      <StopConfirm sessionId={stopping.sessionId} what={stopping.what} onDone={() => setStopping(null)} />
    </li>
  )
  // The session whose name is being typed in place of its row.
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameRow = (s: SessionSummary) => (
    <li className="flex h-[28px] items-center pl-[22px] pr-1">
      <InlineRename sessionId={s.session_id} initial={s.name?.trim() || sessionAbout(s)} current={s.name ?? ''} onDone={() => setRenaming(null)} />
    </li>
  )
  const itemRow = (it: SidebarRow) => {
    const k = leadKey(it)
    const drag: RowDrag = { rowKey: k, projectId: orderId, dragging: dragKey === k, onPress: onReorder ? pressRow(k) : undefined }
    const proj = it.projectName !== undefined ? { name: it.projectName, id: it.projectId } : undefined
    const digit = it.tab ? digits?.get(it.tab.id) : undefined
    if (!it.tab) {
      const x = it.node!
      const named = renamable(x.session, x.isShell)
      if (named && renaming === x.session.session_id) return renameRow(x.session)
      return (
        <>
          <LiveRow
            onRename={named ? () => setRenaming(x.session.session_id) : undefined}
            item={x}
            drag={drag}
            project={proj}
            ownBranch={it.ownBranch}
            onOpen={() => onOpenLive?.(x.session, it.projectId)}
            onStop={x.session.owned ? () => setStopping({ sessionId: x.session.session_id, what: 'session' }) : undefined}
            onHide={onHideSession ? () => onHideSession(x.session.session_id, true) : undefined}
            onMenu={(at, from) => setRowMenu({ ...at, from, kind: 'live', id: k })}
          />
          {confirm(x.session.session_id)}
        </>
      )
    }
    const t = it.tab
    const l = it.label
    const named = l?.file === undefined && renamable(l?.session, l?.isShell) ? l!.session! : undefined
    if (named && renaming === named.session_id) return renameRow(named)
    return (
      <>
        <TabRow
          onRename={named ? () => setRenaming(named.session_id) : undefined}
          drag={drag}
          project={proj}
          digit={digit}
          tab={t}
          label={l}
          waiting={!!it.node?.waiting}
          asks={!!it.node?.asks}
          active={t.id === activeTabId}
          onOpen={() => onActivateTab(t.id)}
          onClose={onCloseTab ? () => onCloseTab(t.id) : undefined}
          onMenu={(at, from) => setRowMenu({ ...at, from, kind: 'tab', id: k })}
        />
        {l?.session && confirm(l.session.session_id)}
      </>
    )
  }
  const rowMenuContent = () => {
    if (!rowMenu) return null
    const it = items.find((x) => leadKey(x) === rowMenu.id)
    if (!it) return null
    if (it.tab) {
      const tab = it.tab
      const l = it.label
      const stop = stoppable(l)
      const sid = l?.session?.session_id
      const hideable = !!onHideSession && !!sid && l?.file === undefined && !l?.isShell && l?.session?.status !== 'ended'
      return (
        <MenuBox at={rowMenu} label={`${l?.title ?? tab.title}: tab actions`} width={232} onClose={closeRowMenu}>
          {l?.file === undefined && renamable(l?.session, l?.isShell) && (
            <MenuItem icon={<PencilIcon size={14} />} label="Rename…" onClick={() => { setRowMenu(null); setRenaming(sid!) }} />
          )}
          {onCloseTab && <MenuItem icon={<CloseIcon size={14} />} label={closeWord(l?.file !== undefined, !!l?.isShell)} hint={keys('⌘W')} onClick={() => { setRowMenu(null); onCloseTab(tab.id) }} />}
          {onCloseTab && hideable && (
            <MenuItem icon={<EyeOffIcon size={14} />} label="Close tab and hide from the list" onClick={() => { setRowMenu(null); onCloseTab(tab.id); onHideSession!(sid!, true) }} />
          )}
          {stop && <MenuItem icon={<StopIcon size={14} />} label={stopLabel(stop.what)} tone="danger" onClick={() => { setRowMenu(null); setStopping(stop) }} />}
        </MenuBox>
      )
    }
    const x = it.node!
    const canStop = x.session.owned && x.session.status !== 'ended'
    return (
      <MenuBox at={rowMenu} label={`${x.title}: actions`} width={232} onClose={closeRowMenu}>
        <MenuItem icon={<PlusIcon size={14} />} label={x.session.owned ? 'Open as a tab' : 'Open in a tab, read-only'} onClick={() => { setRowMenu(null); onOpenLive?.(x.session, it.projectId) }} />
        {renamable(x.session, x.isShell) && <MenuItem icon={<PencilIcon size={14} />} label="Rename…" onClick={() => { setRowMenu(null); setRenaming(x.session.session_id) }} />}
        {onHideSession &&<MenuItem icon={<EyeOffIcon size={14} />} label="Hide from the list" onClick={() => { setRowMenu(null); onHideSession(x.session.session_id, true) }} />}
        {canStop && <MenuItem icon={<StopIcon size={14} />} label={stopLabel('session')} tone="danger" onClick={() => { setRowMenu(null); setStopping({ sessionId: x.session.session_id, what: 'session' }) }} />}
      </MenuBox>
    )
  }
  return (
    <>
      <ul className="grid grid-cols-1 pb-1" role="group" aria-label={ariaLabel} onKeyDown={onMoveKey} onClickCapture={onClickCapture}>
        {/* Every agent session in its fixed place (lib/rowOrder.ts). */}
        {visible.map((it) => <Fragment key={leadKey(it)}>{itemRow(it)}</Fragment>)}
      </ul>
      {rowMenuContent()}
    </>
  )
}

/** A flat row's project: a dot in its hue and its name, dimmed, after the title. */
function ProjectMark({ project }: { project: { name: string; id: string } }) {
  return (
    <span data-row-project-mark className="flex min-w-0 max-w-[9ch] shrink items-center gap-1 text-[11px] text-fg-faint" title={project.name}>
      <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: `hsl(${projectHue(project.id)} 42% 56%)` }} />
      <span className="truncate">{project.name}</span>
    </span>
  )
}

/** What a tab's Stop… would stop: its session, when Caprock started it and it still runs (rule 7). */
function stoppable(l?: TabLabel): { sessionId: string; what: StopWhat } | undefined {
  const s = l?.session
  if (!s || l?.file !== undefined || !s.owned || s.status === 'ended') return undefined
  return { sessionId: s.session_id, what: l!.isShell ? 'shell' : 'session' }
}

/** The state word at a row's right: none for a shell or a file. "asks" for a permission prompt. */
function StateWord({ dot, asks }: { dot: Dot; asks?: boolean }) {
  return (
    <span data-state={dot} className={`shrink-0 text-[11.5px] ${STATE_CLASS[dot]}`}
      title={dot === 'waiting' ? (asks ? 'Waiting on you: it asks permission' : 'Waiting on you: your turn') : undefined}>
      {dot === 'waiting' && asks ? 'asks' : STATE_WORD[dot]}
    </span>
  )
}

/** A row's right-click, Shift+F10 and context-menu key: its menu, at the pointer or under the row. */
function menuHandlers(onMenu: (at: MenuAt, from: HTMLElement | null) => void) {
  return {
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }, e.currentTarget) },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        onMenu({ x: r.right - 4, y: r.bottom + 2 }, e.currentTarget)
      }
    },
  }
}

/** One open tab under the current project: what the strip calls it, its dot, its state, its branch when not the project's own. */
/** A row's place for moving it by hand: its key, its project, and the press that starts a drag. */
interface RowDrag {
  rowKey: string
  projectId: string
  dragging: boolean
  onPress?: (e: ReactPointerEvent<HTMLElement>) => void
}

/** The attributes that make a row's <li> a drop target and a drag handle. */
function dragProps(drag?: RowDrag) {
  if (!drag) return {}
  return {
    'data-row-key': drag.rowKey,
    'data-row-project': drag.projectId,
    'data-dragging': drag.dragging || undefined,
    onPointerDown: drag.onPress,
  }
}

function TabRow({ tab, label, active, waiting, asks, onOpen, onClose, onMenu, onRename, drag, project, digit }: {
  tab: Tab
  /** Double-click names it: an agent's tab only. */
  onRename?: () => void
  label?: TabLabel
  drag?: RowDrag
  project?: { name: string; id: string }
  digit?: number
  active: boolean
  /** Waits on you now: the amber mark (lib/sidebar.ts SessionNode.waiting). */
  waiting: boolean
  asks: boolean
  onOpen: () => void
  onClose?: () => void
  onMenu: (at: MenuAt, from: HTMLElement | null) => void
}) {
  const title = label?.title ?? tab.title
  const isFile = label?.file !== undefined
  const word = !isFile && !label?.isShell && label?.session ? label.dot : undefined
  const closeTip = closeTitle(isFile, !!label?.isShell, !!label?.chat)
  const n = onClose ? 1 : 0
  return (
    <li className={`group/row relative ${drag?.dragging ? 'opacity-60' : ''}`} {...dragProps(drag)}>
      <button
        type="button"
        data-nav-row
        data-tab-row={tab.id}
        data-waiting={waiting || undefined}
        aria-current={active ? 'true' : undefined}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10"
        onClick={onOpen}
        onDoubleClick={onRename}
        {...menuHandlers(onMenu)}
        className={`app-row flex h-[28px] w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-[22px] text-left ${active ? PAD_ALWAYS[n] : PAD_ON_HOVER[n]}`}
        title={[label?.file ?? title, label?.session ? agentGlyphLabel(label.session.agent, label.isShell) : '', label?.branch, project?.name].filter(Boolean).join(' · ')}
      >
        {isFile ? <FileIcon size={12} className="text-fg-faint" /> : <StatusDot dot={label?.dot ?? 'idle'} />}
        <TitleAndBranch title={title} branch={project ? undefined : label?.branch} className={active || waiting ? 'text-fg' : 'text-fg-muted'} />
        {project && <ProjectMark project={project} />}
        {!isFile && <HotMark sessionId={label?.session?.session_id} />}
        {word && <StateWord dot={word} asks={asks} />}
        {/* Every tab's key, the one in front included (owner, 2026-10-14). */}
        {digit && <kbd data-row-key-digit aria-hidden className={`app-kbd-sm shrink-0 ${onClose && !active ? 'group-hover/row:hidden group-focus-within/row:hidden' : ''}`}>{tabKey(digit)}</kbd>}
      </button>
      {onClose && (
        <span data-row-actions className={`absolute right-1 top-1/2 -translate-y-1/2 items-center gap-0.5 ${active ? 'flex' : ACTIONS_ON_HOVER}`}>
          <RowAction label={`${closeWord(isFile, !!label?.isShell)} ${title}`} title={closeTip} onClick={onClose}><CloseIcon size={14} /></RowAction>
        </span>
      )}
    </li>
  )
}

export interface LiveWithoutTab {
  /** Caprock started them: rows. */
  own: SessionNode[]
  /** Started in another terminal and waiting on you now: rows too. */
  waitingOther: SessionNode[]
  /** Started in another terminal, not waiting: behind one line. */
  other: SessionNode[]
  /** Hidden by hand, whoever started them: last inside "+N more". */
  hidden: SessionNode[]
}

/**
 * The project's live sessions and shells that no tab shows: those Caprock
 * started (`own`, listed as rows), those started in another terminal (rows
 * while they wait on you, `waitingOther`; the rest behind one line,
 * `other`), and those hidden by hand (`hidden`, whatever started them). In
 * the order they started, so a status change never moves a row and a new
 * one lands at the end.
 */
export function liveWithoutTab(node: ProjectNode, hiddenSessions?: HiddenSessions): LiveWithoutTab {
  const all = node.worktrees
    .flatMap((w) => w.sessions)
    .filter((x) => !x.open && x.session.status !== 'ended')
    .sort((a, b) => (a.session.started_at ?? 0) - (b.session.started_at ?? 0) || a.session.session_id.localeCompare(b.session.session_id))
  const out: LiveWithoutTab = { own: [], waitingOther: [], other: [], hidden: [] }
  for (const x of all) {
    if (rowHidden(x, hiddenSessions)) out.hidden.push(x)
    else if (x.session.owned) out.own.push(x)
    else if (x.waiting) out.waitingOther.push(x)
    else out.other.push(x)
  }
  return out
}

/**
 * A live session or shell with no tab: muted, so it reads as not open (not
 * while it waits on you: then it carries the amber mark); a click opens it.
 * × hides it from the list, ■ stops it when Caprock started it, and a hidden
 * one shown on demand has the open eye that brings it back.
 */
function LiveRow({ item, ownBranch, hidden = false, onOpen, onStop, onHide, onShow, onMenu, onRename, drag, project }: {
  item: SessionNode
  /** Double-click names it: an agent's session only. */
  onRename?: () => void
  drag?: RowDrag
  project?: { name: string; id: string }
  ownBranch?: string
  /** Hidden by hand and shown on demand last inside "+N more". */
  hidden?: boolean
  onOpen: () => void
  onStop?: () => void
  onHide?: () => void
  onShow?: () => void
  onMenu: (at: MenuAt, from: HTMLElement | null) => void
}) {
  const s = item.session
  const own = branchLabel(ownBranch ?? '')
  const b = branchLabel(s.git_branch ?? '')
  const branch = b && b !== own ? b : undefined
  const title = item.isShell ? `Shell${s.program ? ` · ${s.program}` : ''}` : item.title
  const canStop = !!onStop && s.owned && s.status !== 'ended'
  const n = (onHide || onShow ? 1 : 0) + (canStop ? 1 : 0)
  return (
    <li className={`group/row relative ${drag?.dragging ? 'opacity-60' : ''}`} {...dragProps(drag)}>
      <button
        type="button"
        data-nav-row
        data-live-row={s.session_id}
        data-waiting={item.waiting || undefined}
        data-hidden-row={hidden || undefined}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10"
        onClick={onOpen}
        onDoubleClick={onRename}
        {...menuHandlers(onMenu)}
        className={`app-row flex h-[28px] w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-[22px] text-left ${item.waiting ? '' : hidden ? 'opacity-55' : 'opacity-75'} ${PAD_ON_HOVER[n]}`}
        title={`${[title, agentGlyphLabel(s.agent, item.isShell), branch, project?.name].filter(Boolean).join(' · ')}: ${s.owned ? 'running, no tab. Open it as a tab.' : 'started in another terminal. Open it in a tab, read-only, with Continue here.'}`}
      >
        <StatusDot dot={item.dot} />
        <TitleAndBranch title={title} branch={project ? undefined : branch} className={item.waiting ? 'text-fg' : 'text-fg-faint'} />
        {project && <ProjectMark project={project} />}
        <HotMark sessionId={s.session_id} />
        {!item.isShell && <StateWord dot={item.dot} asks={item.asks} />}
      </button>
      {n > 0 && (
        <span data-row-actions className={`absolute right-1 top-1/2 -translate-y-1/2 items-center gap-0.5 ${ACTIONS_ON_HOVER}`}>
          {onShow && <RowAction label={`Show ${title} in the list again`} onClick={onShow}><EyeIcon size={14} /></RowAction>}
          {onHide && (
            <RowAction label={`Hide ${title} from the list`} title={`Hide from the list: ${s.owned ? 'it keeps running' : 'nothing is sent to it'}; More… at the end of the list shows it again`} onClick={onHide}>
              <CloseIcon size={14} />
            </RowAction>
          )}
          {canStop && (
            <RowAction label={item.isShell ? stopLabel('shell') : stopLabel('session')} title={`${item.isShell ? stopLabel('shell') : stopLabel('session')} Asks first.`} onClick={onStop!}>
              <StopIcon size={12} />
            </RowAction>
          )}
        </span>
      )}
    </li>
  )
}

/**
 * A row's title and, after it, the branch it runs on — the title wins.
 *
 * Both used to shrink together, and the title was `flex-1` (a basis of zero),
 * so a long branch kept its ten characters while the title went to "Fix…":
 * the row said where the work was and not what it was. Now the title never
 * shrinks while the branch has any width left: it is sized to its text up to
 * the whole row, and the branch takes only what is left over, truncating to
 * nothing first. The title is cut only once the branch is gone. The full
 * text of both is in the row's tooltip.
 */
export function TitleAndBranch({ title, branch, className }: { title: string; branch?: string; className: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center overflow-hidden">
      <span data-row-title className={`max-w-full shrink-0 truncate text-[12.5px] ${className}`}>{title}</span>
      {branch && <span data-row-branch className="mono ml-2 min-w-0 max-w-[10ch] shrink truncate text-[11px] text-fg-faint">{branch}</span>}
    </span>
  )
}

/** A row's button: 26px, big enough to hit without aiming (owner, 2026-10-11: "big, clear"). */
function RowAction({ label, title, onClick, popup, children }: { label: string; title?: string; onClick: (el: HTMLButtonElement) => void; popup?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-haspopup={popup ? 'menu' : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(e.currentTarget) }}
      className="flex h-[26px] min-w-[26px] items-center justify-center rounded-[6px] px-0.5 text-fg-muted hover:bg-[var(--app-row-hover-strong)] hover:text-fg"
    >
      {children}
    </button>
  )
}

const FOLDED_KEY = 'caprock-sidebar-folded'
function readIds(store: Storage, key: string): Set<string> {
  try { return new Set(JSON.parse(store.getItem(key) ?? '[]') as string[]) } catch { return new Set() }
}

/** One project's yes/no kept under `key` in `store`: folded by hand, its "+N more" open. */
function useIdFlag(store: () => Storage, key: string, id: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { return readIds(store(), key).has(id) } catch { return false } })
  const set = (next: boolean) => {
    setV(next)
    try {
      const all = readIds(store(), key)
      if (next) all.add(id); else all.delete(id)
      store().setItem(key, JSON.stringify([...all]))
    } catch { /* private window: for this page only */ }
  }
  return [v, set]
}

/** A project folded by hand, kept per viewer. */
function useFolded(id: string): [boolean, (v: boolean) => void] {
  return useIdFlag(() => localStorage, FOLDED_KEY, id)
}

/** A row under a project: a tab (with the session it shows, if any), or a live session or shell with no tab. */
export interface LeadItem {
  key: string
  tab?: Tab
  label?: TabLabel
  node?: SessionNode
}

/** A row's place key: the session it shows, tab or not (lib/rowOrder.ts tabRowKey). */
export function leadKey(it: LeadItem): string {
  return it.tab ? tabRowKey(it.tab) : it.key
}

/** When a row's session started; unknown (a file, a tab before the list answers) sorts last. */
function leadStarted(it: LeadItem): number | undefined {
  return it.node?.session.started_at ?? it.label?.session?.started_at
}

/** One stop of ⌥⌘↑ ⌥⌘↓: a tab, or a live session with no tab, opened when reached. */
export interface SessionStop {
  key: string
  tabId?: string
  session?: SessionSummary
}

/**
 * The rows under a project, in their fixed order: every agent session —
 * its tabs (not shells, not files, not an ended session's) and its live
 * sessions with no tab — leaving out what was hidden by hand.
 */
function agentRows(tabs: readonly Tab[], labels: ReadonlyMap<string, TabLabel>, nodes: ReadonlyMap<string, SessionNode>, live: LiveWithoutTab, rowOrder?: readonly string[], hiddenSessions?: HiddenSessions): LeadItem[] {
  const tabRows = tabs.flatMap((t): LeadItem[] => {
    const kind = namingLeaf(t).target.kind
    if (kind !== 'session' && kind !== 'observe') return []
    const l = labels.get(t.id)
    if (l?.isShell || l?.file !== undefined || l?.session?.status === 'ended') return []
    const sid = l?.session?.session_id
    const n = sid ? nodes.get(sid) : undefined
    if (n && rowHidden(n, hiddenSessions)) return []
    return [{ key: t.id, tab: t, label: l, node: n }]
  })
  const liveRows = [...live.own, ...live.waitingOther, ...live.other].filter((x) => !x.isShell).map((x) => ({ key: x.session.session_id, node: x }))
  return orderRows([...tabRows, ...liveRows], leadKey, leadStarted, rowOrder)
}

/** A project's session rows as the sidebar lists them, with the project on each. */
export function projectRows(node: ProjectNode, tabs: readonly Tab[], labels: ReadonlyMap<string, TabLabel>, rowOrder?: readonly string[], hiddenSessions?: HiddenSessions): SidebarRow[] {
  const nodes = new Map(node.worktrees.flatMap((w) => w.sessions).map((x) => [x.session.session_id, x] as const))
  return agentRows(tabs, labels, nodes, liveWithoutTab(node, hiddenSessions), rowOrder, hiddenSessions)
    .map((it) => ({ ...it, projectId: node.project.id, ownBranch: node.project.branch }))
}

/** The order the flat list keeps by hand, among the per-project ones (lib/rowOrder.ts). */
export const FLAT_ORDER = '*'

/**
 * Every listed project's session rows as one list (the Flat sidebar, the
 * default): the rows with a tab in the strip's order — the order the tabs
 * were opened, so ⌘1, ⌘2 … run down the list — then the sessions running
 * with no tab, in the order set by hand in the flat list, then by when each
 * started (owner, 2026-10-14).
 */
export function flatRows(projects: readonly ProjectNode[], tabs: readonly Tab[], labels: ReadonlyMap<string, TabLabel>, rowOrders: Readonly<Record<string, readonly string[]>>, hiddenSessions?: HiddenSessions): SidebarRow[] {
  const all = projects.flatMap((n) => projectRows(n, tabs.filter((t) => t.projectId === n.project.id), labels, undefined, hiddenSessions)
    .map((it) => ({ ...it, projectName: n.project.name })))
  const at = new Map(tabs.map((t, i) => [t.id, i] as const))
  const tabbed = all.filter((r) => r.tab).sort((a, b) => (at.get(a.tab!.id) ?? 0) - (at.get(b.tab!.id) ?? 0))
  return [...tabbed, ...orderRows(all.filter((r) => !r.tab), leadKey, leadStarted, rowOrders[FLAT_ORDER])]
}

/**
 * The rows ⌥⌘↑ ⌥⌘↓ walk under a project: the rows the sidebar lists, in
 * the same order (a session with no tab opens in one when reached).
 */
export function sessionStops(node: ProjectNode | undefined, tabs: readonly Tab[], labels: ReadonlyMap<string, TabLabel>, rowOrder?: readonly string[], hiddenSessions?: HiddenSessions): SessionStop[] {
  const nodes = new Map((node?.worktrees ?? []).flatMap((w) => w.sessions).map((x) => [x.session.session_id, x] as const))
  const live: LiveWithoutTab = node ? liveWithoutTab(node, hiddenSessions) : { own: [], waitingOther: [], other: [], hidden: [] }
  return agentRows(tabs, labels, nodes, live, rowOrder, hiddenSessions).map((it) => (it.tab ? { key: leadKey(it), tabId: it.tab.id } : { key: it.key, session: it.node!.session }))
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden className={`transition-transform duration-100 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
      <path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The project's last hour as a small area line: turns and tool calls per two
 * minutes, scaled to its own peak. Amber while something works in it, grey
 * after. Nothing is drawn for an hour with nothing in it.
 */
export function Spark({ values, working }: { values: number[]; working: boolean }) {
  const peak = Math.max(...values)
  if (!(peak > 0)) return null
  const w = 40, h = 12
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / peak) * (h - 2)).toFixed(1)}`)
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <svg data-project-spark width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${total} turns and tool calls in the last hour`}
      className={`shrink-0 group-hover:invisible ${working ? 'text-accent' : 'text-fg-faint'}`}>
      <title>{`${total} turns and tool calls in the last hour`}</title>
      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill="currentColor" opacity="0.18" />
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
