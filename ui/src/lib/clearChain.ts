import type { SessionSummary } from './api'
import { leaves, type Tab, type TabTarget } from './tabs'

/**
 * An open tab follows its conversation through a `/clear` (.ai/04-ui.md
 * § One card per conversation).
 *
 * A `/clear` keeps Claude Code's process and starts a new session id; the
 * server links the new one to the old (`parent_session`) and ends the old
 * one. A fork Caprock started is linked the same way but runs in a process
 * of its own, so a link counts here only when both ends share a known pid —
 * the fact the server itself linked a /clear by. A fork never takes the
 * original's tab, whether the original is still running or not.
 */
type Lookup = ReadonlyMap<string, Pick<SessionSummary, 'session_id' | 'parent_session' | 'pid' | 'started_at'>>

/** Bounds every walk: a cycle cannot be stored, but a bound costs nothing. */
const MAX_LINKS = 64

function sameProcess(child: { pid?: number } | undefined, parent: { pid?: number } | undefined): boolean {
  return !!child?.pid && child.pid > 0 && child.pid === parent?.pid
}

/**
 * The newest session that continues `id` in the same process — after one
 * /clear or several — or undefined when nothing does.
 */
export function clearSuccessor(id: string, sessions: Lookup): string | undefined {
  const children = new Map<string, { session_id: string; started_at: number }>()
  for (const s of sessions.values()) {
    const p = s.parent_session
    if (!p || p === s.session_id || !sameProcess(s, sessions.get(p))) continue
    const have = children.get(p)
    if (!have || s.started_at > have.started_at) children.set(p, s)
  }
  let cur = id
  let found: string | undefined
  for (let i = 0; i < MAX_LINKS; i++) {
    const next = children.get(cur)
    if (!next || next.session_id === id) break
    found = cur = next.session_id
  }
  return found
}

/**
 * The sessions `id` continues in the same process, oldest first: what a
 * /clear wiped from the model's context, still worth reading above it.
 */
export function clearedParts(id: string, sessions: Lookup): string[] {
  const out: string[] = []
  let cur = sessions.get(id)
  for (let i = 0; i < MAX_LINKS && cur; i++) {
    const p = cur.parent_session
    if (!p || p === id || out.includes(p)) break
    const parent = sessions.get(p)
    if (!sameProcess(cur, parent)) break
    out.unshift(p)
    cur = parent
  }
  return out
}

/**
 * The panes to move on: each session or watched-session pane whose
 * conversation a /clear carried on under another id, paired with that id.
 * A session already shown in a pane of its own stays where it is.
 */
export function clearMoves(tabs: readonly Tab[], sessions: Lookup): { from: string; target: TabTarget }[] {
  const open = new Set(tabs.flatMap((t) => leaves(t.root).map((l) => l.target.sessionId)))
  const out: { from: string; target: TabTarget }[] = []
  for (const t of tabs) {
    for (const l of leaves(t.root)) {
      if (l.target.kind !== 'session' && l.target.kind !== 'observe') continue
      const next = clearSuccessor(l.target.sessionId, sessions)
      if (!next || open.has(next)) continue
      open.add(next)
      out.push({ from: l.target.sessionId, target: { ...l.target, sessionId: next } })
    }
  }
  return out
}
