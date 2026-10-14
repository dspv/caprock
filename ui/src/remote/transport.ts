/**
 * The phone's channel to one machine, through a relay (ADR-058).
 *
 * One WebSocket to the relay, one Noise session inside it, and many streams
 * inside that: each fetch() is a stream, each WebSocket is a stream. The
 * frame protocol is internal/remote/proto.go's, and the daemon replays every
 * stream onto its own loopback API as a paired device — so the dashboard's
 * code runs unchanged, and so do the daemon's rules about what a phone may do.
 *
 * Installed by boot.ts, only in the build served to phones at the remote
 * page; the dashboard a daemon serves never loads this file.
 */
import { Initiator, MAX_PLAINTEXT, type Session } from './noise'

export const KIND = {
  req: 0x01,
  reqBody: 0x02,
  reqEnd: 0x03,
  res: 0x04,
  resBody: 0x05,
  resEnd: 0x06,
  wsOpen: 0x07,
  wsOpened: 0x08,
  wsText: 0x09,
  wsBinary: 0x0a,
  wsClose: 0x0b,
  cancel: 0x0c,
  wsPart: 0x0d,
} as const

const CHUNK = 60 * 1024
const enc = new TextEncoder()
const dec = new TextDecoder()

export interface Machine {
  /** The machine's id on the relay: its Ed25519 key, base64url. */
  id: string
  /** The X25519 key the handshake pins, base64url. */
  key: string
  relay: string
  name: string
  /** The device token from pairing; '' until paired. */
  token: string
}

export type ChannelState = 'connecting' | 'open' | 'offline' | 'closed'

/**
 * Why the channel is not open, in terms a person can act on:
 * - `machine-offline`: the relay has no live connection from the machine
 *   (asleep, off the internet, Caprock not running, or access turned off).
 * - `no-answer`: the relay took the phone but the machine never answered the
 *   handshake — a machine that went to sleep on an older relay.
 * - `relay-unreachable`: the phone could not reach the relay at all.
 * - `no-internet`: the phone itself is offline.
 * - `lost`: an open channel dropped, or stopped answering.
 * - `wrong-machine`: the reply was not from the key the QR carried.
 * - `removed`: the machine no longer knows this phone's token.
 */
export type Problem = '' | 'machine-offline' | 'no-answer' | 'relay-unreachable' | 'no-internet' | 'lost' | 'wrong-machine' | 'removed'

/** How long an attempt may take, from dialling the relay to the machine's reply. */
export const ATTEMPT_MS = 10_000
/** The waits between automatic retries; the last repeats. */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
/** The channel pings the relay this often while open… */
export const PING_MS = 25_000
/** …and drops a channel that has heard nothing for this long. */
export const SILENT_MS = 60_000
/** With each ping, the machine itself must answer a /healthz within this… */
export const PROBE_MS = 15_000
/** …and within this after the page comes back to the foreground. */
export const WAKE_MS = 5_000

/** Problems that a retry cannot fix: only pairing again can. */
export function needsPairing(p: Problem): boolean {
  return p === 'wrong-machine' || p === 'removed'
}

function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

export function frame(kind: number, id: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + body.length)
  out[0] = kind
  new DataView(out.buffer).setUint32(1, id >>> 0, false)
  out.set(body, 5)
  return out
}

export function parseFrame(b: Uint8Array): { kind: number; id: number; body: Uint8Array } {
  if (b.length < 5) throw new Error('short frame')
  return { kind: b[0]!, id: new DataView(b.buffer, b.byteOffset).getUint32(1, false), body: b.subarray(5) }
}

interface StreamHandler {
  onFrame(kind: number, body: Uint8Array): void
  onDrop(reason: string): void
}

/**
 * A channel to one machine. connect() is idempotent and called by every
 * stream that needs it; a dropped channel fails its open streams (a fetch
 * rejects, a socket closes).
 *
 * It never waits silently. An attempt that has not reached the machine in
 * ATTEMPT_MS is given up with a reason; a channel that stops hearing pongs is
 * dropped; and a channel that is not open tries again by itself, with
 * backoff, until it is — or until only pairing again could help. The owner,
 * 2026-10-14 (translated): "On the phone I now have 'Connecting' and nothing."
 */
export class Channel {
  state: ChannelState = 'closed'
  /** Why the last attempt failed, in words for the bar. */
  reason = ''
  /** Why the last attempt failed, for the screen that says what to do. */
  problem: Problem = ''
  /** Automatic retries since the channel was last open. */
  attempt = 0
  /** When the next automatic retry runs (ms since the epoch), or null. */
  nextAt: number | null = null
  /** Whether this page has had the channel open at least once. */
  everOpen = false
  welcome: { v: number; version: string; name: string } | null = null
  private ws: WebSocket | null = null
  private session: Session | null = null
  private opening: Promise<void> | null = null
  private streams = new Map<number, StreamHandler>()
  private nextId = 1
  private listeners = new Set<(s: ChannelState) => void>()
  private ping: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private heard = 0
  private stopped = false

  constructor(
    readonly machine: Machine,
    private readonly NativeWebSocket: typeof WebSocket = WebSocket,
    private readonly online: () => boolean = () => typeof navigator === 'undefined' || navigator.onLine !== false,
  ) {}

  onState(fn: (s: ChannelState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(s: ChannelState, reason = '', problem: Problem = '') {
    this.state = s
    this.reason = reason
    this.problem = problem
    for (const fn of this.listeners) fn(s)
  }

  connect(): Promise<void> {
    if (this.state === 'open') return Promise.resolve()
    if (this.opening) return this.opening
    if (needsPairing(this.problem)) return Promise.reject(new TypeError(this.reason))
    this.stopped = false
    this.opening = this.open().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  /** Tries now rather than at the next scheduled retry: the Retry button. */
  retryNow(): Promise<void> {
    this.clearRetry()
    if (needsPairing(this.problem)) return Promise.reject(new TypeError(this.reason))
    return this.connect()
  }

  /**
   * The page came back to the foreground, or the network came back. A phone
   * freezes a page in the background, and the socket it left may be dead
   * while it still reads as open: ask the machine, and replace the channel
   * if no answer comes in WAKE_MS. A channel that is not open tries at once.
   */
  wake() {
    if (this.stopped || needsPairing(this.problem)) return
    if (this.state !== 'open') {
      if (!this.opening) void this.retryNow().catch(() => { /* scheduled again */ })
      return
    }
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    this.probe(ws, WAKE_MS)
  }

  private probing: WebSocket | null = null

  /**
   * One round trip to the machine itself, /healthz through the channel, that
   * must come back within ms or the channel is replaced. The relay's pong
   * proves only the relay: a machine asleep behind it left the phone's
   * channel open and every request on it unanswered.
   */
  private probe(ws: WebSocket, ms: number) {
    if (this.probing === ws) return
    this.probing = ws
    let answered = false
    const timer = setTimeout(() => {
      if (!answered && this.ws === ws) this.drop(ws, 'no-answer', 'the computer stopped answering')
    }, ms)
    channelFetch(this, 'https://machine/healthz')
      .then(
        (r) => {
          answered = true
          return r.arrayBuffer()
        },
        () => { /* the channel dropped; onclose said why */ },
      )
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        if (this.probing === ws) this.probing = null
      })
  }

  /**
   * A response for a /v1 route that said 401 to a request carrying a device
   * token: the machine removed this phone (Settings → Use on your phone).
   * Pairing is the way back, and nothing retries until then. A request with
   * no token — a phone part-way through pairing — is not a removal.
   */
  noteStatus(path: string, status: number, sentToken: boolean) {
    if (status !== 401 || !sentToken || path.startsWith('/v1/pair')) return
    if (this.problem === 'removed') return
    this.problem = 'removed'
    this.reason = 'This phone was removed on the computer.'
    for (const fn of this.listeners) fn(this.state)
  }

  private clearRetry() {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.nextAt = null
  }

  private schedule() {
    this.clearRetry()
    if (this.stopped || needsPairing(this.problem)) return
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt++
    this.nextAt = Date.now() + wait
    this.retry = setTimeout(() => {
      this.retry = null
      this.nextAt = null
      void this.connect().catch(() => { /* scheduled again */ })
    }, wait)
    for (const fn of this.listeners) fn(this.state)
  }

  /** Hangs up ws, saying why; onclose does the rest. */
  private drop(ws: WebSocket, problem: Problem, reason: string) {
    this.forced = { problem, reason }
    try {
      ws.close(4408, reason)
    } catch { /* closed already */ }
    // A socket the network lost may never deliver its close: do it here.
    this.closed?.()
  }

  private forced: { problem: Problem; reason: string } | null = null
  private closed: (() => void) | null = null

  private open(): Promise<void> {
    this.clearRetry()
    this.forced = null
    // The last reason stays while trying again: the screen keeps saying why.
    this.set('connecting', this.reason, this.problem)
    return new Promise<void>((resolve, reject) => {
      const url = this.machine.relay.replace(/\/$/, '') + '/v1/c/' + this.machine.id
      let ws: WebSocket
      try {
        ws = new this.NativeWebSocket(url)
      } catch (e) {
        this.set('offline', String(e), 'relay-unreachable')
        this.schedule()
        reject(e)
        return
      }
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      let init: Initiator | null = null
      let reached = false // the relay took the connection
      let settled = false
      let done = false
      const fail = (reason: string) => {
        if (!settled) {
          settled = true
          reject(new TypeError(reason))
        }
      }
      const deadline = setTimeout(() => {
        if (settled) return
        this.drop(ws, reached ? 'no-answer' : this.online() ? 'relay-unreachable' : 'no-internet', reached ? 'the computer did not answer' : 'could not reach the relay')
      }, ATTEMPT_MS)
      ws.onopen = () => {
        reached = true
        this.heard = Date.now()
        const start = Initiator.start(b64url(this.machine.key), enc.encode(JSON.stringify({ v: 1 })))
        init = start.init
        ws.send(start.message as Uint8Array<ArrayBuffer>)
      }
      ws.onmessage = (m) => {
        if (done) return
        this.heard = Date.now()
        if (typeof m.data === 'string') return // "pong"
        const data = new Uint8Array(m.data as ArrayBuffer)
        if (!this.session) {
          if (!init) return
          try {
            const { payload, session } = init.finish(data)
            this.session = session
            this.welcome = JSON.parse(dec.decode(payload))
          } catch {
            // The reply did not come from the machine whose key the QR
            // carried. Nothing it sent is trusted, and nothing is retried
            // against it until the phone pairs again.
            this.drop(ws, 'wrong-machine', 'This is not the computer this phone paired with.')
            return
          }
          settled = true
          clearTimeout(deadline)
          this.attempt = 0
          this.everOpen = true
          this.set('open')
          this.ping = setInterval(() => {
            if (Date.now() - this.heard > SILENT_MS) {
              this.drop(ws, 'lost', 'not answering')
              return
            }
            if (ws.readyState !== WebSocket.OPEN) return
            ws.send('ping')
            this.probe(ws, PROBE_MS)
          }, PING_MS)
          resolve()
          return
        }
        let pt: Uint8Array
        try {
          pt = this.session.decrypt(data)
        } catch {
          this.drop(ws, 'lost', 'decrypt')
          return
        }
        const { kind, id, body } = parseFrame(pt)
        this.streams.get(id)?.onFrame(kind, body)
      }
      const onClose = (code: number, closeReason: string) => {
        if (done) return
        done = true
        this.closed = null
        clearTimeout(deadline)
        if (this.ping) clearInterval(this.ping)
        this.ping = null
        if (this.ws === ws) {
          this.ws = null
          this.session = null
        }
        let problem: Problem
        let why: string
        if (this.forced) {
          ;({ problem, reason: why } = this.forced)
          this.forced = null
        } else if (code === 4404) {
          problem = 'machine-offline'
          why = 'offline'
        } else if (!reached) {
          problem = this.online() ? 'relay-unreachable' : 'no-internet'
          why = 'could not reach the relay'
        } else {
          problem = 'lost'
          why = closeReason || 'connection lost'
        }
        if (this.problem === 'removed') problem = 'removed'
        this.set(needsPairing(problem) ? 'closed' : 'offline', why, problem)
        const streams = [...this.streams.values()]
        this.streams.clear()
        for (const s of streams) s.onDrop(why)
        fail(why)
        this.schedule()
      }
      this.closed = () => onClose(4408, '')
      ws.onclose = (ev) => onClose(ev.code, ev.reason)
      ws.onerror = () => {
        /* onclose follows with the reason */
      }
    })
  }

  /** Hangs up for good: no retry follows. */
  close() {
    this.stopped = true
    this.clearRetry()
    this.ws?.close(1000)
  }

  register(handler: StreamHandler): number {
    // Odd ids from the phone, so a later protocol can let the daemon open
    // streams with even ones.
    const id = this.nextId
    this.nextId += 2
    this.streams.set(id, handler)
    return id
  }

  release(id: number) {
    this.streams.delete(id)
  }

  send(kind: number, id: number, body?: Uint8Array) {
    if (!this.session || !this.ws || this.ws.readyState !== WebSocket.OPEN) throw new TypeError('channel closed')
    this.ws.send(this.session.encrypt(frame(kind, id, body)) as Uint8Array<ArrayBuffer>)
  }

  sendJSON(kind: number, id: number, v: unknown) {
    this.send(kind, id, enc.encode(JSON.stringify(v)))
  }

  /** Sends body in frames of at most CHUNK. */
  sendChunks(kind: number, last: number, id: number, body: Uint8Array) {
    let off = 0
    while (body.length - off > CHUNK) {
      this.send(kind, id, body.subarray(off, off + CHUNK))
      off += CHUNK
    }
    this.send(last, id, body.subarray(off))
  }
}

// Keep MAX_PLAINTEXT in view: CHUNK plus the five-byte header must fit.
if (CHUNK + 5 > MAX_PLAINTEXT) throw new Error('chunk too large for one Noise message')

/** fetch() over the channel. Rejects with TypeError, as fetch does offline. */
export async function channelFetch(ch: Channel, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init)
  const url = new URL(req.url)
  const body = req.method === 'GET' || req.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await req.arrayBuffer())
  await ch.connect()
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headers[k] = v
  })
  return new Promise<Response>((resolve, reject) => {
    let head: { s: number; h?: Record<string, string> } | null = null
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        try {
          ch.send(KIND.cancel, id)
        } catch { /* closed already */ }
        ch.release(id)
      },
    })
    const id = ch.register({
      onFrame(kind, b) {
        if (kind === KIND.res) {
          head = JSON.parse(dec.decode(b))
          const status = head!.s
          ch.noteStatus(url.pathname, status, Boolean(headers['x-caprock-device']))
          // A Response cannot carry a body on these statuses.
          const nobody = status === 204 || status === 304 || req.method === 'HEAD'
          resolve(new Response(nobody ? null : stream, { status, headers: head!.h ?? {} }))
        } else if (kind === KIND.resBody) {
          controller?.enqueue(b.slice())
        } else if (kind === KIND.resEnd) {
          ch.release(id)
          try {
            controller?.close()
          } catch { /* cancelled */ }
        }
      },
      onDrop(reason) {
        if (!head) reject(new TypeError(reason))
        else {
          try {
            controller?.error(new TypeError(reason))
          } catch { /* closed */ }
        }
      },
    })
    if (init?.signal) {
      init.signal.addEventListener('abort', () => {
        try {
          ch.send(KIND.cancel, id)
        } catch { /* closed */ }
        ch.release(id)
        reject(new DOMException('aborted', 'AbortError'))
      })
    }
    try {
      ch.sendJSON(KIND.req, id, { m: req.method, p: url.pathname + url.search, h: headers })
      let off = 0
      while (off < body.length) {
        ch.send(KIND.reqBody, id, body.subarray(off, off + CHUNK))
        off += CHUNK
      }
      ch.send(KIND.reqEnd, id)
    } catch (e) {
      ch.release(id)
      reject(e instanceof TypeError ? e : new TypeError(String(e)))
    }
  })
}

/**
 * A WebSocket over the channel, with the parts of the browser's interface the
 * dashboard uses: on* handlers, readyState, protocol, binaryType, send, close.
 */
export class ChannelSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = 0
  protocol = ''
  binaryType: BinaryType = 'blob'
  readonly url: string
  readonly extensions = ''
  bufferedAmount = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  private id = 0
  private parts: Uint8Array[] = []

  constructor(
    private readonly ch: Channel,
    url: string,
    protocols?: string | string[],
  ) {
    super()
    this.url = url
    const u = new URL(url)
    const proto = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
    ch.connect().then(
      () => {
        if (this.readyState !== 0) return
        this.id = ch.register({
          onFrame: (kind, b) => this.frame(kind, b),
          onDrop: (reason) => this.finish(1006, reason),
        })
        try {
          ch.sendJSON(KIND.wsOpen, this.id, { p: u.pathname + u.search, proto })
        } catch {
          this.finish(1006, 'channel closed')
        }
      },
      (e) => {
        this.fire('error', new Event('error'))
        this.finish(1006, String(e?.message ?? e))
      },
    )
  }

  private fire(type: string, ev: Event) {
    const h = (this as unknown as Record<string, unknown>)['on' + type]
    if (typeof h === 'function') (h as (e: Event) => void).call(this, ev)
    this.dispatchEvent(ev)
  }

  private frame(kind: number, b: Uint8Array) {
    switch (kind) {
      case KIND.wsOpened: {
        const o = JSON.parse(dec.decode(b)) as { proto?: string }
        this.protocol = o.proto ?? ''
        this.readyState = 1
        this.fire('open', new Event('open'))
        break
      }
      case KIND.wsPart:
        this.parts.push(b.slice())
        break
      case KIND.wsText:
      case KIND.wsBinary: {
        this.parts.push(b.slice())
        const total = this.parts.reduce((n, p) => n + p.length, 0)
        const all = new Uint8Array(total)
        let o = 0
        for (const p of this.parts) {
          all.set(p, o)
          o += p.length
        }
        this.parts = []
        const data =
          kind === KIND.wsText ? dec.decode(all) : this.binaryType === 'arraybuffer' ? all.buffer : new Blob([all as Uint8Array<ArrayBuffer>])
        this.fire('message', new MessageEvent('message', { data }))
        break
      }
      case KIND.wsClose: {
        const c = JSON.parse(dec.decode(b)) as { code?: number; reason?: string }
        this.finish(c.code ?? 1006, c.reason ?? '')
        break
      }
    }
  }

  private finish(code: number, reason: string) {
    if (this.readyState === 3) return
    this.readyState = 3
    if (this.id) this.ch.release(this.id)
    this.fire('close', new CloseEvent('close', { code, reason, wasClean: code === 1000 }))
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1) throw new DOMException('not open', 'InvalidStateError')
    if (typeof data === 'string') {
      this.ch.sendChunks(KIND.wsPart, KIND.wsText, this.id, enc.encode(data))
      return
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((b) => this.send(b))
      return
    }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer)
    this.ch.sendChunks(KIND.wsPart, KIND.wsBinary, this.id, bytes)
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return
    if (this.readyState === 1) {
      try {
        this.ch.sendJSON(KIND.wsClose, this.id, { code, reason })
      } catch { /* closed already */ }
    }
    this.finish(code, reason)
  }
}
