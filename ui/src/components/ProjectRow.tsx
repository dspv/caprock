/**
 * One project in the app's sidebar (WP-06), as an accordion (owner,
 * 2026-10-09: "which one is active, which to pick, unclear", translated).
 *
 * A project is one line: its name, a green dot with how many sessions and
 * shells run in it, and how many wait on you. The current project is open,
 * and so is every project where something runs or waits (owner,
 * 2026-10-11); the chevron folds one by hand. Under it, exactly the tabs the
 * tab strip shows for it, in the same order and under the same names
 * (lib/tablabels.ts). After them, muted, whatever Caprock started in the
 * project that still runs with no tab — a tab closed on a live shell or
 * agent — so live work is never out of sight; a click opens it as a tab.
 * Sessions started in another terminal are behind one muted line, "Running
 * in other terminals · N", except one waiting on you, which is always a row.
 * Ended sessions are not listed. The order is the strip's, then the order
 * things started: a status change never moves a row, and a new one appears
 * at the end. The tab in front is the one highlighted row in the whole
 * sidebar.
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
 * ■, which stops it after the cockpit's confirmation. Hidden rows wait
 * behind "N hidden · show", and each comes back by itself when it next
 * waits on you (lib/sidebar.ts rowHidden). The same actions are in each
 * row's menu: a right-click, Shift+F10 or the context-menu key. The buttons
 * show on hover and focus, always on the tab in front, and always on a touch
 * screen, where there is no hover. A project's × closes its tabs and moves
 * it under Hidden, unless something still runs or waits in it: then only
 * its tabs close and it stays, its dot green. Delete and Backspace close
 * nothing.
 */
import { Fragment, memo, useMemo, useState } from 'react'
import type { SessionSummary } from '@/lib/api'
import { rowHidden, type HiddenSessions, type ProjectNode, type SessionNode } from '@/lib/sidebar'
import type { Dot } from '@/lib/sidebar'
import { branchLabel } from '@/lib/sessionLabels'
import type { Tab } from '@/lib/tabs'
import type { TabLabel } from '@/lib/tablabels'
import { closeTitle, closeWord } from '@/lib/closeShell'
import { fmtUSD } from '@/lib/format'
import { AgentGlyph } from './AgentMarks'
import { CloseIcon, EyeIcon, EyeOffIcon, FileIcon, MoreIcon, PlusIcon, StopIcon, TerminalIcon } from './AppIcons'
import { MenuBox, MenuItem, type MenuAt } from './RowMenu'
import { StopConfirm, stopLabel, type StopWhat } from './StopConfirm'
import { keys, tabKey } from '@/lib/appkeys'
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
  /** Each tab's jump-key digit in the strip, if it has one. */
  tabDigits?: ReadonlyMap<string, number | null>
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
  // Open when current, and also whenever something runs or waits in it
  // (owner, 2026-10-11, translated: "active sessions should stay expanded,
  // so I don't switch between projects and have the other one fold"). Only
  // projects with nothing going on fold.
  // Unless folded by hand: the chevron's choice wins over both (owner,
  // 2026-10-11: "a button to fold, hide").
  const [folded, setFolded] = useFolded(id)
  const open = !folded && (current || node.live > 0 || node.waiting > 0)
  // Folded by hand while something in it waits on you: what waits still
  // shows under it, and nothing else. A fold never hides what needs you.
  const waitingOnly = !open && folded && node.waiting > 0
  const live = useMemo(() => (open || waitingOnly ? liveWithoutTab(node, hiddenSessions) : NO_LIVE), [open, waitingOnly, node, hiddenSessions])
  const nodes = useMemo(() => new Map(node.worktrees.flatMap((w) => w.sessions).map((x) => [x.session.session_id, x] as const)), [node])
  const shownTabs = waitingOnly
    ? tabs.filter((t) => { const sid = labels.get(t.id)?.session?.session_id; return !!sid && !!nodes.get(sid)?.waiting })
    : tabs
  const ownRows = waitingOnly ? live.own.filter((x) => x.waiting) : live.own
  const [othersOpen, setOthersOpen] = useState(false)
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)
  const [stopping, setStopping] = useState<{ sessionId: string; what: StopWhat } | null>(null)
  // Other folders is a group, not a folder: no menu, no new agent in it.
  const isGroup = p.root === ''
  const menu = !isGroup && onMenu
  // Its shells end with it; only agents and what waits keep it listed.
  const keeps = node.agents > 0 || node.waiting > 0
  const openMenuFrom = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    onMenu?.(id, { x: r.right - 4, y: r.bottom + 2 }, el)
  }
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
  const hideSession = onHideSession ? (sid: string) => () => onHideSession(sid, true) : undefined
  const liveRow = (x: SessionNode, rowHiddenNow = false) => (
    <LiveRow
      item={x}
      ownBranch={p.branch}
      hidden={rowHiddenNow}
      onOpen={() => onOpenLive?.(x.session, id)}
      onStop={x.session.owned ? () => setStopping({ sessionId: x.session.session_id, what: x.isShell ? 'shell' : 'session' }) : undefined}
      onHide={rowHiddenNow ? undefined : hideSession?.(x.session.session_id)}
      onShow={rowHiddenNow && onHideSession ? () => onHideSession(x.session.session_id, false) : undefined}
      onMenu={(at, from) => setRowMenu({ ...at, from, kind: 'live', id: x.session.session_id })}
    />
  )
  const rowMenuContent = () => {
    if (!rowMenu) return null
    if (rowMenu.kind === 'tab') {
      const tab = tabs.find((t) => t.id === rowMenu.id)
      if (!tab) return null
      const l = labels.get(tab.id)
      const stop = stoppable(l)
      const sid = l?.session?.session_id
      const hideable = !!onHideSession && !!sid && l?.file === undefined && !l?.isShell && l?.session?.status !== 'ended'
      return (
        <MenuBox at={rowMenu} label={`${l?.title ?? tab.title}: tab actions`} width={232} onClose={closeRowMenu}>
          {onCloseTab && <MenuItem icon={<CloseIcon size={14} />} label={closeWord(l?.file !== undefined, !!l?.isShell)} hint={keys('⌘W')} onClick={() => { setRowMenu(null); onCloseTab(tab.id) }} />}
          {onCloseTab && hideable && (
            <MenuItem icon={<EyeOffIcon size={14} />} label="Close tab and hide from the list" onClick={() => { setRowMenu(null); onCloseTab(tab.id); onHideSession!(sid!, true) }} />
          )}
          {stop && <MenuItem icon={<StopIcon size={14} />} label={stopLabel(stop.what)} tone="danger" onClick={() => { setRowMenu(null); setStopping(stop) }} />}
        </MenuBox>
      )
    }
    const x = nodes.get(rowMenu.id)
    if (!x) return null
    const isHidden = rowHidden(x, hiddenSessions)
    const canStop = x.session.owned && x.session.status !== 'ended'
    return (
      <MenuBox at={rowMenu} label={`${x.title}: actions`} width={232} onClose={closeRowMenu}>
        <MenuItem icon={<PlusIcon size={14} />} label={x.session.owned ? 'Open as a tab' : 'Open its details'} onClick={() => { setRowMenu(null); onOpenLive?.(x.session, id) }} />
        {onHideSession && (isHidden
          ? <MenuItem icon={<EyeIcon size={14} />} label="Show in the list again" onClick={() => { setRowMenu(null); onHideSession(x.session.session_id, false) }} />
          : <MenuItem icon={<EyeOffIcon size={14} />} label="Hide from the list" onClick={() => { setRowMenu(null); onHideSession(x.session.session_id, true) }} />)}
        {canStop && <MenuItem icon={<StopIcon size={14} />} label={stopLabel(x.isShell ? 'shell' : 'session')} tone="danger" onClick={() => { setRowMenu(null); setStopping({ sessionId: x.session.session_id, what: x.isShell ? 'shell' : 'session' }) }} />}
      </MenuBox>
    )
  }
  return (
    <li className="grid grid-cols-1" data-project={id}>
      <div className="group relative">
        <button
          type="button"
          data-project-fold
          aria-label={`${folded ? 'Unfold' : 'Fold'} ${p.name}`}
          title={folded ? 'Unfold: show its tabs and sessions' : 'Fold: one line, what runs in it keeps running'}
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
          className="absolute left-0 top-1/2 z-[1] flex h-[26px] w-[20px] -translate-y-1/2 items-center justify-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          <Chevron open={!folded && open} />
        </button>
        <button
          type="button"
          data-nav-row
          data-project-row={id}
          data-current={current || undefined}
          aria-expanded={open}
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
          title={isGroup ? 'Sessions in folders you have not added as a project. Add one with Add project.' : p.repos?.length ? `${p.root} · ${p.repos.map((r) => r.name).join(', ')}` : p.root || p.name}
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
      {(open || waitingOnly) && (
        <ul className="grid grid-cols-1 pb-1" role="group" aria-label={`${p.name}: open tabs`}>
          {current && !waitingOnly && tabs.length === 0 && live.own.length === 0 && live.waitingOther.length === 0 && live.other.length === 0 && live.hidden.length === 0 && (
            <li className="flex h-[30px] items-center pl-[22px] pr-2 text-[12px] text-fg-faint">No tabs open.</li>
          )}
          {shownTabs.map((t) => {
            const l = labels.get(t.id)
            const n = l?.session ? nodes.get(l.session.session_id) : undefined
            return (
              <Fragment key={t.id}>
                <TabRow
                  tab={t}
                  label={l}
                  waiting={!!n?.waiting}
                  asks={!!n?.asks}
                  digit={tabDigits?.get(t.id) ?? undefined}
                  active={t.id === activeTabId}
                  onOpen={() => onActivateTab(t.id)}
                  onClose={onCloseTab ? () => onCloseTab(t.id) : undefined}
                  onMenu={(at, from) => setRowMenu({ ...at, from, kind: 'tab', id: t.id })}
                />
                {l?.session && confirm(l.session.session_id)}
              </Fragment>
            )
          })}
          {ownRows.map((x) => (
            <Fragment key={x.session.session_id}>
              {liveRow(x)}
              {confirm(x.session.session_id)}
            </Fragment>
          ))}
          {/* Started in another terminal and waiting on you: always a row,
            * never behind the line below, since these rows are now the
            * sidebar's only list of what needs you. */}
          {live.waitingOther.map((x) => <Fragment key={x.session.session_id}>{liveRow(x)}</Fragment>)}
          {!waitingOnly && live.other.length > 0 && (
            <li>
              <button
                type="button"
                data-nav-row
                aria-expanded={othersOpen}
                onClick={() => setOthersOpen((v) => !v)}
                className="app-row flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-[22px] pr-2 text-left text-[12px] text-fg-faint"
                title="Sessions in this project started outside Caprock, in another terminal. Caprock watches them; it does not hold their terminal."
              >
                <span className="min-w-0 flex-1 truncate">Running in other terminals <span className="num">· {live.other.length}</span></span>
                <span className={`inline-block transition-transform motion-reduce:transition-none ${othersOpen ? 'rotate-90' : ''}`} aria-hidden>›</span>
              </button>
            </li>
          )}
          {!waitingOnly && othersOpen && live.other.map((x) => <Fragment key={x.session.session_id}>{liveRow(x)}</Fragment>)}
          {/* Hidden by hand, never lost: one line brings them back. */}
          {!waitingOnly && live.hidden.length > 0 && (
            <li>
              <button
                type="button"
                data-nav-row
                data-hidden-rows
                aria-expanded={hiddenOpen}
                onClick={() => setHiddenOpen((v) => !v)}
                className="app-row flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-[22px] pr-2 text-left text-[12px] text-fg-faint"
                title="Rows you hid. What runs in them keeps running; each shows again by itself when it next waits on you."
              >
                <EyeOffIcon size={13} />
                <span className="min-w-0 flex-1 truncate"><span className="num">{live.hidden.length}</span> hidden · {hiddenOpen ? 'hide again' : 'show'}</span>
              </button>
            </li>
          )}
          {!waitingOnly && hiddenOpen && live.hidden.map((x) => <Fragment key={x.session.session_id}>{liveRow(x, true)}{confirm(x.session.session_id)}</Fragment>)}
        </ul>
      )}
      {rowMenuContent()}
    </li>
  )
})

const NO_LIVE: LiveWithoutTab = { own: [], waitingOther: [], other: [], hidden: [] }

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
function TabRow({ tab, label, active, waiting, asks, onOpen, onClose, onMenu, digit }: {
  tab: Tab
  label?: TabLabel
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
  const closeTip = closeTitle(isFile, !!label?.isShell)
  const n = onClose ? 1 : 0
  return (
    <li className="group/row relative">
      <button
        type="button"
        data-nav-row
        data-tab-row={tab.id}
        data-waiting={waiting || undefined}
        aria-current={active ? 'true' : undefined}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10"
        onClick={onOpen}
        {...menuHandlers(onMenu)}
        className={`app-row flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] text-left ${active ? PAD_ALWAYS[n] : PAD_ON_HOVER[n]}`}
        title={label?.file ?? (label?.branch ? `${title} · ${label.branch}` : title)}
      >
        {isFile ? (
          <FileIcon size={12} className="text-fg-faint" />
        ) : (
          <>
            <StatusDot dot={label?.dot ?? 'idle'} />
            <AgentGlyph agent={label?.session?.agent} shell={label?.isShell} />
          </>
        )}
        <TitleAndBranch title={title} branch={label?.branch} className={active || waiting ? 'text-fg' : 'text-fg-muted'} />
        {!isFile && <HotMark sessionId={label?.session?.session_id} />}
        {word && <StateWord dot={word} asks={asks} />}
        {digit && (
          <kbd data-tab-key aria-hidden className={`app-kbd-key shrink-0 ${onClose ? 'group-hover/row:hidden group-focus-within/row:hidden pointer-coarse:hidden' : ''} ${active && onClose ? 'hidden' : ''}`}>{tabKey(digit)}</kbd>
        )}
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
  /** Hidden by hand, whoever started them: behind "N hidden · show". */
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
function LiveRow({ item, ownBranch, hidden = false, onOpen, onStop, onHide, onShow, onMenu }: {
  item: SessionNode
  ownBranch?: string
  /** Hidden by hand and shown on demand under "N hidden". */
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
    <li className="group/row relative">
      <button
        type="button"
        data-nav-row
        data-live-row={s.session_id}
        data-waiting={item.waiting || undefined}
        data-hidden-row={hidden || undefined}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10"
        onClick={onOpen}
        {...menuHandlers(onMenu)}
        className={`app-row flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] text-left ${item.waiting ? '' : hidden ? 'opacity-55' : 'opacity-75'} ${PAD_ON_HOVER[n]}`}
        title={`${title}${branch ? ` · ${branch}` : ''}: ${s.owned ? 'running, no tab. Open it as a tab.' : 'started in another terminal. Open its details.'}`}
      >
        <StatusDot dot={item.dot} />
        <AgentGlyph agent={s.agent} shell={item.isShell} />
        <TitleAndBranch title={title} branch={branch} className={item.waiting ? 'text-fg' : 'text-fg-faint'} />
        <HotMark sessionId={s.session_id} />
        {!item.isShell && <StateWord dot={item.dot} asks={item.asks} />}
      </button>
      {n > 0 && (
        <span data-row-actions className={`absolute right-1 top-1/2 -translate-y-1/2 items-center gap-0.5 ${ACTIONS_ON_HOVER}`}>
          {onShow && <RowAction label={`Show ${title} in the list again`} onClick={onShow}><EyeIcon size={14} /></RowAction>}
          {onHide && (
            <RowAction label={`Hide ${title} from the list`} title={`Hide from the list: ${s.owned ? 'it keeps running' : 'nothing is sent to it'}; “hidden · show” brings it back`} onClick={onHide}>
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

function readFolded(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}

/** A project folded by hand, kept per viewer. */
function useFolded(id: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => readFolded().has(id))
  const set = (next: boolean) => {
    setV(next)
    try {
      const all = readFolded()
      if (next) all.add(id); else all.delete(id)
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...all]))
    } catch { /* private window: folded for this page only */ }
  }
  return [v, set]
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
