/**
 * Terminal protocol v2, the browser's side (.ai/03-contracts.md, "Terminal
 * socket, protocol v2").
 *
 * Version 1 replayed the whole screen on every connect and carried no
 * positions, so a reconnect repainted the terminal (losing what the user had
 * scrolled to) and a keystroke sent into a dying socket was either lost or,
 * after a retry, typed twice. Here every output byte has an offset and every
 * input frame a sequence number: a reconnect asks for what came after the
 * last byte it has, and resends only what the daemon has not acknowledged,
 * which the daemon drops if it was typed already.
 *
 * Kept free of React and xterm so it can be driven by a test: the terminal is
 * reached through the callbacks.
 */

import {
  DEAD_MS, LIVENESS_CHECK_MS, PING_MS, PROBE_MS, RECONNECT_MAX_MS, RECONNECT_MIN_MS, Reconnector, STALL_MS,
  isConnectStuck, isProbeLost, isSilent, isSuspect, reconnectDelay, type LinkPhase, type LinkStatus,
} from './reconnect'

export { DEAD_MS, PING_MS }

export const TERM_V2_PROTOCOL = 'caprock.term.v2'
/** Reconnect backoff (lib/reconnect.ts, shared with /v1/live): from this… */
export const BACKOFF_MIN_MS = RECONNECT_MIN_MS
/** …doubling up to this, with full jitter, forever. */
export const BACKOFF_MAX_MS = RECONNECT_MAX_MS
/** Typed input kept while there is no connection; past it, keys are refused. */
export const OFFLINE_QUEUE_BYTES = 4 * 1024
/** Bytes waiting for xterm to parse past which the socket is let go… */
export const HIGH_WATER = 1024 * 1024
/** …and the level it must drain to before it is picked up again. */
export const LOW_WATER = 256 * 1024

export type TermState = LinkPhase

/** Focus events this close together are one claim on the PTY's size. */
export const FOCUS_DEBOUNCE_MS = 100

/** Said when the daemon closes with 1008 and gives no reason of its own. */
export const REVOKED_REASON = 'ask on the machine Caprock runs on'

export interface TermCallbacks {
  /** Write output to the terminal; call done once it is parsed. */
  write(data: Uint8Array | string, done: () => void): void
  /** Clear the terminal before a full repaint. */
  reset(): void
  state(s: TermState): void
  /** The retry status changed (attempt, next try, down since): for the state indicator. */
  status?(link: LinkStatus): void
  /** The session's program exited with this code. */
  exit?(code: number): void
  /** The socket opened (v1 or v2): the place to tell the daemon the size. */
  open?(): void
  /**
   * The daemon no longer holds the session (its process is gone, e.g. it
   * died with a restart of the background service): the client has stopped
   * retrying and is 'ended'.
   */
  gone?(): void
}

export interface TermOptions {
  /** ws:// or wss:// URL of /v1/agents/{id}/term, without a query. */
  url: string
  /** A paired device's token, sent as its subprotocol. */
  deviceToken?: string | null
  callbacks: TermCallbacks
  /** Injected for tests. */
  random?: () => number
  now?: () => number
  fetch?: typeof fetch
}

/** Sockets in a row that closed without opening before the daemon is asked why. */
export const DIAGNOSE_AFTER = 3
/** The daemon is asked at most this often while the refusals go on. */
export const DIAGNOSE_EVERY_MS = 15_000
/**
 * A session the daemon has said it does not hold, still not held this long
 * after (asked again), is gone: the tab stops retrying. Longer than a
 * permission-mode restart, which starts a new process under the same id.
 */
export const GONE_AFTER_MS = 10_000

/** The terminal socket's HTTP twin: the same route, asked by a plain GET. */
export function diagnosisUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://')
}

/**
 * Why the daemon refuses a terminal socket, from the plain GET's answer
 * (internal/api/ws.go serveTerm), in words with what to do; undefined when
 * the answer says nothing is wrong. `status` 0 is no answer at all.
 */
export function refusalFor(status: number, body = ''): string | undefined {
  const restart = 'Quit Caprock, run `caprock down` in Terminal, then open Caprock again.'
  switch (status) {
    case 0:
      return `Caprock’s background service is not answering. ${restart}`
    case 409:
      return 'This session is no longer running in Caprock: its process ended, or Caprock’s background service restarted without it. Close this tab and resume the session from its list.'
    case 501:
      return `Caprock’s background service found no Claude Code or other agent, so it runs no terminal. ${restart}`
    case 401:
    case 403:
      return body.includes('shells are used') ? 'A shell is used on the machine Caprock runs on.' : 'Caprock’s background service refused this window. Reload the window.'
    case 404:
      return `Caprock’s background service does not have this terminal: it may be an older Caprock. ${restart}`
  }
  if (status >= 200 && status < 300) {
    return `Caprock’s background service accepts this terminal but the connection keeps failing. ${restart}`
  }
  const detail = body.trim().slice(0, 120)
  return `Caprock’s background service refused the terminal (HTTP ${status}${detail ? `: ${detail}` : ''}). ${restart}`
}

interface Pending { seq: number; frame: Uint8Array<ArrayBuffer>; size: number }

/** A random id for this tab's input numbering. */
export function newClientId(random: () => number = Math.random): string {
  const bytes = new Uint8Array(12)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The delay before reconnect attempt `n` (0-based): lib/reconnect's full jitter. */
export function backoff(n: number, random: () => number = Math.random): number {
  return reconnectDelay(n, random)
}

export class TermClient {
  private ws: WebSocket | null = null
  private readonly enc = new TextEncoder()
  private readonly clientId: string
  private readonly random: () => number
  private readonly now: () => number
  private disposed = false
  private ended = false
  /** Offset one past the last output byte this client has; null before any. */
  private pos: number | null = null
  /** A reset is pending: the next binary frame is a snapshot ending at this offset. */
  private snapshotAt: number | null = null
  private wroteAny = false
  /** Version 1 only: the next output is a replay of the screen. */
  private v1Repaint = false
  private lastPing = 0
  private seq = 0
  private pending: Pending[] = []
  private readonly retry: Reconnector
  /** When a woken page pinged an open socket to check it; 0 when no check waits. */
  private probeAt = 0
  private revokedReason: string | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private heard = 0
  /** Bytes handed to the terminal and not yet parsed. */
  private parsing = 0
  /** The socket was let go because the terminal is behind. */
  private drained = true
  /** When the terminal last reported parsing something, or the socket was let go for it. */
  private parsedAt = 0
  private stateNow: TermState = 'connecting'
  /** Let go on purpose while out of sight (the app's hidden tabs); `wake` resumes. */
  private suspended = false
  /** The program exited to be started again under the same id (a
   *  permission-mode restart): the close that follows is reconnected. */
  private restarting = false
  /** Sockets in a row that closed without ever opening: refused, or no daemon. */
  private unopened = 0
  /** Why the daemon refuses, once asked (`diagnose`); cleared by a live link. */
  private refusal: string | undefined
  private diagnosedAt = 0
  private diagnosing = false
  /** When the daemon first said it does not hold this session; 0 when it has not. */
  private goneSince = 0
  /** A claim on the PTY's size (`focus`) waits to be sent: debounced, or until a socket opens. */
  private focusPending = false
  private focusTimer: ReturnType<typeof setTimeout> | undefined
  /** The terminal's size at the latest claim, sent with it. */
  private focusSize: { cols: number; rows: number } | undefined

  constructor(private readonly opts: TermOptions) {
    this.random = opts.random ?? Math.random
    this.now = opts.now ?? Date.now
    this.clientId = newClientId(this.random)
    this.retry = new Reconnector({
      connect: () => this.connect(),
      onChange: () => this.opts.callbacks.status?.(this.link),
      random: this.random,
      now: this.now,
    })
  }

  get state(): TermState { return this.stateNow }
  /** The state with its retry status, for the state indicator. */
  get link(): LinkStatus { return { phase: this.stateNow, ...this.retry.status, reason: this.revokedReason, refusal: this.refusal } }
  /** When anything last arrived from the daemon: "live" means a round trip within DEAD_MS. */
  get heardAt(): number { return this.heard }
  /** The protocol of the open socket, if one is open. */
  get protocol(): 'v1' | 'v2' | undefined {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return undefined
    return this.isV2(ws) ? 'v2' : 'v1'
  }
  /** Bytes typed and not yet acknowledged. */
  get unacked(): number { return this.pending.reduce((n, p) => n + p.size, 0) }

  start(): void { this.connect() }

  /**
   * "Reconnect now", by hand: a new socket at once, whatever the backoff,
   * the flow-control pause or a let-go tab was waiting for. The session and
   * its process are untouched — the new socket resumes from the last byte
   * this client has, as any reconnect does.
   */
  reconnectNow(): void {
    if (this.ended || this.disposed) return
    this.suspended = false
    if (!this.drained) this.unstall()
    this.drop()
    this.retry.retryNow()
  }

  /** Type text into the session. False when it could not even be queued. */
  send(text: string): boolean {
    if (this.ended || this.disposed) return false
    const data = this.enc.encode(text)
    const ws = this.ws
    const open = ws !== null && ws.readyState === WebSocket.OPEN
    if (open && !this.isV2(ws)) {
      // A daemon from before v2: as version 1 did, bytes as they come.
      ws.send(data)
      return true
    }
    if (!open && this.unacked + data.length > OFFLINE_QUEUE_BYTES) return false
    this.seq = (this.seq + 1) >>> 0 || 1
    const frame = new Uint8Array(4 + data.length)
    new DataView(frame.buffer).setUint32(0, this.seq)
    frame.set(data, 4)
    this.pending.push({ seq: this.seq, frame, size: data.length })
    if (open && this.stateNow === 'live') ws.send(frame)
    return true
  }

  resize(cols: number, rows: number): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || cols <= 0 || rows <= 0) return
    if (this.focusPending && this.isV2(ws)) {
      // A claim waiting for this socket goes with its first size: one repaint, not two.
      this.focusPending = false
      this.focusSize = undefined
      ws.send(JSON.stringify({ resize: { cols, rows }, focus: true }))
      return
    }
    ws.send(JSON.stringify({ resize: { cols, rows } }))
  }

  /**
   * The person is looking at this terminal — its window gained focus, its tab
   * came to the front, a click in it: the PTY takes this terminal's size
   * when another one has it (`{"focus":true}`, internal/api/termsize.go).
   * Typing claims it on the daemon's side and needs no call. Bursts (a
   * window's focus and visibility arrive together) are sent once; a claim
   * made while no socket is open goes with the next one's first size. The
   * daemon does nothing when this terminal already has the PTY.
   */
  focus(cols?: number, rows?: number): void {
    if (this.ended || this.disposed) return
    this.focusPending = true
    // The size the terminal has now goes with the claim, so a PTY left at
    // another terminal's size (a detach the daemon never heard of) is put
    // right by looking, not only by this terminal's box changing.
    if (cols && rows && cols > 0 && rows > 0) this.focusSize = { cols, rows }
    if (this.focusTimer !== undefined) return
    this.focusTimer = setTimeout(() => {
      this.focusTimer = undefined
      const ws = this.ws
      if (!this.focusPending || !ws || ws.readyState !== WebSocket.OPEN || !this.isV2(ws)) return
      this.focusPending = false
      const size = this.focusSize
      this.focusSize = undefined
      ws.send(JSON.stringify(size ? { resize: size, focus: true } : { focus: true }))
    }, FOCUS_DEBOUNCE_MS)
  }

  /**
   * This terminal went out of sight — its page was hidden, a phone locked or
   * went to the background, an app tab went behind another: when it has the
   * PTY, the daemon gives it at once to a terminal still in sight
   * (`{"blur":true}`, internal/api/termsize.go), rather than when the socket
   * is finally taken for dead, which for a phone whose browser keeps
   * answering in the background is never. A claim still waiting is dropped.
   */
  blur(): void {
    clearTimeout(this.focusTimer)
    this.focusTimer = undefined
    this.focusPending = false
    this.focusSize = undefined
    if (this.ended || this.disposed) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.isV2(ws)) return
    ws.send(JSON.stringify({ blur: true }))
  }

  /**
   * The page came back (visible, online, restored from the back/forward
   * cache): reconnect now rather than at the end of a backoff, and drop a
   * socket that has been silent too long to trust.
   */
  wake(): void {
    this.suspended = false
    if (this.ended || this.disposed) return
    this.watch()
    if (!this.drained) return // resumed by the terminal's parse callbacks, or by the watchdog
    const ws = this.ws
    const now = this.now()
    if (ws && ws.readyState === WebSocket.OPEN && now - this.heard <= PING_MS + 2_000) {
      // It looks open, but after a network change it may be bound to a
      // route that is gone: it has PROBE_MS to answer, or it is replaced.
      this.probeAt = now
      ws.send(JSON.stringify({ ping: now }))
      return
    }
    // An attempt that has only just started is given its chance.
    if (ws && ws.readyState === WebSocket.CONNECTING && now - this.heard < PROBE_MS) { this.retry.expedite(); return }
    // Silent too long to trust, hung opening over a route that is gone, or
    // no socket at all: a new one now, not at the end of the backoff.
    this.drop()
    this.retry.retryNow()
  }

  /**
   * Let the socket go without reconnecting — a tab out of sight — keeping the
   * offset, so `wake` resumes from the last byte instead of repainting.
   */
  suspend(): void {
    if (this.ended || this.disposed) return
    this.suspended = true
    this.retry.cancel()
    this.unwatch()
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close() }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.focusTimer)
    this.retry.cancel()
    this.unwatch()
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close() }
  }

  /**
   * The watchdog runs from the first connect until the client is disposed,
   * ends or is let go out of sight — with a socket or without one, so a client
   * between sockets is watched too (tick).
   */
  private watch(): void {
    if (this.pingTimer === undefined) this.pingTimer = setInterval(() => this.tick(), LIVENESS_CHECK_MS)
  }

  private unwatch(): void {
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  /**
   * Out of a flow-control pause whose parse callbacks never came: forget the
   * bytes counted as unparsed and fetch from the offset reached. What was
   * handed to the terminal stays handed; nothing is fetched twice.
   */
  private unstall(): void {
    this.parsing = 0
    this.drained = true
  }

  private isV2(ws: WebSocket): boolean { return ws.protocol === TERM_V2_PROTOCOL }

  private setState(s: TermState): void {
    if (s === this.stateNow) return
    this.stateNow = s
    this.opts.callbacks.state(s)
    this.opts.callbacks.status?.(this.link)
  }

  private connect(): void {
    if (this.disposed || this.ended || this.suspended) return
    this.watch()
    const q = new URLSearchParams({ client: this.clientId })
    if (this.pos !== null) q.set('since', String(this.pos))
    const protocols = [TERM_V2_PROTOCOL]
    if (this.opts.deviceToken) protocols.push(`caprock.device.${this.opts.deviceToken}`)
    let ws: WebSocket
    try {
      ws = new WebSocket(`${this.opts.url}?${q}`, protocols)
    } catch {
      // A browser can refuse to even start one (a network stack being
      // replaced under it). Before, this threw out of the retry timer — or
      // out of xterm's parse callback, wedging its write queue — and nothing
      // was ever tried again: "Reconnecting…" for good (Vova, 2026-10-15).
      this.ws = null
      this.setState('reconnecting')
      this.retry.fail()
      this.unopenedClose()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.heard = this.now()
    this.probeAt = 0
    this.v1Repaint = this.wroteAny
    let opened = false
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.heard = this.now()
      opened = true
      this.unopened = 0
      this.goneSince = 0
      if (!this.isV2(ws)) {
        // An older daemon answers with version 1: it replays the screen (so
        // the terminal is cleared before it lands, see output) and takes
        // input as plain bytes, unnumbered.
        for (const p of this.pending) ws.send(p.frame.subarray(4))
        this.pending = []
        this.retry.succeed()
        this.refusal = undefined
        this.setState('live')
      } else if (this.stateNow !== 'connecting') {
        // Open, and the hello with what was missed is on its way.
        this.setState('catching-up')
      }
      this.opts.callbacks.open?.()
    }
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return
      this.heard = this.now()
      if (typeof e.data === 'string') this.control(ws, e.data)
      else this.output(ws, new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.disposed) return
      if (this.restarting) {
        // The new process takes a moment to start; the daemon answers 501
        // until it has, and each failure is retried with the usual backoff.
        this.restarting = false
        this.setState('reconnecting')
        this.retry.fail()
        return
      }
      if (this.ended || e?.code === 1000) {
        this.ended = true
        this.unwatch()
        this.setState('ended')
        return
      }
      if (e?.code === 1008) {
        // The owner took control away from this device; asking again is refused.
        this.ended = true
        this.revokedReason = e.reason || REVOKED_REASON
        this.retry.cancel()
        this.unwatch()
        this.setState('revoked')
        return
      }
      if (!this.drained) return // let go on purpose; picked up when xterm catches up
      // Any other close — 1011 (an input not confirmed as typed, resent from
      // `pending` after the hello), a dead network, a daemon restart — is
      // retried forever.
      this.setState('reconnecting')
      this.retry.fail()
      if (!opened) this.unopenedClose()
    }
  }

  /**
   * A socket closed without ever opening. A browser is never told why an
   * upgrade failed, so after DIAGNOSE_AFTER in a row the daemon is asked by
   * a plain GET on the same route (internal/api/ws.go), at most every
   * DIAGNOSE_EVERY_MS, and the answer is shown with what to do. Before,
   * a session the daemon no longer held — after a crash and a restart of
   * the background service — read "Reconnecting…" on every tab, for good.
   * The retries go on: a refusal that ends connects as usual.
   */
  private unopenedClose(): void {
    this.unopened++
    if (this.unopened < DIAGNOSE_AFTER || this.diagnosing) return
    const now = this.now()
    if (this.diagnosedAt && now - this.diagnosedAt < DIAGNOSE_EVERY_MS) return
    const f = this.opts.fetch ?? (typeof fetch === 'function' ? fetch : undefined)
    if (!f) return
    this.diagnosing = true
    this.diagnosedAt = now
    const headers: Record<string, string> = {}
    if (this.opts.deviceToken) headers['X-Caprock-Device'] = this.opts.deviceToken
    const settle = (status: number, body = '') => {
      this.diagnosing = false
      if (this.disposed || this.ended || this.unopened < DIAGNOSE_AFTER) return
      if (status === 409) {
        // The daemon does not hold this session: its process is gone (or
        // restarting under the same id, which takes seconds). Still so
        // GONE_AFTER_MS later, it is over — not a network blip.
        if (!this.goneSince) this.goneSince = this.now()
        else if (this.now() - this.goneSince >= GONE_AFTER_MS) { this.gone(); return }
      } else {
        this.goneSince = 0
      }
      const refusal = refusalFor(status, body)
      if (refusal === this.refusal) return
      this.refusal = refusal
      this.opts.callbacks.status?.(this.link)
    }
    let asked: Promise<Response>
    try {
      asked = f(diagnosisUrl(this.opts.url), { headers, cache: 'no-store' })
    } catch {
      settle(0)
      return
    }
    asked.then(
      async (res) => {
        let body = ''
        try { body = await res.text() } catch { /* the status says enough */ }
        settle(res.status, body)
      },
      () => settle(0),
    )
  }

  /**
   * The session's process is gone: retrying cannot bring it back. The
   * client ends ('ended', with the reason) and says so (`gone`), and the
   * app shows the session's conversation with Continue here in its place.
   */
  private gone(): void {
    this.ended = true
    this.refusal = refusalFor(409)
    this.retry.cancel()
    this.unwatch()
    this.setState('ended')
    this.opts.callbacks.status?.(this.link)
    this.opts.callbacks.gone?.()
  }

  private tick(): void {
    if (this.disposed || this.ended || this.suspended) return
    const now = this.now()
    const ws = this.ws
    if (!ws) {
      if (!this.drained) {
        // Paused for the terminal's backlog: resumed by its parse callbacks,
        // or here once they have been silent for STALL_MS.
        if (now - this.parsedAt > STALL_MS) { this.unstall(); this.connect() }
        return
      }
      // Between sockets: a retry must be on its way, and on time.
      if (this.stateNow !== 'reconnecting') this.setState('reconnecting')
      this.retry.ensure(now)
      return
    }
    // A socket that has said nothing for DEAD_MS — or never finished
    // opening — is dead, whatever the browser thinks; so is one that did not
    // answer the ping a wake sent.
    if (isSilent(this.heard, now) || isConnectStuck(ws.readyState, this.heard, now)) { this.drop(); return }
    if (isProbeLost(this.probeAt, this.heard, now)) { this.drop(); this.retry.retryNow(); return }
    if (this.heard > this.probeAt) this.probeAt = 0
    if (ws.readyState !== WebSocket.OPEN || !this.isV2(ws)) return
    // Long silent: this ping must be answered within PROBE_MS (half-open).
    const suspect = isSuspect(this.heard, this.probeAt, now)
    if (suspect || this.now() - this.lastPing >= PING_MS) {
      this.lastPing = this.now()
      if (suspect) this.probeAt = this.lastPing
      ws.send(JSON.stringify({ ping: this.lastPing }))
    }
  }

  /** Close the socket and reconnect as for any other drop. */
  private drop(): void {
    const ws = this.ws
    if (!ws) return
    const onclose = ws.onclose
    ws.onclose = null
    ws.close()
    onclose?.call(ws, { code: 4001 } as CloseEvent)
  }

  private control(ws: WebSocket, text: string): void {
    if (!this.isV2(ws)) {
      // Version 1 has no control frames to the client; text is output.
      this.output(ws, text)
      return
    }
    let m: Record<string, unknown>
    try { m = JSON.parse(text) as Record<string, unknown> } catch { return }
    const hello = m.hello as { offset: number; reset: boolean; ack: number } | undefined
    if (hello) {
      if (hello.reset) this.snapshotAt = hello.offset
      else this.pos = hello.offset
      this.acked(hello.ack)
      // Whatever is still unacknowledged was not typed: send it again. The
      // daemon drops anything it already applied.
      for (const p of this.pending) ws.send(p.frame)
      this.retry.succeed()
      this.refusal = undefined
      this.setState('live')
      return
    }
    if (typeof m.ack === 'number') { this.acked(m.ack); return }
    if (m.ping !== undefined) { ws.send(JSON.stringify({ pong: m.ping })); return }
    const reset = m.reset as { offset: number } | undefined
    if (reset) { this.snapshotAt = reset.offset; return }
    const exit = m.exit as { code: number; restart?: number } | undefined
    if (exit?.restart) {
      // A new process, a new ring: the next connect asks for all of it.
      this.restarting = true
      this.pos = null
      return
    }
    if (exit) {
      this.ended = true
      this.opts.callbacks.exit?.(exit.code)
    }
  }

  private acked(seq: number): void {
    if (!seq) return
    this.pending = this.pending.filter((p) => p.seq > seq)
  }

  private output(ws: WebSocket, data: Uint8Array | string): void {
    if (typeof data === 'string' || !this.isV2(ws)) {
      if (this.v1Repaint) { this.opts.callbacks.reset(); this.v1Repaint = false }
      this.emit(data)
      return
    }
    if (data.length < 8) return
    const offset = Number(new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0))
    const body = data.subarray(8)
    if (this.snapshotAt !== null) {
      // A full repaint. Cleared first only when something is on screen, so
      // a first connect keeps nothing to lose and a resume never clears.
      if (this.wroteAny) this.opts.callbacks.reset()
      this.pos = this.snapshotAt
      this.snapshotAt = null
      this.emit(body)
      return
    }
    const pos = this.pos ?? offset
    if (offset > pos) {
      // A hole the daemon should never leave; ask again from where we are.
      this.drop()
      return
    }
    const skip = pos - offset
    if (skip < body.length) this.emit(body.subarray(skip))
    this.pos = Math.max(pos, offset + body.length)
  }

  private emit(data: Uint8Array | string): void {
    const n = data.length
    if (n === 0) return
    this.wroteAny = true
    this.parsing += n
    this.opts.callbacks.write(data, () => {
      this.parsing = Math.max(0, this.parsing - n)
      this.parsedAt = this.now()
      if (!this.drained && this.parsing <= LOW_WATER) {
        this.drained = true
        this.connect()
      }
    })
    if (this.drained && this.parsing > HIGH_WATER && this.ws && this.isV2(this.ws)) {
      // The terminal cannot parse as fast as the session prints. Stop
      // reading, let it catch up, then resume from the offset it reached.
      this.drained = false
      this.parsedAt = this.now()
      const ws = this.ws
      this.ws = null
      ws.onclose = null
      ws.onmessage = null
      ws.close()
      // Not live while the socket is let go: what was printed meanwhile is
      // fetched once the terminal has caught up.
      this.setState('catching-up')
    }
  }
}
