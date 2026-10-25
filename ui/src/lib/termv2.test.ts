/**
 * Terminal protocol v2 from the browser's side, against a fake daemon that
 * speaks the protocol: offsets, resume without a repaint, numbered input
 * resent until acknowledged, liveness, backpressure and reconnecting forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECT_TIMEOUT_MS, LIVENESS_CHECK_MS, PROBE_MS, RETRY_OVERDUE_MS, STALL_MS, offersManualRetry } from './reconnect'
import {
  FREED,
  BACKOFF_MAX_MS, BACKOFF_MIN_MS, DEAD_MS, FOCUS_DEBOUNCE_MS, HIGH_WATER, OFFLINE_QUEUE_BYTES, TERM_V2_PROTOCOL,
  TermClient, backoff, type TermState,
} from './termv2'
import { PAGE_HIDDEN_SUSPEND_MS, suspendWhileHidden } from './visible'

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static all: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  protocol = ''
  binaryType = ''
  sent: (string | Uint8Array)[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason?: string }) => void) | null = null
  readonly query: URLSearchParams
  constructor(readonly url: string, readonly protocols: string[]) {
    this.query = new URL(url).searchParams
    FakeSocket.all.push(this)
  }
  send(d: string | Uint8Array) { this.sent.push(typeof d === 'string' ? d : new Uint8Array(d)) }
  close() { this.readyState = FakeSocket.CLOSED }
  // Server side.
  accept(protocol = TERM_V2_PROTOCOL) { this.protocol = protocol; this.readyState = FakeSocket.OPEN; this.onopen?.() }
  text(v: unknown) { this.onmessage?.({ data: JSON.stringify(v) }) }
  bytes(offset: number, s: string) {
    const body = new TextEncoder().encode(s)
    const b = new Uint8Array(8 + body.length)
    new DataView(b.buffer).setBigUint64(0, BigInt(offset))
    b.set(body, 8)
    this.onmessage?.({ data: b.buffer })
  }
  drop(code = 1006, reason = '') { this.readyState = FakeSocket.CLOSED; this.onclose?.({ code, reason } as { code: number }) }
  inputs(): { seq: number; text: string }[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string').map((d) => ({
      seq: new DataView(d.buffer, d.byteOffset).getUint32(0),
      text: new TextDecoder().decode(d.subarray(4)),
    }))
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!

function mount(over: { write?: (d: Uint8Array | string, done: () => void) => void } = {}) {
  const out: string[] = []
  const states: TermState[] = []
  let resets = 0
  let exit: number | undefined
  const c = new TermClient({
    url: 'ws://localhost/v1/agents/s1/term',
    random: () => 0.5,
    callbacks: {
      write: over.write ?? ((d, done) => { out.push(typeof d === 'string' ? d : new TextDecoder().decode(d)); done() }),
      reset: () => { resets++; out.length = 0 },
      state: (s) => states.push(s),
      exit: (code) => { exit = code },
    },
  })
  c.start()
  wakeLast = () => c.wake()
  return { c, out, states, resets: () => resets, exit: () => exit }
}

describe('TermClient (protocol v2)', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('asks for v2 with a client id, and resumes from its offset without clearing the screen', () => {
    const t = mount()
    const s1 = last()
    expect(s1.protocols).toContain(TERM_V2_PROTOCOL)
    expect(s1.query.get('client')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(s1.query.get('since')).toBeNull()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 5, reset: true, ack: 0 } })
    s1.bytes(5, 'hello')
    s1.bytes(5, ' world')
    expect(t.out.join('')).toBe('hello world')
    expect(t.states.at(-1)).toBe('live')

    s1.drop()
    expect(t.states.at(-1)).toBe('reconnecting')
    vi.advanceTimersByTime(BACKOFF_MIN_MS)
    const s2 = last()
    expect(s2.query.get('since')).toBe('11')
    expect(s2.query.get('client')).toBe(s1.query.get('client'))
    s2.accept()
    s2.text({ hello: { v: 2, offset: 11, reset: false, ack: 0 } })
    // An overlap is trimmed, never written twice.
    s2.bytes(9, 'ld!')
    expect(t.out.join('')).toBe('hello world!')
    expect(t.resets()).toBe(0)
  })

  it('suspends a hidden tab without reconnecting, and resumes from its offset on wake', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    // A snapshot that ends at offset 3.
    s1.text({ hello: { v: 2, offset: 3, reset: true, ack: 0 } })
    s1.bytes(0, 'abc')
    expect(t.c.protocol).toBe('v2')
    t.c.suspend()
    expect(t.c.protocol).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    t.c.wake()
    const s2 = last()
    expect(FakeSocket.all).toHaveLength(2)
    expect(s2.query.get('since')).toBe('3')
    s2.accept()
    s2.text({ hello: { v: 2, offset: 3, reset: false, ack: 0 } })
    s2.bytes(3, 'd')
    expect(t.out.join('')).toBe('abcd')
    expect(t.resets()).toBe(0)
  })

  it('lets the socket go while the page is hidden and loses no byte across hide and show', () => {
    let hidden = false
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
    const flip = (h: boolean) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')) }
    try {
      const t = mount()
      const stop = suspendWhileHidden(t.c)
      const s1 = last()
      s1.accept()
      s1.text({ hello: { v: 2, offset: 0, reset: false, ack: 0 } })
      s1.bytes(0, 'one ')
      // A blink of occlusion keeps the socket.
      flip(true)
      vi.advanceTimersByTime(PAGE_HIDDEN_SUSPEND_MS - 1)
      flip(false)
      vi.advanceTimersByTime(PAGE_HIDDEN_SUSPEND_MS)
      expect(t.c.protocol).toBe('v2')
      s1.bytes(4, 'two ')
      // Hidden past the grace: let go, and nothing reconnects while hidden.
      flip(true)
      s1.bytes(8, 'three ')
      vi.advanceTimersByTime(PAGE_HIDDEN_SUSPEND_MS)
      expect(t.c.protocol).toBeUndefined()
      vi.advanceTimersByTime(120_000)
      expect(FakeSocket.all).toHaveLength(1)
      // Shown: the page's wake asks from the last byte held; the daemon
      // sends what was printed meanwhile, overlapping by a little.
      flip(false)
      t.c.wake()
      const s2 = last()
      expect(FakeSocket.all).toHaveLength(2)
      expect(s2.query.get('since')).toBe('14')
      s2.accept()
      s2.text({ hello: { v: 2, offset: 14, reset: false, ack: 0 } })
      s2.bytes(8, 'three four five')
      expect(t.out.join('')).toBe('one two three four five')
      expect(t.resets()).toBe(0)
      stop()
      flip(true)
      vi.advanceTimersByTime(PAGE_HIDDEN_SUSPEND_MS)
      expect(t.c.protocol).toBe('v2')
    } finally {
      vis.mockRestore()
    }
  })

  it('repaints only when the daemon says the offset is gone', () => {
    const t = mount()
    last().accept()
    last().text({ hello: { v: 2, offset: 3, reset: true, ack: 0 } })
    last().bytes(3, 'abc')
    last().text({ reset: { offset: 900 } })
    last().bytes(900, 'SCREEN')
    expect(t.resets()).toBe(1)
    expect(t.out.join('')).toBe('SCREEN')
    last().bytes(900, '+')
    expect(t.out.join('')).toBe('SCREEN+')
  })

  it('numbers input, resends what was not acknowledged, and forgets what was', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    s1.bytes(0, '')
    t.c.send('a'); t.c.send('b'); t.c.send('c')
    expect(s1.inputs()).toEqual([{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }, { seq: 3, text: 'c' }])
    s1.text({ ack: 1 })
    s1.drop()
    t.c.send('d') // typed while down: queued
    vi.advanceTimersByTime(BACKOFF_MIN_MS)
    const s2 = last()
    s2.accept()
    expect(s2.inputs()).toEqual([]) // nothing before the hello
    s2.text({ hello: { v: 2, offset: 0, reset: false, ack: 2 } })
    expect(s2.inputs()).toEqual([{ seq: 3, text: 'c' }, { seq: 4, text: 'd' }])
    s2.text({ ack: 4 })
    expect(t.c.unacked).toBe(0)
  })

  // A paste of non-ASCII text broke in a session (user report, 2026-10-11).
  // The page was not why: the whole paste goes as one frame of its exact
  // UTF-8 bytes, never split inside a character (the cause was the session's
  // locale, agents.withUTF8Locale).
  it('sends a long multi-byte paste as one frame of its exact UTF-8 bytes', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    const paste = `\x1b[200~${'καλημέρα κόσμε こんにちは世界 🙂 '.repeat(300)}\x1b[201~`
    expect(t.c.send(paste)).toBe(true)
    const frames = s1.sent.filter((d): d is Uint8Array => typeof d !== 'string')
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0]!.subarray(4))).toEqual(Array.from(new TextEncoder().encode(paste)))
  })

  it('keeps at most 4 KB of typing while offline', () => {
    const t = mount()
    last().drop()
    expect(t.c.send('x'.repeat(OFFLINE_QUEUE_BYTES - 1))).toBe(true)
    expect(t.c.send('y')).toBe(true)
    expect(t.c.send('z')).toBe(false)
  })

  it('answers pings, pings itself, and treats 25 s of silence as a dead socket', () => {
    mount()
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    s1.text({ ping: 7 })
    expect(s1.sent).toContain(JSON.stringify({ pong: 7 }))
    vi.advanceTimersByTime(10_000)
    expect(s1.sent.some((d) => typeof d === 'string' && d.startsWith('{"ping"'))).toBe(true)
    vi.advanceTimersByTime(DEAD_MS)
    vi.advanceTimersByTime(BACKOFF_MAX_MS)
    expect(FakeSocket.all.length).toBeGreaterThan(1)
  })

  it('stops at the exit and does not reconnect', () => {
    const t = mount()
    last().accept()
    last().text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    last().text({ exit: { code: 3 } })
    last().drop(1000)
    vi.advanceTimersByTime(60_000)
    expect(t.exit()).toBe(3)
    expect(t.states.at(-1)).toBe('ended')
    expect(FakeSocket.all).toHaveLength(1)
  })

  // A program that exited at once: the daemon accepts, says the exit with
  // early and closes — no hello, no reconnect, and the pane is told it was
  // early (it shows what the program printed, components/EarlyExit).
  it('ends on an early exit without a hello, and says it was early', () => {
    let seen: [number, boolean | undefined] | undefined
    const c = new TermClient({
      url: 'ws://localhost/v1/agents/s1/term',
      random: () => 0.5,
      callbacks: { write: (_d, done) => done(), reset: () => {}, state: () => {}, exit: (code, early) => { seen = [code, early] } },
    })
    c.start()
    last().accept()
    last().text({ exit: { code: 1, early: 1 } })
    last().drop(1000)
    vi.advanceTimersByTime(60_000)
    expect(seen).toEqual([1, true])
    expect(c.state).toBe('ended')
    expect(FakeSocket.all).toHaveLength(1)
    c.dispose()
  })

  // An agent Caprock ended to free memory: gone at once, with the reason —
  // the app shows its conversation with Continue (AppShell onPaneGone).
  it('is gone at once when the agent was ended to free memory', () => {
    let gone = 0
    const c = new TermClient({
      url: 'ws://localhost/v1/agents/s1/term',
      random: () => 0.5,
      callbacks: { write: (_d, done) => done(), reset: () => {}, state: () => {}, gone: () => { gone++ } },
    })
    c.start()
    last().accept()
    last().text({ exit: { code: -1, freed: 1 } })
    last().drop(1000)
    vi.advanceTimersByTime(60_000)
    expect(gone).toBe(1)
    expect(c.state).toBe('ended')
    expect(c.link.refusal).toBe(FREED)
    expect(FakeSocket.all).toHaveLength(1)
    c.dispose()
  })

  it('reconnects to the new process after a restart exit, from its start, without ending', () => {
    const t = mount()
    last().accept()
    last().text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    last().bytes(0, 'old')
    last().text({ exit: { code: 0, restart: 1 } })
    last().drop(1000)
    expect(t.exit()).toBeUndefined()
    expect(t.states.at(-1)).toBe('reconnecting')
    vi.advanceTimersByTime(BACKOFF_MAX_MS)
    expect(FakeSocket.all.length).toBeGreaterThan(1)
    // A new process has a new ring: nothing is asked "since" the old one.
    expect(last().url).not.toContain('since=')
  })

  it('reconnects forever, backing off to 15 s, and at once when the page wakes', () => {
    const t = mount()
    for (let i = 0; i < 200; i++) {
      last().drop()
      vi.advanceTimersByTime(BACKOFF_MAX_MS)
    }
    // At least one attempt per drop; more where an attempt hung opening
    // past CONNECT_TIMEOUT_MS and was replaced.
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(201)
    last().drop()
    const before = FakeSocket.all.length
    t.c.wake()
    expect(FakeSocket.all).toHaveLength(before + 1)
    for (let n = 0; n < 30; n++) {
      expect(backoff(n, () => 0)).toBeGreaterThanOrEqual(BACKOFF_MIN_MS)
      expect(backoff(n, () => 1)).toBeLessThanOrEqual(BACKOFF_MAX_MS)
    }
  })

  it('lets go of the socket while the terminal is 1 MB behind, then resumes from its offset', () => {
    const pendingDone: (() => void)[] = []
    mount({ write: (_d, done) => { pendingDone.push(done) } })
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    s1.bytes(0, '')
    const chunk = 'x'.repeat(64 * 1024)
    let off = 0
    while (off <= HIGH_WATER) { s1.bytes(off, chunk); off += chunk.length }
    expect(s1.readyState).toBe(FakeSocket.CLOSED)
    vi.advanceTimersByTime(STALL_MS - 1_000)
    expect(FakeSocket.all).toHaveLength(1) // not before the terminal catches up
    pendingDone.forEach((d) => d())
    expect(FakeSocket.all).toHaveLength(2)
    expect(last().query.get('since')).toBe(String(off))
  })

  it('stays byte-identical and types every key once through random drops', () => {
    // A fake daemon: the program echoes each key it is given, and a resent
    // sequence is dropped, as the pty-host's table does.
    const t = mount()
    let output = ''
    const applied: string[] = []
    let lastSeq = 0
    let rnd = 42
    const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2 ** 31; return rnd / 2 ** 31 }
    const serve = (s: FakeSocket) => {
      s.accept()
      const since = s.query.get('since')
      if (since !== null && Number(since) <= output.length) {
        s.text({ hello: { v: 2, offset: Number(since), reset: false, ack: lastSeq } })
        s.bytes(Number(since), output.slice(Number(since)))
      } else {
        s.text({ hello: { v: 2, offset: output.length, reset: true, ack: lastSeq } })
        s.bytes(output.length, output)
      }
    }
    const pump = (s: FakeSocket, from: number) => {
      const fresh = s.inputs().slice(from)
      for (const { seq, text } of fresh) {
        if (seq <= lastSeq) continue
        lastSeq = seq
        applied.push(text)
        const off = output.length
        output += `<${text}>`
        if (rand() < 0.8) s.bytes(off, output.slice(off))
        if (rand() < 0.3) s.text({ ack: lastSeq })
      }
      return s.inputs().length
    }
    serve(last())
    let seen = 0
    for (let i = 1; i <= 2000; i++) {
      t.c.send(`k${i}`)
      seen = pump(last(), seen)
      if (rand() < 0.03) {
        last().drop()
        if (rand() < 0.5) t.c.send(`k${++i}`) // typed while down
        vi.advanceTimersByTime(BACKOFF_MAX_MS)
        serve(last())
        seen = pump(last(), 0)
      }
    }
    pump(last(), seen)
    // Two more reconnects: the first delivers any resent input, the second
    // whatever output the fake daemon held back.
    for (let i = 0; i < 2; i++) {
      last().drop()
      vi.advanceTimersByTime(BACKOFF_MAX_MS)
      serve(last())
      pump(last(), 0)
    }
    const want = Array.from({ length: applied.length }, (_, j) => `k${j + 1}`)
    expect(applied.length).toBeGreaterThanOrEqual(2000)
    expect(applied.join() === want.join()).toBe(true)
    const got = t.out.join('')
    expect(got.length).toBe(output.length)
    expect(got === output).toBe(true)
    expect(t.resets()).toBe(0)
  })
})

describe('TermClient — WP-13 resilience', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const live = () => {
    const t = mount()
    last().accept()
    last().text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    return t
  }

  it('resends an input the daemon closed 1011 on, once, after the reconnect', () => {
    const t = live()
    t.c.send('x')
    last().drop(1011)
    expect(t.states.at(-1)).toBe('reconnecting')
    vi.advanceTimersByTime(BACKOFF_MIN_MS)
    last().accept()
    last().text({ hello: { v: 2, offset: 0, reset: false, ack: 0 } })
    expect(last().inputs()).toEqual([{ seq: 1, text: 'x' }])
  })

  it('stops on 1008 and says why, with no further attempt', () => {
    const t = live()
    last().drop(1008, '')
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(t.c.link.phase).toBe('revoked')
    expect(t.c.link.reason).toMatch(/ask on the machine/)
    t.c.wake()
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('reports the attempt, the next try and since when, and resets them once live', () => {
    const t = live()
    const lost = Date.now()
    last().drop()
    expect(t.c.link).toMatchObject({ phase: 'reconnecting', attempt: 0, downSince: lost, nextAt: lost + BACKOFF_MIN_MS })
    vi.advanceTimersByTime(BACKOFF_MIN_MS)
    expect(t.c.link).toMatchObject({ attempt: 1, nextAt: null })
    last().drop()
    expect(t.c.link.attempt).toBe(1)
    expect(t.c.link.nextAt).not.toBeNull()
    vi.advanceTimersByTime(BACKOFF_MAX_MS)
    last().accept()
    expect(t.c.link.phase).toBe('catching-up') // open, the hello not yet in
    last().text({ hello: { v: 2, offset: 0, reset: false, ack: 0 } })
    expect(t.c.link).toEqual({ phase: 'live', attempt: 0, nextAt: null, downSince: null, reason: undefined })
  })

  it('makes a woken socket answer within 2 s, and replaces it at once when it does not', () => {
    live()
    const s1 = last()
    // The network changed under an open socket: the wake pings it.
    const t2 = FakeSocket.all.length
    s1.sent.length = 0
    mountWake()
    expect(s1.sent.some((d) => typeof d === 'string' && d.startsWith('{"ping"'))).toBe(true)
    vi.advanceTimersByTime(PROBE_MS + 1_000)
    // No answer: a new socket now, not after the backoff.
    expect(FakeSocket.all.length).toBe(t2 + 1)
  })

  it('keeps a woken socket that answers', () => {
    live()
    const s1 = last()
    mountWake()
    vi.advanceTimersByTime(500)
    s1.text({ pong: 1 })
    vi.advanceTimersByTime(PROBE_MS + 1_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('takes a laptop that slept for a dead socket and reconnects at once on wake', () => {
    const t = live()
    last().bytes(0, '') // the (empty) snapshot
    last().bytes(0, 'abc')
    vi.setSystemTime(Date.now() + 10 * 60_000)
    t.c.wake()
    expect(FakeSocket.all).toHaveLength(2)
    expect(last().query.get('since')).toBe('3')
  })

  it('abandons an attempt that hangs opening', () => {
    const t = live()
    last().drop()
    vi.advanceTimersByTime(BACKOFF_MIN_MS)
    const hanging = FakeSocket.all.length
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 1_000)
    expect(t.c.state).toBe('reconnecting')
    vi.advanceTimersByTime(BACKOFF_MAX_MS)
    expect(FakeSocket.all.length).toBeGreaterThan(hanging)
  })

  it('is not live while the socket is let go for a terminal 1 MB behind', () => {
    const pendingDone: (() => void)[] = []
    const t = mount({ write: (_d, done) => { pendingDone.push(done) } })
    last().accept()
    last().text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    const chunk = 'x'.repeat(64 * 1024)
    let off = 0
    last().bytes(0, '') // the (empty) snapshot
    while (off <= HIGH_WATER) { last().bytes(off, chunk); off += chunk.length }
    expect(t.c.state).toBe('catching-up')
    pendingDone.forEach((d) => d())
    last().accept()
    last().text({ hello: { v: 2, offset: off, reset: false, ack: 0 } })
    expect(t.c.state).toBe('live')
  })
})

describe('TermClient — exactly once (Phone v2 item 3)', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('types 10,000 sequenced inputs across 50 forced disconnects exactly once', () => {
    // The fake pty-host's echo log is the proof: each key echoed once, in order.
    const t = mount()
    let output = ''
    const echo: string[] = []
    let lastSeq = 0
    let rnd = 7
    const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2 ** 31; return rnd / 2 ** 31 }
    const serve = (s: FakeSocket) => {
      s.accept()
      const since = Number(s.query.get('since') ?? output.length)
      s.text({ hello: { v: 2, offset: since, reset: false, ack: lastSeq } })
      s.bytes(since, output.slice(since))
    }
    const pump = (s: FakeSocket, from: number) => {
      for (const { seq, text } of s.inputs().slice(from)) {
        if (seq <= lastSeq) continue
        lastSeq = seq
        echo.push(text)
        const off = output.length
        output += text
        if (rand() < 0.7) s.bytes(off, text)
        if (rand() < 0.2) s.text({ ack: lastSeq })
      }
      return s.inputs().length
    }
    const reconnect = () => {
      const before = FakeSocket.all.length
      for (let i = 0; FakeSocket.all.length === before && i < 200; i++) vi.advanceTimersByTime(100)
      serve(last())
      return pump(last(), 0)
    }
    serve(last())
    let seen = 0
    let disconnects = 0
    let typed = 0
    while (typed < 10_000) {
      t.c.send(`<${++typed}>`)
      seen = pump(last(), seen)
      if (typed % 200 === 0) {
        disconnects++
        // Three ways a connection goes: dropped, closed 1011 (an input not
        // confirmed as typed), and half-open (nothing arrives, nothing closes).
        const how = disconnects % 3
        if (how === 0) last().drop(1006)
        else if (how === 1) last().drop(1011)
        else vi.advanceTimersByTime(DEAD_MS)
        for (let k = 0; k < 3; k++) t.c.send(`<${++typed}>`) // typed while down
        seen = reconnect()
      }
    }
    // A last reconnect delivers anything still unacknowledged.
    last().drop()
    seen = reconnect()
    expect(disconnects).toBe(50)
    expect(echo.length).toBe(typed)
    expect(echo.every((k, i) => k === `<${i + 1}>`)).toBe(true)
    expect(t.c.unacked).toBe(0)
    // Synchronous on fake timers, so nothing in it waits on anything: its
    // time is CPU alone — 1.4–3.4 s measured on a busy laptop, 7.2 s on a very
    // busy one, where the default 5 s failed it with nothing wrong.
  }, 30_000)
})

/** The last mounted client's wake, as the page's listeners would call it. */
let wakeLast: (() => void) | null = null
function mountWake() { wakeLast?.() }

// One PTY, several terminals: the one in use sizes it (internal/api/termsize.go).
describe('TermClient — claiming the PTY (focus)', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const texts = (s: FakeSocket) => s.sent.filter((d): d is string => typeof d === 'string' && !d.startsWith('{"ping"'))

  it('sends one claim for a burst of focus events', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    t.c.focus()
    t.c.focus()
    t.c.focus()
    expect(texts(s1)).toEqual([])
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    expect(texts(s1)).toEqual(['{"focus":true}'])
    t.c.focus()
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    expect(texts(s1)).toEqual(['{"focus":true}', '{"focus":true}'])
  })

  it('a claim made with no socket goes with the next first size, as one frame', () => {
    const t = mount()
    const s1 = last()
    t.c.focus()
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    s1.accept()
    t.c.resize(150, 40)
    t.c.resize(151, 40)
    expect(texts(s1)).toEqual(['{"resize":{"cols":150,"rows":40},"focus":true}', '{"resize":{"cols":151,"rows":40}}'])
  })

  it('says nothing to a daemon from before v2, which would not understand it', () => {
    const t = mount()
    const s1 = last()
    s1.accept('')
    t.c.focus()
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    t.c.resize(100, 30)
    expect(texts(s1)).toEqual(['{"resize":{"cols":100,"rows":30}}'])
  })

  // Vova (2026-10-13): the desktop stayed at a phone's width after the phone
  // was put away. The claim re-sends the size, the latest of a burst.
  it('a claim with a size sends it in the same frame', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    t.c.focus(150, 40)
    t.c.focus(151, 40)
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    expect(texts(s1)).toEqual(['{"resize":{"cols":151,"rows":40},"focus":true}'])
    t.c.focus()
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    expect(texts(s1)[1]).toBe('{"focus":true}')
  })

  it('going out of sight sends blur at once and drops a claim still waiting', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    t.c.focus(150, 40)
    t.c.blur()
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    expect(texts(s1)).toEqual(['{"blur":true}'])
    // The next first size is not a claim.
    t.c.resize(150, 40)
    expect(texts(s1)[1]).toBe('{"resize":{"cols":150,"rows":40}}')
  })

  it('a blur with no socket, or to a daemon from before v2, says nothing', () => {
    const t = mount()
    const s1 = last()
    t.c.blur()
    s1.accept('')
    t.c.blur()
    expect(texts(s1)).toEqual([])
  })
})

// Vova, 2026-10-15: after a Wi-Fi drop every tab hung at "Reconnecting…"
// and nothing he typed went anywhere until the tab was closed. Each case
// below is a way the client could stop trying for good; none may.
describe('TermClient — never stops trying (the Wi-Fi drop)', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('a half-open socket — open, silent, no close event — is replaced within DEAD_MS and input goes through', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 5, reset: true, ack: 0 } })
    s1.bytes(5, 'ready')
    expect(t.c.state).toBe('live')
    // The network goes; the browser still says OPEN and never fires close.
    t.c.send('ls\r')
    vi.advanceTimersByTime(DEAD_MS)
    expect(FakeSocket.all.length).toBeGreaterThan(1)
    expect(t.states).toContain('reconnecting')
    vi.advanceTimersByTime(30_000)
    const s2 = last()
    expect(s2.query.get('since')).toBe('5')
    s2.accept()
    s2.text({ hello: { v: 2, offset: 5, reset: false, ack: 0 } })
    expect(t.c.state).toBe('live')
    // What was typed into the dead socket is sent again on the new one.
    expect(s2.inputs().map((i) => i.text)).toEqual(['ls\r'])
    t.c.send('pwd\r')
    expect(s2.inputs().map((i) => i.text)).toEqual(['ls\r', 'pwd\r'])
  })

  it('a WebSocket constructor that throws is retried, not the end of the client', () => {
    const t = mount()
    last().drop()
    // The browser refuses to start sockets for a while (a network stack
    // being replaced under it).
    const Real = FakeSocket
    let refusing = true
    vi.stubGlobal('WebSocket', class extends Real {
      constructor(url: string, p: string[]) {
        if (refusing) throw new DOMException('refused', 'SecurityError')
        super(url, p)
      }
    })
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow()
    expect(t.c.state).toBe('reconnecting')
    expect(t.c.link.attempt).toBeGreaterThan(2)
    refusing = false
    const before = FakeSocket.all.length
    vi.advanceTimersByTime(t.c.link.nextAt! - Date.now())
    expect(FakeSocket.all).toHaveLength(before + 1)
    last().accept()
    last().text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    expect(t.c.state).toBe('live')
  })

  it('a close the browser never reports is caught by the watchdog', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    // The socket dies; its close event is lost (no onclose call at all),
    // and the daemon's pings stop.
    s1.readyState = FakeSocket.CLOSED
    vi.advanceTimersByTime(DEAD_MS + LIVENESS_CHECK_MS)
    expect(t.c.state).toBe('reconnecting')
    vi.advanceTimersByTime(20_000)
    expect(FakeSocket.all.length).toBeGreaterThan(1)
  })

  it('a retry timer that never fires is noticed and the attempt made anyway', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    // The page loses the one timer the retry was waiting on.
    const realSetTimeout = globalThis.setTimeout
    let lost = 0
    vi.stubGlobal('setTimeout', ((_fn: () => void, ms?: number) => { lost++; return realSetTimeout(() => {}, ms ?? 0) }) as typeof setTimeout)
    s1.drop()
    vi.unstubAllGlobals()
    vi.stubGlobal('WebSocket', FakeSocket)
    expect(lost).toBe(1)
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(t.c.link.nextAt! - Date.now() + RETRY_OVERDUE_MS + 2 * LIVENESS_CHECK_MS)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('a pending attempt that never opens or fails is abandoned for a new one, forever', () => {
    mount()
    // Every attempt hangs in CONNECTING (an SYN the network lost).
    vi.advanceTimersByTime(5 * 60_000)
    expect(FakeSocket.all.length).toBeGreaterThan(10)
    // Each old attempt was closed; only the newest is still trying.
    expect(FakeSocket.all.slice(0, -1).every((s) => s.readyState === FakeSocket.CLOSED)).toBe(true)
  })

  it('the online event retries at once instead of waiting out a 15 s backoff', () => {
    const t = mount()
    for (let i = 0; i < 8; i++) { last().drop(); vi.advanceTimersByTime(t.c.link.nextAt! - Date.now()) }
    last().drop()
    expect(t.c.link.nextAt! - Date.now()).toBeGreaterThan(400)
    const before = FakeSocket.all.length
    // TerminalPane and Terminal call wake() on online, focus, visibility.
    t.c.wake()
    expect(FakeSocket.all).toHaveLength(before + 1)
  })

  it('a flow-control pause whose parse callbacks never come resumes after STALL_MS', () => {
    const t = mount({ write: () => { /* the terminal never reports parsing it */ } })
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
    s1.bytes(0, '')
    const chunk = 'x'.repeat(64 * 1024)
    let off = 0
    while (off <= HIGH_WATER) { s1.bytes(off, chunk); off += chunk.length }
    expect(s1.readyState).toBe(FakeSocket.CLOSED)
    expect(t.c.state).toBe('catching-up')
    // A wake while paused does not open a socket, but cannot stop the watchdog either.
    t.c.wake()
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(STALL_MS + LIVENESS_CHECK_MS)
    expect(FakeSocket.all).toHaveLength(2)
    expect(last().query.get('since')).toBe(String(off))
  })

  it('Reconnect now opens a socket at once, from the offset, even for a let-go tab', () => {
    const t = mount()
    const s1 = last()
    s1.accept()
    s1.text({ hello: { v: 2, offset: 3, reset: true, ack: 0 } })
    s1.bytes(3, 'abc')
    t.c.suspend()
    expect(FakeSocket.all).toHaveLength(1)
    t.c.reconnectNow()
    expect(FakeSocket.all).toHaveLength(2)
    expect(last().query.get('since')).toBe('3')
    // And in the middle of a backoff.
    last().drop()
    const before = FakeSocket.all.length
    t.c.reconnectNow()
    expect(FakeSocket.all).toHaveLength(before + 1)
  })

  it('offers the button only once the retries have failed a few times or for a while', () => {
    const now = 1_000_000
    expect(offersManualRetry({ phase: 'reconnecting', attempt: 1, downSince: now - 2_000 }, now)).toBe(false)
    expect(offersManualRetry({ phase: 'reconnecting', attempt: 3, downSince: now - 2_000 }, now)).toBe(true)
    expect(offersManualRetry({ phase: 'reconnecting', attempt: 1, downSince: now - 10_000 }, now)).toBe(true)
    expect(offersManualRetry({ phase: 'live', attempt: 9, downSince: null }, now)).toBe(false)
    expect(offersManualRetry({ phase: 'ended', attempt: 9, downSince: now - 60_000 }, now)).toBe(false)
  })

  it('stops watching once ended or disposed: no timer keeps a closed tab alive', () => {
    const t = mount()
    last().accept()
    last().drop(1000)
    expect(t.c.state).toBe('ended')
    expect(vi.getTimerCount()).toBe(0)
    const u = mount()
    u.c.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
