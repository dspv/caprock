/**
 * Closing a tab or a pane that holds a shell (.ai/21-app.md § Shell tabs).
 * Close means close, as in iTerm, Terminal and VS Code: an idle shell ends
 * with its tab, and one running a program asks first. An agent's tab stops
 * its agent only when you say so, and only one Caprock started
 * (planAgentClose). Pure, so the decision is tested without a daemon.
 */
import type { SessionSummary } from './api'
import { leaves, namingLeaf, type PaneLeaf, type Tab } from './tabs'
import { keys } from './appkeys'

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

/** What a tab's close button says: a shell closes for real, a quick chat ends, an agent runs on unless Caprock started it and you end it. */
export function closeTitle(isFile: boolean, isShell: boolean, isChat = false, owned = false): string {
  if (isFile) return `Close tab (${keys('⌘W')})`
  if (isShell) return `Close shell (${keys('⌘W')})`
  if (isChat) return `Close tab (${keys('⌘W')}) — the chat ends`
  // An agent Caprock started: closing asks whether to end it too (lib/agentClose.ts).
  return owned ? `Close tab (${keys('⌘W')}) — keep the agent running or end it` : `Close tab (${keys('⌘W')}) — the agent keeps running`
}

/** The quick chats a close ends: `stop` at once, `busy` (still answering) after one question. */
export interface ChatClosePlan {
  stop: string[]
  busy: string[]
}

/**
 * The plan for the quick chats in a closing tab or pane (.ai/21-app.md §
 * Quick chat). A quick chat lives in Caprock's own folder and has nothing to
 * come back to, so closing its tab ends its process — closed chats piled up
 * as idle sessions under Outside projects (owner, 2026-10-12). Only a chat
 * Caprock started and still running (`owned`, not ended) is ever stopped
 * (rule 7); one mid-turn is asked about first. Any other agent's tab still
 * leaves its agent running. `isChat` is lib/quickchat's test, passed in so
 * this module stays free of storage. `startedHere` is a chat this window
 * spawned a moment ago, before the session list has it: Caprock started
 * it, and it has not answered anything yet, so it ends with no question.
 */
export function planChatClose(
  tab: Tab,
  paneId: string | undefined,
  sessions: ReadonlyMap<string, SessionSummary>,
  isChat: (s: SessionSummary) => boolean,
  startedHere: (id: string) => boolean = () => false,
): ChatClosePlan {
  const closing = paneId ? leaves(tab.root).filter((l) => l.id === paneId) : leaves(tab.root)
  const plan: ChatClosePlan = { stop: [], busy: [] }
  const seen = new Set<string>()
  for (const leaf of closing) {
    if (leaf.target.kind !== 'session') continue
    const id = leaf.target.sessionId
    if (seen.has(id)) continue
    const s = sessions.get(id)
    if (!s) {
      if (startedHere(id)) { seen.add(id); plan.stop.push(id) }
      continue
    }
    if (!s.owned || s.status === 'ended' || s.kind === 'shell' || !isChat(s)) continue
    seen.add(s.session_id)
    const health = s.activity?.health
    ;(health === 'working' || health === 'looping' ? plan.busy : plan.stop).push(s.session_id)
  }
  return plan
}

/** The one question before ending a chat that is still answering. */
export const CHAT_CLOSE_QUESTION = 'Stop the chat? It is still answering.'

/**
 * The agents a closing tab or pane shows that Caprock started: `all` of
 * them, `busy` the ones still answering, `active` the ones working or
 * waiting on you (busy, plus a question or a permission prompt open) —
 * what closing asks about. An agent not in `active` ends with its tab.
 */
export interface AgentClosePlan {
  all: string[]
  busy: string[]
  active: string[]
}

/**
 * The agents a close may offer to end (owner, 2026-10-14): only sessions
 * Caprock started (`owned`), still running, not shells and not quick chats
 * (`isChat`: those end with their tab already, planChatClose). A session
 * another terminal started is never here, so it is never signalled (rule 7);
 * its tab just closes. One not on the session list yet is left alone too.
 */
export function planAgentClose(
  tab: Tab,
  paneId: string | undefined,
  sessions: ReadonlyMap<string, SessionSummary>,
  isChat: (s: SessionSummary) => boolean,
  asks: (id: string) => boolean = () => false,
): AgentClosePlan {
  const closing = paneId ? leaves(tab.root).filter((l) => l.id === paneId) : leaves(tab.root)
  const plan: AgentClosePlan = { all: [], busy: [], active: [] }
  for (const leaf of closing) {
    if (leaf.target.kind !== 'session') continue
    const s = sessions.get(leaf.target.sessionId)
    if (!s || !s.owned || s.status === 'ended' || s.kind === 'shell' || isChat(s) || plan.all.includes(s.session_id)) continue
    plan.all.push(s.session_id)
    const health = s.activity?.health
    if (health === 'working' || health === 'looping') plan.busy.push(s.session_id)
    if (health === 'working' || health === 'looping' || health === 'waiting-on-you' || asks(s.session_id)) plan.active.push(s.session_id)
  }
  return plan
}

/**
 * What closing an agent's tab says once the agent is ended (owner,
 * 2026-10-15, translated: "I never understand whether data is kept"). True:
 * the end is a SIGTERM first (`end`), so Claude Code writes its transcript
 * and the session can be continued with --resume.
 */
export const AGENT_SAVED_TOAST = 'Closed. The conversation is saved — reopen it from History or the sidebar.'

/** The one sentence before closing the tab of an agent that is working or waiting. */
export function agentStillWorking(title: string, many: boolean): string {
  return many
    ? `“${title}”: its agents are still working. The conversations are saved either way.`
    : `“${title}” is still working. The conversation is saved either way.`
}

/**
 * The two equal choices under that sentence, each with one plain line
 * saying what it does (owner, 2026-10-17, translated: one button "may be
 * the wrong choice").
 */
export function agentCloseChoices(many: boolean): { keep: { label: string; says: string }; end: { label: string; says: string } } {
  return many
    ? {
        keep: { label: 'Keep them running', says: 'Only the tab closes. They work on in the background, under Running in the sidebar.' },
        end: { label: 'Stop them', says: 'They stop now and the tab closes. Continue them later from History or the sidebar.' },
      }
    : {
        keep: { label: 'Keep it running', says: 'Only the tab closes. It works on in the background, under Running in the sidebar.' },
        end: { label: 'Stop it', says: 'It stops now and the tab closes. Continue it later from History or the sidebar.' },
      }
}

/** The one question before ending an agent that is still answering. */
export const AGENT_END_QUESTION = 'End the agent? It is still answering.'

/** The close action's name: "Close shell" for a shell's tab, else "Close tab". */
export function closeWord(isFile: boolean, isShell: boolean): string {
  return isShell && !isFile ? 'Close shell' : 'Close tab'
}
