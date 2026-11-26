/**
 * A start that ends at once is never silent (#1086). The owner started two
 * agents on a linked Windows PC in Bypass: each ended about 8 s later, on
 * Claude Code's own one-time warning, with no turn and nothing said — the
 * tab of a session on another computer has no early-exit panel of its own.
 *
 * After New agent starts a session on another computer, `watchStart` asks
 * that computer's `GET /v1/agents/<sid>/exit` every couple of seconds for a
 * little longer than the daemon's early-exit window (internal/agents
 * EarlyExit, 15 s). While the session runs it answers 409 (or 404 before the
 * exit is recorded); once it reports an exit marked `early`, the exit is
 * announced to StartExitToast with its code and the last lines it printed.
 * An exit that is not early — somebody typed into it and closed it — is not.
 */
import type { AgentExit } from './api'
import { machineBase } from './machinepage'

/** How long a start is watched: the daemon's 15 s window, and some slack. */
export const START_WATCH_MS = 20_000
/** How often the exit is asked for meanwhile. */
export const START_WATCH_EVERY_MS = 2_000

/** A session that ended at once, as announced. */
export interface StartExit {
  /** The computer it ran on; '' for this one. */
  machine: string
  /** That computer's name, for the words. */
  name: string
  sessionId: string
  report: AgentExit
}

type Listener = (e: StartExit) => void
const listeners = new Set<Listener>()

/** Hears every start that ended at once; returns the unsubscribe. */
export function onStartExit(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Passes an early exit to every listener. */
export function announceStartExit(e: StartExit): void {
  for (const fn of listeners) fn(e)
}

/**
 * Watches a just-started session for an exit in its first seconds. Returns
 * a stop function; it also stops by itself on the first exit it reads, on
 * an answer other than "still running" or "not recorded yet", and after
 * START_WATCH_MS.
 */
export function watchStart(
  { machine, name, sessionId }: { machine: string; name: string; sessionId: string },
  opts: { fetch?: typeof fetch; every?: number; within?: number } = {},
): () => void {
  const get = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const every = opts.every ?? START_WATCH_EVERY_MS
  const until = Date.now() + (opts.within ?? START_WATCH_MS)
  const url = `${machine ? machineBase(machine) : ''}/v1/agents/${encodeURIComponent(sessionId)}/exit`
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
  const tick = async () => {
    if (stopped) return
    let again = true
    try {
      const res = await get(url, { headers: { Accept: 'application/json' } })
      if (res.ok) {
        again = false
        const report = (await res.json()) as AgentExit
        if (!stopped && report.early) announceStartExit({ machine, name, sessionId, report })
      } else if (res.status !== 409 && res.status !== 404) {
        // Not "running" and not "not yet": nothing more to learn here. A
        // link that is down for a moment is a 5xx, and is asked again.
        again = res.status >= 500
      }
    } catch {
      // The way there blinked: ask again.
    }
    if (stopped || !again || Date.now() + every > until) { stop(); return }
    timer = setTimeout(() => { void tick() }, every)
  }
  timer = setTimeout(() => { void tick() }, every)
  return stop
}
