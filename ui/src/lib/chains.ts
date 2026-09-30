import type { SessionSummary } from './api'

/**
 * One terminal is one conversation, however many session ids it went through.
 *
 * A `/clear` keeps Claude Code's process and starts a new session id, and a
 * fork from Caprock does too; each used to be its own ended card, so a repo
 * Vova had open in two terminals showed four cards and he opened each to find
 * the one he meant (FB-039). The server links a session to the one it
 * continues only when that is a fact (`parent_session`); this folds each
 * chain into its latest part.
 *
 * Only an ended session is folded, and only into a session that is in the
 * same list: a page or a search that holds the earlier part alone still
 * shows it.
 */
export function foldChains(list: SessionSummary[]): {
  shown: SessionSummary[]
  earlier: Map<string, SessionSummary[]>
} {
  const byId = new Map(list.map((s) => [s.session_id, s]))
  const childOf = new Map<string, string>()
  for (const s of list) {
    const parent = s.parent_session
    if (parent && parent !== s.session_id && byId.get(parent)?.status === 'ended' && !childOf.has(parent)) {
      childOf.set(parent, s.session_id)
    }
  }
  // Follow a folded session up to the part that is shown.
  const head = (id: string): string => {
    const seen = new Set<string>()
    let cur = id
    while (childOf.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = childOf.get(cur)!
    }
    return cur
  }
  const earlier = new Map<string, SessionSummary[]>()
  for (const [parent] of childOf) {
    const h = head(parent)
    if (h === parent) continue
    const arr = earlier.get(h) ?? []
    arr.push(byId.get(parent)!)
    earlier.set(h, arr)
  }
  for (const arr of earlier.values()) arr.sort((a, b) => (b.worked_at || b.last_event_at) - (a.worked_at || a.last_event_at))
  const shown = list.filter((s) => !childOf.has(s.session_id) || head(s.session_id) === s.session_id)
  return { shown, earlier }
}
