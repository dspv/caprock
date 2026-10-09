/**
 * One project in the app's sidebar (WP-06), as an accordion (owner,
 * 2026-10-09: "which one is active, which to pick, unclear", translated).
 *
 * A project is one line: its name, a green dot with how many sessions and
 * shells run in it, and how many wait on you. The current project is the one
 * open, with no chevron to manage: under it, exactly the tabs the tab strip
 * shows for it, in the same order and under the same names
 * (lib/tablabels.ts). After them, muted, whatever Caprock started in the
 * project that still runs with no tab — a tab closed on a live shell or
 * agent — so live work is never out of sight; a click opens it as a tab.
 * Sessions started in another terminal are not rows: one muted line, "Running
 * in other terminals · N", lists them when clicked. Ended sessions are not
 * listed. The order is the strip's, then the order things started: a status
 * change never moves a row, and a new one appears at the end. The tab in
 * front is the one highlighted row in the whole sidebar.
 *
 * Each row says its state in one word at its right — working, waiting (the
 * one amber thing: it needs you), idle, done; a shell says nothing.
 *
 * Closing has one sign, × (owner, 2026-10-09: "unclear how to close projects
 * on the left, or their parts", translated). A tab row's × closes the tab,
 * as ⌘W and the strip's × do — what runs in it keeps running. A project's ×
 * closes its tabs and moves it under Hidden, unless something still runs or
 * waits in it: then only its tabs close and it stays, its dot green. ■ on a
 * row with no tab stops what Caprock started there, after the cockpit's
 * confirmation; nothing is offered for a session Caprock did not start
 * (rule 7). A right-click on a project opens its ⋯ menu; on a tab, Close tab
 * and Stop…. Delete and Backspace close nothing.
 */
import { Fragment, memo, useMemo, useState } from 'react'
import type { SessionSummary } from '@/lib/api'
import type { ProjectNode, SessionNode } from '@/lib/sidebar'
import type { Dot } from '@/lib/sidebar'
import { branchLabel } from '@/lib/sessionLabels'
import type { Tab } from '@/lib/tabs'
import type { TabLabel } from '@/lib/tablabels'
import { fmtUSD } from '@/lib/format'
import { AgentGlyph, CloseIcon, EyeIcon, FileIcon, MoreIcon, PlusIcon, StopIcon, TerminalIcon } from './AppIcons'
import { MenuBox, MenuItem, type MenuAt } from './RowMenu'
import { StopConfirm, stopLabel, type StopWhat } from './StopConfirm'

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
export function keepsProject(node: ProjectNode): boolean {
  return node.live > 0 || node.waiting > 0
}

export interface ProjectRowProps {
  node: ProjectNode
  /** The project in front: open, its name bold. */
  current: boolean
  /** Its tabs, in strip order, with their labels; drawn only when current. */
  tabs: readonly Tab[]
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
}

export const ProjectRow = memo(function ProjectRow({
  node,
  current,
  tabs,
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
}: ProjectRowProps) {
  const p = node.project
  const id = p.id
  const live = useMemo(() => (current ? liveWithoutTab(node) : { own: [], other: [] }), [current, node])
  const [othersOpen, setOthersOpen] = useState(false)
  const [tabMenu, setTabMenu] = useState<(MenuAt & { tabId: string; from: HTMLElement | null }) | null>(null)
  const [stopping, setStopping] = useState<{ sessionId: string; what: StopWhat } | null>(null)
  // Other folders is a group, not a folder: no menu, no new agent in it.
  const isGroup = p.root === ''
  const menu = !isGroup && onMenu
  const keeps = keepsProject(node)
  const openMenuFrom = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    onMenu?.(id, { x: r.right - 4, y: r.bottom + 2 }, el)
  }
  const closeTabMenu = () => {
    const from = tabMenu?.from
    setTabMenu(null)
    if (from?.isConnected) requestAnimationFrame(() => { if (document.activeElement === document.body) from.focus() })
  }
  const menuTab = tabMenu ? tabs.find((t) => t.id === tabMenu.tabId) : undefined
  const menuStop = menuTab ? stoppable(labels.get(menuTab.id)) : undefined
  const confirm = (sessionId: string) => stopping?.sessionId === sessionId && (
    <li className="py-1 pl-[22px] pr-1">
      <StopConfirm sessionId={stopping.sessionId} what={stopping.what} onDone={() => setStopping(null)} />
    </li>
  )
  return (
    <li className="grid grid-cols-1" data-project={id}>
      <div className="group relative">
        <button
          type="button"
          data-nav-row
          data-project-row={id}
          data-current={current || undefined}
          aria-expanded={current}
          onClick={() => onSelect(id)}
          onContextMenu={menu
            ? (e) => { e.preventDefault(); onMenu(id, { x: e.clientX, y: e.clientY }, e.currentTarget) }
            : onFolderMenu && p.root ? (e) => onFolderMenu(e, p.root, p.name) : undefined}
          onKeyDown={menu ? (e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenuFrom(e.currentTarget) }
          } : undefined}
          aria-haspopup={menu ? 'menu' : undefined}
          aria-keyshortcuts={menu ? 'Shift+F10' : undefined}
          className="app-row flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-2.5 pr-2 text-left"
          title={p.root || p.name}
        >
          <span className={`min-w-0 flex-1 truncate text-[13px] ${current ? 'font-semibold text-fg' : 'text-fg-muted'}`}>{p.name}</span>
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
        {/* Actions on hover or focus, where the figures sit: the row stays one line. */}
        {!isGroup && (
          <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex">
            <RowAction label={`New agent in ${p.name}`} onClick={() => onNewAgent(id)}><PlusIcon size={13} /></RowAction>
            <RowAction label={`New shell in ${p.name}`} onClick={() => onNewShell(id)}><TerminalIcon size={13} /></RowAction>
            {menu && (
              <RowAction label={`More for ${p.name}: hide, close its tabs, remove`} popup onClick={(el) => openMenuFrom(el)}><MoreIcon size={14} /></RowAction>
            )}
            {hidden ? (
              onHide && <RowAction label={`Show ${p.name} in the list again`} onClick={() => onHide(id, false)}><EyeIcon size={13} /></RowAction>
            ) : onCloseProject && (
              <RowAction
                label={`Close project ${p.name}`}
                title={keeps
                  ? `Close project: its tabs close. Its agents keep running, so it stays in the list (${runningLabel(Math.max(node.live, node.waiting))}).`
                  : 'Close project: its tabs close and it moves under Hidden. Anything running keeps running.'}
                onClick={() => onCloseProject(id)}
              >
                <CloseIcon size={13} />
              </RowAction>
            )}
          </span>
        )}
      </div>
      {current && (
        <ul className="grid grid-cols-1 pb-1" role="group" aria-label={`${p.name}: open tabs`}>
          {tabs.length === 0 && live.own.length === 0 && (
            <li className="flex h-[26px] items-center pl-[22px] pr-2 text-[12px] text-fg-faint">No tabs open.</li>
          )}
          {tabs.map((t) => {
            const l = labels.get(t.id)
            return (
              <Fragment key={t.id}>
                <TabRow
                  tab={t}
                  label={l}
                  active={t.id === activeTabId}
                  onOpen={() => onActivateTab(t.id)}
                  onClose={onCloseTab ? () => onCloseTab(t.id) : undefined}
                  onMenu={(at, from) => setTabMenu({ ...at, tabId: t.id, from })}
                />
                {l?.session && confirm(l.session.session_id)}
              </Fragment>
            )
          })}
          {live.own.map((x) => (
            <Fragment key={x.session.session_id}>
              <LiveRow
                item={x}
                ownBranch={p.branch}
                onOpen={() => onOpenLive?.(x.session, id)}
                onStop={() => setStopping({ sessionId: x.session.session_id, what: x.isShell ? 'shell' : 'session' })}
              />
              {confirm(x.session.session_id)}
            </Fragment>
          ))}
          {live.other.length > 0 && (
            <li>
              <button
                type="button"
                data-nav-row
                aria-expanded={othersOpen}
                onClick={() => setOthersOpen((v) => !v)}
                className="app-row flex h-[26px] w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-[22px] pr-2 text-left text-[11.5px] text-fg-faint"
                title="Sessions in this project started outside Caprock, in another terminal. Caprock watches them; it does not hold their terminal."
              >
                <span className="min-w-0 flex-1 truncate">Running in other terminals <span className="num">· {live.other.length}</span></span>
                <span className={`inline-block transition-transform motion-reduce:transition-none ${othersOpen ? 'rotate-90' : ''}`} aria-hidden>›</span>
              </button>
            </li>
          )}
          {othersOpen && live.other.map((x) => (
            <LiveRow key={x.session.session_id} item={x} ownBranch={p.branch} onOpen={() => onOpenLive?.(x.session, id)} />
          ))}
        </ul>
      )}
      {tabMenu && menuTab && (
        <MenuBox at={tabMenu} label={`${labels.get(menuTab.id)?.title ?? menuTab.title}: tab actions`} width={200} onClose={closeTabMenu}>
          {onCloseTab && <MenuItem icon={<CloseIcon size={14} />} label="Close tab" hint="⌘W" onClick={() => { setTabMenu(null); onCloseTab(menuTab.id) }} />}
          {menuStop && (
            <MenuItem
              icon={<StopIcon size={14} />}
              label={stopLabel(menuStop.what)}
              tone="danger"
              onClick={() => { setTabMenu(null); setStopping(menuStop) }}
            />
          )}
        </MenuBox>
      )}
    </li>
  )
})

/** What a tab's Stop… would stop: its session, when Caprock started it and it still runs (rule 7). */
function stoppable(l?: TabLabel): { sessionId: string; what: StopWhat } | undefined {
  const s = l?.session
  if (!s || l?.file !== undefined || !s.owned || s.status === 'ended') return undefined
  return { sessionId: s.session_id, what: l!.isShell ? 'shell' : 'session' }
}

/** The state word at a row's right: none for a shell or a file. */
function StateWord({ dot, hideOnHover }: { dot: Dot; hideOnHover: boolean }) {
  return (
    <span data-state={dot} className={`shrink-0 text-[11px] ${STATE_CLASS[dot]} ${hideOnHover ? 'group-hover/row:invisible group-focus-within/row:invisible' : ''}`}>
      {STATE_WORD[dot]}
    </span>
  )
}

/** One open tab under the current project: what the strip calls it, its dot, its state, its branch when not the project's own. */
function TabRow({ tab, label, active, onOpen, onClose, onMenu }: {
  tab: Tab
  label?: TabLabel
  active: boolean
  onOpen: () => void
  onClose?: () => void
  onMenu: (at: MenuAt, from: HTMLElement | null) => void
}) {
  const title = label?.title ?? tab.title
  const isFile = label?.file !== undefined
  const word = !isFile && !label?.isShell && label?.session ? label.dot : undefined
  const closeTitle = isFile ? 'Close tab (⌘W)' : label?.isShell ? 'Close tab (⌘W) — the shell keeps running' : 'Close tab (⌘W) — the agent keeps running'
  return (
    <li className="group/row relative">
      <button
        type="button"
        data-nav-row
        data-tab-row={tab.id}
        aria-current={active ? 'true' : undefined}
        aria-haspopup="menu"
        onClick={onOpen}
        onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }, e.currentTarget) }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            onMenu({ x: r.right - 4, y: r.bottom + 2 }, e.currentTarget)
          }
        }}
        className={`app-row flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] text-left ${onClose ? (active ? 'pr-7' : 'pr-2 group-hover/row:pr-7 group-focus-within/row:pr-7') : 'pr-2'}`}
        title={label?.file ?? title}
      >
        {isFile ? (
          <FileIcon size={12} className="text-fg-faint" />
        ) : (
          <>
            <StatusDot dot={label?.dot ?? 'idle'} />
            <AgentGlyph agent={label?.session?.agent} shell={label?.isShell} />
          </>
        )}
        <span data-row-title className={`min-w-0 flex-1 truncate text-[12.5px] ${active ? 'text-fg' : 'text-fg-muted'}`}>{title}</span>
        {label?.branch && <span className="mono min-w-0 max-w-[10ch] shrink truncate text-[11px] text-fg-faint">{label.branch}</span>}
        {word && <StateWord dot={word} hideOnHover={false} />}
      </button>
      {onClose && (
        <span className={`absolute right-1 top-1/2 -translate-y-1/2 ${active ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex'}`}>
          <RowAction label={`Close tab ${title}`} title={closeTitle} onClick={onClose}><CloseIcon size={12} /></RowAction>
        </span>
      )}
    </li>
  )
}

/**
 * The project's live sessions and shells that no tab shows: those Caprock
 * started (`own`, listed as rows) and those started in another terminal
 * (`other`, behind one line). In the order they started, so a status change
 * never moves a row and a new one lands at the end.
 */
export function liveWithoutTab(node: ProjectNode): { own: SessionNode[]; other: SessionNode[] } {
  const all = node.worktrees
    .flatMap((w) => w.sessions)
    .filter((x) => !x.open && x.session.status !== 'ended')
    .sort((a, b) => (a.session.started_at ?? 0) - (b.session.started_at ?? 0) || a.session.session_id.localeCompare(b.session.session_id))
  return { own: all.filter((x) => x.session.owned), other: all.filter((x) => !x.session.owned) }
}

/** A live session or shell with no tab: muted, so it reads as not open; a click opens it. ■ stops it, when Caprock started it. */
function LiveRow({ item, ownBranch, onOpen, onStop }: { item: SessionNode; ownBranch?: string; onOpen: () => void; onStop?: () => void }) {
  const s = item.session
  const own = branchLabel(ownBranch ?? '')
  const b = branchLabel(s.git_branch ?? '')
  const branch = b && b !== own ? b : undefined
  const title = item.isShell ? 'Shell' : item.title
  const canStop = !!onStop && s.owned && s.status !== 'ended'
  return (
    <li className="group/row relative">
      <button
        type="button"
        data-nav-row
        data-live-row={s.session_id}
        onClick={onOpen}
        className={`app-row flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] text-left opacity-70 ${canStop ? 'pr-2 group-hover/row:pr-7 group-focus-within/row:pr-7' : 'pr-2'}`}
        title={s.owned ? `${title}: running, no tab. Open it as a tab.` : `${title}: started in another terminal. Open its details.`}
      >
        <StatusDot dot={item.dot} />
        <AgentGlyph agent={s.agent} shell={item.isShell} />
        <span data-row-title className="min-w-0 flex-1 truncate text-[12.5px] text-fg-faint">{title}</span>
        {branch && <span className="mono min-w-0 max-w-[10ch] shrink truncate text-[11px] text-fg-faint">{branch}</span>}
        {!item.isShell && <StateWord dot={item.dot} hideOnHover={canStop} />}
      </button>
      {canStop && (
        <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 group-hover/row:flex group-focus-within/row:flex">
          <RowAction label={item.isShell ? stopLabel('shell') : stopLabel('session')} title={`${item.isShell ? stopLabel('shell') : stopLabel('session')} Asks first.`} onClick={onStop}><StopIcon size={11} /></RowAction>
        </span>
      )}
    </li>
  )
}

function RowAction({ label, title, onClick, popup, children }: { label: string; title?: string; onClick: (el: HTMLButtonElement) => void; popup?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-haspopup={popup ? 'menu' : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(e.currentTarget) }}
      className="flex h-[22px] min-w-[22px] items-center justify-center rounded-[5px] px-0.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      {children}
    </button>
  )
}
