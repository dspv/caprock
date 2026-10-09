/**
 * One project in the app's sidebar (WP-06), as an accordion (owner,
 * 2026-10-09: "which one is active, which to pick, unclear", translated).
 *
 * A project is one line: its name, a green dot with how many sessions and
 * shells run in it, and how many wait on you. The current project is the one
 * open, with no chevron to manage: under it, exactly the tabs the tab strip
 * shows for it, in the same order and under the same names
 * (lib/tablabels.ts). After them, muted, whatever of the project still runs
 * with no tab — a session started in a terminal, a tab closed on a live shell
 * — so live work is never out of sight; a click opens it as a tab. Ended
 * sessions are not listed. The tab in front is the one highlighted row in
 * the whole sidebar. Hover shows New agent, New shell, hide and the ⋯ menu.
 */
import { memo, useMemo } from 'react'
import type { SessionSummary } from '@/lib/api'
import type { ProjectNode, SessionNode } from '@/lib/sidebar'
import type { Dot } from '@/lib/sidebar'
import { branchLabel } from '@/lib/sessionLabels'
import type { Tab } from '@/lib/tabs'
import type { TabLabel } from '@/lib/tablabels'
import { fmtUSD } from '@/lib/format'
import { AgentGlyph, EyeIcon, EyeOffIcon, FileIcon, MoreIcon, PlusIcon, TerminalIcon } from './AppIcons'

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
  /** Opens, as a tab, a live session or shell of the project that has none. */
  onOpenLive?: (s: SessionSummary, projectId: string) => void
  onNewAgent: (projectId: string, cwd?: string) => void
  onNewShell: (projectId: string, cwd?: string) => void
  /** Right-click on a project row with no menu: the folder, for the editor menu (F18). */
  onFolderMenu?: (e: React.MouseEvent, path: string, label: string) => void
  /** Hidden by hand: its row action shows it again instead of hiding it. */
  hidden?: boolean
  /** Hides the project from the list (true) or shows it again (false); absent, no such action. */
  onHide?: (id: string, hide: boolean) => void
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
  onOpenLive,
  onNewAgent,
  onNewShell,
  onFolderMenu,
  hidden = false,
  onHide,
  onMenu,
}: ProjectRowProps) {
  const p = node.project
  const id = p.id
  const untabbed = useMemo(() => (current ? liveWithoutTab(node) : []), [current, node])
  // Other folders is a group, not a folder: no menu, no new agent in it.
  const isGroup = p.root === ''
  const menu = !isGroup && onMenu
  const openMenuFrom = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    onMenu?.(id, { x: r.right - 4, y: r.bottom + 2 }, el)
  }
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
            {onHide && (hidden ? (
              <RowAction label={`Show ${p.name} in the list again`} onClick={() => onHide(id, false)}><EyeIcon size={13} /></RowAction>
            ) : (
              <RowAction label={`Hide ${p.name} from the list`} onClick={() => onHide(id, true)}><EyeOffIcon size={13} /></RowAction>
            ))}
            {menu && (
              <RowAction label={`More for ${p.name}: hide, close its tabs, remove`} popup onClick={(el) => openMenuFrom(el)}><MoreIcon size={14} /></RowAction>
            )}
          </span>
        )}
      </div>
      {current && (
        <ul className="grid grid-cols-1 pb-1" role="group" aria-label={`${p.name}: open tabs`}>
          {tabs.length === 0 && untabbed.length === 0 && (
            <li className="flex h-[26px] items-center pl-[22px] pr-2 text-[12px] text-fg-faint">No tabs open.</li>
          )}
          {tabs.map((t) => {
            const l = labels.get(t.id)
            return (
              <TabRow key={t.id} tab={t} label={l} active={t.id === activeTabId} onOpen={() => onActivateTab(t.id)} />
            )
          })}
          {untabbed.map((x) => (
            <LiveRow key={x.session.session_id} item={x} ownBranch={p.branch} onOpen={() => onOpenLive?.(x.session, id)} />
          ))}
        </ul>
      )}
    </li>
  )
})

/** One open tab under the current project: what the strip calls it, its dot, its branch when not the project's own. */
function TabRow({ tab, label, active, onOpen }: { tab: Tab; label?: TabLabel; active: boolean; onOpen: () => void }) {
  const title = label?.title ?? tab.title
  return (
    <li>
      <button
        type="button"
        data-nav-row
        data-tab-row={tab.id}
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        className="app-row flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] pr-2 text-left"
        title={label?.file ?? title}
      >
        {label?.file !== undefined ? (
          <FileIcon size={12} className="text-fg-faint" />
        ) : (
          <>
            <StatusDot dot={label?.dot ?? 'idle'} />
            <AgentGlyph agent={label?.session?.agent} shell={label?.isShell} />
          </>
        )}
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${active ? 'text-fg' : 'text-fg-muted'}`}>{title}</span>
        {label?.branch && <span className="mono min-w-0 max-w-[10ch] shrink truncate text-[11px] text-fg-faint">{label.branch}</span>}
      </button>
    </li>
  )
}

/** The project's live sessions and shells that no tab shows: agents first, then the most recent. */
export function liveWithoutTab(node: ProjectNode): SessionNode[] {
  return node.worktrees
    .flatMap((w) => w.sessions)
    .filter((x) => !x.open && x.session.status !== 'ended')
    .sort((a, b) => Number(a.isShell) - Number(b.isShell) || (b.session.last_event_at ?? 0) - (a.session.last_event_at ?? 0))
}

/** A live session or shell with no tab: muted, so it reads as not open; a click opens it. */
function LiveRow({ item, ownBranch, onOpen }: { item: SessionNode; ownBranch?: string; onOpen: () => void }) {
  const s = item.session
  const own = branchLabel(ownBranch ?? '')
  const b = branchLabel(s.git_branch ?? '')
  const branch = b && b !== own ? b : undefined
  const title = item.isShell ? 'Shell' : item.title
  return (
    <li>
      <button
        type="button"
        data-nav-row
        data-live-row={s.session_id}
        onClick={onOpen}
        className="app-row flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] pr-2 text-left opacity-70"
        title={`${title}: running, no tab. Open it as a tab.`}
      >
        <StatusDot dot={item.dot} />
        <AgentGlyph agent={s.agent} shell={item.isShell} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-faint">{title}</span>
        {branch && <span className="mono min-w-0 max-w-[10ch] shrink truncate text-[11px] text-fg-faint">{branch}</span>}
      </button>
    </li>
  )
}

function RowAction({ label, onClick, popup, children }: { label: string; onClick: (el: HTMLButtonElement) => void; popup?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-haspopup={popup ? 'menu' : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(e.currentTarget) }}
      className="flex h-[22px] min-w-[22px] items-center justify-center rounded-[5px] px-0.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      {children}
    </button>
  )
}
