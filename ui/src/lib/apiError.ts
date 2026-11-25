/**
 * Resume after an API error (ADR-105): what the line under a session's
 * terminal says once Caprock has typed "continue" into it after a transient
 * API error, or given up. Pure.
 *
 * - resumed: "API error (529 Overloaded) — resumed automatically · try 1 of 3"
 * - recovered: the same, "· it went on", for an hour after the try
 * - gave_up: "API error (529 Overloaded) — gave up after 3 automatic tries"
 *
 * Nothing for an error Caprock does not answer (not retryable, the user took
 * over, or the setting is off — then no try was ever made), and nothing for
 * a session that is not Caprock's or has ended.
 */
import type { SessionSummary } from './api'

/** How many tries one incident gets; the daemon's resumeMaxTries. */
export const RESUME_MAX_TRIES = 3

/** How long "it went on" stays after the try that got it going. */
export const RECOVERED_SHOWN_MS = 60 * 60 * 1000

export interface ApiErrorNotice {
  kind: 'resumed' | 'recovered' | 'gave_up'
  text: string
}

export function apiErrorNotice(
  s: Pick<SessionSummary, 'api_error' | 'owned' | 'status' | 'kind'> | undefined,
  now = Date.now(),
): ApiErrorNotice | null {
  const e = s?.api_error
  if (!s || !e || !s.owned || s.status === 'ended' || s.kind === 'shell') return null
  const tries = e.tries ?? 0
  const head = e.reason ? `API error (${e.reason})` : 'API error'
  switch (e.resume) {
    case 'resumed':
      if (!e.at || tries < 1) return null
      return { kind: 'resumed', text: `${head} — resumed automatically · try ${tries} of ${RESUME_MAX_TRIES}` }
    case 'recovered': {
      // A newer error than the try that got past the last one is a new incident.
      if (e.at || tries < 1 || !e.resumed_at || now - e.resumed_at > RECOVERED_SHOWN_MS) return null
      return { kind: 'recovered', text: `API error — resumed automatically (try ${tries} of ${RESUME_MAX_TRIES}) · it went on` }
    }
    case 'gave_up':
      if (!e.at) return null
      return { kind: 'gave_up', text: `${head} — gave up after ${tries} automatic ${tries === 1 ? 'try' : 'tries'}` }
  }
  return null
}
