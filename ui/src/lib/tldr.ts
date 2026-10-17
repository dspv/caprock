/**
 * AI;DR: an agent answer cut to two lines by the daemon
 * (`POST /v1/events/{id}/tldr`, .ai/03-contracts.md), shown on the phone's
 * latest answer card (.ai/04-ui.md § From a phone, *AI;DR*).
 *
 * - **No body.** The daemon reads the answer from its own store by the
 *   event's id; 200 is `{tldr, cached}`, 404 an unknown event, 503
 *   `{error}` when no agent CLI on the machine can summarise, 502 `{error}`
 *   when the agent ran and failed or timed out. Any non-200 is an error,
 *   said in the daemon's `error` text, else by its status.
 * - **Asked once per page.** A summary is kept in memory for the page's
 *   life, so "Full answer" and back again costs nothing; two taps in flight
 *   share one request. A failure is not kept: the next tap asks again.
 */
import { deviceToken } from './api'

export interface Tldr {
  tldr: string
  cached: boolean
}

/** A request that failed: the daemon's own words where it gave some. */
export class TldrError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const cache = new Map<number, Promise<string>>()

async function ask(eventId: number): Promise<string> {
  const t = deviceToken()
  let res: Response
  try {
    res = await fetch(`/v1/events/${encodeURIComponent(String(eventId))}/tldr`, {
      method: 'POST',
      headers: t ? { 'X-Caprock-Device': t } : {},
    })
  } catch (e) {
    throw new TldrError(0, `The summary could not be asked for — ${e instanceof Error ? e.message : String(e)}`)
  }
  let body: unknown
  try { body = await res.json() } catch { /* no JSON */ }
  if (!res.ok) {
    const said = (body as { error?: unknown } | undefined)?.error
    const msg = typeof said === 'string' && said.trim()
      ? said
      : res.status === 404 ? 'This answer is not known to Caprock any more.' : `No summary — ${res.status} ${res.statusText}`.trim()
    throw new TldrError(res.status, msg)
  }
  const tldr = (body as Partial<Tldr> | undefined)?.tldr
  if (typeof tldr !== 'string' || !tldr.trim()) throw new TldrError(res.status, 'The summary came back empty.')
  return tldr.trim()
}

/** The two-line summary of an answer, from memory when this page asked before. */
export function fetchTldr(eventId: number): Promise<string> {
  let p = cache.get(eventId)
  if (!p) {
    p = ask(eventId)
    cache.set(eventId, p)
    p.catch(() => { if (cache.get(eventId) === p) cache.delete(eventId) })
  }
  return p
}

/** For tests: forget every summary. */
export function resetTldr(): void {
  cache.clear()
}
