/**
 * The iOS app's demo mode (ADR-083): "Try it without a Mac".
 *
 * The dashboard asks its daemon for everything with fetch() and WebSocket on
 * its own origin, as it does through the relay on the phone's page. Here the
 * same requests are answered from bundled sample data (fixture.ts): reads get
 * the sample, every change is refused with a line saying the demo sends
 * nothing, and sockets open and stay quiet. No request leaves the phone.
 */
import { buildFixture, chatList, detail, type Fixture } from './fixture'

export const DEMO_MACHINE_NAME = 'Sample Mac'

/** What the demo says to anything that would change something. */
export const DEMO_REFUSAL = 'Sample data: the demo sends nothing. Pair with your Mac to use your own sessions.'

const INSTALLED = '__caprockDemo'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** A URL the dashboard means for its daemon: same origin, /v1/… or /healthz. */
function forDaemon(raw: string, origin: string): URL | null {
  try {
    const u = new URL(raw, origin)
    if (u.host !== new URL(origin).host) return null
    return u.pathname.startsWith('/v1/') || u.pathname === '/healthz' ? u : null
  } catch {
    return null
  }
}

/** The answer to one request, from the sample. Exported for the tests. */
export function answer(f: Fixture, method: string, u: URL): Response {
  if (u.pathname === '/healthz') return json({ ok: true })
  if (method !== 'GET' && method !== 'HEAD') return json({ error: DEMO_REFUSAL }, 403)
  const p = u.pathname
  const q = u.searchParams
  const limit = Number(q.get('limit') ?? 0)
  const parts = p.split('/').filter(Boolean) // ['v1', …]
  switch (p) {
    case '/v1/status': return json(f.status)
    case '/v1/pair/me': return json(f.pairMe)
    case '/v1/premium': return json(f.premium)
    case '/v1/projects': return json(f.projects)
    case '/v1/inbox': return json(f.inbox)
    case '/v1/stats/limits': return json(f.limits)
    case '/v1/agents/catalog': return json(f.catalog)
    case '/v1/tabs': return json(f.tabs)
    case '/v1/chats': return json(chatList(f, limit))
    case '/v1/saved-prompts': return json({ items: [], max: 100 })
    case '/v1/sessions': {
      const chats = q.get('chats')
      let items = chats === 'only' ? f.chats : chats === 'exclude' ? f.sessions : [...f.sessions, ...f.chats]
      if (q.get('active') === 'true') items = items.filter((s) => s.status !== 'ended')
      const page = limit > 0 ? items.slice(0, limit) : items
      return json(page, 200, { 'X-Total-Count': String(items.length) })
    }
  }
  if (parts[1] === 'sessions' && parts[2]) {
    const id = decodeURIComponent(parts[2])
    if (parts.length === 3) {
      const d = detail(f, id)
      return d ? json(d) : json({ error: 'not in the sample data' }, 404)
    }
    if (parts[3] === 'events') {
      const kinds = q.get('kind')?.split(',').filter(Boolean)
      let list = f.events[id] ?? []
      if (kinds?.length) list = list.filter((e) => kinds.includes(e.kind))
      const after = Number(q.get('after') ?? 0)
      if (after > 0) list = list.filter((e) => e.id > after)
      if (q.has('before')) return json([])
      return json(limit > 0 ? list.slice(-limit) : list)
    }
  }
  if (parts[1] === 'agents' && parts[2] && parts[3] === 'permission') {
    return json({ permission: f.permissions[decodeURIComponent(parts[2])] ?? null })
  }
  if (parts[1] === 'chats' && parts[2] && parts[3] === 'files') return json([])
  return json({ error: 'not in the sample data' }, 404)
}

type Handler = ((this: WebSocket, ev: Event) => unknown) | null

/**
 * A socket that answers from nowhere: it opens, and for the live feed says
 * hello and answers pings, so the dashboard reads as connected. A terminal
 * socket opens and stays quiet.
 */
class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  extensions = ''
  protocol = ''
  readonly url: string
  onopen: Handler = null
  onmessage: Handler = null
  onclose: Handler = null
  onerror: Handler = null
  private readonly live: boolean

  constructor(url: string) {
    super()
    this.url = url
    this.live = new URL(url).pathname === '/v1/live'
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.fire('open', new Event('open'))
      if (this.live) this.message({ type: 'hello', seq: 1, data: { server_time: Date.now() } })
    }, 0)
  }

  private fire(type: string, ev: Event) {
    this.dispatchEvent(ev)
    const h = (this as unknown as Record<string, Handler>)[`on${type}`]
    h?.call(this as unknown as WebSocket, ev)
  }

  private message(data: unknown) {
    if (this.readyState !== 1) return
    this.fire('message', new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  send(data: unknown) {
    if (!this.live || typeof data !== 'string') return
    try {
      const m = JSON.parse(data) as { ping?: number }
      if (typeof m.ping === 'number') setTimeout(() => this.message({ type: 'pong', data: m.ping }), 0)
    } catch { /* not ours to answer */ }
  }

  close(code = 1000) {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.fire('close', new CloseEvent('close', { code, wasClean: true }))
  }
}

/** Routes the dashboard's same-origin /v1/... and /healthz requests and WebSockets to bundled sample data; nothing leaves the phone. Idempotent. */
export function installDemo(w: Window & typeof globalThis = window): void {
  const flags = w as unknown as Record<string, unknown>
  if (flags[INSTALLED]) return
  flags[INSTALLED] = true
  const f = buildFixture(Date.now())
  const origin = w.location.origin
  const nativeFetch = w.fetch.bind(w)
  const NativeWebSocket = w.WebSocket
  w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const u = forDaemon(raw, origin)
    if (!u) return nativeFetch(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    return Promise.resolve(answer(f, method, u))
  }) as typeof fetch
  const Shim = function (url: string | URL, protocols?: string | string[]) {
    const s = String(url)
    if (forDaemon(s.replace(/^ws/, 'http'), origin)) return new DemoSocket(s.replace(/^ws/, 'http'))
    return new NativeWebSocket(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  w.WebSocket = Shim
}
