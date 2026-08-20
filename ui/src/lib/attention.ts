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

// Thresholds for "spent, with little to show". Deliberately conservative: this
// must fire on a session that plainly went nowhere, never on ordinary research
// or a long conversation that happened not to edit much. Measured against a
// real month, these select 2 sessions out of 56.
const wastedUSD = 25
const wastedTurns = 300
const wastedFiles = 2
const wastedWindowMs = 24 * 60 * 60 * 1000

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
  // Defensive: the daemon always sends stats and activity, but this decides
  // whether to interrupt someone and runs at the top of Now — a version-skewed
  // or partial response must not take the whole screen down.
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : []
  const live = Array.isArray(alerts) ? alerts.filter(Boolean) : []
  const byId = new Map(list.map((s) => [s.session_id, s]))

  // 1. A loop, with what it has cost so far. The detector already decided this
  // is real; our job is to attach the money and make it actionable.
  for (const a of live) {
    const s = byId.get(a.session_id)
    out.push({
      id: `loop-${a.session_id}`,
      sessionId: a.session_id,
      project: s?.project ?? '',
      severity: 'high',
      title: 'Stuck in a loop',
      // The banner is the product's loudest surface, so it must never print a
      // literal "undefined" — assemble only the parts that are actually there.
      detail: [
        `ran ${a.sample || a.tool || 'the same call'}`,
        Number.isFinite(a.count) ? `${a.count}×` : 'repeatedly',
        Number.isFinite(a.window_min) ? `in ${a.window_min} min` : '',
      ].filter(Boolean).join(' '),
      costUSD: s?.stats?.cost_usd,
      since: ms(a.ts) || undefined,
    })
  }

  for (const s of list) {
    if (s.status === 'ended') continue
    if (!s.activity) continue

    // 2. An errored session is not going to recover on its own.
    if (s.activity.health === 'error') {
      out.push({
        id: `error-${s.session_id}`,
        sessionId: s.session_id,
        project: s.project,
        severity: 'high',
        title: 'Session hit an error',
        detail: s.activity.phrase,
        costUSD: s.stats?.cost_usd,
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

  // A session that spent real money and produced almost nothing. The other
  // rules deliberately skip ended sessions, which means the expensive failures
  // — all of them ended — had no surface at all: finding one meant scanning
  // dozens of unsorted cards behind a checkbox at the bottom of the page.
  //
  // Cost alone is still not a rule: spending is the job. It is cost with
  // nothing to show for it that is worth someone's attention, and both halves
  // of that are already on every card.
  for (const s of list) {
    if (!s.stats || !s.activity) continue
    const { cost_usd: cost, turns, files_touched: files } = s.stats
    if (cost < wastedUSD || turns < wastedTurns || files > wastedFiles) continue
    // Only recent work: a session that went nowhere last month is history, not
    // something to act on, and an alert you cannot act on is noise that trains
    // people to stop reading the strip.
    const endedAt = ms(s.activity.at) || s.last_event_at
    if (endedAt > 0 && now - endedAt > wastedWindowMs) continue
    out.push({
      id: `spent-${s.session_id}`,
      sessionId: s.session_id,
      project: s.project,
      severity: 'medium',
      title: 'Spent with little to show',
      detail: `${turns.toLocaleString()} turns, ${files === 0 ? 'no files' : files === 1 ? '1 file' : `${files} files`} touched`,
      costUSD: cost,
      since: ms(s.activity.at) || s.last_event_at,
    })
  }

  // High severity first; within a severity, the oldest condition first, because
  // the thing that has been wrong longest has cost the most.
  const rank = { high: 0, medium: 1 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.since ?? 0) - (b.since ?? 0))
}
