/**
 * A phone on a bad network (WP-13, .ai/22-app-plan.md § Phone v2 items 1–3):
 * the terminal and /v1/live clients against fake daemons over a fake network
 * that drops, stalls, black-holes and sleeps, driven by fake timers.
 *
 * The 20 network events are the MVP list's — Wi-Fi off and on, Wi-Fi to
 * cellular over Tailscale, 60 s of airplane mode, 5% loss at 300 ms — plus
 * long stalls and a laptop sleep. Each must recover with no call but the
 * browser's own events, median ≤ 3 s after the network returns; every key
 * typed across the run must reach the session exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERM_V2_PROTOCOL, TermClient } from './termv2'
import { DEAD_MS, LIVENESS_CHECK_MS, PROBE_MS, SUSPECT_MS, onNetworkWake } from './reconnect'
import { live } from './live'

// ---------------------------------------------------------------------------
// The network.

type Profile = 'android' | 'ios'

interface Server {
  open(s: Sock): void
  receive(s: Sock, d: string | Uint8Array): void
}

const net = {
  up: true,
  /** Packets are held, as TCP holds them, and delivered when this clears. */
  stalled: false,
  latency: 20,
  /** The chance a new connection fails. */
  loss: 0,
  held: [] as (() => void)[],
  sockets: [] as Sock[],
  server: null as Server | null,
  rand: (() => { let x = 99; return () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31 } })(),
}

/** Sends `fn` across the network; `lane` keeps one direction of one connection in order, as TCP does. */
function send(fn: () => void, lane?: { at: number }): void {
  if (net.stalled) { net.held.push(fn); return }
  const at = Math.max(Date.now() + net.latency, lane?.at ?? 0)
  if (lane) lane.at = at
  setTimeout(fn, at - Date.now())
}

class Sock {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = Sock.CONNECTING
  protocol = ''
  binaryType = ''
  /** Half-open: whatever is sent either way vanishes, and nothing says so. */
  broken = false
  private readonly up = { at: 0 }
  private readonly down = { at: 0 }
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly query: URLSearchParams
  constructor(readonly url: string, readonly protocols: string[] = []) {
    this.query = new URL(url).searchParams
    net.sockets.push(this)
    if (!net.up) { setTimeout(() => this.fail(), 100); return }
    send(() => this.accept())
  }
  private accept() {
    if (this.readyState !== Sock.CONNECTING) return
    if (!net.up || net.rand() < net.loss) { this.fail(); return }
    setTimeout(() => {
      if (this.readyState !== Sock.CONNECTING) return
      this.readyState = Sock.OPEN
      this.protocol = this.protocols.includes(TERM_V2_PROTOCOL) ? TERM_V2_PROTOCOL : ''
      this.onopen?.()
      net.server?.open(this)
    }, net.latency)
  }
  /** Client to daemon. Data already handed to the kernel still goes after a local close. */
  send(d: string | Uint8Array) {
    if (this.readyState !== Sock.OPEN || this.broken || !net.up) return
    const copy = typeof d === 'string' ? d : new Uint8Array(d)
    send(() => { if (!this.broken && net.up) net.server?.receive(this, copy) }, this.up)
  }
  /** Daemon to client. */
  deliver(d: string | Uint8Array) {
    if (this.broken) return
    send(() => {
      if (this.readyState !== Sock.OPEN || this.broken || !net.up) return
      this.onmessage?.({ data: typeof d === 'string' ? d : d.buffer })
    }, this.down)
  }
  close() { this.readyState = Sock.CLOSED }
  fail() {
    if (this.readyState === Sock.CLOSED) return
    this.readyState = Sock.CLOSED
    this.onclose?.({ code: 1006 })
  }
}

const openSockets = () => net.sockets.filter((s) => s.readyState === Sock.OPEN)

function unstall() {
  net.stalled = false
  const held = net.held
  net.held = []
  for (const fn of held) setTimeout(fn, net.latency)
}

// ---------------------------------------------------------------------------
// The 20 network events.

type Kind = 'wifi' | 'cellular' | 'airplane' | 'loss' | 'stall' | 'sleep'

const EVENTS: { kind: Kind; ms: number }[] = [
  { kind: 'wifi', ms: 3_000 }, { kind: 'cellular', ms: 3_000 }, { kind: 'loss', ms: 0 },
  { kind: 'airplane', ms: 60_000 }, { kind: 'wifi', ms: 8_000 }, { kind: 'stall', ms: 40_000 },
  { kind: 'cellular', ms: 2_000 }, { kind: 'loss', ms: 0 }, { kind: 'wifi', ms: 12_000 },
  { kind: 'sleep', ms: 10 * 60_000 }, { kind: 'airplane', ms: 60_000 }, { kind: 'cellular', ms: 5_000 },
  { kind: 'loss', ms: 0 }, { kind: 'wifi', ms: 20_000 }, { kind: 'stall', ms: 30_000 },
  { kind: 'airplane', ms: 60_000 }, { kind: 'cellular', ms: 4_000 }, { kind: 'loss', ms: 0 },
  { kind: 'wifi', ms: 5_000 }, { kind: 'sleep', ms: 30 * 60_000 },
]

const fire = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type))

/**
 * Plays one event and returns when the network came back. While it lasts,
 * `during` runs every 500 ms (typing, for the terminal).
 */
async function play(kind: Kind, ms: number, profile: Profile, during: () => void): Promise<number> {
  const pass = async (total: number) => {
    for (let t = 0; t < total; t += 500) { during(); await vi.advanceTimersByTimeAsync(Math.min(500, total - t)) }
  }
  switch (kind) {
    case 'wifi':
    case 'airplane':
      // The interface goes: the browser closes its sockets and says offline.
      net.up = false
      for (const s of openSockets()) setTimeout(() => s.fail(), 200)
      fire(window, 'offline')
      await pass(ms)
      net.up = true
      fire(window, 'online')
      return Date.now()
    case 'cellular':
      // Over Tailscale the tunnel roams and the TCP connection survives, after
      // a pause. Android reports the network type change; iOS says nothing.
      net.stalled = true
      if (profile === 'android') fire((navigator as unknown as { connection: EventTarget }).connection, 'change')
      await pass(ms)
      unstall()
      return Date.now()
    case 'loss':
      // 5% of connections fail, at 300 ms each way, and a burst kills the socket.
      net.latency = 300
      net.loss = 0.05
      for (const s of openSockets()) s.fail()
      return Date.now()
    case 'stall':
      // Nothing gets through and nothing says so; attempts hang opening.
      net.stalled = true
      await pass(ms)
      unstall()
      return Date.now()
    case 'sleep': {
      // The machine sleeps: no timer runs, and the daemon gives up on the
      // socket meanwhile. It wakes with the clock far ahead.
      for (const s of openSockets()) s.broken = true
      vi.setSystemTime(Date.now() + ms)
      fire(document, 'visibilitychange')
      return Date.now()
    }
  }
}

/** Steps time until the client is live with a round trip after `since`; the time it took. */
async function recovery(since: number, isLive: () => boolean, heardAt: () => number, during: () => void): Promise<number> {
  for (let waited = 0; waited <= 120_000; waited += 100) {
    if (isLive() && heardAt() >= since) return Date.now() - since
    during()
    await vi.advanceTimersByTimeAsync(100)
  }
  return Infinity
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/** Events the browser announces when the network returns: the attempt is made at once. */
const ANNOUNCED: ReadonlySet<Kind> = new Set(['wifi', 'airplane', 'sleep'])

function expectRecovered(times: number[]) {
  times.forEach((t, i) => {
    expect(t, `event ${i} (${EVENTS[i]!.kind})`).toBeLessThan(DEAD_MS + 15_000)
    if (ANNOUNCED.has(EVENTS[i]!.kind)) expect(t, `event ${i} (${EVENTS[i]!.kind}) is announced`).toBeLessThanOrEqual(1_000)
  })
  expect(median(times)).toBeLessThanOrEqual(3_000)
}

function setup() {
  net.up = true; net.stalled = false; net.latency = 20; net.loss = 0; net.held = []; net.sockets = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Sock)
  const connection = new EventTarget()
  Object.defineProperty(navigator, 'connection', { configurable: true, value: connection })
}

function teardown() {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (navigator as { connection?: unknown }).connection
}

// ---------------------------------------------------------------------------
// The terminal.

/** A pty-host and daemon: echoes each key once, dedupes by sequence, never forgets output. */
function termServer() {
  const st = { output: '', lastSeq: new Map<string, number>(), applied: [] as string[] }
  const frame = (offset: number, s: string) => {
    const body = new TextEncoder().encode(s)
    const b = new Uint8Array(8 + body.length)
    new DataView(b.buffer).setBigUint64(0, BigInt(offset))
    b.set(body, 8)
    return b
  }
  const pos = new Map<Sock, number>()
  const flush = () => {
    for (const [s, p] of pos) {
      if (s.readyState !== Sock.OPEN) { pos.delete(s); continue }
      if (p < st.output.length) { s.deliver(frame(p, st.output.slice(p))); pos.set(s, st.output.length) }
    }
  }
  setInterval(() => { for (const s of pos.keys()) s.deliver(JSON.stringify({ ping: Date.now() })) }, 10_000)
  const server: Server = {
    open(s) {
      const client = s.query.get('client') ?? ''
      const since = s.query.get('since')
      const ack = st.lastSeq.get(client) ?? 0
      if (since !== null && Number(since) <= st.output.length) {
        s.deliver(JSON.stringify({ hello: { v: 2, offset: Number(since), reset: false, ack } }))
        pos.set(s, Number(since))
      } else {
        s.deliver(JSON.stringify({ hello: { v: 2, offset: st.output.length, reset: true, ack } }))
        s.deliver(frame(0, st.output))
        pos.set(s, st.output.length)
      }
      flush()
    },
    receive(s, d) {
      if (typeof d === 'string') {
        const m = JSON.parse(d) as { ping?: number }
        if (m.ping !== undefined) s.deliver(JSON.stringify({ pong: m.ping }))
        return
      }
      const client = s.query.get('client') ?? ''
      const seq = new DataView(d.buffer, d.byteOffset).getUint32(0)
      if (seq <= (st.lastSeq.get(client) ?? 0)) return
      st.lastSeq.set(client, seq)
      const text = new TextDecoder().decode(d.subarray(4))
      st.applied.push(text)
      st.output += `<${text}>`
      s.deliver(JSON.stringify({ ack: seq }))
      flush()
    },
  }
  return { st, server }
}

describe.each(['android', 'ios'] as const)('the terminal on a bad network (%s)', (profile) => {
  beforeEach(setup)
  afterEach(teardown)

  it('recovers from 20 network events with no tap, median ≤ 3 s, every key typed exactly once', async () => {
    const { st, server } = termServer()
    net.server = server
    let out = ''
    let resets = 0
    const c = new TermClient({
      url: 'ws://phone.test/v1/agents/s1/term',
      random: net.rand,
      callbacks: {
        write: (d, done) => { out += typeof d === 'string' ? d : new TextDecoder().decode(d); done() },
        reset: () => { resets++; out = '' },
        state: () => {},
      },
    })
    const unwake = onNetworkWake(() => c.wake())
    c.start()
    let typed = 0
    const type = () => { if (c.send(`k${typed + 1}`)) typed++ }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(c.state).toBe('live')

    const times: number[] = []
    for (const { kind, ms } of EVENTS) {
      for (let i = 0; i < 5; i++) { type(); await vi.advanceTimersByTimeAsync(200) }
      const back = await play(kind, ms, profile, type)
      const took = await recovery(back, () => c.state === 'live', () => c.heardAt, type)
      times.push(took)
      net.latency = 20
      net.loss = 0
    }
    // Let the last acknowledgements and output land.
    await vi.advanceTimersByTimeAsync(5_000)
    unwake()
    c.dispose()

    console.info(`[${profile}] terminal recovery ms per event:`, times.join(' '), '— median', median(times))
    expectRecovered(times)
    const want = Array.from({ length: typed }, (_, i) => `k${i + 1}`)
    expect(st.applied.length).toBe(typed)
    expect(st.applied.join() === want.join()).toBe(true)
    expect(c.unacked).toBe(0)
    expect(out === st.output).toBe(true)
    expect(resets).toBe(0)
  })

  it('detects a half-open socket within about 23 s, with room under 25 s, and never stays "live" on it', async () => {
    const { server } = termServer()
    net.server = server
    const c = new TermClient({ url: 'ws://phone.test/v1/agents/s1/term', random: net.rand, callbacks: { write: (_d, done) => done(), reset: () => {}, state: () => {} } })
    c.start()
    await vi.advanceTimersByTimeAsync(1_000)
    // The route goes silently: nothing is closed, nothing arrives.
    for (const s of openSockets()) s.broken = true
    const lastHeard = c.heardAt
    while (c.state === 'live') await vi.advanceTimersByTimeAsync(100)
    expect(c.state).toBe('reconnecting')
    // Asked for a round trip at 20 s of silence, dropped when it does not come.
    expect(Date.now() - lastHeard).toBeLessThanOrEqual(SUSPECT_MS + PROBE_MS + LIVENESS_CHECK_MS)
    expect(Date.now() - lastHeard).toBeLessThan(DEAD_MS)
    // Live again over a new socket, with no call from outside.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(c.state).toBe('live')
    c.dispose()
  })
})

// ---------------------------------------------------------------------------
// /v1/live.

/** The daemon's bus: numbered frames, a ring that keeps them all, pings every 10 s. */
function liveServer() {
  const st = { seq: 1000, published: [] as number[] }
  const conns = new Set<Sock>()
  const frame = (type: string, seq: number, data: unknown) => JSON.stringify({ type, seq, data })
  setInterval(() => {
    st.seq++
    st.published.push(st.seq)
    for (const s of conns) s.deliver(frame('session', st.seq, {}))
  }, 2_000)
  setInterval(() => { for (const s of conns) s.deliver(frame('ping', st.seq, Date.now())) }, 10_000)
  const server: Server = {
    open(s) {
      for (const c of conns) if (c.readyState !== Sock.OPEN) conns.delete(c)
      const since = s.query.get('since')
      if (since === null) {
        s.deliver(frame('hello', st.seq, { server_time: Date.now(), reset: false }))
      } else {
        s.deliver(frame('hello', Number(since), { server_time: Date.now(), reset: false }))
        for (const q of st.published) if (q > Number(since)) s.deliver(frame('session', q, {}))
      }
      conns.add(s)
    },
    receive(s, d) {
      const m = JSON.parse(String(d)) as { ping?: number }
      if (m.ping !== undefined) s.deliver(frame('pong', st.seq, m.ping))
    },
  }
  return { st, server }
}

describe.each(['android', 'ios'] as const)('/v1/live on a bad network (%s)', (profile) => {
  beforeEach(setup)
  afterEach(teardown)

  it('recovers from 20 network events with no tap, median ≤ 3 s, each frame applied once', async () => {
    const { st, server } = liveServer()
    net.server = server
    const store = new (live.constructor as new () => typeof live)()
    const applied: number[] = []
    store.onFrame((f) => { if (f.type === 'session' && typeof f.seq === 'number') applied.push(f.seq) })
    store.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().link.phase).toBe('live')

    const isLive = () => store.getState().link.phase === 'live'
    const times: number[] = []
    for (const { kind, ms } of EVENTS) {
      await vi.advanceTimersByTimeAsync(3_000)
      const back = await play(kind, ms, profile, () => {})
      times.push(await recovery(back, isLive, store.heardAt, () => {}))
      net.latency = 20
      net.loss = 0
    }
    await vi.advanceTimersByTimeAsync(5_000)

    console.info(`[${profile}] /v1/live recovery ms per event:`, times.join(' '), '— median', median(times))
    expectRecovered(times)
    // Every frame the daemon published reached the store, once, in order.
    expect(applied.join() === st.published.slice(0, applied.length).join()).toBe(true)
    expect(st.published.length - applied.length).toBeLessThanOrEqual(1)
  })
})
