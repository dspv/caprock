/**
 * Attention — the panel that says "look at this", and says nothing otherwise.
 *
 * It renders only when there is something concrete to report (see
 * lib/attention.ts). There is deliberately no "all clear" state: an always-on
 * banner trains people to stop reading the space where the real warning will
 * one day appear.
 */
import type { AttentionItem } from '@/lib/attention'
import { fmtAgo, fmtUSD, shortId } from '@/lib/format'
import { href } from '@/lib/router'

export function Attention({ items, now, onDismiss }: {
  items: AttentionItem[]
  now: number
  onDismiss?: (sessionId: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="grid gap-1.5">
      {items.map((it) => (
        <Row key={it.id} it={it} now={now} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function Row({ it, now, onDismiss }: {
  it: AttentionItem
  now: number
  onDismiss?: (sessionId: string) => void
}) {
  const high = it.severity === 'high'
  const frame = high
    ? 'border-danger/50 bg-danger/10'
    : 'border-warn/50 bg-warn/10'
  return (
    <div className={`border rounded-[var(--radius-panel)] px-3 py-2 flex items-center gap-3 ${frame}`}>
      <span className={`font-medium text-[13px] shrink-0 ${high ? 'text-danger' : 'text-warn'}`}>
        {it.title}
      </span>
      <span className="text-[12px] text-fg-muted truncate">
        <a href={href({ name: 'session', id: it.sessionId })} className="link mono text-fg">
          {it.project || shortId(it.sessionId)}
        </a>
        <span className="ml-2">{it.detail}</span>
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
        <a
          href={href({ name: 'session', id: it.sessionId })}
          className="text-[11px] border border-border px-1.5 py-0.5 rounded-sm hover:border-border-strong no-underline text-fg-muted hover:text-fg"
        >
          open
        </a>
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
  )
}
