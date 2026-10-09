/**
 * Closing a tab or a pane that holds a shell (.ai/21-app.md § Shell tabs).
 * Close means close, as in iTerm, Terminal and VS Code: an idle shell ends
 * with its tab, and one running a program asks first. An agent's tab never
 * stops its agent. Pure, so the decision is tested without a daemon.
 */
import type { SessionSummary } from './api'
import { leaves, namingLeaf, type PaneLeaf, type Tab } from './tabs'

/** A shell the close would end, or ask about. */
export interface ClosingShell {
  sessionId: string
  /** "Shell 1", or "The shell" when the tab is named after something else. */
  name: string
  /** What runs in front of its prompt; absent when it is idle. */
  program?: string
}

/** What closing does: end `stop` with no question; ask about `busy` first. */
export interface ClosePlan {
  stop: ClosingShell[]
  busy: ClosingShell[]
}

/** Whether a pane shows a shell: opened as one, or a session the daemon calls one. */
export function isShellLeaf(leaf: PaneLeaf, sessions: ReadonlyMap<string, SessionSummary>): boolean {
  if (leaf.target.kind === 'file') return false
  return leaf.target.kind === 'shell' || sessions.get(leaf.target.sessionId)?.kind === 'shell'
}

/**
 * The plan for closing a tab, or one pane of it when `paneId` is given.
 * `live` is the daemon's shell list read at the moment of closing — id to
 * program — so a shell that already ended is neither stopped nor asked
 * about, and a program started a second ago is not missed. `shellName` is
 * the tab's own name for its shell ("Shell 1"), when the tab is named after it.
 */
export function planClose(
  tab: Tab,
  paneId: string | undefined,
  sessions: ReadonlyMap<string, SessionSummary>,
  live: ReadonlyMap<string, string | undefined>,
  shellName?: string,
): ClosePlan {
  const all = leaves(tab.root)
  const closing = paneId ? all.filter((l) => l.id === paneId) : all
  const naming = namingLeaf(tab)
  const plan: ClosePlan = { stop: [], busy: [] }
  const seen = new Set<string>()
  for (const leaf of closing) {
    const id = leaf.target.sessionId
    if (seen.has(id) || !isShellLeaf(leaf, sessions) || !live.has(id)) continue
    seen.add(id)
    const program = live.get(id) || undefined
    const name = leaf.id === naming.id && shellName ? shellName : 'The shell'
    ;(program ? plan.busy : plan.stop).push({ sessionId: id, name, program })
  }
  return plan
}

/** The question for busy shells: "Shell 1 is running claude. Close and stop it?" */
export function closeQuestion(busy: readonly ClosingShell[]): string {
  if (busy.length === 1) return `${busy[0]!.name} is running ${busy[0]!.program}. Close and stop it?`
  return `${busy.length} shells are running ${busy.map((b) => b.program).join(', ')}. Close and stop them?`
}

/**
 * The plan for *Close project*: every shell of the project, with a tab or
 * without, that the daemon still lists. Idle ones end; busy ones are asked
 * about together. Agents are not in `shellIds` and are never touched.
 * `names` is a tabbed shell's name ("Shell 1"); one with no tab is "Shell".
 */
export function planProjectClose(
  shellIds: readonly string[],
  live: ReadonlyMap<string, string | undefined>,
  names: ReadonlyMap<string, string>,
): ClosePlan {
  const plan: ClosePlan = { stop: [], busy: [] }
  for (const id of new Set(shellIds)) {
    if (!live.has(id)) continue
    const program = live.get(id) || undefined
    ;(program ? plan.busy : plan.stop).push({ sessionId: id, name: names.get(id) ?? 'Shell', program })
  }
  return plan
}

/** What *Close project* did with the project's shells: asked and was told no, or stopped how many. */
export interface ProjectShellsOutcome {
  cancelled: boolean
  stopped: number
}

/** "alpha: Shell 1 is running claude, Shell 2 is running npm. Stop them and close?" */
export function projectCloseQuestion(project: string, busy: readonly ClosingShell[]): string {
  const list = busy.map((b) => `${b.name} is running ${b.program}`).join(', ')
  return `${project}: ${list}. Stop ${busy.length === 1 ? 'it' : 'them'} and close?`
}

/** Each tabbed shell's name, by session id: the name its tab carries ("Shell 2"). */
export function shellNames(tabs: readonly Tab[], labels: ReadonlyMap<string, { shellName?: string }>): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of tabs) {
    const name = labels.get(t.id)?.shellName
    if (name) out.set(namingLeaf(t).target.sessionId, name)
  }
  return out
}

/** The shell list as `planClose` reads it: id to program. */
export function liveShells(list: readonly { id: string; program?: string }[]): Map<string, string | undefined> {
  return new Map(list.map((sh) => [sh.id, sh.program]))
}

/** What a tab's close button says: a shell closes for real, an agent runs on. */
export function closeTitle(isFile: boolean, isShell: boolean): string {
  if (isFile) return 'Close tab (⌘W)'
  return isShell ? 'Close shell (⌘W)' : 'Close tab (⌘W) — the agent keeps running'
}

/** The close action's name: "Close shell" for a shell's tab, else "Close tab". */
export function closeWord(isFile: boolean, isShell: boolean): string {
  return isShell && !isFile ? 'Close shell' : 'Close tab'
}
