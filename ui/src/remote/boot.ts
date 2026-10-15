/**
 * The phone's page, before the dashboard loads (ADR-058).
 *
 * Served from the remote page (m.caprock.dev, or the owner's own), not by a
 * daemon, so there is no machine behind its origin. This file decides which
 * machine the page is for and makes fetch() and WebSocket for /v1/… go to it
 * through the relay; after that the dashboard is the dashboard.
 *
 * - **Machines** are kept in this browser: each one's relay, id, pinned key,
 *   name and device token. Several machines, one at a time — a laptop and the
 *   Mac mini in the cupboard.
 * - **A pairing link** (the QR on the machine) adds or refreshes a machine and
 *   hands its six-digit code to the dashboard's own pairing screen, which
 *   trades it for a token the usual way, over the channel.
 * - **The device token** the dashboard reads from `caprock.device.token` is
 *   the current machine's; switching machines swaps it and reloads.
 */
import { Channel, ChannelSocket, channelFetch, type Machine } from './transport'

const MACHINES_KEY = 'caprock.remote.machines'
const CURRENT_KEY = 'caprock.remote.current'
const PAIRING_KEY = 'caprock.remote.pairing'
export const DEVICE_TOKEN_KEY = 'caprock.device.token'

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, v: unknown) {
  try {
    if (v === null || v === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, typeof v === 'string' ? v : JSON.stringify(v))
  } catch { /* private mode: the phone pairs again next time */ }
}

function raw(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function machines(): Machine[] {
  return read<Machine[]>(MACHINES_KEY, []).filter((m) => m && m.id && m.key && m.relay)
}

export function saveMachines(ms: Machine[]) {
  write(MACHINES_KEY, ms)
}

export function currentId(): string {
  return raw(CURRENT_KEY)
}

export function currentMachine(): Machine | undefined {
  const ms = machines()
  return ms.find((m) => m.id === currentId()) ?? ms[0]
}

/** A pairing link's machine and code, or null when the hash is not one. */
export function parsePairLink(hash: string): { machine: Machine; code: string } | null {
  const [path, query] = hash.replace(/^#\/?/, '').split('?')
  if (path !== 'pair' || !query) return null
  const q = new URLSearchParams(query)
  const relay = q.get('r') ?? ''
  const id = q.get('h') ?? ''
  const key = q.get('k') ?? ''
  if (!relay || !/^[A-Za-z0-9_-]{43}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null
  if (!relayAllowed(relay)) return null
  const code = (q.get('c') ?? '').replace(/\D/g, '')
  return { machine: { id, key, relay, name: (q.get('n') ?? '').slice(0, 64) || 'Caprock', token: '' }, code: code.length === 6 ? code : '' }
}

/** wss:// anywhere; ws:// only to this device itself, for development. */
export function relayAllowed(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'wss:') return true
    return u.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/**
 * Runs once, before the dashboard: applies a pairing link if the page was
 * opened with one, adopts the token the pairing screen just stored, and puts
 * the current machine's token where the dashboard looks for it.
 */
export function prepare(loc: Location = window.location, hist: History = history): Machine | undefined {
  const ms = machines()
  const link = parsePairLink(loc.hash)
  if (link) {
    const old = ms.find((m) => m.id === link.machine.id)
    const next = ms.filter((m) => m.id !== link.machine.id)
    // A fresh link for a machine already here keeps its name if the link
    // has none. Its token stays on the record as a fallback while the
    // dashboard sends none: opening a QR whose code was already spent (the
    // camera, then the app) must not cost a pairing that worked.
    next.push({
      ...link.machine,
      name: link.machine.name === 'Caprock' && old ? old.name : link.machine.name,
      token: old?.token ?? '',
    })
    saveMachines(next)
    write(CURRENT_KEY, link.machine.id)
    if (!link.code && old?.token) {
      // A link with no code to redeem (Copy link without a code, an old
      // QR): nothing to pair with, so the phone stays paired as it was.
      write(PAIRING_KEY, null)
      write(DEVICE_TOKEN_KEY, old.token)
      hist.replaceState(null, '', loc.pathname + '#/')
      return next.find((m) => m.id === link.machine.id)
    }
    write(PAIRING_KEY, link.machine.id)
    write(DEVICE_TOKEN_KEY, null)
    // Onto the dashboard's own pairing screen, which redeems the code over
    // the channel; the link's keys leave the address bar and the history.
    hist.replaceState(null, '', loc.pathname + (link.code ? `#/pair?code=${link.code}` : '#/pair'))
    return next.find((m) => m.id === link.machine.id)
  }

  const cur = currentMachine()
  if (!cur) return undefined
  const token = raw(DEVICE_TOKEN_KEY)
  if (raw(PAIRING_KEY) === cur.id) {
    if (token) {
      // The pairing screen stored this machine's new token and reloaded.
      cur.token = token
      saveMachines(ms.map((m) => (m.id === cur.id ? cur : m)))
      write(PAIRING_KEY, null)
      keepStorage()
    } else if (cur.token) {
      // Pairing again did not finish (a spent or expired code, or the page
      // closed first): back to the token that worked before.
      write(DEVICE_TOKEN_KEY, cur.token)
      write(PAIRING_KEY, null)
    }
  } else if (!cur.token && token) {
    // The token only where the dashboard reads it, and not on the record (a
    // record from an older page, or one a write did not reach): the record
    // takes it, since the record is what survives the next switch or link.
    cur.token = token
    saveMachines(ms.map((m) => (m.id === cur.id ? cur : m)))
  } else {
    // The record is the source of truth: it is never cleared here, and a
    // token is only ever replaced by a pairing that completed (above).
    write(DEVICE_TOKEN_KEY, cur.token || null)
  }
  write(CURRENT_KEY, cur.id)
  return cur
}

/**
 * Asks the browser to keep this origin's storage — the token is the pairing,
 * and a browser short of space, or Safari's tracking rules, may otherwise
 * clear it (Vova, 2026-10-15: a phone paired yesterday has to open today with
 * nothing but the address). A request the browser may refuse quietly; the
 * page works either way.
 */
export function keepStorage(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator) {
  try {
    void nav?.storage?.persist?.().catch(() => {})
  } catch { /* an old browser */ }
}

/**
 * True when this browser has the machine on its list but holds no token for
 * it and is not in the middle of pairing: storage was partly cleared, or the
 * pairing never finished. The page says so instead of a pairing form or an
 * error (Vova, 2026-10-15).
 */
export function notPairedHere(m: Machine | undefined): boolean {
  return Boolean(m) && !m!.token && !raw(DEVICE_TOKEN_KEY) && raw(PAIRING_KEY) !== m!.id
}

/**
 * The code a pairing link carried did not work (spent, expired, mistyped):
 * back to the token that worked before, when this machine had one. True when
 * there was one to go back to; the caller reloads.
 */
export function abandonPairing(): boolean {
  const cur = currentMachine()
  if (!cur?.token || raw(PAIRING_KEY) !== cur.id) return false
  write(DEVICE_TOKEN_KEY, cur.token)
  write(PAIRING_KEY, null)
  return true
}

/** Makes another machine current; the caller reloads. */
export function selectMachine(id: string) {
  const m = machines().find((x) => x.id === id)
  if (!m) return
  write(CURRENT_KEY, id)
  write(PAIRING_KEY, null)
  write(DEVICE_TOKEN_KEY, m.token || null)
}

/** Forgets a machine on this phone. The machine keeps its own record until revoked there. */
export function forgetMachine(id: string) {
  const rest = machines().filter((m) => m.id !== id)
  saveMachines(rest)
  if (currentId() === id) {
    write(CURRENT_KEY, rest[0]?.id ?? null)
    write(DEVICE_TOKEN_KEY, rest[0]?.token || null)
  }
}

let channel: Channel | null = null

/** The channel to the current machine, once install() has run. */
export function currentChannel(): Channel | null {
  return channel
}

/** True for a URL the dashboard means for its daemon: same origin, /v1/ or /healthz. */
export function forDaemon(url: string, origin = window.location.origin): boolean {
  try {
    const u = new URL(url, origin)
    const same = u.host === new URL(origin).host
    return same && (u.pathname.startsWith('/v1/') || u.pathname === '/healthz')
  } catch {
    return false
  }
}

/**
 * Routes the dashboard's requests for its daemon through the channel to m.
 * Everything else — the page's own files — goes where it would have.
 */
export function install(m: Machine, w: Window & typeof globalThis = window) {
  const NativeWebSocket = w.WebSocket
  const nativeFetch = w.fetch.bind(w)
  channel = new Channel(m, NativeWebSocket)
  const ch = channel
  w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return forDaemon(url) ? channelFetch(ch, input, init) : nativeFetch(input, init)
  }) as typeof fetch
  const Shim = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const s = String(url)
    if (forDaemon(s.replace(/^ws/, 'http'))) return new ChannelSocket(ch, s, protocols)
    return new NativeWebSocket(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  w.WebSocket = Shim
  void ch.connect().catch(() => { /* the bar shows the state; the channel retries */ })
  // Back from the background (a phone freezes the page there), or back on
  // the network: check the channel now rather than at the next retry.
  const wake = () => ch.wake()
  w.document.addEventListener('visibilitychange', () => {
    if (w.document.visibilityState === 'visible') wake()
  })
  w.addEventListener('online', wake)
  w.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) wake()
  })
}
