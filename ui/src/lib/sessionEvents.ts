/**
 * A session's own model calls and tool calls, held once per session for every
 * panel that reads them (the agent cockpit, the session deck under the
 * terminal). Each reader used to fetch them and follow the live socket on its
 * own; with the cockpit and the deck open on the same session that was two
 * fetches and two listeners for the same list.
 *
 * Fetched filtered (`main=1&kind=…`): a parent whose subagents log hundreds of
 * events an hour had none of its own among its newest 400. Then followed on
 * the live socket, and fetched again after the socket resets. The entry goes
 * — listener and all — when its last reader does, so a closed deck and a
 * closed inspector cost nothing.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { api, type Event } from './api'
import { live } from './live'
import { mergeEvents } from './chat'
import { mainThread } from './cockpit'
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
      publish(e, mergeEvents(e.events, list.filter(isMainKind)).slice(-EVENTS_HELD), true)
    })
    .catch(() => { /* an older daemon or a gone session: the panels show what the row has */ })
}

function subscribe(id: string, cb: () => void): () => void {
  let e = entries.get(id)
  if (!e) {
    const entry: Entry = { events: EMPTY, listeners: new Set(), off: () => {}, gen: 0, tell: coalesce(() => tellAll(entry), FRAME_BATCH_MS) }
    entries.set(id, entry)
    entry.off = live.onFrame((f) => {
      if (f.type === 'event' && f.data.session_id === id) {
        if (!isMainKind(f.data)) return
        const next = mergeEvents(entry.events, [f.data])
        if (next !== entry.events) publish(entry, next.slice(-EVENTS_HELD))
      } else if (f.type === 'reset' || (f.type === 'hello' && f.data.reset)) {
        load(id, entry)
      }
    })
    load(id, entry)
    e = entry
  }
  const held = e
  held.listeners.add(cb)
  return () => {
    held.listeners.delete(cb)
    if (held.listeners.size === 0 && entries.get(id) === held) {
      held.off()
      held.tell.cancel()
      entries.delete(id)
    }
  }
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
