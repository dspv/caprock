import type { FoundAccount, Signin } from './mailApi'

// "Import everything" walks the ticked accounts one at a time: the ones whose
// password came with them connect by themselves first, then each remaining
// account waits for its one sign-in (a browser sign-in, an app password or a
// password). This is that walk as a pure reducer, so the order, retry and
// skip-and-come-back rules are tested without a screen.

export type RowStatus = 'waiting' | 'working' | 'ok' | 'failed' | 'skipped'

export type Row = {
  email: string
  name: string
  /** The mail app to import it from (POST /v1/mail/import's `source`). */
  source: string
  provider: string
  imapHost: string
  need: Signin
  status: RowStatus
  error?: string
  /** A line under a connected row, e.g. which address the browser signed in. */
  note?: string
}

export type Flow = { rows: Row[]; active: string | null }

export type FlowEvent =
  | { type: 'begin'; email: string }
  | { type: 'ok'; email: string; note?: string }
  | { type: 'fail'; email: string; error: string }
  | { type: 'skip'; email: string }
  /** Retry a failed row or come back to a skipped one: it becomes the step on screen. */
  | { type: 'open'; email: string }
  /** Back to waiting without an answer (a sign-in cancelled). */
  | { type: 'cancel'; email: string }
  /** Take another way in (an app password instead of a browser sign-in). */
  | { type: 'need'; email: string; need: Signin }

/** The rows for the ticked accounts: those that need nothing first, the rest in list order. */
export function plan(found: FoundAccount[], picked: (email: string) => boolean): Flow {
  const chosen = found.filter((a) => picked(a.email))
  const order = [...chosen.filter((a) => a.signin === 'ready'), ...chosen.filter((a) => a.signin !== 'ready')]
  const rows: Row[] = order.map((a) => ({
    email: a.email, name: a.name, source: a.source, provider: a.provider ?? '', imapHost: a.imap_host,
    need: a.signin, status: 'waiting',
  }))
  return { rows, active: rows[0]?.email ?? null }
}

/** The first row still waiting, in order. */
function next(rows: Row[]): string | null {
  return rows.find((r) => r.status === 'waiting')?.email ?? null
}

export function step(f: Flow, e: FlowEvent): Flow {
  const at = f.rows.findIndex((r) => r.email === e.email)
  if (at < 0) return f
  const rows = f.rows.slice()
  const r: Row = { ...f.rows[at]! }
  rows[at] = r
  switch (e.type) {
    case 'begin':
      r.status = 'working'
      r.error = undefined
      return { rows, active: e.email }
    case 'ok':
      r.status = 'ok'
      r.error = undefined
      r.note = e.note
      return { rows, active: f.active === e.email || f.active === null ? next(rows) : f.active }
    case 'fail':
      r.status = 'failed'
      r.error = e.error
      if (r.need === 'ready') {
        // The saved password was refused: the way back in is typing it, and
        // the walk goes on with the rest meanwhile.
        r.need = 'password'
        return { rows, active: f.active === e.email ? next(rows) : f.active }
      }
      // A step the user was doing stays on screen with its reason, to retry or skip.
      return { rows, active: e.email }
    case 'skip':
      r.status = 'skipped'
      return { rows, active: f.active === e.email ? next(rows) : f.active }
    case 'open':
      if (r.status === 'ok') return f
      r.status = 'waiting'
      return { rows, active: e.email }
    case 'cancel':
      if (r.status === 'working') r.status = 'waiting'
      return { rows, active: f.active }
    case 'need':
      r.need = e.need
      r.status = 'waiting'
      r.error = undefined
      return { rows, active: e.email }
  }
}

/** Nothing left on screen: every row connected, failed or skipped. */
export const finished = (f: Flow) => f.active === null
export const connected = (f: Flow) => f.rows.filter((r) => r.status === 'ok').length
