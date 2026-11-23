/**
 * The subagents as one tree inside the cockpit's *Now* (.ai/04-ui.md §
 * Inspector; owner, 2026-11-23, picked from a clickable mockup): a header
 * *Background agents · N* with what they cost and how long they have run,
 * one entry per working subagent, the finished folded into one *N done*
 * entry, and each entry's own subagents nested under it. Pure, so the tree
 * is tested without a DOM; the view (*Rows · Cards*) is kept per viewer.
 *
 * Nesting: `/subagents` names no parent for a subagent (Claude Code does
 * not give its subagents the Agent tool), so the cockpit passes no
 * `parentOf` and the tree is one level deep today. The builder nests
 * whatever a parent is given for, so a daemon that learns one needs no
 * change here.
 */
import { useSyncExternalStore } from 'react'
import type { Subagent, SubagentDone, SubagentsNow } from './api'
import { orderSubagents } from './subagentview'

export interface TreeNode {
  agent_id: string
  started_at: number
  /** Working: the daemon's row for it. */
  a?: Subagent
  /** Finished lately. */
  d?: SubagentDone
  /** Its own subagents, in the order they started. */
  children: TreeNode[]
}

export interface SubagentTree {
  /** The working subagents with no parent among those listed, in the order they started. */
  working: TreeNode[]
  /** The finished with no parent among those listed: what *N done* opens to. */
  done: TreeNode[]
  /** How many finished in the daemon's window: N in *N done* (at least `done.length`). */
  doneCount: number
  /** What the finished cost, when every one is listed and its cost known. */
  doneCost?: number
  /** Every working subagent, nested ones included: N in the header. */
  count: number
  /** What every subagent of the session has cost (the daemon's sum); absent when any is unknown. */
  cost?: number
  /** Unix ms: the earliest start among the working, for the header's time; absent when none works. */
  since?: number
}

type Item = Subagent | SubagentDone

/**
 * The tree from one `/subagents` answer. `seen` keeps each subagent's first
 * seen start (orderSubagents), so no entry moves while the window slides.
 * `parentOf` names an item's parent by agent id; an item whose parent is not
 * listed, or whose parent chain loops, is a root.
 */
export function buildSubagentTree(subs: SubagentsNow, seen: Map<string, number>, parentOf?: (x: Item) => string | undefined): SubagentTree {
  const recent = subs.recent ?? []
  const nodes = new Map<string, TreeNode>()
  for (const a of subs.working) nodes.set(a.agent_id, { agent_id: a.agent_id, started_at: a.started_at, a, children: [] })
  for (const d of recent) if (!nodes.has(d.agent_id)) nodes.set(d.agent_id, { agent_id: d.agent_id, started_at: d.started_at, d, children: [] })

  const parent = (n: TreeNode): string | undefined => {
    const p = parentOf?.((n.a ?? n.d)!)
    return p && p !== n.agent_id && nodes.has(p) ? p : undefined
  }
  // A chain that comes back to where it started makes its node a root.
  const loops = (id: string): boolean => {
    const path = new Set<string>([id])
    let at = parent(nodes.get(id)!)
    while (at) {
      if (path.has(at)) return true
      path.add(at)
      at = parent(nodes.get(at)!)
    }
    return false
  }
  const roots: TreeNode[] = []
  for (const n of orderSubagents([...nodes.values()], seen)) {
    const p = parent(n)
    if (p && !loops(n.agent_id)) nodes.get(p)!.children.push(n)
    else roots.push(n)
  }

  const working = roots.filter((n) => n.a)
  const done = roots.filter((n) => !n.a)
  const doneCount = Math.max(subs.finished, done.length)
  // A sum of some of them would read as all of theirs: only when every one is listed and priced.
  const known = done.length === doneCount && done.every((n) => typeof n.d?.cost_usd === 'number')
  const starts = subs.working.map((a) => seen.get(a.agent_id) ?? a.started_at).filter((t) => t > 0)
  return {
    working,
    done,
    doneCount,
    doneCost: done.length > 0 && known ? done.reduce((s, n) => s + (n.d!.cost_usd ?? 0), 0) : undefined,
    count: subs.working.length,
    cost: typeof subs.cost_usd === 'number' ? subs.cost_usd : undefined,
    since: starts.length > 0 ? Math.min(...starts) : undefined,
  }
}

/** The tool a node's row names: its newest call, `mcp__server__tool` as `server·tool`. */
export function nodeTool(n: TreeNode): string {
  return n.a?.tool?.replace(/^mcp__(.+?)__/, '$1·') ?? ''
}

/** How Now draws its subagents: dense one-line rows, or the cards it always had. */
export type NowView = 'rows' | 'cards'

/** Before a viewer picks: the cards, today's look. */
export const DEFAULT_NOW_VIEW: NowView = 'cards'

export const NOW_VIEW_KEY = 'caprock.app.now-view'

let current: NowView | undefined
const listeners = new Set<() => void>()

export function getNowView(): NowView {
  if (current) return current
  try {
    const s = localStorage.getItem(NOW_VIEW_KEY)
    current = s === 'rows' || s === 'cards' ? s : DEFAULT_NOW_VIEW
  } catch {
    current = DEFAULT_NOW_VIEW
  }
  return current
}

export function setNowView(v: NowView): void {
  current = v
  try {
    localStorage.setItem(NOW_VIEW_KEY, v)
  } catch {
    // Private storage: the choice holds until the window closes.
  }
  for (const fn of listeners) fn()
}

/** For tests: forget what was read, so the next read is from storage. */
export function resetNowViewForTest(): void {
  current = undefined
}

export function useNowView(): NowView {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getNowView,
    getNowView,
  )
}
