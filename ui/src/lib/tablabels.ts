/**
 * What a tab is called, once, for both places that list tabs: the tab strip
 * and the sidebar's list under the current project. The two show the same
 * tabs in the same order, so they must say the same words (owner,
 * 2026-10-09: "which one is active, which to pick, unclear", translated).
 */
import type { SessionSummary } from './api'
import { baseName } from './files'
import { dotOf, sessionTitle, type Dot } from './sidebar'
import { branchLabel } from './sessionLabels'
import { leaves, namingLeaf, type Tab } from './tabs'

export interface TabLabel {
  /** The agent's title, "Shell 2", or a file's name; "+N" for panes split beside it. */
  title: string
  /** The branch, only when it is not the project's own; muted beside the title. */
  branch?: string
  /** A file tab: the file's path, for its tooltip. */
  file?: string
  isShell: boolean
  /** The session the tab is named after, when the list knows it. */
  session?: SessionSummary
  dot: Dot
}

/**
 * The label of every tab, by id. Shells are numbered within their project in
 * strip order — "Shell 1", "Shell 2" — since "shell" twice tells nothing
 * apart. `defaultBranch` is the branch a project's main checkout is on; a tab
 * on any other branch says so.
 */
export function tabLabels(
  tabs: readonly Tab[],
  sessions: ReadonlyMap<string, SessionSummary>,
  permissions: ReadonlySet<string>,
  defaultBranch: (projectId: string) => string | undefined,
): Map<string, TabLabel> {
  const out = new Map<string, TabLabel>()
  const shells = new Map<string, number>()
  for (const t of tabs) {
    const leaf = namingLeaf(t)
    const panes = leaves(t.root).length
    const more = panes > 1 ? ` +${panes - 1}` : ''
    if (leaf.target.kind === 'file') {
      const file = leaf.target.path ?? ''
      out.set(t.id, { title: baseName(file), file, isShell: false, dot: 'idle' })
      continue
    }
    const s = sessions.get(leaf.target.sessionId)
    const isShell = leaf.target.kind === 'shell' || s?.kind === 'shell'
    const dot: Dot = s ? dotOf(s, permissions.has(s.session_id)) : 'idle'
    const own = branchLabel(defaultBranch(t.projectId) ?? '')
    const b = branchLabel(s?.git_branch ?? '')
    const branch = b && b !== own ? b : undefined
    if (isShell) {
      const n = (shells.get(t.projectId) ?? 0) + 1
      shells.set(t.projectId, n)
      out.set(t.id, { title: `Shell ${n}${more}`, branch, isShell, session: s, dot })
      continue
    }
    out.set(t.id, { title: `${s ? sessionTitle(s) : t.title || 'session'}${more}`, branch, isShell, session: s, dot })
  }
  return out
}
