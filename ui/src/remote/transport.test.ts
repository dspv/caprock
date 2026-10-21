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
import { ATTEMPT_MS, BACKOFF_MS, Channel, KIND, PING_MS, PROBE_MS, RECHECK_MS, REFUSALS_FOR_WRONG_MACHINE, SILENT_MS, WAKE_MS, frame, parseFrame, type Machine } from './transport'

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
  private paths = new Map<number, string>()
  /** Every request this machine was asked, by path. */
  static asked: string[] = []
  /** The status the machine answers a path with; 200 unless a test says otherwise. */
  static statusFor: (path: string) => number = () => 200
  send(d: unknown) {
    this.sent.push(d)
    if (d === 'ping') {
      if (this.relayAlive) this.onmessage?.({ data: 'pong' })
      return
    }
    if (!this.sess || !this.machineAlive) return
    const { kind, id, body } = parseFrame(this.sess.decrypt(d as Uint8Array))
    if (kind === KIND.req) this.paths.set(id, (JSON.parse(new TextDecoder().decode(body)) as { p: string }).p)
    if (kind !== KIND.reqEnd) return
    const path = this.paths.get(id) ?? ''
    FakeSocket.asked.push(path)
    const reply = (k: number, b?: Uint8Array) => this.onmessage?.({ data: this.sess!.encrypt(frame(k, id, b)).slice().buffer })
    reply(KIND.res, new TextEncoder().encode(JSON.stringify({ s: FakeSocket.statusFor(path) })))
    reply(KIND.resEnd)
  }
  /** A frame meant for someone else: what a relay reusing a number delivered. */
  stray() {
    this.onmessage?.({ data: new Uint8Array(96).fill(7).buffer })
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
  FakeSocket.asked = []
  FakeSocket.statusFor = () => 200
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

/** Opens the channel's next attempt and lets the machine answer it. */
async function answerNext(ch: Channel) {
  await vi.advanceTimersByTimeAsync(0)
  last().open()
  last().answer()
  await vi.advanceTimersByTimeAsync(0)
  expect(ch.state).toBe('open')
}

/**
 * Pairing again is asked for only on a confirmed answer, never one hiccup
 * (owner, 2026-10-14, translated: "my connection to Caprock dropped and it
 * asks me to go to Caprock settings again. It has to never drop").
 */
describe('pair again only when it is so', () => {
  it('a stray frame before the machine’s reply is skipped, not "wrong machine"', async () => {
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().stray()
    expect(ch.problem).toBe('')
    expect(ch.state).toBe('connecting')
    last().answer()
    await p
    expect(ch.state).toBe('open')
  })

  it('only stray frames until the deadline is "no answer", and tried again', async () => {
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().stray()
    vi.advanceTimersByTime(ATTEMPT_MS)
    await expect(p).rejects.toThrow()
    expect(ch.problem).toBe('no-answer')
    expect(ch.nextAt).not.toBeNull()
  })

  it('a machine refusing the handshake is "wrong machine" only after three in a row, and is still tried', async () => {
    const ch = channel()
    void ch.connect().catch(() => {})
    for (let i = 1; i <= REFUSALS_FOR_WRONG_MACHINE; i++) {
      last().open()
      last().serverClose(1000)
      await vi.advanceTimersByTimeAsync(0)
      expect(ch.problem).toBe(i < REFUSALS_FOR_WRONG_MACHINE ? 'no-answer' : 'wrong-machine')
      if (i < REFUSALS_FOR_WRONG_MACHINE) await vi.advanceTimersByTimeAsync(BACKOFF_MS[i - 1]!)
    }
    expect(ch.state).toBe('closed')
    // Behind the pair-again screen it keeps trying, once a minute…
    const n = FakeSocket.all.length
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(FakeSocket.all.length).toBe(n + 1)
    // …and comes back by itself when the machine answers after all.
    last().open()
    last().answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(ch.state).toBe('open')
    expect(ch.problem).toBe('')
  })

  it('a refusal between good connections never adds up', async () => {
    const ch = channel()
    void ch.connect().catch(() => {})
    for (let round = 0; round < 4; round++) {
      last().open()
      last().serverClose(1000)
      await vi.advanceTimersByTimeAsync(ch.nextAt! - Date.now())
      await answerNext(ch)
      last().serverClose(1006)
      await vi.advanceTimersByTimeAsync(ch.nextAt! - Date.now())
    }
    expect(ch.problem).not.toBe('wrong-machine')
  })

  it('a 401 is checked with /v1/pair/me, and a machine that still knows the token changes nothing', async () => {
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().answer()
    await p
    ch.noteStatus('/v1/status', 401, '')
    ch.noteStatus('/v1/pair', 401, 'tok')
    expect(FakeSocket.asked).toEqual([])
    ch.noteStatus('/v1/brain', 401, 'tok')
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeSocket.asked).toEqual(['/v1/pair/me'])
    expect(ch.problem).toBe('')
    expect(ch.state).toBe('open')
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('"removed" needs the machine to disown the token on two connections; until then it reconnects and asks', async () => {
    FakeSocket.statusFor = (path) => (path === '/v1/pair/me' ? 401 : 200)
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().answer()
    await p
    ch.noteStatus('/v1/status', 401, 'tok')
    await vi.advanceTimersByTimeAsync(0)
    // Once: not believed. A fresh connection asks again.
    expect(ch.problem).not.toBe('removed')
    expect(ch.state).not.toBe('open')
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!)
    last().open()
    last().answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeSocket.asked).toEqual(['/v1/pair/me', '/v1/pair/me'])
    expect(ch.problem).toBe('removed')
    // Removed, it still asks once a minute, and is back when the machine knows it again.
    FakeSocket.statusFor = () => 200
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(ch.problem).toBe('')
  })

  it('a removal that does not hold on the second connection is forgotten', async () => {
    let n = 0
    FakeSocket.statusFor = (path) => (path === '/v1/pair/me' && n++ === 0 ? 401 : 200)
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().answer()
    await p
    ch.noteStatus('/v1/live', 401, 'tok')
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!)
    await answerNext(ch)
    expect(ch.problem).toBe('')
    // And a later lone 401 starts from nothing again.
    FakeSocket.statusFor = (path) => (path === '/v1/pair/me' ? 401 : 200)
    ch.noteStatus('/v1/status', 401, 'tok')
    await vi.advanceTimersByTimeAsync(0)
    expect(ch.problem).not.toBe('removed')
  })

  it('statuses an older machine gives a newer page (403, 404, 5xx) are never a removal', async () => {
    const ch = channel()
    const p = ch.connect()
    last().open()
    last().answer()
    await p
    for (const s of [403, 404, 405, 500, 502, 503]) ch.noteStatus('/v1/brain', s, 'tok')
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeSocket.asked).toEqual([])
    expect(ch.problem).toBe('')
  })
})

// Vova, 2026-10-15: "the link doesn't load; maybe my VPN". The page's
// Details says what failed last, with the relay's code, and when.
describe('what Details reads', () => {
  it('records the last failure, the last try and the last time it was open', async () => {
    const ch = channel()
    expect(ch.lastError).toBeNull()
    const p = ch.connect()
    expect(ch.lastAttemptAt).toBe(Date.now())
    last().serverClose(1006)
    await expect(p).rejects.toThrow()
    expect(ch.lastError).toMatchObject({ problem: 'relay-unreachable', code: 1006, at: Date.now() })
    expect(ch.lastOpenAt).toBeNull()

    vi.advanceTimersByTime(ch.nextAt! - Date.now())
    last().open()
    last().serverClose(4404, 'the machine is not connected')
    await Promise.resolve()
    expect(ch.lastError).toMatchObject({ problem: 'machine-offline', code: 4404 })

    vi.advanceTimersByTime(ch.nextAt! - Date.now())
    last().open()
    last().answer()
    await Promise.resolve()
    expect(ch.state).toBe('open')
    expect(ch.lastOpenAt).toBe(Date.now())
    // The last failure stays readable after recovering.
    expect(ch.lastError?.problem).toBe('machine-offline')
    ch.close()
  })
})

// The owner, 2026-10-21 (translated): "When the phone loses network while
// Caprock is open, I see 'Retry' and 'Pair again'." A phone without a
// network is said to be one at once, and never sent to pair again.
describe('a phone that loses its network', () => {
  it('the browser saying offline hangs up an open channel at once, as no internet', async () => {
    let online = true
    const ch = new Channel(machine, FakeSocket as unknown as typeof WebSocket, () => online)
    const p = ch.connect()
    last().open()
    last().answer()
    await p
    online = false
    ch.wentOffline()
    expect(ch.state).toBe('offline')
    expect(ch.problem).toBe('no-internet')
    expect(ch.nextAt).not.toBeNull()
    online = true
    ch.wake()
    last().open()
    last().answer()
    expect(ch.state).toBe('open')
    expect(ch.problem).toBe('')
    ch.close()
  })

  it('a channel that drops while the browser is offline is no internet, whatever the socket said', async () => {
    let online = true
    const ch = new Channel(machine, FakeSocket as unknown as typeof WebSocket, () => online)
    const p = ch.connect()
    last().open()
    last().answer()
    await p
    online = false
    last().serverClose(1006)
    expect(ch.problem).toBe('no-internet')
    ch.close()
  })

  it('a relay that is down while the page origin answers nothing either is no internet', async () => {
    const ch = new Channel(machine, FakeSocket as unknown as typeof WebSocket, () => true, () => Promise.resolve(false))
    const p = ch.connect()
    last().serverClose(1006)
    await expect(p).rejects.toThrow()
    await Promise.resolve()
    expect(ch.problem).toBe('no-internet')
    ch.close()
  })

  it('a relay that is down while the page origin answers stays the relay', async () => {
    const ch = new Channel(machine, FakeSocket as unknown as typeof WebSocket, () => true, () => Promise.resolve(true))
    const p = ch.connect()
    last().serverClose(1006)
    await expect(p).rejects.toThrow()
    await Promise.resolve()
    expect(ch.problem).toBe('relay-unreachable')
    ch.close()
  })

  it('offline never touches a refused pairing', async () => {
    const ch = channel()
    void ch.connect().catch(() => {})
    for (let i = 0; i < REFUSALS_FOR_WRONG_MACHINE; i++) {
      if (i > 0) await vi.advanceTimersByTimeAsync(ch.nextAt! - Date.now())
      last().open()
      last().serverClose(1000)
      await Promise.resolve()
    }
    expect(ch.problem).toBe('wrong-machine')
    ch.wentOffline()
    expect(ch.problem).toBe('wrong-machine')
    ch.close()
  })
})
