/**
 * One reconnect policy for every socket the dashboard keeps open — `/v1/live`
 * (lib/live.ts) and each terminal (lib/termv2.ts) — so a phone on a bad
 * network never needs a manual reconnect (.ai/21-app.md § Phone v2, WP-13).
 *
 * - **Forever.** Exponential backoff with full jitter, 0.5 s to a 15 s cap,
 *   never giving up.
 * - **At once** when the page or the network comes back: `visibilitychange`,
 *   `online`, `pageshow` (the back/forward cache) and a network type change.
 * - **Honest.** A socket silent for DEAD_MS is dead whatever the browser says,
 *   and a woken page asks for a round trip before it trusts an open socket.
 *
 * Kept free of React so it can be driven by fake timers.
 */

/** How often each side says it is alive (protocol v2 and /v1/live). */
export const PING_MS = 10_000
/** Silence after which a socket is taken for dead. */
export const DEAD_MS = 25_000
/** How often a client checks its socket's silence. */
export const LIVENESS_CHECK_MS = 1_000
/** After a wake, how long an open socket has to answer a ping before it is dropped. */
export const PROBE_MS = 2_000
/** An attempt still not open after this is abandoned for a new one (a SYN lost on a bad network). */
export const CONNECT_TIMEOUT_MS = 10_000
/** The first retry's delay, and the floor of every later one… */
export const RECONNECT_MIN_MS = 500
/** …and the cap the doubling stops at. */
export const RECONNECT_MAX_MS = 15_000

/**
 * Where a connection stands, as the state indicator says it
 * (components/ConnectionState.tsx).
 */
export type LinkPhase = 'connecting' | 'live' | 'catching-up' | 'reconnecting' | 'ended' | 'revoked'

export interface ReconnectStatus {
  /** Attempts made since the link was last live. */
  attempt: number
  /** When the next attempt starts (ms since the epoch); null when none waits. */
  nextAt: number | null
  /** When the link was lost; null while live or before it ever was. */
  downSince: number | null
}

export interface LinkStatus extends ReconnectStatus {
  phase: LinkPhase
  /** Why the link was revoked, in words for the user. */
  reason?: string
}

/**
 * The delay before retry `attempt` (0-based): uniform between
 * RECONNECT_MIN_MS and a ceiling that doubles from it up to RECONNECT_MAX_MS
 * ("full jitter"), so phones that lost the same Wi-Fi do not return in step.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceil = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(Math.max(attempt, 0), 16))
  return Math.round(RECONNECT_MIN_MS + random() * (ceil - RECONNECT_MIN_MS))
}

/** True once a socket last heard from at `heardAt` must be taken for dead. */
export function isSilent(heardAt: number, now: number): boolean {
  // One check interval early, so a dead socket is caught within DEAD_MS of
  // the last thing it said, not DEAD_MS plus however late the check ran.
  return now - heardAt > DEAD_MS - LIVENESS_CHECK_MS
}

/** True when an attempt started at `startedAt` has hung in CONNECTING too long. */
export function isConnectStuck(readyState: number, startedAt: number, now: number): boolean {
  return readyState === 0 && now - startedAt > CONNECT_TIMEOUT_MS
}

/** True when a ping sent at `probeAt` went unanswered for PROBE_MS. */
export function isProbeLost(probeAt: number, heardAt: number, now: number): boolean {
  return probeAt > 0 && heardAt <= probeAt && now - probeAt >= PROBE_MS
}

export interface ReconnectorOptions {
  /** Open a new socket. */
  connect: () => void
  /** The status changed (an attempt was scheduled, started or succeeded). */
  onChange?: (status: ReconnectStatus) => void
  /** Injected for tests. */
  random?: () => number
  now?: () => number
}

/** Schedules the retries of one connection. */
export class Reconnector {
  private attempt = 0
  private nextAt: number | null = null
  private downSince: number | null = null
  /** The network came back while an attempt was under way. */
  private expedited = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly random: () => number
  private readonly now: () => number

  constructor(private readonly opts: ReconnectorOptions) {
    this.random = opts.random ?? Math.random
    this.now = opts.now ?? Date.now
  }

  get status(): ReconnectStatus {
    return { attempt: this.attempt, nextAt: this.nextAt, downSince: this.downSince }
  }

  /** The connection was lost, or an attempt failed: retry after the backoff. */
  fail(): void {
    if (this.timer !== undefined) return
    const now = this.now()
    if (this.downSince === null) this.downSince = now
    // The page or the network came back while the failed attempt was under
    // way (it may have started on the old route): the next one goes at once.
    const delay = this.expedited ? 0 : reconnectDelay(this.attempt, this.random)
    this.expedited = false
    this.nextAt = now + delay
    this.timer = setTimeout(() => this.fire(), delay)
    this.changed()
  }

  /** The link is live again: the next loss starts from the shortest delay. */
  succeed(): void {
    this.cancel()
    this.attempt = 0
    this.downSince = null
    this.expedited = false
    this.changed()
  }

  /** Retry now rather than at the end of the backoff: the page or the network came back. */
  retryNow(): void {
    this.cancel()
    this.fire()
  }

  /** The network came back during an attempt: should it fail, retry at once. */
  expedite(): void {
    this.expedited = true
  }

  /** No retry is scheduled after this (a suspended tab, a disposed client). */
  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.nextAt = null
  }

  private fire(): void {
    this.timer = undefined
    this.nextAt = null
    this.attempt++
    this.changed()
    this.opts.connect()
  }

  private changed(): void {
    this.opts.onChange?.(this.status)
  }
}

interface NetworkInformationLike {
  addEventListener?: (type: 'change', fn: () => void) => void
  removeEventListener?: (type: 'change', fn: () => void) => void
}

/**
 * Calls `wake` whenever a dropped connection is likely to work again: the
 * page is shown, the browser is back online, the page is restored from the
 * back/forward cache, or the network type changes (Wi-Fi to cellular, where
 * the browser exposes it). Never while the page is hidden. Returns the
 * unsubscribe.
 */
export function onNetworkWake(wake: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const fire = () => { if (document.visibilityState !== 'hidden') wake() }
  const network = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  document.addEventListener('visibilitychange', fire)
  window.addEventListener('online', fire)
  window.addEventListener('pageshow', fire)
  network?.addEventListener?.('change', fire)
  return () => {
    document.removeEventListener('visibilitychange', fire)
    window.removeEventListener('online', fire)
    window.removeEventListener('pageshow', fire)
    network?.removeEventListener?.('change', fire)
  }
}
