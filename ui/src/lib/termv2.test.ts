/**
 * Terminal protocol v2 from the browser's side, against a fake daemon that
 * speaks the protocol: offsets, resume without a repaint, numbered input
 * resent until acknowledged, liveness, backpressure and reconnecting forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_MAX_MS, DEAD_MS, HIGH_WATER, OFFLINE_QUEUE_BYTES, TERM_V2_PROTOCOL,
  TermClient, backoff, type TermState,
} from './termv2'

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
  onclose: ((e: { code: number }) => void) | null = null
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
  drop(code = 1006) { this.readyState = FakeSocket.CLOSED; this.onclose?.({ code }) }
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
    vi.advanceTimersByTime(250)
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
    vi.advanceTimersByTime(250)
    const s2 = last()
    s2.accept()
    expect(s2.inputs()).toEqual([]) // nothing before the hello
    s2.text({ hello: { v: 2, offset: 0, reset: false, ack: 2 } })
    expect(s2.inputs()).toEqual([{ seq: 3, text: 'c' }, { seq: 4, text: 'd' }])
    s2.text({ ack: 4 })
    expect(t.c.unacked).toBe(0)
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

  it('reconnects forever, backing off to 5 s, and at once when the page wakes', () => {
    const t = mount()
    for (let i = 0; i < 200; i++) {
      last().drop()
      vi.advanceTimersByTime(BACKOFF_MAX_MS)
    }
    expect(FakeSocket.all).toHaveLength(201)
    last().drop()
    t.c.wake()
    expect(FakeSocket.all).toHaveLength(202)
    for (let n = 0; n < 30; n++) {
      expect(backoff(n, () => 0)).toBeGreaterThanOrEqual(125)
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
    vi.advanceTimersByTime(60_000)
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
