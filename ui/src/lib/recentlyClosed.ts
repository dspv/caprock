/**
 * The tabs the user closed, newest first, so a conversation closed by mistake
 * — or put down an hour ago — comes back with one click in the sidebar's
 * *Recently closed* or ⇧⌘T, as in a browser (owner, 2026-10-20).
 *
 * Only agent conversations are kept — this machine's and those on another
 * computer (issue #1085) alike: a shell's tab ends its shell (nothing
 * to come back to), a file reopens from the project, a browser tab is a page.
 * Kept in localStorage like the rest of the tab state, so the list survives a
 * reload and a restart; capped, the oldest going first. An entry is dropped
 * once it is reopened, and one whose session has a tab again is not listed.
 *
 * Bringing one back (`reopenPlan`): a session whose process still runs gets
 * its tab again, as a click on its row does (its terminal, or read-only when
 * Caprock did not start it, rule 7); an ended one is continued with
 * `--resume` under its own id, in the permission mode it last ran in, as
 * *Continue here* does (components/ContinueSession.tsx).
 *
 * A session that ended unexpectedly — a signal, a crash, nobody asked
 * (lib/endedAgent.ts) — is put on the list too, though no tab closed: its
 * tab became a shell, and the owner could not find the session anywhere
 * (2026-11-20, translated). Its row says *ended unexpectedly*, its project
 * and the time; reopening it resumes it the same way.
 */
import type { SessionSummary } from './api'
import { leaves, type Tab } from './tabs'

export const RECENTLY_CLOSED_KEY = 'caprock.app.recently-closed'
/** Said on window when the list changes, so the sidebar reads it again. */
export const RECENTLY_CLOSED_EVENT = 'caprock:recently-closed'
/** How many are kept; the sidebar shows RECENTLY_CLOSED_SHOWN of them. */
export const RECENTLY_CLOSED_MAX = 20
export const RECENTLY_CLOSED_SHOWN = 5

export interface ClosedTab {
  sessionId: string
  /** What its tab was called when it closed. */
  title: string
  /** The project the tab belonged to: where it reopens. */
  projectId: string
  /** Its folder, so an ended session can be continued even once the list no longer carries it. */
  cwd?: string
  /** When the tab closed (unix ms); for one that ended unexpectedly, when it ended. */
  closedAt: number
  /** It ended and nobody asked it to (lib/endedAgent.ts): no tab closed, its tab became a shell. */
  unexpected?: boolean
  /** The project's name when it was put on the list, for the row. */
  project?: string
  /** The tab's place in the strip when it closed (an index into the tabs), so it reopens there. */
  at?: number
  /**
   * A session on another computer (lib/tabs.ts `remote`): that computer's
   * id, the session's id there and the computer's name. `sessionId` is then
   * the tab's key (remoteKey). It reopens as its tab again, which shows
   * *Continue* there once the session has ended (components/MachineTab.tsx).
   */
  machine?: string
  remote?: string
  machineName?: string
}

function valid(x: unknown): x is ClosedTab {
  const c = x as ClosedTab
  return !!c && typeof c === 'object' && typeof c.sessionId === 'string' && c.sessionId !== '' &&
    typeof c.title === 'string' && typeof c.projectId === 'string' && typeof c.closedAt === 'number'
}

export function parseRecentlyClosed(raw: string | null): ClosedTab[] {
  try {
    const v = JSON.parse(raw ?? 'null') as unknown
    // Sorted on read too: a list stored before 2026-11-27 kept the order things were added.
    return Array.isArray(v) ? withClosed([], v.filter(valid)) : []
  } catch {
    return []
  }
}

export function loadRecentlyClosed(): ClosedTab[] {
  try { return parseRecentlyClosed(localStorage.getItem(RECENTLY_CLOSED_KEY)) } catch { return [] }
}

function save(list: readonly ClosedTab[]) {
  try { localStorage.setItem(RECENTLY_CLOSED_KEY, JSON.stringify(list.slice(0, RECENTLY_CLOSED_MAX))) } catch { /* not kept */ }
  try { window.dispatchEvent(new Event(RECENTLY_CLOSED_EVENT)) } catch { /* no window */ }
}

/**
 * `entries` merged into `list`, each session once (the new entry wins),
 * ordered by when it closed, newest first, capped. Sorted rather than put in
 * front: a session that ended unexpectedly is recorded when the app notices,
 * with the time it ended, and must not sit above tabs closed after it
 * (owner, 2026-11-27: "in Recently closed, at the top, by the time they were
 * closed", translated). Pure; equal times keep the new entries first.
 */
export function withClosed(list: readonly ClosedTab[], entries: readonly ClosedTab[]): ClosedTab[] {
  const ids = new Set(entries.map((e) => e.sessionId))
  const all = [...entries, ...list.filter((e) => !ids.has(e.sessionId))]
  return all
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.closedAt - a.e.closedAt || a.i - b.i)
    .map((x) => x.e)
    .slice(0, RECENTLY_CLOSED_MAX)
}

/** Keeps the closed tabs at the front of the stored list. */
export function recordClosed(entries: readonly ClosedTab[]): void {
  if (entries.length === 0) return
  save(withClosed(loadRecentlyClosed(), entries))
}

/** Drops a session from the list: it was reopened. */
export function forgetClosed(sessionId: string): void {
  const list = loadRecentlyClosed()
  if (!list.some((e) => e.sessionId === sessionId)) return
  save(list.filter((e) => e.sessionId !== sessionId))
}

/**
 * What closing `tab` (or only its pane `paneId`) puts on the list: each agent
 * conversation in it — a session's or a watched session's pane — never a
 * shell, a file or a page. `title` is the tab's name, used for a tab of one
 * pane; a split names each pane by its session.
 */
export function closedEntries(
  tab: Tab,
  paneId: string | undefined,
  sessions: ReadonlyMap<string, SessionSummary>,
  title: string,
  name: (s: SessionSummary) => string,
  now = Date.now(),
  at?: number,
): ClosedTab[] {
  const all = leaves(tab.root)
  const closing = paneId ? all.filter((l) => l.id === paneId) : all
  const out: ClosedTab[] = []
  for (const l of closing) {
    if (l.target.kind === 'remote' && l.target.machine && l.target.remote) {
      out.push({
        sessionId: l.target.sessionId,
        title: title || 'session',
        projectId: tab.projectId,
        closedAt: now,
        machine: l.target.machine,
        remote: l.target.remote,
        ...(l.target.machineName ? { machineName: l.target.machineName } : {}),
        ...(at !== undefined && at >= 0 ? { at } : {}),
      })
      continue
    }
    if (l.target.kind !== 'session' && l.target.kind !== 'observe') continue
    const s = sessions.get(l.target.sessionId)
    if (s?.kind === 'shell') continue
    const one = all.length === 1
    out.push({
      sessionId: l.target.sessionId,
      title: (one && title) || (s ? name(s) : '') || title || 'session',
      projectId: tab.projectId,
      ...(s?.cwd ? { cwd: s.cwd } : {}),
      closedAt: now,
      ...(at !== undefined && at >= 0 ? { at } : {}),
    })
  }
  return out
}

/** The rows the sidebar lists: the newest, leaving out any whose session has a tab again. */
export function shownClosed(list: readonly ClosedTab[], open: ReadonlySet<string>, n = RECENTLY_CLOSED_SHOWN): ClosedTab[] {
  return list.filter((e) => !open.has(e.sessionId)).slice(0, n)
}

/**
 * How bringing a closed tab back goes:
 * - `tab`: the session has a tab already; bring it to the front.
 * - `open`: it still runs (or is listed and cannot be continued): open it as
 *   a click on its row does — its terminal, or its conversation read-only.
 * - `resume`: it ended and can be continued: `--resume` under its own id.
 *   `checked` is false when nothing said it can be — the list does not
 *   carry it, or carries it without its `resume` answer yet (the poll right
 *   after it ended): the session's own page is asked first (`GET
 *   /v1/sessions/{id}`), and the plan made again from that, so a session
 *   with no transcript opens read-only rather than a refused start (a 400 on
 *   Linux CI, 2026-10-21).
 * - `page`: the list no longer carries it and its folder is unknown: its
 *   session page, which has *Continue here*.
 */
export type ReopenPlan =
  | { do: 'tab' }
  | { do: 'open'; session: SessionSummary }
  | { do: 'resume'; cwd: string; permissionMode?: string; checked: boolean }
  | { do: 'page' }

export function reopenPlan(entry: ClosedTab, session: SessionSummary | undefined, hasTab: boolean): ReopenPlan {
  if (hasTab) return { do: 'tab' }
  if (session && session.status !== 'ended') return { do: 'open', session }
  // A session the list says cannot be continued here opens read-only, its reason in the pane.
  if (session && session.resume && !session.resume.ok) return { do: 'open', session }
  const cwd = session?.cwd || entry.cwd
  if (!cwd) return session ? { do: 'open', session } : { do: 'page' }
  const mode = session?.resume?.permission_mode
  const checked = !!session?.resume?.ok
  return mode ? { do: 'resume', cwd, permissionMode: mode, checked } : { do: 'resume', cwd, checked }
}

/** A quiet age for a row: "now", "2 min", "1 h", "3 d". */
export function closedAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}
