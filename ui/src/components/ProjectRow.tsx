/**
 * One project in the app's sidebar (WP-06): its name, branch and today's cost,
 * then — expanded — its worktrees and the sessions and shells in each.
 */
import { memo } from 'react'
import { branchLabel } from '@/lib/sessionLabels'
import { OTHER_FOLDERS_ID, type Dot, type ProjectNode, type SessionNode, type WorktreeNode } from '@/lib/sidebar'
import { fmtUSD } from '@/lib/format'
import { AgentGlyph, BranchIcon, ChevronIcon, FolderIcon, PlusIcon, TerminalIcon } from './AppIcons'

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
          className="app-row flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-[7px] pl-1.5 pr-2 text-left"
          title={p.root}
        >
          <span
            className="app-chevron flex h-4 w-4 items-center justify-center text-fg-faint"
            onClick={(e) => { e.stopPropagation(); onToggle(id) }}
            aria-hidden
          >
            <ChevronIcon size={12} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{p.name}</span>
          {mainBranch && (
            <span className="mono max-w-[84px] truncate text-[11px] text-fg-faint group-hover:invisible">{mainBranch}</span>
          )}
          {node.waiting > 0 ? (
            <span
              className="num ml-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-panel group-hover:invisible"
              aria-label={`${node.waiting} waiting on you`}
            >
              {node.waiting}
            </span>
          ) : node.looping > 0 ? (
            <span className="num ml-0.5 text-[11px] text-danger group-hover:invisible" aria-label={`${node.looping} looping`}>⟳{node.looping}</span>
          ) : cost ? (
            <span className="num ml-0.5 text-[11px] text-fg-faint group-hover:invisible" title="spent today">{cost}</span>
          ) : null}
        </button>
        {/* Actions on hover or focus, where the badges sit: the row stays one line. */}
        {!isGroup && (
          <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex">
            <RowAction label={`New agent in ${p.name}`} onClick={() => onNewAgent(id)}><PlusIcon size={13} /></RowAction>
            <RowAction label={`New shell in ${p.name}`} onClick={() => onNewShell(id)}><TerminalIcon size={13} /></RowAction>
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
              <WorktreeRows key={w.key} w={w} projectId={id} activeSessionId={activeSessionId} onOpenSession={onOpenSession} onNewAgent={onNewAgent} onNewShell={onNewShell} />
            ),
          )}
        </ul>
      )}
    </li>
  )
})

function WorktreeRows({
  w,
  projectId,
  activeSessionId,
  onOpenSession,
  onNewAgent,
  onNewShell,
}: {
  w: WorktreeNode
  projectId: string
  activeSessionId?: string
  onOpenSession: (s: SessionNode, projectId: string) => void
  onNewAgent: (projectId: string, cwd?: string) => void
  onNewShell: (projectId: string, cwd?: string) => void
}) {
  return (
    <li className="grid grid-cols-1">
      <div className="group relative flex h-[26px] items-center gap-1.5 pl-[26px] pr-2 text-[12px] text-fg-muted" title={w.path}>
        {projectId === OTHER_FOLDERS_ID ? <FolderIcon size={12} className="text-fg-faint" /> : <BranchIcon size={12} className="text-fg-faint" />}
        <span className={`min-w-0 flex-1 truncate ${projectId === OTHER_FOLDERS_ID ? '' : 'mono'}`}>{w.branch}</span>
        <span className="num flex items-center gap-1.5 text-[10.5px] text-fg-faint group-hover:invisible">
          {!!w.ahead && <span title="commits ahead">↑{w.ahead}</span>}
          {!!w.behind && <span title="commits behind">↓{w.behind}</span>}
          {!!w.changed && <span title="changed files">±{w.changed}</span>}
        </span>
        <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex">
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

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      {children}
    </button>
  )
}
