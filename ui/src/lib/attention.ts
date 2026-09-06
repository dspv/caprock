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
import type { LoopAlert, RateLimits, SessionSummary } from '@/lib/api'

export interface AttentionItem {
  id: string
  sessionId: string
  project: string
  severity: 'high' | 'medium'
  /** The headline: what is wrong, in the user's terms. */
  title: string
  /** The evidence: the measured fact behind the headline. */
  detail: string
  /**
   * What this session has spent in total — NOT what the problem cost.
   *
   * The two are far apart and the difference matters: a loop that ran for two
   * hours sat inside a session that had already spent $58, and printing that
   * figure beside "Stuck in a loop" reads as the price of the loop. Neither a
   * narrower window fixes it — the spend inside a loop's window is mostly the
   * useful work that happened alongside it, so charging it to the loop swaps
   * one wrong number for a less obviously wrong one (rule 6). The honest move
   * is to keep the figure the session total it is and label it as such.
   */
  costUSD?: number
  /**
   * Whether Caprock started this session. The spend cap can only pause
   * sessions it owns (rule 7), so this decides whether a cap could actually
   * have acted here — 96% of the sessions with real work on this machine are
   * not owned, which is how a "a cap that stops this" button ended up beside
   * a loop no cap would have touched.
   */
  owned?: boolean
  /** Age of the condition, unix ms, when known. */
  since?: number
  /**
   * The moment worth looking at, unix ms — where "open" should land.
   *
   * Without it the link opened a session at whatever the timeline happened to
   * show, which for a loop that started three hours ago is the wrong end of a
   * long list: the banner named a problem and then handed over a haystack.
   */
  at?: number
}

export interface AttentionInput {
  sessions: SessionSummary[]
  alerts: LoopAlert[]
  now: number
  /** Plan-limit windows, when Claude Code's status line is feeding them. */
  limits?: RateLimits
  /** Sessions idle-but-waiting for this long are surfaced. Default 15 min. */
  waitingMs?: number
}

const DEFAULT_WAITING_MS = 15 * 60 * 1000

// Running out of plan window stops work outright, so it earns an interruption —
// but only near the end. The Cost screen already colours 85% amber, and an
// alert that fires wherever a colour changes is an alert people learn to
// scroll past. 90% is roughly "one more session and you are done".
const limitPct = 90
// A reset clock already past, or implausibly far ahead, is a stale sample
// rather than a fact — the 5-hour window once announced a reset in 2030. An
// alert built on a stale percentage would never clear, so windows whose clock
// cannot be believed do not raise one.
const staleWindowMs = 8 * 24 * 60 * 60 * 1000

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
export function findAttention({ sessions, alerts, now, limits, waitingMs = DEFAULT_WAITING_MS }: AttentionInput): AttentionItem[] {
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
      owned: s?.owned,
      since: ms(a.ts) || undefined,
      // Where the repetition STARTED, not where the detector noticed it. The
      // first call is the one that explains what the session was trying to do;
      // the fifth is just the fifth.
      at: ms(a.first_ts) || ms(a.ts) || undefined,
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

    // 3. Waiting for you, and has been for a while. A session that asked a
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
          title: 'Waiting for you',
          // No detail. The other rows put the activity phrase here because it
          // carries the evidence — an error row's phrase names what broke. A
          // waiting session's phrase is the fixed string "waiting for you", so
          // the row read "Waiting on you · caprock · waiting for you": the same
          // sentence twice, in two prepositions, with the repeat in grey as
          // though it were adding something.
          //
          // The title says it once, and "what did it ask?" beside it is the
          // part that actually tells you anything.
          detail: '',
          since: at,
        })
      }
    }
  }

  // There was a "lots of turns, few files" alert here. It is gone, and the
  // reason is worth keeping: `files_touched` counts only Edit/Write/MultiEdit/
  // NotebookEdit, so every file changed through Bash — `sed -i`, a heredoc, a
  // python one-liner — was invisible to it. Agents working under bypassed
  // permissions are told to prefer exactly those, so the rule was blind to a
  // whole ordinary way of working.
  //
  // On the owner's machine it had fired on three sessions ever, with 636, 418
  // and 288 Bash calls: all three were false, and one of them had shipped
  // three releases while the banner said "no files touched". A rule with no
  // true positives is not a threshold to tune.
  //
  // It also argued against itself. Its own comment conceded the product cannot
  // tell a long investigation from a session that went nowhere and left the
  // judgement to the reader — which is a reason not to interrupt them at all.
  // "I don't even know what to do with this" was the report that removed it.
  //
  // Counting files from Bash command text would be guesswork about shell
  // syntax, and rule 6 prefers no number to an invented one. If this returns,
  // it should be built on `internal/gitdiff`, which already knows what a
  // session really changed.

  // High severity first; within a severity, the oldest condition first, because
  // the thing that has been wrong longest has cost the most.
  const rank = { high: 0, medium: 1 }
  // 4. The plan window is nearly spent. Not about one session — this stops
  // every session at once, which is why it is here rather than a colour on a
  // number someone has to go and look at.
  for (const [label, w] of [
    ['5-hour', limits?.five_hour],
    ['7-day', limits?.seven_day],
  ] as const) {
    if (!w || w.used_percentage < limitPct) continue
    const resetMs = (w.resets_at ?? 0) * 1000
    if (!(resetMs > now && resetMs < now + staleWindowMs)) continue
    const pct = Math.round(w.used_percentage)
    const resets = new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    out.push({
      id: `limit-${label}`,
      sessionId: '',
      project: '',
      severity: pct >= 95 ? 'high' : 'medium',
      title: `${label} plan window ${pct}% used`,
      detail: `resets at ${resets}${w.forecast ? ` — ${w.forecast}` : ''}`,
    })
  }

  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.since ?? 0) - (b.since ?? 0))
}
