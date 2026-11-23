/**
 * What an agent does not record, said one way for every agent.
 *
 * The server sends a session's gaps (`SessionSummary.gaps`, built by
 * internal/agentcat/gaps.go): field → "Cursor doesn't save cache reads or
 * writes on this computer". A tile whose figure the agent does not record
 * shows "—" with that sentence in its sub-line, the slot the Context tile
 * uses for "no turn yet", and a GapMark (ⓘ) after the dash that says it on
 * hover, focus or tap.
 * A figure that is not one session's (the Cost screen's Cursor panel) builds
 * the same sentence here.
 */

/** The figures a gap can name; the keys of `SessionSummary.gaps`. */
export type GapField = 'tokens' | 'cache' | 'cache_write' | 'context' | 'cost' | 'compaction_cost'

export type Gaps = Partial<Record<GapField, string>>

/** "Cursor doesn't save a cost for these chats on this computer". */
export function doesntRecord(agentLabel: string, what: string): string {
  return `${agentLabel} doesn't save ${what} on this computer`
}

/**
 * What a GapMark says: the gap's sentence and what follows from it, so the
 * dash reads as the agent's limit, never as Caprock broken (owner,
 * 2026-11-23): "Cursor CLI doesn't save token counts on this computer, so
 * there is nothing for Caprock to show."
 */
export function gapSentence(why: string): string {
  const s = why.trim().replace(/[.\s]+$/, '')
  return `${s}, so there is nothing for Caprock to show.`
}

/**
 * The size behind a context reading: "120k / 200k", or — for a reading that
 * is a share of the window alone, with no tokens and no window (Cursor's
 * November 2025 builds keep only `contextUsagePercent`) — the session's
 * `context_note`, "Cursor doesn't save this chat's context in tokens on this
 * computer".
 */
export function contextSize(ctx: { tokens: number; window: number }, note: string | undefined, fmt: (n: number) => string): string {
  if (ctx.window > 0) return `${fmt(ctx.tokens)} / ${fmt(ctx.window)}`
  return note || 'share of the window'
}
