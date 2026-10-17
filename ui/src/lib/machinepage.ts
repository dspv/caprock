/**
 * The machine page (ADR-067): this dashboard opened at `/?machine=<id>` in a
 * frame of the local one, showing one of computer id's sessions. Kept apart
 * from lib/machines.ts, with no imports, because main.tsx reads it before
 * any screen loads and the entry chunk stays small.
 */

/** Where a computer's own API is reached through this machine's daemon. */
export function machineBase(id: string): string {
  return `/v1/m/${encodeURIComponent(id)}`
}

/** The query flag of the machine page: `/?machine=<id>`. */
export const MACHINE_QUERY = 'machine'

/** The computer this page shows, or '' when it is this machine's own dashboard. */
export function machinePageId(search: string = typeof location === 'undefined' ? '' : location.search): string {
  const id = new URLSearchParams(search).get(MACHINE_QUERY) ?? ''
  return /^[A-Za-z0-9_-]{16,128}$/.test(id) ? id : ''
}

/** The machine page's address for one of computer id's sessions. */
export function machinePageURL(id: string, session: string, tab?: string): string {
  return `/?${MACHINE_QUERY}=${encodeURIComponent(id)}#/session/${encodeURIComponent(session)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`
}

/**
 * The URL a request of the machine page goes to: this daemon's `/v1/…` and
 * `/healthz` become computer id's, through the proxy; everything else (the
 * page's own files) is left alone. `ws:`/`wss:` are matched as their http
 * counterparts.
 */
export function rewriteForMachine(url: string, id: string, origin: string): string | null {
  let u: URL
  try {
    u = new URL(url.replace(/^ws(s?):/, 'http$1:'), origin)
  } catch {
    return null
  }
  const o = new URL(origin)
  if (u.host !== o.host) return null
  if (!(u.pathname.startsWith('/v1/') || u.pathname === '/healthz')) return null
  if (u.pathname.startsWith('/v1/m/')) return null // already a computer's
  const ws = /^wss?:/.test(url)
  const proto = ws ? (o.protocol === 'https:' ? 'wss:' : 'ws:') : o.protocol
  return `${proto}//${o.host}${machineBase(id)}${u.pathname}${u.search}`
}

/**
 * Makes this page's fetch() and WebSocket for `/v1/…` go to computer id
 * through this daemon's proxy. Run once, before anything asks.
 */
export function installMachineProxy(id: string, w: Window & typeof globalThis = window): void {
  const nativeFetch = w.fetch.bind(w)
  const NativeWebSocket = w.WebSocket
  const origin = w.location.origin
  w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const to = rewriteForMachine(url, id, origin)
    if (!to) return nativeFetch(input, init)
    if (typeof input === 'string' || input instanceof URL) return nativeFetch(to, init)
    return nativeFetch(new Request(to, input), init)
  }) as typeof fetch
  const Shim = function (url: string | URL, protocols?: string | string[]) {
    const to = rewriteForMachine(String(url), id, origin)
    return new NativeWebSocket(to ?? url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: NativeWebSocket.prototype })
  w.WebSocket = Shim
}
