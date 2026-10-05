/**
 * A clone started from the phone that survives the phone (WP-15).
 *
 * The clone runs in the daemon; the phone only follows it. What the phone must
 * not do is lose track of it, or start it twice, when its connection drops
 * mid-clone or the browser discards the page in the background. So:
 *
 *  - the request (with its client-made `op_id`) is kept in localStorage before
 *    it is sent, so a reloaded page picks it up again;
 *  - following it is a sync — `GET /v1/projects/ops` for the op, and the same
 *    `POST /v1/projects` with the same `op_id` when the daemon has not heard of
 *    it (the first answer was lost) — which the daemon makes idempotent;
 *  - a sync that fails on the network is retried on the reconnect policy of
 *    every socket (lib/reconnect.ts: backoff with jitter, and at once on a
 *    network wake or the live feed's next `hello`); `op` frames on /v1/live
 *    update it in between.
 */
import { ApiError, errText } from './api'
import { live } from './live'
import { projectsApi, type AddProjectRequest, type AddProjectResult, type OpFrame } from './projects'
import { Reconnector, onNetworkWake } from './reconnect'

/** A clone asked for and not yet seen to finish. */
export interface PendingClone {
  op_id: string
  url: string
  parent: string
  started_at: number
}

export const PENDING_CLONE_KEY = 'caprock.start.clone'

/** The daemon forgets a finished op after an hour; so does the phone. */
const PENDING_TTL_MS = 60 * 60 * 1000

/** How often a running clone is re-read when no frame has said anything. */
const POLL_MS = 5_000

/** Clone URLs a phone may send (the daemon checks the same): https://, or git@host:path. */
export function isPhoneCloneURL(url: string): boolean {
  return /^https:\/\/[^\s/@]+(:\d+)?\/[^\s]+$/.test(url) || /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(url)
}

/** The folder a clone lands in, as git names it: the last path segment, without .git. */
export function repoName(url: string): string {
  const path = url.replace(/^https:\/\/[^/]+/, '').replace(/^git@[^:]+:/, '').replace(/\/+$/, '')
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.git$/, '')
}

export function loadPendingClone(now = Date.now()): PendingClone | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_CLONE_KEY) ?? 'null') as PendingClone | null
    if (!v || typeof v.op_id !== 'string' || typeof v.url !== 'string' || typeof v.parent !== 'string') return null
    return now - (v.started_at ?? 0) < PENDING_TTL_MS ? v : null
  } catch {
    return null
  }
}

export function savePendingClone(p: PendingClone): void {
  try { localStorage.setItem(PENDING_CLONE_KEY, JSON.stringify(p)) } catch { /* private mode: this page still follows it */ }
}

export function clearPendingClone(): void {
  try { localStorage.removeItem(PENDING_CLONE_KEY) } catch { /* nothing to do */ }
}

export function cloneRequest(p: PendingClone): AddProjectRequest {
  return { clone: { url: p.url, parent: p.parent }, op_id: p.op_id }
}

/** Where a followed clone stands, as the screen says it. */
export type CloneView =
  | { phase: 'sending'; op?: OpFrame }
  /** The phone cannot reach the daemon; the clone, if started, goes on there. */
  | { phase: 'offline'; op?: OpFrame }
  | { phase: 'running'; op: OpFrame }
  | { phase: 'done'; op: OpFrame }
  | { phase: 'failed'; op?: OpFrame; error: string }

/** A newer word on the same op: a finished state is never undone by a late running frame. */
export function mergeOp(current: OpFrame | undefined, next: OpFrame): OpFrame {
  if (current && current.state !== 'running' && next.state === 'running') return current
  return { ...current, ...next }
}

export function viewOf(op: OpFrame): CloneView {
  if (op.state === 'done') return { phase: 'done', op }
  if (op.state === 'failed') return { phase: 'failed', op, error: op.error || 'The clone failed.' }
  return { phase: 'running', op }
}

/** A failure the network may fix (retry), as opposed to the daemon's answer (show it). */
export function isRetryable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status >= 500 || e.status === 408 || e.status === 429
  return !(e instanceof Error && /newer Caprock daemon/.test(e.message))
}

export interface CloneApi {
  ops: () => Promise<OpFrame[]>
  add: (req: AddProjectRequest) => Promise<AddProjectResult>
}

/** Follows one clone until it is done or failed. */
export class CloneTracker {
  private op: OpFrame | undefined
  private view: CloneView = { phase: 'sending' }
  private stopped = false
  private syncing = false
  private poll: ReturnType<typeof setTimeout> | undefined
  private readonly unsubs: (() => void)[] = []
  private readonly retry = new Reconnector({ connect: () => void this.sync() })

  constructor(
    private readonly pending: PendingClone,
    private readonly onChange: (v: CloneView) => void,
    private readonly apis: CloneApi = projectsApi,
  ) {}

  start(): void {
    this.unsubs.push(live.onFrame((f) => {
      if (f.type === 'op' && f.data.op_id === this.pending.op_id) this.apply(f.data)
      // The live feed is back: what was missed is read, not waited for.
      else if (f.type === 'hello' || f.type === 'reset') this.retry.retryNow()
    }))
    this.unsubs.push(onNetworkWake(() => this.retry.retryNow()))
    void this.sync()
  }

  stop(): void {
    this.stopped = true
    this.retry.cancel()
    clearTimeout(this.poll)
    for (const u of this.unsubs.splice(0)) u()
  }

  /** Asks the daemon where the clone stands, and starts it if it never arrived. */
  async sync(): Promise<void> {
    if (this.stopped || this.syncing || this.finished()) return
    this.syncing = true
    try {
      const known = (await this.apis.ops()).find((o) => o.op_id === this.pending.op_id)
      if (known) {
        this.apply(known)
      } else {
        const r = await this.apis.add(cloneRequest(this.pending))
        if ('op' in r) this.apply(r.op)
      }
      this.retry.succeed()
      this.schedulePoll()
    } catch (e) {
      if (this.stopped) return
      if (isRetryable(e)) {
        this.set({ phase: 'offline', op: this.op })
        this.retry.fail()
      } else {
        this.finish({ phase: 'failed', op: this.op, error: errText(e) })
      }
    } finally {
      this.syncing = false
    }
  }

  private finished(): boolean {
    return this.view.phase === 'done' || this.view.phase === 'failed'
  }

  private schedulePoll(): void {
    clearTimeout(this.poll)
    if (this.stopped || this.finished()) return
    this.poll = setTimeout(() => void this.sync(), POLL_MS)
  }

  private apply(op: OpFrame): void {
    if (this.stopped || this.finished()) return
    this.op = mergeOp(this.op, op)
    const v = viewOf(this.op)
    if (v.phase === 'running') this.set(v)
    else this.finish(v)
  }

  private finish(v: CloneView): void {
    clearPendingClone()
    this.retry.cancel()
    clearTimeout(this.poll)
    this.set(v)
  }

  private set(v: CloneView): void {
    this.view = v
    this.onChange(v)
  }
}
