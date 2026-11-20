/**
 * What a tab is called, once, for both places that list tabs: the tab strip
 * and the sidebar's list under the current project. The sidebar shows the
 * current project's part of the strip, in the strip's order, so the two
 * must say the same words (owner,
 * 2026-10-09: "which one is active, which to pick, unclear", translated).
 */
import type { SessionSummary } from './api'
import { baseName } from './files'
import { dotOf, sessionAbout, sessionTitle, type Dot } from './sidebar'
import { renamable } from './sessionNames'
import { branchLabel } from './sessionLabels'
import { leaves, namingLeaf, type Tab } from './tabs'
import { isQuickChat, startedChat } from './quickchat'
import { pageTitle } from './browsertab'

export interface TabLabel {
  /** The agent's title, "Shell 2", or a file's name; "+N" for panes split beside it. */
  title: string
  /** The branch, only when it is not the project's own; muted beside the title. */
  branch?: string
  /** A file tab: the file's path, for its tooltip. */
  file?: string
  /** A browser tab (ADR-075): the address it shows, '' for a new one. A page is never an agent, a shell or a file. */
  page?: string
  isShell: boolean
  /** A shell tab: its name alone, "Shell 2" or the one the user gave it, for the question before closing it. */
  shellName?: string
  /** A shell tab: what runs in front of its prompt, when something does. */
  program?: string
  /** A quick chat: named as one, never by its group (lib/quickchat.ts). */
  chat?: boolean
  /** The session the tab is named after, when the list knows it; a shell's tab: the shell. */
  session?: SessionSummary
  /**
   * A shell's tab with an agent session Caprock observes in front of its
   * prompt (`agent_session_id`, `GET /v1/shells`): that session. The tab is
   * named after it and Rename renames it; when it exits the tab is the
   * shell again.
   */
  inside?: SessionSummary
  /** A shell's tab: the name the user gave it (TabTarget.name), '' for none. */
  shellTitle?: string
  dot: Dot
}

/**
 * The agent session running in front of a shell's prompt — `claude --resume
 * <id>` typed there (`agent_session_id`, `GET /v1/shells`) — while it runs;
 * undefined for anything else. The tab is named after it, the inspector
 * shows its panel (components/Inspector.tsx) and the close question names it
 * (lib/closeShell.ts).
 */
export function agentInShell(shell: SessionSummary | undefined, sessions: ReadonlyMap<string, SessionSummary>): SessionSummary | undefined {
  if (!shell?.agent_session_id) return undefined
  const inner = sessions.get(shell.agent_session_id)
  return inner && inner.status !== 'ended' && inner.kind !== 'shell' ? inner : undefined
}

/** What Rename on a tab renames: the session it is named after, or a shell's tab itself. */
export type RenameOf =
  | { kind: 'session'; id: string; initial: string; current: string }
  | { kind: 'shell'; id: string; initial: string; current: string }

/**
 * What Rename on a tab renames, or undefined when it renames nothing (a
 * file, a page, the Files tab). An agent's tab renames its session; a
 * shell's tab renames the agent session running in it when there is one,
 * else the tab's own name, "Shell N" when it has none (owner, 2026-11-20,
 * translated: "since when can't I rename an open session, neither in the
 * top tabs nor on the left?").
 */
export function renameOf(l: TabLabel | undefined): RenameOf | undefined {
  if (!l || l.file !== undefined || l.page !== undefined) return undefined
  const s = l.isShell ? l.inside : l.session
  if (s && renamable(s)) return { kind: 'session', id: s.session_id, initial: s.name?.trim() || sessionAbout(s), current: s.name ?? '' }
  if (l.isShell && l.session) return { kind: 'shell', id: l.session.session_id, initial: l.shellTitle || l.shellName || 'Shell', current: l.shellTitle ?? '' }
  return undefined
}

/**
 * The label of every tab, by id. Shells are numbered within their project in
 * strip order — "Shell 1", "Shell 2" — since "shell" twice tells nothing
 * apart; one running a program says which, "Shell 1 · claude". A shell the
 * user named is called that instead, and one with an agent session Caprock
 * observes in front of its prompt is named after that session.
 * `defaultBranch` is the branch a project's main checkout is on; a tab on
 * any other branch says so.
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
    if (leaf.target.kind === 'page') {
      const url = leaf.target.url ?? ''
      out.set(t.id, { title: pageTitle(url, t.title), page: url, isShell: false, dot: 'idle' })
      continue
    }
    if (leaf.target.kind === 'files') {
      out.set(t.id, { title: t.title || 'Files', isShell: false, dot: 'idle' })
      continue
    }
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
      const shellTitle = leaf.target.name?.trim() || ''
      const shellName = shellTitle || `Shell ${n}`
      const program = s?.program || undefined
      // An agent session running in the shell — `claude --resume <id>` typed
      // at its prompt — names the tab while it runs, as an agent's tab is
      // named; the shell is said on hover (owner, 2026-11-20).
      const inside = agentInShell(s, sessions)
      if (inside) {
        const ib = branchLabel(inside.git_branch ?? '')
        out.set(t.id, {
          title: `${sessionTitle(inside)}${more}`, shellName, shellTitle, program, branch: ib && ib !== own ? ib : undefined,
          isShell, session: s, inside, dot: dotOf(inside, permissions.has(inside.session_id)),
        })
        continue
      }
      // A shell that took over an agent that ended unexpectedly keeps that
      // agent's name (lib/endedAgent.ts): "shell" alone hid which session it
      // was (owner, 2026-11-20). A name the user gave the tab wins.
      const name = shellTitle || leaf.target.ended?.title || shellName
      out.set(t.id, { title: `${name}${program ? ` · ${program}` : ''}${more}`, shellName, shellTitle, program, branch, isShell, session: s, dot })
      continue
    }
    const chat = isQuickChat(s) || (!s && !!startedChat(leaf.target.sessionId))
    out.set(t.id, { title: `${s ? sessionTitle(s) : t.title || 'session'}${more}`, branch, isShell, session: s, dot, ...(chat ? { chat } : {}) })
  }
  return out
}
