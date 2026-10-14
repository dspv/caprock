/**
 * The channel never sits on "Connecting…" with nothing after it (owner,
 * 2026-10-14, translated: "On the phone I now have 'Connecting' and
 * nothing"). Every way it used to wait forever — a machine asleep behind a
 * relay that still splices to it, a relay that never answers, a socket the
 * phone froze in the background — ends in a reason and a retry.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { respondForTest, type Session } from './noise'
import { ATTEMPT_MS, BACKOFF_MS, Channel, KIND, PING_MS, PROBE_MS, SILENT_MS, WAKE_MS, frame, parseFrame, type Machine } from './transport'

const v = JSON.parse(readFileSync(resolve(__dirname, '../../../testdata/remote/noise-vector.json'), 'utf8')) as {
  responder_static: string
  responder_public: string
  responder_ephemeral: string
}
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16))
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const machine: Machine = { id: 'a'.repeat(43), key: b64url(hex(v.responder_public)), relay: 'wss://relay.example', name: 'Mac mini', token: 'tok' }

/** A WebSocket the test drives: it opens, answers and closes when told. */
class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  /** The relay answers "ping"; the machine answers requests. Either can go quiet. */
  relayAlive = true
  machineAlive = true
  private sess: Session | null = null
  send(d: unknown) {
    this.sent.push(d)
    if (d === 'ping') {
      if (this.relayAlive) this.onmessage?.({ data: 'pong' })
      return
    }
    if (!this.sess || !this.machineAlive) return
    const { kind, id } = parseFrame(this.sess.decrypt(d as Uint8Array))
    if (kind !== KIND.reqEnd) return
    const reply = (k: number, body?: Uint8Array) => this.onmessage?.({ data: this.sess!.encrypt(frame(k, id, body)).slice().buffer })
    reply(KIND.res, new TextEncoder().encode('{"s":200}'))
    reply(KIND.resEnd)
  }
  close() {
    this.readyState = 3
  }
  // What the relay and the machine do:
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  answer() {
    const msg1 = this.sent[0] as Uint8Array
    const { message, session } = respondForTest(hex(v.responder_static), msg1, new TextEncoder().encode('{"v":1,"version":"t","name":"mini"}'), hex(v.responder_ephemeral))
    this.sess = session
    this.onmessage?.({ data: message.slice().buffer })
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!

function channel(online = true) {
  return new Channel(machine, FakeSocket as unknown as typeof WebSocket, () => online)
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('an attempt always ends', () => {
  it('a machine that never answers the handshake (asleep, spliced by the relay) is said so, and tried again', async () => {
    const ch = channel()
    const p = ch.connect()
    last().open()
    expect(ch.state).toBe('connecting')
    vi.advanceTimersByTime(ATTEMPT_MS)
    await expect(p).rejects.toThrow()
    expect(ch.state).toBe('offline')
    expect(ch.problem).toBe('no-answer')
    expect(ch.nextAt).not.toBeNull()
    vi.advanceTimersByTime(BACKOFF_MS[0]!)
    expect(FakeSocket.all).toHaveLength(2)
    expect(ch.state).toBe('connecting')
  })

  it('a relay that never takes the connection is "relay unreachable", or "no internet" when the phone is offline', async () => {
    const ch = channel()
    const p = ch.connect()
    vi.advanceTimersByTime(ATTEMPT_MS)
    await expect(p).rejects.toThrow()
    expect(ch.problem).toBe('relay-unreachable')

    const off = channel(false)
    const q = off.connect()
    last().serverClose(1006)
    await expect(q).rejects.toThrow()
    expect(off.problem).toBe('no-internet')
  })

  it('a machine the relay does not have is "offline", retried with growing waits, and reset once open', async () => {
    const ch = channel()
    void ch.connect().catch(() => {})
    last().open()
    last().serverClose(4404, 'the machine is not connected')
    await Promise.resolve()
    expect(ch.problem).toBe('machine-offline')
    const first = ch.nextAt! - Date.now()
    vi.advanceTimersByTime(first)
    last().open()
    last().serverClose(4404)
    await Promise.resolve()
    expect(ch.nextAt! - Date.now()).toBeGreaterThan(first)
    vi.advanceTimersByTime(ch.nextAt! - Date.now())
    last().open()
    last().answer()
    expect(ch.state).toBe('open')
    expect(ch.problem).toBe('')
    expect(ch.attempt).toBe(0)
    expect(ch.everOpen).toBe(true)
  })
})

async function opened() {
  const ch = channel()
  const p = ch.connect()
  const ws = last()
  ws.open()
  ws.answer()
  await p
  return { ch, ws }
}

describe('an open channel that goes quiet is replaced', () => {
  it('stays open for minutes while the relay pongs and the machine answers', async () => {
    const { ch } = await opened()
    await vi.advanceTimersByTimeAsync(10 * PING_MS)
    expect(ch.state).toBe('open')
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('notices a machine asleep behind a live relay: the relay pongs, the machine never answers', async () => {
    const { ch, ws } = await opened()
    ws.machineAlive = false
    await vi.advanceTimersByTimeAsync(PING_MS + PROBE_MS)
    expect(ch.state).toBe('offline')
    expect(ch.problem).toBe('no-answer')
    expect(ch.nextAt).not.toBeNull()
  })

  it('drops a channel that has heard nothing at all, not even a pong, for SILENT_MS', async () => {
    const { ch, ws } = await opened()
    ws.relayAlive = false
    ws.machineAlive = false
    // The probe would notice first; SILENT_MS is the floor under it.
    await vi.advanceTimersByTimeAsync(Math.max(PING_MS + PROBE_MS, SILENT_MS))
    expect(ch.state).not.toBe('open')
  })

  it('back from the background, asks the machine and reconnects when no answer comes in WAKE_MS', async () => {
    const { ch, ws } = await opened()
    ws.machineAlive = false
    await vi.advanceTimersByTimeAsync(1000)
    ch.wake()
    await vi.advanceTimersByTimeAsync(WAKE_MS)
    expect(ch.problem).toBe('no-answer')
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!)
    expect(FakeSocket.all.length).toBe(2)
  })

  it('an answer in time keeps it', async () => {
    const { ch } = await opened()
    await vi.advanceTimersByTimeAsync(1000)
    ch.wake()
    await vi.advanceTimersByTimeAsync(WAKE_MS)
    expect(ch.state).toBe('open')
  })

  it('a channel that is down tries at once on wake, without waiting out the backoff', async () => {
    const ch = channel()
    void ch.connect().catch(() => {})
    last().serverClose(4404)
    await Promise.resolve()
    expect(FakeSocket.all).toHaveLength(1)
    ch.wake()
    expect(FakeSocket.all).toHaveLength(2)
  })
})

describe('only pairing again helps', () => {
  it('a reply from another key closes the channel for good', async () => {
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().onmessage?.({ data: new Uint8Array(64).fill(7).buffer })
    await expect(p).rejects.toThrow()
    expect(ch.state).toBe('closed')
    expect(ch.problem).toBe('wrong-machine')
    expect(ch.nextAt).toBeNull()
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.all).toHaveLength(1)
    await expect(ch.retryNow()).rejects.toThrow()
  })

  it('a 401 to a request that carried the token means this phone was removed; one without a token does not', async () => {
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().answer()
    await p
    ch.noteStatus('/v1/status', 401, false)
    expect(ch.problem).toBe('')
    ch.noteStatus('/v1/pair', 401, true)
    expect(ch.problem).toBe('')
    ch.noteStatus('/v1/status', 401, true)
    expect(ch.problem).toBe('removed')
    last().serverClose(1006)
    expect(ch.problem).toBe('removed')
    expect(ch.nextAt).toBeNull()
  })
})
