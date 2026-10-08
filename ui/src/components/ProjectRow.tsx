/**
 * One project in the app's sidebar (WP-06): its name, branch, how many agents
 * run in it and what it cost today, then — expanded — its worktrees and the
 * sessions and shells in each. Its ⋯ (on hover, on the project in front, and
 * on a right-click) opens the project menu (ProjectMenu).
 */
import { memo } from 'react'
import { branchLabel } from '@/lib/sessionLabels'
import { OTHER_FOLDERS_ID, type Dot, type ProjectNode, type SessionNode, type WorktreeNode } from '@/lib/sidebar'
import { fmtUSD } from '@/lib/format'
import { AgentGlyph, BranchIcon, ChevronIcon, EyeIcon, EyeOffIcon, FolderIcon, MoreIcon, PlusIcon, TerminalIcon } from './AppIcons'
import { PRDot } from './PullRequest'

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

/** "1 changed file", "3 changed files". */
export function changedFiles(n: number): string {
  return `${n} changed ${n === 1 ? 'file' : 'files'}`
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

export interface ProjectRowProps {
  node: ProjectNode
  expanded: boolean
  active: boolean
  activeSessionId?: string
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onOpenSession: (s: SessionNode, projectId: string) => void
  onNewAgent: (projectId: string, cwd?: string) => void
  onNewShell: (projectId: string, cwd?: string) => void
  /** Right-click on a project or worktree: the folder, for the editor menu (F18). */
  onFolderMenu?: (e: React.MouseEvent, path: string, label: string) => void
  onOpenChanges?: (projectId: string, w?: WorktreeNode) => void
  /** Hidden by hand: its row action shows it again instead of hiding it. */
  hidden?: boolean
  /** Hides the project from the list (true) or shows it again (false); absent, no such action. */
  onHide?: (id: string, hide: boolean) => void
  /** Opens the project menu at a point; `from` gets focus back when it closes. Absent, no menu. */
  onMenu?: (id: string, at: { x: number; y: number }, from: HTMLElement | null) => void
}

/** "2 agents running · 1 working". */
export function agentsLabel(agents: number, working: number): string {
  const n = `${agents} ${agents === 1 ? 'agent' : 'agents'} running`
  return working > 0 ? `${n} · ${working} working` : n
}

/** A right-click handler for a folder row, or none when there is no menu or no folder. */
function folderMenu(onFolderMenu: ProjectRowProps['onFolderMenu'], path: string, label: string) {
  if (!onFolderMenu || !path) return undefined
  return (e: React.MouseEvent) => onFolderMenu(e, path, label)
}

/** A worktree's changed-file count; a button into its Changes view when there is one. */
function ChangedBadge({ count, label, onOpen }: { count: number; label: string; onOpen?: () => void }) {
  if (!onOpen) return <span title="changed files">±{count}</span>
  return (
    <button
      type="button"
      title={`Review and commit the changes ${label}`}
      aria-label={`${changedFiles(count)} ${label}: review and commit`}
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      className="rounded-[4px] px-0.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      ±{count}
    </button>
  )
}

export const ProjectRow = memo(function ProjectRow({
  node,
  expanded,
  active,
  activeSessionId,
  onToggle,
  onSelect,
  onOpenSession,
  onNewAgent,
  onNewShell,
  onFolderMenu,
  onOpenChanges,
  hidden = false,
  onHide,
  onMenu,
}: ProjectRowProps) {
  const p = node.project
  const id = p.id
  // One checkout: the worktree level says nothing, so its sessions sit
  // directly under the project and its branch rides in the project's row.
  // Other folders has no folder of its own: always one row per folder.
  const isGroup = p.root === ''
  const flat = node.worktrees.length <= 1 && !isGroup
  const branch = flat ? node.worktrees[0]?.branch || p.branch : p.branch
  // A detached checkout, or a folder that is no repository, says HEAD.
  const mainBranch = branchLabel(branch)
  const cost = fmtCostShort(node.costToday)
  // One checkout: its changed count rides in the project's row.
  const flatChanged = flat && p.kind === 'repo' ? (node.worktrees[0]?.changed ?? p.changed ?? 0) : 0
  const menu = !isGroup && onMenu
  // The ⋯ stays on the project in front, so the menu is found without hovering.
  const pinnedMenu = !!menu && active
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
          aria-expanded={expanded}
          aria-current={active ? 'true' : undefined}
          onClick={() => { onSelect(id); if (!expanded) onToggle(id) }}
          onDoubleClick={() => onToggle(id)}
          onContextMenu={menu ? (e) => { e.preventDefault(); onMenu(id, { x: e.clientX, y: e.clientY }, e.currentTarget) } : folderMenu(onFolderMenu, p.root, p.name)}
          onKeyDown={menu ? (e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenuFrom(e.currentTarget) }
          } : undefined}
          aria-haspopup={menu ? 'menu' : undefined}
          aria-keyshortcuts={menu ? 'Shift+F10' : undefined}
          className={`app-row flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-1.5 text-left ${pinnedMenu ? 'pr-[30px]' : 'pr-2'}`}
          title={p.root}
        >
          <span
            className="app-chevron flex h-4 w-4 items-center justify-center text-fg-faint"
            onClick={(e) => { e.stopPropagation(); onToggle(id) }}
            aria-hidden
          >
            <ChevronIcon size={12} />
          </span>
          {/* The name is what the row is for: the branch takes only what is left. */}
          <span className="min-w-[5.5rem] flex-[0_1_auto] truncate text-[13px] font-medium text-fg">{p.name}</span>
          {mainBranch ? <FitOrHide text={mainBranch} /> : <span className="flex-1" />}
          {flat && !isGroup && p.kind === 'repo' && (
            <span className="group-hover:invisible"><PRDot projectId={id} worktree={node.worktrees[0] && !node.worktrees[0].isMain ? node.worktrees[0].key : ''} /></span>
          )}
          {flatChanged > 0 && (
            <span className="num text-[10.5px] text-fg-faint group-hover:invisible">
              <ChangedBadge count={flatChanged} label={`in ${p.name}`} onOpen={onOpenChanges ? () => onOpenChanges(id, node.worktrees[0]) : undefined} />
            </span>
          )}
          {/* What runs in it and what it cost today: each only when there is
              some, so a quiet project reads clean rather than as a row of zeros. */}
          {node.agents > 0 && (
            <span className="num inline-flex shrink-0 items-center gap-[3px] text-[11px] text-fg-muted group-hover:invisible" title={agentsLabel(node.agents, node.working)} aria-label={agentsLabel(node.agents, node.working)}>
              <span aria-hidden className={`inline-block h-[5px] w-[5px] rounded-full ${node.working > 0 ? 'bg-ok' : 'bg-fg-faint/70'}`} />
              {node.agents}
            </span>
          )}
          {cost && (
            <span className="num shrink-0 text-[11px] text-fg-faint group-hover:invisible" title={`${p.name} spent ${cost} today`} aria-label={`${cost} today`}>{cost}</span>
          )}
          {node.waiting > 0 ? (
            <span
              className="num ml-0.5 inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-panel group-hover:invisible"
              aria-label={`${node.waiting} waiting on you`}
            >
              {node.waiting}
            </span>
          ) : node.looping > 0 ? (
            <span className="num ml-0.5 shrink-0 text-[11px] text-danger group-hover:invisible" aria-label={`${node.looping} looping`}>⟳{node.looping}</span>
          ) : null}
        </button>
        {/* Actions on hover or focus, where the badges sit: the row stays one line. */}
        {!isGroup && (
          <span className={`absolute right-1 top-1/2 -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex ${pinnedMenu ? 'flex' : 'hidden'}`}>
            <span className="hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
              {flatChanged > 0 && onOpenChanges && (
                <RowAction label={`Review and commit ${changedFiles(flatChanged)} in ${p.name}`} onClick={() => onOpenChanges(id, node.worktrees[0])}><span className="num text-[10.5px]">±{flatChanged}</span></RowAction>
              )}
              <RowAction label={`New agent in ${p.name}`} onClick={() => onNewAgent(id)}><PlusIcon size={13} /></RowAction>
              <RowAction label={`New shell in ${p.name}`} onClick={() => onNewShell(id)}><TerminalIcon size={13} /></RowAction>
              {onHide && (hidden ? (
                <RowAction label={`Show ${p.name} in the list again`} onClick={() => onHide(id, false)}><EyeIcon size={13} /></RowAction>
              ) : (
                <RowAction label={`Hide ${p.name} from the list`} onClick={() => onHide(id, true)}><EyeOffIcon size={13} /></RowAction>
              ))}
            </span>
            {menu && (
              <RowAction label={`More for ${p.name}: hide, close its tabs, remove`} popup onClick={(el) => openMenuFrom(el)}><MoreIcon size={14} /></RowAction>
            )}
          </span>
        )}
      </div>
      {expanded && (
        <ul className="grid grid-cols-1 pb-1" role="group">
          {node.worktrees.length === 0 && (
            <li className="flex h-[26px] items-center pl-[30px] pr-2 text-[12px] text-fg-faint">
              Nothing running.
              <button type="button" onClick={() => onNewAgent(id)} className="ml-1.5 text-fg-muted underline-offset-2 hover:text-fg hover:underline">Start an agent</button>
            </li>
          )}
          {node.worktrees.map((w) =>
            flat ? (
              w.sessions.map((s) => (
                <SessionRow key={s.session.session_id} s={s} depth={1} active={s.session.session_id === activeSessionId} onOpen={() => onOpenSession(s, id)} />
              ))
            ) : (
              <WorktreeRows key={w.key} w={w} projectId={id} activeSessionId={activeSessionId} onOpenSession={onOpenSession} onNewAgent={onNewAgent} onNewShell={onNewShell} onFolderMenu={onFolderMenu} onOpenChanges={isGroup ? undefined : onOpenChanges} />
            ),
          )}
        </ul>
      )}
    </li>
  )
})

/**
 * The project row's branch, in the space the name and the figures leave: it
 * is the row's spacer, set against the figures. Where too little is left to
 * read (under 2.5rem) it goes rather than standing as a sliver or "ma…": a
 * zero-width item before it lets it wrap onto a second line that the fixed
 * height hides. CSS alone, so nothing is measured on every render.
 */
function FitOrHide({ text }: { text: string }) {
  return (
    <span className="flex h-[16px] min-w-0 flex-1 flex-wrap content-start justify-end overflow-hidden group-hover:invisible" title={text}>
      {/* A full-height first line, so the line it wraps to is the hidden one. */}
      <span aria-hidden className="h-[16px] w-0" />
      {/* A short name ("main") shows whole or not at all; a long one keeps at least 2.5rem. */}
      <span className={`mono text-[11px] leading-[16px] text-fg-faint ${[...text].length <= 6 ? 'min-w-max' : 'min-w-[2.5rem] max-w-[96px] truncate'}`}>{text}</span>
    </span>
  )
}

function WorktreeRows({
  w,
  projectId,
  activeSessionId,
  onOpenSession,
  onNewAgent,
  onNewShell,
  onFolderMenu,
  onOpenChanges,
}: {
  w: WorktreeNode
  projectId: string
  activeSessionId?: string
  onOpenSession: (s: SessionNode, projectId: string) => void
  onNewAgent: (projectId: string, cwd?: string) => void
  onNewShell: (projectId: string, cwd?: string) => void
  onFolderMenu?: ProjectRowProps['onFolderMenu']
  onOpenChanges?: (projectId: string, w?: WorktreeNode) => void
}) {
  return (
    <li className="grid grid-cols-1">
      <div className="group relative flex h-[26px] items-center gap-1.5 pl-[26px] pr-2 text-[12px] text-fg-muted" title={w.path} onContextMenu={folderMenu(onFolderMenu, w.path, w.branch)}>
        {projectId === OTHER_FOLDERS_ID ? <FolderIcon size={12} className="text-fg-faint" /> : <BranchIcon size={12} className="text-fg-faint" />}
        <span className={`min-w-0 flex-1 truncate ${projectId === OTHER_FOLDERS_ID ? '' : 'mono'}`}>{w.branch}</span>
        <span className="num flex items-center gap-1.5 text-[10.5px] text-fg-faint group-hover:invisible">
          {projectId !== OTHER_FOLDERS_ID && <PRDot projectId={projectId} worktree={w.isMain ? '' : w.key} />}
          {!!w.ahead && <span title="commits ahead">↑{w.ahead}</span>}
          {!!w.behind && <span title="commits behind">↓{w.behind}</span>}
          {!!w.changed && <ChangedBadge count={w.changed} label={`on ${w.branch}`} onOpen={onOpenChanges ? () => onOpenChanges(projectId, w) : undefined} />}
        </span>
        <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex">
          {!!w.changed && onOpenChanges && (
            <RowAction label={`Review and commit ${changedFiles(w.changed)} on ${w.branch}`} onClick={() => onOpenChanges(projectId, w)}><span className="num text-[10.5px]">±{w.changed}</span></RowAction>
          )}
          <RowAction label={`New agent on ${w.branch}`} onClick={() => onNewAgent(projectId, w.path)}><PlusIcon size={12} /></RowAction>
          <RowAction label={`New shell on ${w.branch}`} onClick={() => onNewShell(projectId, w.path)}><TerminalIcon size={12} /></RowAction>
        </span>
      </div>
      {w.sessions.length > 0 && (
        <ul className="grid grid-cols-1">
          {w.sessions.map((s) => (
            <SessionRow key={s.session.session_id} s={s} depth={2} active={s.session.session_id === activeSessionId} onOpen={() => onOpenSession(s, projectId)} />
          ))}
        </ul>
      )}
    </li>
  )
}

function SessionRow({ s, depth, active, onOpen }: { s: SessionNode; depth: 1 | 2; active: boolean; onOpen: () => void }) {
  const owned = s.session.owned
  return (
    <li>
      <button
        type="button"
        data-nav-row
        data-session-row={s.session.session_id}
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        className={`app-row flex h-[26px] w-full min-w-0 items-center gap-2 rounded-[7px] pr-2 text-left ${depth === 1 ? 'pl-[26px]' : 'pl-[40px]'}`}
        title={owned ? s.title : `${s.title} — started outside Caprock: opens its details, not a terminal`}
      >
        <StatusDot dot={s.dot} />
        <AgentGlyph agent={s.session.agent} shell={s.isShell} />
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${s.dot === 'ended' ? 'text-fg-faint' : owned ? 'text-fg' : 'text-fg-muted'}`}>{s.title}</span>
        {s.dot === 'waiting' && <span className="text-[10.5px] font-medium text-accent">waiting</span>}
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
