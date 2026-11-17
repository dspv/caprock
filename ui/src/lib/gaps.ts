/**
 * What an agent does not record, said one way for every agent.
 *
 * The server sends a session's gaps (`SessionSummary.gaps`, built by
 * internal/agentcat/gaps.go): field → "Cursor doesn't record cache reads or
 * writes". A tile whose figure the agent does not record shows "—" with that
 * sentence in its sub-line, the slot the Context tile uses for "no turn yet".
 * A figure that is not one session's (the Cost screen's Cursor panel) builds
 * the same sentence here.
 */

/** The figures a gap can name; the keys of `SessionSummary.gaps`. */
export type GapField = 'tokens' | 'cache' | 'cache_write' | 'context' | 'cost'

export type Gaps = Partial<Record<GapField, string>>

/** "Cursor doesn't record a cost for these chats". */
export function doesntRecord(agentLabel: string, what: string): string {
  return `${agentLabel} doesn't record ${what}`
}
