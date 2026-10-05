// /v1/live WebSocket client + a tiny store. Frames: {type: "event"|"session"|"alert"|"stats"|"hello", seq, data}.
// Reconnects with backoff; exposes connection state so screens can show a
// staleness dot instead of a spinner (no spinner longer than 300ms).
// Live replay (.ai/03-contracts.md): every frame carries a seq, a reconnect asks
// for what came after the last one with ?since=, and a "reset" frame (the
// daemon no longer holds them) makes screens refetch. Liveness is protocol v2's:
// a ping every 10 s, and 25 s of silence means the socket is dead.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Event, LoopAlert, Permission, Session, Stats, TaskFrame } from './api'
import { deviceToken } from './api'
import type { OpFrame, ProjectFrame } from './projects'
import { DEAD_MS, PING_MS } from './termv2'

/**
 * A notification (.ai/21-app.md § Notifications), sent by WP-09. It travels in
 * the replay ring like any frame, so one sent while this client was offline
 * arrives after the reconnect.
 */
export interface NotifyFrame {
  id: string
  kind: 'approval' | 'finished' | 'loop' | 'limit' | 'error'
  session_id: string
  project?: string
  title: string
  body: string
  prompt_id?: string
  actions?: string[]
}

export type Frame = (
  | { type: 'hello'; data: { server_time: number; reset?: boolean } }
  | { type: 'event'; data: Event }
  | { type: 'session'; data: { session: Session; stats: Stats } }
  | { type: 'alert'; data: LoopAlert }
  | { type: 'task'; data: TaskFrame }
  | { type: 'stats'; data: unknown }
  | { type: 'permission'; data: { session_id: string; permission: Permission | null } }
  // The app's projects (.ai/21-app.md § Projects): git state, and long operations.
  | { type: 'project'; data: ProjectFrame }
  | { type: 'op'; data: OpFrame }
  // Live replay: the frames after this client's since are gone; refetch.
  | { type: 'reset'; data: { seq: number } }
  | { type: 'notify'; data: NotifyFrame }
) & { seq?: number }

/** Control frames: liveness, never part of the stream a screen reads. */
type ControlFrame = { type: 'ping' | 'pong'; seq?: number; data: number }

export type ConnState = 'connecting' | 'open' | 'closed'

interface LiveState {
  conn: ConnState
  lastFrameAt: number
  /** Monotonic counter bumped on every session/event frame — screens refetch on change. */
  tick: number
  alerts: LoopAlert[]
  /** Notifications received, newest first, one per id (a replay never doubles one). */
  notifications: NotifyFrame[]
  lastEvent?: Event
}

type Listener = () => void

class LiveStore {
  private state: LiveState = { conn: 'connecting', lastFrameAt: 0, tick: 0, alerts: [], notifications: [] }
  private listeners = new Set<Listener>()
  private backoff = 500
  private timer: number | null = null
  private started = false
  /** The seq of the last frame applied; null until the first hello. */
  private lastSeq: number | null = null
  private ws: WebSocket | null = null
  private heard = 0
  private lastPing = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
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
    const since = this.lastSeq === null ? '' : `?since=${this.lastSeq}`
    const url = `${proto}://${location.host}/v1/live${since}`
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
    this.ws = ws
    this.heard = Date.now()
    ws.onopen = () => { this.backoff = 500; this.heard = Date.now(); this.set({ conn: 'open' }) }
    ws.onmessage = (m) => {
      this.heard = Date.now()
      let f: Frame | ControlFrame
      try { f = JSON.parse(String(m.data)) as Frame | ControlFrame } catch { return }
      if (f.type === 'ping' || f.type === 'pong') {
        if (f.type === 'ping') ws.send(JSON.stringify({ pong: (f as ControlFrame).data }))
        return
      }
      this.handle(f as Frame)
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.set({ conn: 'closed' })
      this.scheduleReconnect()
    }
    ws.onerror = () => { ws.close() }
    if (this.pingTimer === null) this.pingTimer = setInterval(() => this.tickLiveness(), PING_MS / 2)
  }

  /** A socket silent for DEAD_MS is dead, whatever the browser thinks. */
  private tickLiveness() {
    const ws = this.ws
    if (!ws) return
    const now = Date.now()
    if (now - this.heard > DEAD_MS) { ws.close(); return }
    if (ws.readyState === WebSocket.OPEN && now - this.lastPing >= PING_MS) {
      this.lastPing = now
      ws.send(JSON.stringify({ ping: now }))
    }
  }

  /**
   * Applies the frame's seq: false for a frame this client already has. A
   * hello or reset states the position outright (a new daemon's numbers may
   * be anywhere); any other frame must be newer than the last one.
   */
  private advance(f: Frame): boolean {
    if (typeof f.seq !== 'number') return true
    if (f.type !== 'hello' && f.type !== 'reset' && this.lastSeq !== null && f.seq <= this.lastSeq) return false
    this.lastSeq = f.seq
    return true
  }

  private scheduleReconnect() {
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => { this.timer = null; this.connect() }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, 10_000)
  }

  handle(f: Frame) {
    if (!this.advance(f)) return
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
      case 'reset':
        // What was missed is gone: every screen refetches on the tick.
        this.set({ lastFrameAt: now, tick: this.state.tick + 1 })
        break
      case 'notify':
        this.set({
          lastFrameAt: now,
          notifications: [f.data, ...this.state.notifications.filter((n) => n.id !== f.data.id)].slice(0, 50),
        })
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

/** The connection state alone: re-renders only when it changes, not on every frame. */
export function useLiveConn(): ConnState {
  const get = () => live.getState().conn
  return useSyncExternalStore(live.subscribe, get, get)
}
