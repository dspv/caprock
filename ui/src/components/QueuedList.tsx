/**
 * Messages waiting for the turn to end (ADR-053), under the conversation as
 * ordinary outgoing bubbles. Send already did the deciding: the daemon types
 * the oldest in by itself when the turn ends, so nothing here asks for a
 * choice. Under each bubble one muted line says what it waits for, with
 * small text links (Send now, Edit, Cancel) kept secondary; Send now is not
 * offered while a prompt or a question is on the screen.
 */
import { useState } from 'react'
import type { QueuedMessage, QueueWaiting } from '@/lib/api'
import { waitingLabel } from '@/lib/queue'

export function QueuedList({ messages, waiting, error, onEdit, onCancel, onSendNow }: {
  messages: readonly QueuedMessage[]
  waiting: QueueWaiting
  error: string
  onEdit: (m: QueuedMessage, text: string) => Promise<boolean>
  onCancel: (m: QueuedMessage) => Promise<boolean>
  onSendNow: (m: QueuedMessage) => Promise<boolean>
}) {
  const prompt = waiting === 'permission' || waiting === 'question'
  return (
    <section aria-label="Queued messages" aria-live="polite" className="grid gap-1.5 py-1.5" data-chat-queue>
      {messages.map((m, i) => (
        <QueuedBubble key={m.id} m={m} n={i + 1} total={messages.length} waiting={waiting} sendNow={!prompt} onEdit={onEdit} onCancel={onCancel} onSendNow={onSendNow} />
      ))}
      {error && <div role="alert" className="text-right text-[12px] text-danger">{error}</div>}
    </section>
  )
}

const BTN = 'min-h-[32px] px-1 text-[12px] text-fg-muted underline underline-offset-2 hover:text-fg disabled:opacity-50'

function QueuedBubble({ m, n, total, waiting, sendNow, onEdit, onCancel, onSendNow }: {
  m: QueuedMessage
  n: number
  total: number
  waiting: QueueWaiting
  sendNow: boolean
  onEdit: (m: QueuedMessage, text: string) => Promise<boolean>
  onCancel: (m: QueuedMessage) => Promise<boolean>
  onSendNow: (m: QueuedMessage) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.text)
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<boolean>, after?: () => void) => {
    setBusy(true)
    try {
      if (await f()) after?.()
    } finally {
      setBusy(false)
    }
  }
  const save = () => void run(() => onEdit(m, draft), () => setEditing(false))
  const discard = () => { setEditing(false); setDraft(m.text) }
  return (
    <div data-queued-id={m.id} className="flex justify-end">
      <div className="grid max-w-[85%] min-w-0 gap-1.5 rounded-[12px] rounded-br-[4px] border border-border-strong bg-panel-2 px-3 py-2 text-[14px] leading-relaxed text-fg">
        {m.via === 'telegram' && <div className="text-[11px] text-fg-faint" data-via="telegram">from Telegram</div>}
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); discard() }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
            }}
            aria-label="Edit the queued message"
            rows={Math.min(6, Math.max(2, draft.split('\n').length))}
            autoFocus
            className="input w-full min-w-[min(220px,60vw)] resize-y"
            style={{ fontSize: 16, lineHeight: '22px' }}
          />
        ) : (
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-x-2 text-[11.5px] text-fg-faint">
          {!editing && <span className="mr-auto">{waitingLabel(waiting)}{total > 1 ? ` · ${n} of ${total}` : ''}</span>}
          {editing ? (
            <>
              <button type="button" className="min-h-[44px] sm:min-h-[30px] rounded-sm border border-border-strong px-3 text-[13px] text-fg disabled:opacity-50" disabled={busy} onClick={discard}>Discard changes</button>
              <button
                type="button"
                className="min-h-[44px] sm:min-h-[30px] rounded-sm bg-accent px-3 text-[13px] font-medium text-bg hover:brightness-110 disabled:opacity-50"
                disabled={busy || !draft.trim()}
                onClick={save}
              >
                Save
              </button>
            </>
          ) : (
            <>
              <button type="button" className={BTN} disabled={busy} onClick={() => { setDraft(m.text); setEditing(true) }} aria-label={`Edit the queued message: ${m.text}`}>Edit</button>
              <button type="button" className={BTN} disabled={busy} onClick={() => void run(() => onCancel(m))} aria-label={`Cancel the queued message: ${m.text}`}>Cancel</button>
              {sendNow && (
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  title="Type it in now, without waiting for the turn to end"
                  onClick={() => void run(() => onSendNow(m))}
                >
                  Send now
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
