/**
 * Attention rules — the things worth interrupting a person for.
 *
 * This is the surface that earns trust or destroys it. Every rule here is
 * derived from measured facts already on screen (a live loop alert, a health
 * state, a cost, a file count); none of them guess at intent. A rule that
 * cannot state a concrete fact does not belong here, because a dashboard that
 * cries wolf gets ignored, and an ignored alert is worse than no alert.
 *
 * Deliberately NOT rules:
 *  - "this session is expensive" on its own — cost is the job, not a problem
 *  - anything predictive ("this will probably fail")
 */
import type { LoopAlert, SessionSummary } from '@/lib/api'

export interface AttentionItem {
  id: string
  sessionId: string
  project: string
  severity: 'high' | 'medium'
  /** The headline: what is wrong, in the user's terms. */
  title: string
  /** The evidence: the measured fact behind the headline. */
  detail: string
  /** A cost to show alongside, when the item is about wasted money. */
  costUSD?: number
  /** Age of the condition, unix ms, when known. */
  since?: number
}

export interface AttentionInput {
  sessions: SessionSummary[]
  alerts: LoopAlert[]
  now: number
  /** Sessions idle-but-waiting for this long are surfaced. Default 15 min. */
  waitingMs?: number
}

const DEFAULT_WAITING_MS = 15 * 60 * 1000

// Timestamps arrive as either RFC-3339 strings (activity, alerts) or unix ms
// (session rows); normalise before any arithmetic.
function ms(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  if (!v) return 0
  return Date.parse(v) || 0
}

/**
 * findAttention returns what deserves the user's attention, most severe first.
 * An empty result is the normal case and means the panel should not render —
 * "all clear" is not news, and showing it trains people to ignore the space.
 */
export function findAttention({ sessions, alerts, now, waitingMs = DEFAULT_WAITING_MS }: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = []
  const byId = new Map(sessions.map((s) => [s.session_id, s]))

  // 1. A loop, with what it has cost so far. The detector already decided this
  // is real; our job is to attach the money and make it actionable.
  for (const a of alerts) {
    const s = byId.get(a.session_id)
    out.push({
      id: `loop-${a.session_id}`,
      sessionId: a.session_id,
      project: s?.project ?? '',
      severity: 'high',
      title: 'Stuck in a loop',
      detail: `ran ${a.sample || a.tool || 'the same call'} ${a.count}× in ${a.window_min} min`,
      costUSD: s?.stats.cost_usd,
      since: ms(a.ts) || undefined,
    })
  }

  for (const s of sessions) {
    if (s.status === 'ended') continue

    // 2. An errored session is not going to recover on its own.
    if (s.activity.health === 'error') {
      out.push({
        id: `error-${s.session_id}`,
        sessionId: s.session_id,
        project: s.project,
        severity: 'high',
        title: 'Session hit an error',
        detail: s.activity.phrase,
        costUSD: s.stats.cost_usd,
        since: ms(s.activity.at) || s.last_event_at,
      })
      continue
    }

    // 3. Waiting on you, and has been for a while. A session that asked a
    // question two minutes ago is not a problem; one that asked twenty minutes
    // ago is time you did not know you were losing.
    if (s.activity.health === 'waiting-on-you') {
      const at = ms(s.activity.at) || s.last_event_at
      if (at > 0 && now - at >= waitingMs) {
        out.push({
          id: `waiting-${s.session_id}`,
          sessionId: s.session_id,
          project: s.project,
          severity: 'medium',
          title: 'Waiting on you',
          detail: s.activity.phrase,
          since: at,
        })
      }
    }
  }

  // High severity first; within a severity, the oldest condition first, because
  // the thing that has been wrong longest has cost the most.
  const rank = { high: 0, medium: 1 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.since ?? 0) - (b.since ?? 0))
}
