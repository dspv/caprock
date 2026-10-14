/**
 * Attention — the panel that says "look at this", and says nothing otherwise.
 *
 * It renders only when there is something concrete to report (see
 * lib/attention.ts). There is deliberately no "all clear" state: an always-on
 * banner trains people to stop reading the space where the real warning will
 * one day appear.
 */
import type { AttentionItem } from '@/lib/attention'
import { useState } from 'react'
import { fmtAgo, fmtUSD, shortId } from '@/lib/format'
import { LastWord } from '@/components/LastWord'
import type { SessionSummary } from '@/lib/api'
import { href } from '@/lib/router'
import { PremiumHint } from './PremiumHint'
import { LoopAlertCard } from './LoopAlertCard'
import { useLoopHidden } from '@/lib/loopalert'

export function Attention({ items, now, onDismiss, sessions }: {
  items: AttentionItem[]
  now: number
  onDismiss?: (sessionId: string) => void
  /** Used to answer "what did it ask?" without leaving the screen. */
  sessions?: SessionSummary[]
}) {
  // A loop dismissed or muted from its card stays away here and in the
  // session's cockpit alike (lib/loopalert.ts).
  const hidden = useLoopHidden()
  const shown = items.filter((it) => !it.loop || !hidden(it.loop))
  if (shown.length === 0) return null
  return (
    <div className="grid grid-cols-1 gap-1.5">
      {shown.map((it) => it.loop ? (
        <LoopAlertCard
          key={it.id}
          alert={it.loop}
          project={it.project}
          owned={it.owned}
          sessionCostUSD={it.costUSD}
          now={now}
          openHref={href({ name: 'session', id: it.sessionId, tab: 'timeline', at: it.at })}
          onDismiss={onDismiss ? () => onDismiss(it.sessionId) : undefined}
        />
      ) : (
        <Row
          key={it.id}
          it={it}
          now={now}
          session={sessions?.find((s) => s.session_id === it.sessionId)}
        />
      ))}
    </div>
  )
}

function Row({ it, now, session }: {
  it: AttentionItem
  now: number
  session?: SessionSummary
}) {
  const [asking, setAsking] = useState(false)
  const high = it.severity === 'high'
  const frame = high
    ? 'border-danger/50 bg-danger/10'
    : 'border-warn/50 bg-warn/10'
  return (
    <>
    <div className={`border rounded-[var(--radius-panel)] px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 ${frame}`}>
      <span className={`font-medium text-[13px] shrink-0 ${high ? 'text-danger' : 'text-warn'}`}>
        {it.title}
      </span>
      <span className="min-w-0 text-[12px] text-fg-muted truncate">
        {/* Not every item is about a session. A plan window is about the whole
          * account, and linking it to `#/session/` with an empty id produced a
          * dead link labelled with nothing. */}
        {it.sessionId && (
          <a href={href({ name: 'session', id: it.sessionId })} className="link mono text-fg">
            {it.project || shortId(it.sessionId)}
          </a>
        )}
        {/* Rendered only when there is something to say. A row whose detail is
          * empty — the waiting one, whose title already says it — would
          * otherwise carry an indented empty span after the project name. */}
        {it.detail && <span className={it.sessionId ? 'ml-2' : ''}>{it.detail}</span>}
      </span>
      <span className="ml-auto flex items-center gap-3 shrink-0">
        {/* Labelled in the open, not only on hover. This is the SESSION's
          * total, and sitting bare beside "Stuck in a loop" it read as the
          * price of the loop — a $58.85 that the repetition had not cost.
          * Charging the loop's own window instead would not fix it: measured
          * here, a two-hour loop's window held $47 of which essentially all
          * was the useful work happening alongside it, so that figure would be
          * wrong too, and harder to argue with (rule 6). The number stays what
          * it is and now says so. */}
        {it.costUSD !== undefined && it.costUSD > 0 && (
          <span className="flex items-baseline gap-1" title="what this session has spent in total — not what this problem cost">
            <span className="num text-[13px] text-fg">{fmtUSD(it.costUSD)}</span>
            <span className="text-[10px] text-fg-faint">session total</span>
          </span>
        )}
        {it.since !== undefined && (
          <span className="num text-[11px] text-fg-faint">{fmtAgo(it.since, now)}</span>
        )}
        {session && it.id.startsWith('waiting-') && (
          <button
            className="text-[11px] border border-border px-1.5 py-0.5 rounded-sm hover:border-border-strong text-fg-muted hover:text-fg"
            onClick={() => setAsking(true)}
          >
            what did it ask?
          </button>
        )}
        {/* Straight to the timeline at the moment in question. "Open" used to
          * land on the session's default view, which for a three-hour-old loop
          * is the wrong end of a long list — the banner named a problem and
          * then handed over a haystack. */}
        <a
          href={
            it.sessionId
              ? href({ name: 'session', id: it.sessionId, tab: 'timeline', at: it.at })
              // An account-level item is the plan window: straight to the
              // panel that explains it, not the top of Cost.
              : href({ name: 'cost', section: 'limits' })
          }
          className="text-[11px] border border-border px-1.5 py-0.5 rounded-sm hover:border-border-strong no-underline text-fg-muted hover:text-fg"
        >
          {it.sessionId ? 'open' : 'details'}
        </a>
        {/* The plan-window stop is the thing that does act here: it pauses
          * Caprock's own sessions before the limit and resumes them after the
          * reset. Offered only on an install known to be without it. */}
        {it.id.startsWith('limit-') && it.offerWindowStop && (
          <PremiumHint feature="window" reason="Premium pauses Caprock's sessions here" now={now} />
        )}
      </span>
    </div>
      {asking && session && <LastWord session={session} now={now} onClose={() => setAsking(false)} />}
    </>
  )
}
