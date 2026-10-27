/**
 * Messages a session never got (ADR-053, amendment of 2026-10-27): they
 * waited in its queue when its process ended, and the daemon keeps them for
 * 7 days. Each stays where it was, under the conversation as an outgoing
 * bubble, dimmed, with one line saying it was not sent and three actions:
 * Send to a new session (the same agent in the same folder, continuing this
 * conversation when it can; the message then goes in through that
 * session's queue), Copy, and Delete. With several, one more button sends
 * them all, in their order, one per turn.
 */
import { useState } from 'react'
import type { QueuedMessage } from '@/lib/api'
import { NOT_SENT } from '@/lib/queue'
import { useCanControl } from '@/lib/useCanControl'

const BTN = 'min-h-[32px] px-1 text-[12px] text-fg-muted underline underline-offset-2 hover:text-fg disabled:opacity-50'

export function UndeliveredList({ messages, live = false, error, onResend, onDelete }: {
  messages: readonly QueuedMessage[]
  /** The session runs again (resumed under its own id): the messages go back into its own queue. */
  live?: boolean
  error: string
  /** Send these (all, when ids is undefined) on; true when it worked. */
  onResend: (ids?: number[]) => Promise<boolean>
  onDelete: (m: QueuedMessage) => Promise<boolean>
}) {
  const canControl = useCanControl()
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<boolean>) => {
    setBusy(true)
    try {
      await f()
    } finally {
      setBusy(false)
    }
  }
  const sendLabel = live ? 'Send here' : 'Send to a new session'
  return (
    <section aria-label="Messages not sent" className="grid gap-1.5 py-1.5" data-chat-undelivered>
      {messages.map((m) => (
        <NotSentBubble key={m.id} m={m} busy={busy} canControl={canControl} sendLabel={sendLabel} onSend={() => void run(() => onResend([m.id]))} onDelete={() => void run(() => onDelete(m))} />
      ))}
      {canControl && messages.length > 1 && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => onResend())}
            title="In their order, one per turn"
            className="min-h-[44px] sm:min-h-[32px] rounded-sm border border-border-strong px-3 text-[13px] text-fg hover:bg-panel-2 disabled:opacity-50"
          >
            {live ? `Send all ${messages.length} here` : `Send all ${messages.length} to a new session`}
          </button>
        </div>
      )}
      {error && <div role="alert" className="text-right text-[12px] text-danger">{error}</div>}
    </section>
  )
}

function NotSentBubble({ m, busy, canControl, sendLabel, onSend, onDelete }: {
  m: QueuedMessage
  busy: boolean
  canControl: boolean
  sendLabel: string
  onSend: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState<'' | 'yes' | 'no'>('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.text)
      setCopied('yes')
    } catch {
      setCopied('no')
    }
    window.setTimeout(() => setCopied(''), 2000)
  }
  const at = m.undelivered_at ?? m.created_at
  return (
    <div data-undelivered-id={m.id} className="flex justify-end">
      <div className="grid max-w-[85%] min-w-0 gap-1.5 rounded-[12px] rounded-br-[4px] border border-dashed border-border-strong bg-panel px-3 py-2 text-[14px] leading-relaxed text-fg-muted">
        {m.via === 'telegram' && <div className="text-[11px] text-fg-faint" data-via="telegram">from Telegram</div>}
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</div>
        <div className="flex flex-wrap items-center justify-end gap-x-2 text-[11.5px] text-fg-faint">
          <span className="mr-auto text-warn" title={`Queued ${new Date(m.created_at).toLocaleString()}; the session ended ${new Date(at).toLocaleString()}. Kept 7 days.`}>{NOT_SENT}</span>
          {canControl && (
            <button type="button" className={BTN} disabled={busy} onClick={onSend} aria-label={`${sendLabel}: ${m.text}`}>{sendLabel}</button>
          )}
          <button type="button" className={BTN} onClick={() => void copy()} aria-label={`Copy the message: ${m.text}`}>
            {copied === 'yes' ? 'Copied' : copied === 'no' ? 'Could not copy' : 'Copy'}
          </button>
          {canControl && (
            <button type="button" className={BTN} disabled={busy} onClick={onDelete} aria-label={`Delete the message: ${m.text}`}>Delete</button>
          )}
        </div>
      </div>
    </div>
  )
}
