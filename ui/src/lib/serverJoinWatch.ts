/**
 * I already have a server (ADR-109): after **Set up** the user is in a
 * terminal tab, not in Settings, while the server installs. This watch
 * outlives the Settings panel: it reads the key every 2 s until the key is
 * no longer waiting, opens the server's page once it has joined, and keeps
 * what Set up answered so the panel shows it again when the user comes back.
 * One at a time; nothing is stored, and a reload forgets it.
 */
import { joinApi, type JoinKeyState, type ServerSSH } from './machines'
import { navigate } from './router'

export const SERVER_JOIN_POLL_MS = 2000

interface Watch {
  made: ServerSSH
  st: JoinKeyState
}

let current: Watch | null = null
let timer: number | undefined
const listeners = new Set<() => void>()

function emit() { for (const l of listeners) l() }

function live(s: JoinKeyState): boolean {
  return s.state === 'waiting' || s.state === 'joining'
}

function stop() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
}

function tick() {
  joinApi.state().then((s) => {
    if (!current) return
    // A key of the other kind (Add with a key) replaced this one.
    const st: JoinKeyState = s.server || s.state === 'none' ? s : { state: 'none' }
    current = { ...current, st }
    if (!live(st)) {
      stop()
      if (st.state === 'joined' && st.machine?.id) {
        current = null
        navigate({ name: 'machine', id: st.machine.id, joined: true })
      }
    }
    emit()
  }, () => { /* the next read says */ })
}

/** Starts watching the key Set up opened, replacing any earlier watch. */
export function watchServerJoin(made: ServerSSH) {
  stop()
  current = { made, st: made }
  timer = window.setInterval(tick, SERVER_JOIN_POLL_MS)
  emit()
}

/** Ends the watch (Cancel, Close); the caller withdraws the key. */
export function endServerJoin() {
  stop()
  current = null
  emit()
}

export function serverJoin(): Watch | null { return current }

export function onServerJoin(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
