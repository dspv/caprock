/**
 * The hosted relay (ADR-058): a Cloudflare Worker with one Durable Object per
 * machine. internal/remote/relaysrv is the reference implementation and the
 * wire is internal/remote/wire.go's; a change to either lands in both.
 *
 * What it does: a machine connects to /v1/host/<id> and proves it holds the
 * Ed25519 key <id> names; a phone connects to /v1/c/<id>; the machine's
 * object numbers the phone and forwards bytes both ways. What it carries is
 * Noise ciphertext between a phone and a machine that share no secret with
 * it: it cannot read a session, a token or a command, and cannot alter one
 * without the phone dropping the connection.
 *
 * What it keeps: nothing. No storage is written; the only state is the open
 * sockets, held by the object for that machine, so two machines never share
 * an object, a socket list or a byte.
 *
 * WebSocket Hibernation: an idle machine costs no duration, and "ping" is
 * answered "pong" by the runtime without waking the object.
 */

export interface Env {
  MACHINE: DurableObjectNamespace
}

const FRAME_OPEN = 0x01
const FRAME_DATA = 0x02
const FRAME_CLOSE = 0x03
const FRAME_CHALLENGE = 0x10
const FRAME_PROOF = 0x11
const FRAME_READY = 0x12

const CLOSE_OFFLINE = 4404
const CLOSE_REPLACED = 4409
const CLOSE_SILENT = 4408
// A daemon pings every 25 s, answered here by the runtime; a machine unheard
// for longer than this is asleep or behind a NAT that forgot it, with its
// socket open only on paper (relaysrv.DefaultHostSilence).
const HOST_SILENCE_MS = 75_000
const MAX_MESSAGE = 65535 + 5
const MAX_PHONES = 32
const PROOF_CONTEXT = 'caprock-relay-host-v1\0'

const enc = new TextEncoder()

function frame(kind: number, conn: number, data?: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + (data?.length ?? 0))
  out[0] = kind
  new DataView(out.buffer).setUint32(1, conn >>> 0, false)
  if (data) out.set(data, 5)
  return out
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=')
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return out.length === 32 ? out : null
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok\n')
    const m = url.pathname.match(/^\/v1\/(host|c)\/([A-Za-z0-9_-]{43})$/)
    if (!m) return new Response('not found\n', { status: 404 })
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket\n', { status: 426 })
    }
    if (!b64urlDecode(m[2]!)) return new Response('not a host id\n', { status: 400 })
    // One object per machine id: every phone and the machine itself meet in
    // the same place, and no other machine's traffic is ever there.
    const stub = env.MACHINE.get(env.MACHINE.idFromName(m[2]!))
    return stub.fetch(req)
  },
}

type Tag = { role: 'host'; id: string; nonce?: string; ready: boolean; readyAt?: number } | { role: 'phone'; conn: number }

export class Machine implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const [, , role, id] = url.pathname.split('/')
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    if (role === 'host') {
      const nonce = crypto.getRandomValues(new Uint8Array(32))
      this.state.acceptWebSocket(server, ['host'])
      server.serializeAttachment({ role: 'host', id: id ?? '', nonce: btoa(String.fromCharCode(...nonce)), ready: false } satisfies Tag)
      server.send(frame(FRAME_CHALLENGE, 0, nonce))
      return new Response(null, { status: 101, webSocket: client })
    }
    const host = this.readyHost()
    if (!host) {
      server.accept()
      server.close(CLOSE_OFFLINE, 'the machine is not connected')
      return new Response(null, { status: 101, webSocket: client })
    }
    const phones = this.state.getWebSockets('phone')
    if (phones.length >= MAX_PHONES) {
      server.accept()
      server.close(1013, 'too many connections to this machine')
      return new Response(null, { status: 101, webSocket: client })
    }
    const conn = this.nextConn()
    this.state.acceptWebSocket(server, ['phone', `c:${conn}`])
    server.serializeAttachment({ role: 'phone', conn } satisfies Tag)
    host.send(frame(FRAME_OPEN, conn))
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * A number for a new phone that no phone has had lately. The lowest free
   * one was handed straight to the next phone, while the machine was still
   * sending to the phone that just hung up under it: the newcomer's first
   * message was the old channel's ciphertext, its handshake failed, and the
   * page told the owner to pair again (2026-10-14). A random 32-bit number
   * is not reused in practice, and needs no storage: the object may be
   * evicted between phones, and a counter in memory would start over.
   * internal/remote/relaysrv counts up instead, as it never sleeps.
   */
  private nextConn(): number {
    const used = new Set(this.state.getWebSockets('phone').map((ws) => (ws.deserializeAttachment() as Tag & { conn: number }).conn))
    const r = new Uint32Array(1)
    for (;;) {
      crypto.getRandomValues(r)
      const n = r[0]!
      if (n !== 0 && !used.has(n)) return n
    }
  }

  /**
   * The machine's connection that has proved its key and is still heard; one
   * at most. A sleeping laptop sends nothing and closes nothing: spliced to
   * it, a phone's handshake went into the void and the phone sat on
   * "Connecting…" (owner, 2026-10-14). Its last ping is the runtime's
   * auto-response timestamp, which hibernation keeps.
   */
  private readyHost(): WebSocket | undefined {
    const now = Date.now()
    for (const ws of this.state.getWebSockets('host')) {
      const tag = ws.deserializeAttachment() as Tag & { ready?: boolean; readyAt?: number }
      if (!tag.ready) continue
      const pinged = this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0
      if (now - Math.max(tag.readyAt ?? now, pinged) <= HOST_SILENCE_MS) return ws
      try {
        ws.close(CLOSE_SILENT, 'the machine stopped answering')
      } catch { /* already closed */ }
    }
    return undefined
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg === 'string') return // "ping" is answered by the runtime
    const data = new Uint8Array(msg)
    if (data.length > MAX_MESSAGE) {
      ws.close(1009, 'message too big')
      return
    }
    const tag = ws.deserializeAttachment() as Tag
    if (tag.role === 'host' && !tag.ready) return this.proof(ws, tag, data)
    if (tag.role === 'host') {
      if (data.length < 5) return
      const kind = data[0]
      const conn = new DataView(data.buffer, data.byteOffset).getUint32(1, false)
      const phone = this.state.getWebSockets(`c:${conn}`)[0]
      if (!phone) return
      if (kind === FRAME_DATA) phone.send(data.subarray(5))
      else if (kind === FRAME_CLOSE) phone.close(1000, '')
      return
    }
    const host = this.readyHost()
    if (!host) {
      ws.close(CLOSE_OFFLINE, 'the machine is not connected')
      return
    }
    host.send(frame(FRAME_DATA, tag.conn, data))
  }

  private async proof(ws: WebSocket, tag: Extract<Tag, { role: 'host' }>, data: Uint8Array) {
    const pub = b64urlDecode(tag.id)
    if (!pub || data.length !== 5 + 64 || data[0] !== FRAME_PROOF || !tag.nonce) {
      ws.close(1008, 'bad proof')
      return
    }
    const nonce = Uint8Array.from(atob(tag.nonce), (c) => c.charCodeAt(0))
    const message = new Uint8Array([...enc.encode(PROOF_CONTEXT), ...enc.encode(tag.id), ...nonce])
    let ok = false
    try {
      const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
      ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, data.subarray(5), message)
    } catch {
      ok = false
    }
    if (!ok) {
      ws.close(1008, 'bad proof')
      return
    }
    // The machine connected again: the old connection is a stale one, and
    // its phones were talking to a session that no longer exists.
    for (const old of this.state.getWebSockets('host')) {
      if (old !== ws) old.close(CLOSE_REPLACED, 'the machine connected again')
    }
    for (const p of this.state.getWebSockets('phone')) p.close(CLOSE_OFFLINE, 'the machine reconnected')
    // Tags are fixed when a socket is accepted, so "proved" lives in the
    // attachment and readyHost reads it there.
    ws.serializeAttachment({ role: 'host', id: tag.id, ready: true, readyAt: Date.now() } satisfies Tag)
    ws.send(frame(FRAME_READY, 0))
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const tag = ws.deserializeAttachment() as Tag
    if (tag.role === 'host') {
      if (!tag.ready) return
      // The close of a connection the machine replaced can arrive after a
      // phone joined the new one; that phone is not the old one's to drop.
      const others = this.state.getWebSockets('host').filter((h) => h !== ws && (h.deserializeAttachment() as Tag & { ready?: boolean }).ready)
      if (others.length > 0) return
      for (const p of this.state.getWebSockets('phone')) p.close(CLOSE_OFFLINE, 'the machine disconnected')
      return
    }
    const host = this.readyHost()
    host?.send(frame(FRAME_CLOSE, tag.conn))
    try {
      ws.close(code === 1005 ? 1000 : code, '')
    } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011)
  }
}
