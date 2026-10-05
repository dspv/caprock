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

export const TERM_V2_PROTOCOL = 'caprock.term.v2'
/** How often the client says it is alive. */
export const PING_MS = 10_000
/** Silence after which the socket is taken for dead. */
export const DEAD_MS = 25_000
/** Reconnect backoff: from this… */
export const BACKOFF_MIN_MS = 250
/** …doubling up to this, with jitter, forever. */
export const BACKOFF_MAX_MS = 5_000
/** Typed input kept while there is no connection; past it, keys are refused. */
export const OFFLINE_QUEUE_BYTES = 4 * 1024
/** Bytes waiting for xterm to parse past which the socket is let go… */
export const HIGH_WATER = 1024 * 1024
/** …and the level it must drain to before it is picked up again. */
export const LOW_WATER = 256 * 1024

export type TermState = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'revoked'

export interface TermCallbacks {
  /** Write output to the terminal; call done once it is parsed. */
  write(data: Uint8Array | string, done: () => void): void
  /** Clear the terminal before a full repaint. */
  reset(): void
  state(s: TermState): void
  /** The session's program exited with this code. */
  exit?(code: number): void
  /** The socket opened (v1 or v2): the place to tell the daemon the size. */
  open?(): void
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
}

interface Pending { seq: number; frame: Uint8Array<ArrayBuffer>; size: number }

/** A random id for this tab's input numbering. */
export function newClientId(random: () => number = Math.random): string {
  const bytes = new Uint8Array(12)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The delay before reconnect attempt `n` (0-based): doubling, capped, jittered. */
export function backoff(n: number, random: () => number = Math.random): number {
  const ceil = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(n, 16))
  return Math.round(ceil / 2 + random() * (ceil / 2))
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
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private heard = 0
  /** Bytes handed to the terminal and not yet parsed. */
  private parsing = 0
  /** The socket was let go because the terminal is behind. */
  private drained = true
  private stateNow: TermState = 'connecting'
  /** Let go on purpose while out of sight (the app's hidden tabs); `wake` resumes. */
  private suspended = false

  constructor(private readonly opts: TermOptions) {
    this.random = opts.random ?? Math.random
    this.now = opts.now ?? Date.now
    this.clientId = newClientId(this.random)
  }

  get state(): TermState { return this.stateNow }
  /** The protocol of the open socket, if one is open. */
  get protocol(): 'v1' | 'v2' | undefined {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return undefined
    return this.isV2(ws) ? 'v2' : 'v1'
  }
  /** Bytes typed and not yet acknowledged. */
  get unacked(): number { return this.pending.reduce((n, p) => n + p.size, 0) }

  start(): void { this.connect() }

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
    ws.send(JSON.stringify({ resize: { cols, rows } }))
  }

  /**
   * The page came back (visible, online, restored from the back/forward
   * cache): reconnect now rather than at the end of a backoff, and drop a
   * socket that has been silent too long to trust.
   */
  wake(): void {
    this.suspended = false
    if (this.ended || this.disposed || !this.drained) return
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (this.now() - this.heard > PING_MS + 2_000) this.drop()
      else ws.send(JSON.stringify({ ping: this.now() }))
      return
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) return
    clearTimeout(this.retryTimer)
    this.connect()
  }

  /**
   * Let the socket go without reconnecting — a tab out of sight — keeping the
   * offset, so `wake` resumes from the last byte instead of repainting.
   */
  suspend(): void {
    if (this.ended || this.disposed) return
    this.suspended = true
    clearTimeout(this.retryTimer)
    clearInterval(this.pingTimer)
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close() }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.retryTimer)
    clearInterval(this.pingTimer)
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close() }
  }

  private isV2(ws: WebSocket): boolean { return ws.protocol === TERM_V2_PROTOCOL }

  private setState(s: TermState): void {
    if (s === this.stateNow) return
    this.stateNow = s
    this.opts.callbacks.state(s)
  }

  private connect(): void {
    if (this.disposed || this.ended || this.suspended) return
    const q = new URLSearchParams({ client: this.clientId })
    if (this.pos !== null) q.set('since', String(this.pos))
    const protocols = [TERM_V2_PROTOCOL]
    if (this.opts.deviceToken) protocols.push(`caprock.device.${this.opts.deviceToken}`)
    const ws = new WebSocket(`${this.opts.url}?${q}`, protocols)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.heard = this.now()
    this.v1Repaint = this.wroteAny
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.heard = this.now()
      this.attempt = 0
      if (!this.isV2(ws)) {
        // An older daemon answers with version 1: it replays the screen (so
        // the terminal is cleared before it lands, see output) and takes
        // input as plain bytes, unnumbered.
        for (const p of this.pending) ws.send(p.frame.subarray(4))
        this.pending = []
        this.setState('live')
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
      clearInterval(this.pingTimer)
      if (this.disposed) return
      if (this.ended || e?.code === 1000) {
        this.ended = true
        this.setState('ended')
        return
      }
      if (e?.code === 1008) {
        // The owner took control away from this device; asking again is refused.
        this.ended = true
        this.setState('revoked')
        return
      }
      if (!this.drained) return // let go on purpose; picked up when xterm catches up
      this.setState('reconnecting')
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => this.connect(), backoff(this.attempt++, this.random))
    }
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.tick(), PING_MS / 2)
  }

  private tick(): void {
    const ws = this.ws
    if (!ws) return
    // A socket that has said nothing for DEAD_MS — or never finished
    // opening — is dead, whatever the browser thinks.
    if (this.now() - this.heard > DEAD_MS) { this.drop(); return }
    if (ws.readyState === WebSocket.OPEN && this.isV2(ws) && this.now() - this.lastPing >= PING_MS) {
      this.lastPing = this.now()
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
      this.setState('live')
      return
    }
    if (typeof m.ack === 'number') { this.acked(m.ack); return }
    if (m.ping !== undefined) { ws.send(JSON.stringify({ pong: m.ping })); return }
    const reset = m.reset as { offset: number } | undefined
    if (reset) { this.snapshotAt = reset.offset; return }
    const exit = m.exit as { code: number } | undefined
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
      this.parsing -= n
      if (!this.drained && this.parsing <= LOW_WATER) {
        this.drained = true
        this.connect()
      }
    })
    if (this.drained && this.parsing > HIGH_WATER && this.ws && this.isV2(this.ws)) {
      // The terminal cannot parse as fast as the session prints. Stop
      // reading, let it catch up, then resume from the offset it reached.
      this.drained = false
      const ws = this.ws
      this.ws = null
      ws.onclose = null
      ws.onmessage = null
      ws.close()
      clearInterval(this.pingTimer)
    }
  }
}
