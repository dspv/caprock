// /v1/live WebSocket client + a tiny store. Frames: {type: "event"|"session"|"alert"|"stats"|"hello", seq, data}.
// Reconnects with backoff; exposes connection state so screens can show a
// staleness dot instead of a spinner (no spinner longer than 300ms).
// Live replay (.ai/03-contracts.md): every frame carries a seq, a reconnect asks
// for what came after the last one with ?since=, and a "reset" frame (the
// daemon no longer holds them) makes screens refetch. Liveness is protocol v2's:
// a ping every 10 s, and 25 s of silence means the socket is dead.
// Retries follow lib/reconnect.ts, the policy every socket shares (WP-13).
import { useRef, useSyncExternalStore } from 'react'
import type { Event, LoopAlert, Permission, QueueView, Session, Stats, TaskFrame } from './api'
import { deviceToken } from './api'
import type { OpFrame, ProjectFrame } from './projects'
import type { GitHubFrame } from './github'
import {
  LIVENESS_CHECK_MS, PING_MS, PROBE_MS, Reconnector, isConnectStuck, isProbeLost, isSuspect, isSilent, onNetworkWake,
  type LinkStatus,
} from './reconnect'
import { onPageVisibility, pageHidden } from './visible'

/**
 * While the page is hidden, frames are held and applied together this often
 * (one render for all of them), and at once when the page is shown. A hidden
 * window keeps its state current — the tray's "N waiting" and the Dock badge
 * are drawn from it — without redrawing for every hook event nobody sees.
 */
export const HIDDEN_FLUSH_MS = 2_000

/** Held frames past this many are replaced by a `reset`: screens refetch on showing. */
export const HIDDEN_HELD_MAX = 2_000

/** Frames applied at once even while hidden, with everything held before them:
 *  a notification, a permission prompt (the badge), a loop alert, and the
 *  link's own position (hello, reset). */
const URGENT: ReadonlySet<string> = new Set(['notify', 'permission', 'alert', 'hello', 'reset'])

/**
 * A notification (.ai/21-app.md § Notifications), sent by WP-09. It travels in
 * the replay ring like any frame, so one sent while this client was offline
 * arrives after the reconnect.
 */
export interface NotifyFrame {
  id: string
  kind: 'approval' | 'finished' | 'loop' | 'limit' | 'error' | 'ci' | 'review'
  /** Empty for a GitHub notification (`ci`, `review`), which is about a pull request. */
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
  // An owned session's message queue after any change (ADR-053).
  | { type: 'queue'; data: QueueView }
  // The app's projects (.ai/21-app.md § Projects): git state, and long operations.
  | { type: 'project'; data: ProjectFrame }
  | { type: 'op'; data: OpFrame }
  // Live replay: the frames after this client's since are gone; refetch.
  | { type: 'reset'; data: { seq: number } }
  | { type: 'notify'; data: NotifyFrame }
  // A followed pull request changed, or the GitHub connection did (WP-19).
  | { type: 'github'; data: GitHubFrame }
  // The Inbox changed: an item saved or deleted (03-contracts.md § Inbox).
  | { type: 'inbox'; data: { id: number; deleted: boolean } }
  // Second Brain changed: a memory added, changed or deleted (03-contracts.md § Second Brain).
  | { type: 'brain'; data: { id: number; op: 'added' | 'changed' | 'deleted'; kind?: string; title?: string; auto?: boolean } }
  // An owned session's status moved on input it has not answered with an
  // event yet — Enter at its prompt, a permission menu answered (§ Nudges).
  | { type: 'status'; data: { session_id: string; kind: string; at: number } }
) & { seq?: number }

/**
 * Event kinds that change what a session is waiting on: its turn starting or
 * ending, a dialog, the session itself starting or going. Screens ask for the
 * session again at once on these instead of on the debounced tick — the
 * badge they move is the one a person is watching after acting.
 */
const STATUS_KINDS: ReadonlySet<string> = new Set([
  'turn.user', 'permission.prompt', 'agent.spawn', 'session.end', 'session.continue', 'context.clear',
])

/** What a session waits on after an event, as far as one event says: a dialog, its turn's end, or nothing. */
export type Wait = 'prompt' | 'stop' | undefined

/**
 * Whether an event moves its session's status, and what the session waits on
 * after it. `wait` is what it waited on before, as this client saw. A
 * STATUS_KINDS event or the main thread's Stop moves it; so does the first
 * event after a dialog (the call running — answered in a terminal Caprock
 * does not hold, where no nudge says so) and the first main-thread event
 * after a Stop. A subagent's events after a Stop are background work, the
 * status they leave unchanged.
 */
export function statusStep(e: Pick<Event, 'kind' | 'agent_id'>, wait: Wait): { moves: boolean; wait: Wait } {
  if (e.kind === 'permission.prompt') return { moves: true, wait: 'prompt' }
  if (e.kind === 'agent.stop' && !e.agent_id) return { moves: true, wait: 'stop' }
  if (wait === 'prompt' || (wait === 'stop' && !e.agent_id)) return { moves: true, wait: undefined }
  return { moves: STATUS_KINDS.has(e.kind), wait: e.agent_id ? wait : undefined }
}

/** Control frames: liveness, never part of the stream a screen reads. */
type ControlFrame = { type: 'ping' | 'pong'; seq?: number; data: number }

export type ConnState = 'connecting' | 'open' | 'closed'

interface LiveState {
  conn: ConnState
  /** The connection as the state indicator says it (components/ConnectionState.tsx). */
  link: LinkStatus
  lastFrameAt: number
  /** Monotonic counter bumped on every session/event frame — screens refetch on change. */
  tick: number
  /**
   * Bumped, with `tick`, on a frame that moves a session's status
   * (movesStatus, a `status` frame): the debounced tick then fires at once
   * rather than up to a debounce later.
   */
  statusTick: number
  alerts: LoopAlert[]
  /** Notifications received, newest first, one per id (a replay never doubles one). */
  notifications: NotifyFrame[]
  lastEvent?: Event
}

type Listener = () => void

class LiveStore {
  private state: LiveState = {
    conn: 'connecting',
    link: { phase: 'connecting', attempt: 0, nextAt: null, downSince: null },
    lastFrameAt: 0, tick: 0, statusTick: 0, alerts: [], notifications: [],
  }
  /** What each session waits on after its newest event, as this client saw (statusStep); only waiting ones are kept. */
  private waits = new Map<string, Exclude<Wait, undefined>>()
  private listeners = new Set<Listener>()
  private readonly retry = new Reconnector({
    connect: () => this.connect(),
    onChange: (st) => this.set({ link: { ...this.state.link, ...st } }),
  })
  private started = false
  /** The seq of the last frame applied; null until the first hello. */
  private lastSeq: number | null = null
  private ws: WebSocket | null = null
  private heard = 0
  private lastPing = 0
  /** When a woken page pinged an open socket to check it; 0 when no check waits. */
  private probeAt = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Per-frame subscribers (session detail wants raw events without re-rendering everything). */
  private frameSubs = new Set<(f: Frame) => void>()
  /** Frames received while the page is hidden, not yet applied (HIDDEN_FLUSH_MS). */
  private held: Frame[] = []
  private heldTimer: ReturnType<typeof setTimeout> | null = null

  getState = () => this.state
  /** When anything last arrived from the daemon: "live" means a round trip within DEAD_MS. */
  heardAt = () => this.heard
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    this.start()
    return () => { this.listeners.delete(l) }
  }
  /** Like subscribe, without opening the link: for a watcher that follows
   *  the link the screens open (lib/staleui), and must not open one on a page
   *  that has none, such as an unpaired device's pairing form. */
  observe = (l: Listener) => {
    this.listeners.add(l)
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
    onNetworkWake(() => this.wake())
    onPageVisibility((hidden) => { if (!hidden) this.flushHeld() })
    this.connect()
  }

  /**
   * The page or the network came back: retry now rather than at the end of
   * the backoff, and make an open socket prove it still reaches the daemon.
   */
  wake() {
    const ws = this.ws
    const now = Date.now()
    if (ws && ws.readyState === WebSocket.OPEN && now - this.heard <= PING_MS + 2_000) {
      // It looks open, but after a network change it may be bound to a
      // route that is gone: it has PROBE_MS to answer, or it is replaced.
      this.probeAt = now
      ws.send(JSON.stringify({ ping: now }))
      return
    }
    // An attempt that has only just started is given its chance.
    if (ws && ws.readyState === 0 && now - this.heard < PROBE_MS) { this.retry.expedite(); return }
    this.drop()
    this.retry.retryNow()
  }

  private setPhase(phase: LinkStatus['phase']) {
    if (this.state.link.phase !== phase) this.set({ link: { ...this.state.link, phase } })
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
    this.probeAt = 0
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
      this.retry.fail()
      return
    }
    this.ws = ws
    this.heard = Date.now()
    // Open is not live yet: the hello, and the frames missed meanwhile, follow.
    ws.onopen = () => {
      this.heard = Date.now()
      this.set({ conn: 'open', link: { ...this.state.link, phase: this.state.link.phase === 'connecting' ? 'connecting' : 'catching-up' } })
    }
    ws.onmessage = (m) => {
      this.heard = Date.now()
      let f: Frame | ControlFrame
      try { f = JSON.parse(String(m.data)) as Frame | ControlFrame } catch { return }
      if (f.type === 'ping' || f.type === 'pong') {
        if (f.type === 'ping') ws.send(JSON.stringify({ pong: (f as ControlFrame).data }))
        return
      }
      this.receive(f as Frame)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.set({ conn: 'closed', link: { ...this.state.link, phase: 'reconnecting' } })
      this.retry.fail()
    }
    ws.onerror = () => { ws.close() }
    if (this.pingTimer === null) this.pingTimer = setInterval(() => this.tickLiveness(), LIVENESS_CHECK_MS)
  }

  /** A socket silent for DEAD_MS is dead, whatever the browser thinks. */
  private tickLiveness() {
    const ws = this.ws
    if (!ws) return
    const now = Date.now()
    if (isSilent(this.heard, now) || isConnectStuck(ws.readyState, this.heard, now)) { this.drop(); return }
    if (isProbeLost(this.probeAt, this.heard, now)) { this.drop(); this.retry.retryNow(); return }
    if (this.heard > this.probeAt) this.probeAt = 0
    if (ws.readyState !== WebSocket.OPEN) return
    // Long silent: this ping must be answered within PROBE_MS (half-open).
    const suspect = isSuspect(this.heard, this.probeAt, now)
    if (suspect || now - this.lastPing >= PING_MS) {
      this.lastPing = now
      if (suspect) this.probeAt = now
      ws.send(JSON.stringify({ ping: now }))
    }
  }

  /**
   * Close the socket and reconnect now, without waiting for the browser's
   * close event: on a half-open socket the closing handshake never completes,
   * and the event can come late.
   */
  private drop() {
    const ws = this.ws
    if (!ws) return
    const onclose = ws.onclose
    ws.onclose = null
    ws.onmessage = null
    ws.close()
    onclose?.call(ws, {} as CloseEvent)
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

  /**
   * A frame from the socket: applied now while the page is shown; held while
   * it is hidden, and applied with the others every HIDDEN_FLUSH_MS, at once
   * for an URGENT one, and when the page is shown again.
   */
  receive(f: Frame) {
    if (!pageHidden()) {
      this.flushHeld()
      this.handle(f)
      return
    }
    if (!this.advance(f)) return
    this.held.push(f)
    if (this.held.length > HIDDEN_HELD_MAX) {
      // What a screen keeps from the stream it reads again on a reset; what
      // is urgent stays, in order.
      const seq = f.seq ?? this.lastSeq ?? 0
      this.held = [...this.held.filter((h) => URGENT.has(h.type) && h.type !== 'reset'), { type: 'reset', seq, data: { seq } }]
    }
    if (URGENT.has(f.type)) this.flushHeld()
    else if (this.heldTimer === null) this.heldTimer = setTimeout(() => this.flushHeld(), HIDDEN_FLUSH_MS)
  }

  /** Applies every held frame, in order, in one task (so one render). */
  private flushHeld() {
    if (this.heldTimer !== null) { clearTimeout(this.heldTimer); this.heldTimer = null }
    if (this.held.length === 0) return
    const out = this.held
    this.held = []
    for (const f of out) this.apply(f)
  }

  handle(f: Frame) {
    if (!this.advance(f)) return
    this.apply(f)
  }

  private apply(f: Frame) {
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
      case 'hello':
        // A round trip: live, and the next loss starts from the shortest delay.
        this.retry.succeed()
        this.setPhase('live')
        this.set({ lastFrameAt: now })
        break
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
      case 'event': {
        const e = f.data
        const { moves, wait } = statusStep(e, this.waits.get(e.session_id))
        if (wait) this.waits.set(e.session_id, wait)
        else this.waits.delete(e.session_id)
        this.set({
          lastFrameAt: now, lastEvent: e, tick: this.state.tick + 1,
          ...(moves ? { statusTick: this.state.statusTick + 1 } : {}),
        })
        break
      }
      case 'status':
        this.waits.delete(f.data.session_id)
        this.set({ lastFrameAt: now, tick: this.state.tick + 1, statusTick: this.state.statusTick + 1 })
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

/**
 * The whole live state. Re-renders on EVERY frame — `lastFrameAt` and `tick`
 * move with each one — so a component that wants one field asks for that field
 * (useLiveConn, useLiveLink, useLiveAlerts) or the debounced tick (useLiveTick).
 */
export function useLive(): LiveState {
  return useSyncExternalStore(live.subscribe, live.getState, live.getState)
}

/**
 * Debounced "something changed" signal: returns a number that bumps at most every `ms`.
 *
 * The frames are counted outside React. It used to read the tick through
 * useLive(), which re-rendered the calling component on every frame and only
 * debounced what it returned: the app workspace (useWorkspaceData) redrew its
 * whole tree, nine terminal panes included, about 19 times a second under five
 * hook events a second, while the person typed (bench, 2026-10-09).
 *
 * One timer per debounce, shared by every caller (TickStore): a screen with
 * twenty useApi hooks used to run twenty timers per burst. While the page is
 * hidden it rests — or keeps `hiddenMs` when given — and catches up at once
 * on showing; `paused` holds it still (a popover that is closed).
 */
export function useLiveTick(ms = 400, opts: { hiddenMs?: number; paused?: boolean } = {}): number {
  const store = tickStore(ms, opts.hiddenMs)
  const frozen = useRef<number | null>(null)
  const paused = !!opts.paused
  const get = paused ? () => (frozen.current ??= store.get()) : store.get
  const v = useSyncExternalStore(paused ? noSubscribe : store.subscribe, get, get)
  frozen.current = v
  return v
}

const noSubscribe = () => () => {}

/** The slowest debounce a status frame cuts short (TickStore.schedule): the live screens' paces, not the all-time figures'. */
export const STATUS_NOW_MAX_MS = 2_000

/** The debounced tick for one (ms, hiddenMs): attached to the live store only while someone reads it. */
class TickStore {
  private value = live.getState().tick
  /** The statusTick last taken at once. */
  private status = live.getState().statusTick
  private subs = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private detach: (() => void) | null = null

  constructor(private readonly ms: number, private readonly hiddenMs: number | undefined) {}

  // Unread, it is caught up: the first render of a screen opened after
  // frames came would otherwise see the old value, then the attached one,
  // and ask every question twice.
  get = () => (this.detach ? this.value : (this.value = live.getState().tick))

  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    if (!this.detach) this.attach()
    return () => {
      this.subs.delete(fn)
      if (this.subs.size === 0 && this.detach) {
        this.detach()
        this.detach = null
        this.clear()
      }
    }
  }

  private attach() {
    // Caught up at once: frames may have come while nobody was reading.
    this.value = live.getState().tick
    this.status = live.getState().statusTick
    const offLive = live.subscribe(() => this.schedule())
    const offVis = onPageVisibility((hidden) => {
      if (hidden) {
        if (this.hiddenMs === undefined) this.clear()
        return
      }
      this.clear()
      this.take()
    })
    this.detach = () => { offLive(); offVis() }
  }

  private clear() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private schedule() {
    const st = live.getState()
    const hidden = pageHidden()
    // A frame that moved a session's status is taken now, not a debounce
    // later: the badge it moves is the one a person watches after acting —
    // "waiting for you" a second or two after they had set the agent going
    // (owner, 2026-10-14). A few per turn, so the debounce still holds the
    // stream of tool events. A slow pace (all-time figures) shows no status
    // and keeps its debounce.
    if (st.statusTick !== this.status && !hidden && this.ms <= STATUS_NOW_MAX_MS) {
      this.status = st.statusTick
      this.clear()
      this.take()
      return
    }
    // Only a new tick is worth a timer: most frames (resources, pings'
    // link updates, projects) leave it where it was.
    if (this.timer !== null || st.tick === this.value) return
    if (hidden && this.hiddenMs === undefined) return
    // The timer outlives the readers unless it is cancelled (subscribe's
    // stop): a screen unmounted inside the window would otherwise be set on
    // after it is gone, and under a test runner that tears the DOM down first
    // it fires into a world with no `window` and fails the run.
    this.timer = setTimeout(() => { this.timer = null; this.take() }, hidden ? Math.max(this.ms, this.hiddenMs!) : this.ms)
  }

  private take() {
    const t = live.getState().tick
    this.status = live.getState().statusTick
    if (t === this.value) return
    this.value = t
    for (const fn of [...this.subs]) fn()
  }
}

const tickStores = new Map<string, TickStore>()
function tickStore(ms: number, hiddenMs: number | undefined): TickStore {
  const key = `${ms}:${hiddenMs ?? ''}`
  let s = tickStores.get(key)
  if (!s) tickStores.set(key, (s = new TickStore(ms, hiddenMs)))
  return s
}

/** The connection state alone: re-renders only when it changes, not on every frame. */
export function useLiveConn(): ConnState {
  const get = () => live.getState().conn
  return useSyncExternalStore(live.subscribe, get, get)
}

/** The loop alerts, re-rendering only when they change. */
export function useLiveAlerts(): LoopAlert[] {
  const get = () => live.getState().alerts
  return useSyncExternalStore(live.subscribe, get, get)
}

/** The connection for the state indicator: re-renders only when it changes. */
export function useLiveLink(): LinkStatus {
  const get = () => live.getState().link
  return useSyncExternalStore(live.subscribe, get, get)
}
