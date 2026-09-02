// /v1/live WebSocket client + a tiny store. Frames: {type: "event"|"session"|"alert"|"stats"|"hello", data}.
// Reconnects with backoff; exposes connection state so screens can show a
// staleness dot instead of a spinner (no spinner longer than 300ms).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Event, LoopAlert, Session, Stats, TaskFrame } from './api'
import { deviceToken } from './api'

export type Frame =
  | { type: 'hello'; data: { server_time: number } }
  | { type: 'event'; data: Event }
  | { type: 'session'; data: { session: Session; stats: Stats } }
  | { type: 'alert'; data: LoopAlert }
  | { type: 'task'; data: TaskFrame }
  | { type: 'stats'; data: unknown }

export type ConnState = 'connecting' | 'open' | 'closed'

interface LiveState {
  conn: ConnState
  lastFrameAt: number
  /** Monotonic counter bumped on every session/event frame — screens refetch on change. */
  tick: number
  alerts: LoopAlert[]
  lastEvent?: Event
}

type Listener = () => void

class LiveStore {
  private state: LiveState = { conn: 'connecting', lastFrameAt: 0, tick: 0, alerts: [] }
  private listeners = new Set<Listener>()
  private backoff = 500
  private timer: number | null = null
  private started = false
  /** Per-frame subscribers (session detail wants raw events without re-rendering everything). */
  private frameSubs = new Set<(f: Frame) => void>()

  getState = () => this.state
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    this.start()
    return () => { this.listeners.delete(l) }
  }
  onFrame = (fn: (f: Frame) => void) => {
    this.frameSubs.add(fn)
    return () => { this.frameSubs.delete(fn) }
  }

  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  start() {
    if (this.started || typeof WebSocket === 'undefined') return
    this.started = true
    this.connect()
  }

  private connect() {
    // A reconnect can outlive the document that scheduled it: a test unmounts,
    // jsdom is torn down, and the pending timer still fires — reaching for
    // `location` in a window that no longer has one. Harmless in a browser,
    // where the page is going away anyway, but on CI it surfaced as an
    // unhandled error that failed a release whose 478 tests had all passed.
    if (typeof location === 'undefined' || typeof WebSocket === 'undefined') return

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/v1/live`
    this.set({ conn: 'connecting' })
    let ws: WebSocket
    try {
      // A paired device sends its token as a subprotocol. The WebSocket
      // constructor takes a URL and protocols and nothing else — it cannot set
      // a header — and a query parameter would write the token into every
      // access log and browser history entry on the device. On the machine
      // itself there is no token and this is a plain connection.
      const t = deviceToken()
      ws = t ? new WebSocket(url, [`caprock.device.${t}`]) : new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.onopen = () => { this.backoff = 500; this.set({ conn: 'open' }) }
    ws.onmessage = (m) => {
      let f: Frame
      try { f = JSON.parse(String(m.data)) as Frame } catch { return }
      this.handle(f)
    }
    ws.onclose = () => { this.set({ conn: 'closed' }); this.scheduleReconnect() }
    ws.onerror = () => { ws.close() }
  }

  private scheduleReconnect() {
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => { this.timer = null; this.connect() }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, 10_000)
  }

  handle(f: Frame) {
    const now = Date.now()
    // One throwing subscriber must not starve the others, or stop the state
    // update below: this runs inside ws.onmessage, outside React, so an
    // ErrorBoundary never sees it. Unguarded, a single malformed frame froze
    // the whole dashboard on stale numbers with nothing shown to the user.
    for (const s of this.frameSubs) {
      try {
        s(f)
      } catch (err) {
        console.error('[caprock] live frame subscriber failed', err)
      }
    }
    switch (f.type) {
      case 'alert':
        // One banner per session. A session that loops twice used to produce
        // two identical rows — same tool, same count, same cost — which reads
        // as a rendering bug and makes the strip look untrustworthy. The newest
        // alert replaces the older one for that session.
        this.set({
          lastFrameAt: now,
          alerts: [f.data, ...this.state.alerts.filter((a) => a.session_id !== f.data.session_id)].slice(0, 50),
          tick: this.state.tick + 1,
        })
        break
      case 'event':
        this.set({ lastFrameAt: now, lastEvent: f.data, tick: this.state.tick + 1 })
        break
      case 'session':
        this.set({ lastFrameAt: now, tick: this.state.tick + 1 })
        break
      case 'task':
        // The orchestration graph subscribes per-frame via onFrame for smooth
        // animation; bump tick so snapshot consumers (useApi(api.tasks)) refetch.
        this.set({ lastFrameAt: now, tick: this.state.tick + 1 })
        break
      default:
        this.set({ lastFrameAt: now })
    }
  }

  dismissAlert(sessionId: string) {
    this.set({ alerts: this.state.alerts.filter((a) => a.session_id !== sessionId) })
  }
}

export const live = new LiveStore()

export function useLive(): LiveState {
  return useSyncExternalStore(live.subscribe, live.getState, live.getState)
}

/** Debounced "something changed" signal: returns a number that bumps at most every `ms`. */
export function useLiveTick(ms = 400): number {
  const { tick } = useLive()
  const [debounced, setDebounced] = useDebouncedValue(tick, ms)
  useEffect(() => { setDebounced(tick) }, [tick, setDebounced])
  return debounced
}

function useDebouncedValue<T>(initial: T, ms: number): [T, (v: T) => void] {
  const [v, setV] = useState(initial)
  const timer = useRef<number | null>(null)
  const pending = useRef(initial)
  // The timer outlives the component unless we cancel it: a screen unmounted
  // inside the debounce window would wake up and set state on a component that
  // is gone. Under a test runner that tears the DOM down first, the same timer
  // fires into a world with no `window` and fails the whole run.
  useEffect(() => () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
  }, [])
  const set = useCallback((next: T) => {
    pending.current = next
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => { timer.current = null; setV(pending.current) }, ms)
  }, [ms])
  return [v, set]
}
