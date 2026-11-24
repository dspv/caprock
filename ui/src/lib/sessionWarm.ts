/**
 * What the inspector reads first for a session, kept in this window's memory
 * and read ahead when the pointer or the keyboard reaches its tab (.ai/04-ui.md
 * § The app workspace, *Switching tabs*).
 *
 * Measured 2026-11-24 on the e2e stand: of the 17 reads a tab switch made,
 * the working tree (`/diff`, `git status` and `git diff` in the checkout) was
 * the slowest at 160–200 ms — far longer on a big checkout — and the main
 * thread's calls (`/events`, 270 KB) and the call series (`/calls`, 95 KB)
 * the largest. Each is drawn from here on the first frame of a session shown
 * again, and read again behind it; the tab's hover starts them early.
 *
 * Small on purpose: the last answer per session, the newest KEPT sessions,
 * nothing written to storage (they are about now, lib/swr's rule).
 */
import { onMemoryReset } from './memoryResets'
import { api, type DiffResult } from './api'
import { callsFromSeries, type CallPoint } from './scrub'
import { warmSessionEvents } from './sessionEvents'

/** How many sessions' answers are kept, newest first. */
export const KEPT = 8
/** A hover within this long of the last read asks nothing. */
export const WARM_FRESH_MS = 15_000

class Lru<T> {
  private m = new Map<string, { v: T; at: number }>()
  get(id: string): T | undefined { return this.m.get(id)?.v }
  age(id: string): number { const e = this.m.get(id); return e ? Date.now() - e.at : Infinity }
  set(id: string, v: T) {
    this.m.delete(id)
    this.m.set(id, { v, at: Date.now() })
    while (this.m.size > KEPT) this.m.delete(this.m.keys().next().value as string)
  }
  clear() { this.m.clear() }
}

export interface SessionCalls { id: string; calls?: CallPoint[] }

const diffs = new Lru<DiffResult>()
const calls = new Lru<SessionCalls>()
const reading = new Set<string>()

export const keptDiff = (id: string): DiffResult | undefined => diffs.get(id)
export const keepDiff = (id: string, d: DiffResult): void => diffs.set(id, d)
export const keptCalls = (id: string): SessionCalls | undefined => calls.get(id)
export const keepCalls = (v: SessionCalls): void => calls.set(v.id, v)

/** Reads a session's call series, keeping it; the answer either way. */
export async function readCalls(id: string): Promise<SessionCalls> {
  const list = await api.sessionCalls(id)
  const got = { id, calls: Array.isArray(list) ? callsFromSeries(list) : undefined }
  if (got.calls) keepCalls(got)
  return got
}

/**
 * Reads ahead what a session's inspector draws first: its calls (held and
 * followed, lib/sessionEvents), its working tree and its call series. A read
 * under way or answered within WARM_FRESH_MS is not asked again. `agent`
 * false (a shell) reads its working tree alone.
 */
export function warmSession(id: string, agent = true): void {
  if (agent) warmSessionEvents(id)
  const go = (what: string, age: number, read: () => Promise<unknown>) => {
    const k = `${what}:${id}`
    if (reading.has(k) || age < WARM_FRESH_MS) return
    reading.add(k)
    read().catch(() => { /* the inspector reads it itself */ }).finally(() => reading.delete(k))
  }
  go('diff', diffs.age(id), () => api.diff(id).then((d) => keepDiff(id, d)))
  if (agent) go('calls', calls.age(id), () => readCalls(id))
}

/** Forgets every kept answer: for tests. */
export function resetSessionWarm(): void {
  diffs.clear()
  calls.clear()
  reading.clear()
}
onMemoryReset(resetSessionWarm)
