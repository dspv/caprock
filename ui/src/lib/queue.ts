/**
 * The message queue of a session Caprock started (ADR-053): what the chat
 * field sent while the agent was working, held by the daemon and typed in
 * when the turn ends, one per turn. The daemon keeps it, so the phone and
 * the Mac show one queue; every change reaches each open page as a `queue`
 * frame, and the list is read again after a reconnect.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type QueueView, type QueuedMessage, type QueueWaiting } from './api'
import { live, useLiveConn } from './live'

export interface QueueState {
  messages: QueuedMessage[]
  waiting: QueueWaiting
}

const EMPTY: QueueState = { messages: [], waiting: '' }

function fromView(v: QueueView): QueueState {
  return { messages: v.messages ?? [], waiting: v.waiting ?? '' }
}

/** What a waiting bubble waits for, said under it. */
export function waitingLabel(w: QueueWaiting): string {
  switch (w) {
    case 'turn': return 'Sends when Claude finishes'
    case 'permission': return 'Waiting: a permission prompt is on the screen; answer it first'
    case 'question': return 'Waiting: the agent asked a question; answer it in the terminal'
    default: return 'The turn ended without a reply; use Send now'
  }
}

/** The session's queue, kept current from the live socket; `apply` takes an answer that carries it. */
export function useQueue(sessionId: string, enabled = true): QueueState & { apply: (v: QueueView) => void } {
  const [state, setState] = useState<QueueState>(EMPTY)
  const apply = useCallback((v: QueueView) => {
    if (v.session_id === sessionId) setState(fromView(v))
  }, [sessionId])
  const load = useCallback(() => {
    if (!enabled) return
    api.queue(sessionId).then(apply).catch(() => { /* no queue here: nothing to show */ })
  }, [sessionId, enabled, apply])
  useEffect(() => {
    setState(EMPTY)
    load()
  }, [load])
  useEffect(() => {
    if (!enabled) return
    return live.onFrame((f) => {
      if (f.type === 'queue') apply(f.data)
      else if (f.type === 'reset') load()
    })
  }, [enabled, apply, load])
  // Back from a dropped connection: what changed meanwhile came as frames
  // this page never saw.
  const conn = useLiveConn()
  useEffect(() => {
    if (conn === 'open') load()
  }, [conn, load])
  return { ...state, apply }
}
