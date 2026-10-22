/**
 * A terminal the daemon keeps refusing says why, and one whose session is
 * gone stops (0.147.0: after the background service restarted, tabs whose
 * processes had died read "Reconnecting…" for good). A browser is never told
 * why an upgrade failed, so the client asks the same route by a plain GET.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_MAX_MS, DIAGNOSE_AFTER, DIAGNOSE_EVERY_MS, TERM_V2_PROTOCOL, TermClient, diagnosisUrl, refusalFor, type TermState,
} from './termv2'
import { readLink } from '@/components/ConnectionState'
import { detachedSession } from '@/components/ObservePane'

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static all: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  protocol = ''
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason?: string }) => void) | null = null
  constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.all.push(this) }
  send() {}
  close() { this.readyState = FakeSocket.CLOSED }
  accept() { this.protocol = TERM_V2_PROTOCOL; this.readyState = FakeSocket.OPEN; this.onopen?.() }
  text(v: unknown) { this.onmessage?.({ data: JSON.stringify(v) }) }
  drop(code = 1006) { this.readyState = FakeSocket.CLOSED; this.onclose?.({ code }) }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!

/** A client whose daemon answers the plain GET with `status()`; 0 is no answer at all. */
function mount(status: () => number, body = '') {
  const asked: { url: string; headers: Record<string, string> }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const code = status()
    if (code === 0) throw new TypeError('Load failed')
    return new Response(code === 204 ? null : body, { status: code })
  }) as unknown as typeof fetch
  let gone = 0
  const states: TermState[] = []
  const c = new TermClient({
    url: 'ws://127.0.0.1:4173/v1/agents/s1/term',
    deviceToken: 'tok',
    random: () => 0.5,
    fetch: f,
    callbacks: { write: (_d, done) => done(), reset: () => {}, state: (s) => states.push(s), gone: () => { gone++ } },
  })
  c.start()
  return { c, asked, states, gone: () => gone }
}

/**
 * Sockets that close without ever opening, each until the next attempt is
 * made (not past it: a socket left opening would be abandoned by the
 * watchdog, a refusal of its own).
 */
async function refuse(times: number) {
  for (let i = 0; i < times; i++) {
    const n = FakeSocket.all.length
    last().drop(1006)
    for (let ms = 0; ms < BACKOFF_MAX_MS + 1000 && FakeSocket.all.length === n; ms += 100) {
      await vi.advanceTimersByTimeAsync(100)
    }
  }
}

function live() {
  last().accept()
  last().text({ hello: { v: 2, offset: 0, reset: true, ack: 0 } })
}

describe('TermClient — a refused terminal says why', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('asks the daemon why after three refusals in a row, shows it, and clears it once live', async () => {
    const t = mount(() => 501, 'spawning unavailable\n')
    await refuse(DIAGNOSE_AFTER - 1)
    expect(t.asked).toHaveLength(0)
    await refuse(1)
    expect(t.asked).toHaveLength(1)
    expect(t.asked[0]!.url).toBe('http://127.0.0.1:4173/v1/agents/s1/term')
    expect(t.asked[0]!.headers['X-Caprock-Device']).toBe('tok')
    expect(t.c.link.refusal).toBe(refusalFor(501))
    expect(t.c.link.refusal).toMatch(/caprock down/)
    // Still trying: a refusal that ends connects as usual.
    expect(t.c.state).toBe('reconnecting')
    live()
    expect(t.c.state).toBe('live')
    expect(t.c.link.refusal).toBeUndefined()
  })

  it('a socket that opens and drops (a network blip) is never diagnosed', async () => {
    const t = mount(() => 409)
    for (let i = 0; i < DIAGNOSE_AFTER + 3; i++) {
      live()
      await refuse(1) // drops the open socket: not a refusal
    }
    expect(t.asked).toHaveLength(0)
    expect(t.gone()).toBe(0)
  })

  it('asks at most every 15 s while the refusals go on', async () => {
    const t = mount(() => 500)
    await refuse(DIAGNOSE_AFTER)
    expect(t.asked).toHaveLength(1)
    await refuse(1) // within 15 s of the first
    expect(t.asked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(DIAGNOSE_EVERY_MS)
    await refuse(1)
    expect(t.asked).toHaveLength(2)
  })

  it('a session the daemon no longer holds stops retrying, ended, within a bounded time', async () => {
    const t = mount(() => 409, 'session is not owned by caprock')
    const started = Date.now()
    await refuse(DIAGNOSE_AFTER)
    expect(t.c.link.refusal).toBe(refusalFor(409))
    expect(t.gone()).toBe(0) // once may be a restart under the same id
    for (let i = 0; i < 10 && t.gone() === 0; i++) await refuse(1)
    expect(t.gone()).toBe(1)
    expect(t.c.state).toBe('ended')
    expect(t.states.at(-1)).toBe('ended')
    expect(Date.now() - started).toBeLessThan(60_000)
    const sockets = FakeSocket.all.length
    await vi.advanceTimersByTimeAsync(5 * BACKOFF_MAX_MS)
    expect(FakeSocket.all.length).toBe(sockets)
  })

  it('a 409 that turns into an open socket is not gone (a restart under the same id)', async () => {
    let code = 409
    const t = mount(() => code)
    await refuse(DIAGNOSE_AFTER)
    code = 204
    live()
    expect(t.c.state).toBe('live')
    await refuse(DIAGNOSE_AFTER + 2)
    expect(t.gone()).toBe(0)
  })

  it('a daemon that does not answer at all is said so', async () => {
    const t = mount(() => 0)
    await refuse(DIAGNOSE_AFTER)
    expect(t.c.link.refusal).toBe(refusalFor(0))
  })

  it('the state indicator says "Can’t connect" with the reason, not "Reconnecting"', () => {
    const r = readLink({ phase: 'reconnecting', attempt: 4, nextAt: 10_000, downSince: 0, refusal: refusalFor(501) }, 0, 5_000)
    expect(r.label).toMatch(/^Can’t connect/)
    expect(r.title).toContain(refusalFor(501)!)
    expect(readLink({ phase: 'reconnecting', attempt: 4, nextAt: 10_000, downSince: 0 }, 0, 5_000).label).toMatch(/^Reconnecting/)
  })

  it('a restored tab of a running session this daemon does not hold is turned into its conversation', () => {
    expect(detachedSession({ kind: 'agent', status: 'active', owned: true, detached: true })).toBe(true)
    expect(detachedSession({ kind: 'agent', status: 'active', owned: false })).toBe(true)
    expect(detachedSession({ kind: 'agent', status: 'active', owned: true })).toBe(false)
    expect(detachedSession({ kind: 'agent', status: 'ended', owned: true })).toBe(false)
    expect(detachedSession({ kind: 'shell', status: 'active', owned: true, detached: true })).toBe(false)
  })

  it('puts every answer in words with what to do', () => {
    expect(diagnosisUrl('wss://h:1/v1/agents/a/term')).toBe('https://h:1/v1/agents/a/term')
    expect(refusalFor(409)).toMatch(/no longer running/)
    expect(refusalFor(204)).toMatch(/caprock down/)
    expect(refusalFor(403, 'shells are used on the machine Caprock runs on')).toMatch(/shell/)
    expect(refusalFor(502, 'bad gateway')).toMatch(/HTTP 502: bad gateway/)
  })
})
