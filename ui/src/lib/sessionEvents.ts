/**
 * A session's own model calls and tool calls, held once per session for every
 * panel that reads them (the agent cockpit, the session deck under the
 * terminal). Each reader used to fetch them and follow the live socket on its
 * own; with the cockpit and the deck open on the same session that was two
 * fetches and two listeners for the same list.
 *
 * Fetched filtered (`main=1&kind=…`): a parent whose subagents log hundreds of
 * events an hour had none of its own among its newest 400. Then followed on
 * the live socket, and fetched again after the socket resets. A result is
 * held without its body (cockpit slimToolResult): the panels read only its
 * outcome.
 *
 * When its last reader goes, the entry lingers (still following the socket,
 * a filter on the session id per frame): the LINGER newest unread entries
 * stay, each for at most LINGER_MS, so switching back to a tab seen a moment
 * ago draws its calls at once instead of asking again for 270 KB and drawing
 * "Reading…" meanwhile (measured 2026-11-24, .ai/04-ui.md § The app
 * workspace, *Switching tabs*). Past either limit the entry goes, listener
 * and all.
 */
import { onMemoryReset } from './memoryResets'
import { useCallback, useSyncExternalStore } from 'react'
import { api, type Event } from './api'
import { live } from './live'
import { mergeEvents } from './chat'
import { mainThread, slimToolResult } from './cockpit'
import { coalesce } from './visible'
import { FRAME_BATCH_MS } from './framebatch'

/** How many of the main thread's newest calls and turns are held: enough for the last several turns. */
export const EVENTS_HELD = 400
/** The kinds the tool list, the cost spark and the deck's bars are made of. */
export const MAIN_KINDS = ['tool.pre', 'tool.post', 'turn.assistant'] as const

const EMPTY: readonly Event[] = []

function isMainKind(e: Event): boolean {
  return (MAIN_KINDS as readonly string[]).includes(e.kind) && mainThread(e)
}

interface Entry {
  events: readonly Event[]
  listeners: Set<() => void>
  off: () => void
  /** Bumped per fetch, so an answer to an older one is dropped. */
  gen: number
  /** Readers told of live events at most once per FRAME_BATCH_MS (lib/framebatch). */
  tell: ReturnType<typeof coalesce>
}

const entries = new Map<string, Entry>()

/** How many entries no reader holds are kept, newest first. */
export const LINGER = 6
/** How long an entry no reader holds is kept. */
export const LINGER_MS = 10 * 60_000

interface Idle { at: number; timer: ReturnType<typeof setTimeout> }
/** Entries no reader holds, oldest first (Map order). */
const idle = new Map<string, Idle>()

function drop(id: string) {
  const e = entries.get(id)
  const w = idle.get(id)
  if (w) { clearTimeout(w.timer); idle.delete(id) }
  if (!e) return
  e.off()
  e.tell.cancel()
  entries.delete(id)
}

function park(id: string) {
  const prev = idle.get(id)
  if (prev) clearTimeout(prev.timer)
  idle.delete(id)
  idle.set(id, { at: Date.now(), timer: setTimeout(() => drop(id), LINGER_MS) })
  while (idle.size > LINGER) drop(idle.keys().next().value as string)
}

function unpark(id: string) {
  const w = idle.get(id)
  if (!w) return
  clearTimeout(w.timer)
  idle.delete(id)
}

function publish(e: Entry, next: readonly Event[], now = false) {
  if (next === e.events) return
  e.events = next
  // A fetch's answer at once; live events a batch at a time, so the cockpit
  // and the deck redraw once per batch, not once per tool call.
  e.tell.ask()
  if (now) e.tell.flush()
}

function tellAll(e: Entry) {
  for (const l of [...e.listeners]) l()
}

function load(id: string, e: Entry) {
  const gen = ++e.gen
  api.recentMainEvents(id, MAIN_KINDS, EVENTS_HELD)
    .then((list) => {
      if (entries.get(id) !== e || e.gen !== gen || !Array.isArray(list)) return
      publish(e, mergeEvents(e.events, list.filter(isMainKind).map(slimToolResult)).slice(-EVENTS_HELD), true)
    })
    .catch(() => { /* an older daemon or a gone session: the panels show what the row has */ })
}

function ensure(id: string): Entry {
  let e = entries.get(id)
  if (!e) {
    const entry: Entry = { events: EMPTY, listeners: new Set(), off: () => {}, gen: 0, tell: coalesce(() => tellAll(entry), FRAME_BATCH_MS) }
    entries.set(id, entry)
    entry.off = live.onFrame((f) => {
      if ((f.type === 'event' || f.type === 'event_update') && f.data.session_id === id) {
        if (!isMainKind(f.data)) return
        const next = mergeEvents(entry.events, [slimToolResult(f.data)])
        if (next !== entry.events) publish(entry, next.slice(-EVENTS_HELD))
      } else if (f.type === 'reset' || (f.type === 'hello' && f.data.reset)) {
        load(id, entry)
      }
    })
    load(id, entry)
    e = entry
  }
  return e
}

function subscribe(id: string, cb: () => void): () => void {
  const held = ensure(id)
  unpark(id)
  held.listeners.add(cb)
  return () => {
    held.listeners.delete(cb)
    if (held.listeners.size === 0 && entries.get(id) === held) park(id)
  }
}

/**
 * Starts reading a session's calls before anything shows them — a tab
 * hovered or focused — so its cockpit draws them on the first frame. An
 * entry already held is left alone; a new one is kept as an unread one is.
 */
export function warmSessionEvents(id: string): void {
  if (entries.has(id)) return
  ensure(id)
  park(id)
}

/** The main thread's own calls and turns, kept current from the live socket; shared by every reader of the session. */
export function useSessionEvents(sessionId: string): readonly Event[] {
  const sub = useCallback((cb: () => void) => subscribe(sessionId, cb), [sessionId])
  const snap = useCallback(() => entries.get(sessionId)?.events ?? EMPTY, [sessionId])
  return useSyncExternalStore(sub, snap, snap)
}

/** How many sessions' events are held now: what the tests read to see a closed panel let go. */
export function heldSessions(): number {
  return entries.size
}

/** Drops every entry: for tests. */
export function resetSessionEvents(): void {
  for (const id of [...entries.keys()]) drop(id)
}
onMemoryReset(resetSessionEvents)
