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

export function Attention({ items, now, onDismiss, sessions }: {
  items: AttentionItem[]
  now: number
  onDismiss?: (sessionId: string) => void
  /** Used to answer "what did it ask?" without leaving the screen. */
  sessions?: SessionSummary[]
}) {
  if (items.length === 0) return null
  return (
    <div className="grid gap-1.5">
      {items.map((it) => (
        <Row
          key={it.id}
          it={it}
          now={now}
          onDismiss={onDismiss}
          session={sessions?.find((s) => s.session_id === it.sessionId)}
        />
      ))}
    </div>
  )
}

function Row({ it, now, onDismiss, session }: {
  it: AttentionItem
  now: number
  onDismiss?: (sessionId: string) => void
  session?: SessionSummary
}) {
  const [asking, setAsking] = useState(false)
  const high = it.severity === 'high'
  const frame = high
    ? 'border-danger/50 bg-danger/10'
    : 'border-warn/50 bg-warn/10'
  return (
    <>
    <div className={`border rounded-[var(--radius-panel)] px-3 py-2 flex items-center gap-3 ${frame}`}>
      <span className={`font-medium text-[13px] shrink-0 ${high ? 'text-danger' : 'text-warn'}`}>
        {it.title}
      </span>
      <span className="text-[12px] text-fg-muted truncate">
        {/* Not every item is about a session. A plan window is about the whole
          * account, and linking it to `#/session/` with an empty id produced a
          * dead link labelled with nothing. */}
        {it.sessionId && (
          <a href={href({ name: 'session', id: it.sessionId })} className="link mono text-fg">
            {it.project || shortId(it.sessionId)}
          </a>
        )}
        <span className={it.sessionId ? 'ml-2' : ''}>{it.detail}</span>
      </span>
      <span className="ml-auto flex items-center gap-3 shrink-0">
        {it.costUSD !== undefined && it.costUSD > 0 && (
          <span className="num text-[13px] text-fg" title="spent by this session so far">
            {fmtUSD(it.costUSD)}
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
              : '#/cost'
          }
          className="text-[11px] border border-border px-1.5 py-0.5 rounded-sm hover:border-border-strong no-underline text-fg-muted hover:text-fg"
        >
          {it.sessionId ? 'open' : 'details'}
        </a>
        {/* Only on the two items a spend cap would actually have acted on: a
          * loop burning money and a session that spent a lot for nothing.
          * Deliberately NOT on the plan-window item — a plan limit is
          * Anthropic's, and no amount of money we take moves it, so selling a
          * cap beside it would be selling the wrong thing. */}
        {(it.id.startsWith('loop-') || it.id.startsWith('spent-')) && (
          <PremiumHint reason="this is what a cap stops" now={now} />
        )}
        {onDismiss && it.id.startsWith('loop-') && (
          <button
            className="text-[11px] text-fg-faint hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
            onClick={() => onDismiss(it.sessionId)}
          >
            dismiss
          </button>
        )}
      </span>
    </div>
      {asking && session && <LastWord session={session} now={now} onClose={() => setAsking(false)} />}
    </>
  )
}
