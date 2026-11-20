/**
 * One line at the top of a shell that took over an agent session which
 * ended unexpectedly (lib/endedAgent.ts; owner, 2026-11-20, translated: the
 * session died with Chrome and the tab silently became a shell). It says
 * which session, when and why — "ops ended unexpectedly at 19:58 (killed by
 * a signal)" — with **Resume**, which continues the same conversation in
 * this tab, and a × that leaves the shell as it is. The quick chat's hint
 * (QuickChatPane.tsx ChatHint) is the same shape.
 */
import { useState } from 'react'
import { endedText, type EndedAgent } from '@/lib/endedAgent'
import { CloseIcon } from './AppIcons'

export function EndedNotice({ ended, onResume, onDismiss, now }: {
  ended: EndedAgent
  /** Continues the conversation in this tab; rejects when it could not. */
  onResume: () => Promise<void> | void
  onDismiss: () => void
  /** For tests: the clock the time is read against. */
  now?: number
}) {
  const [busy, setBusy] = useState(false)
  const text = endedText(ended, now)
  const resume = async () => {
    if (busy) return
    setBusy(true)
    try { await onResume() } finally { setBusy(false) }
  }
  return (
    <div
      role="status"
      data-ended-notice={ended.sessionId}
      className="flex min-h-[30px] shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 py-1 pl-3 pr-1 text-[12px]"
    >
      <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full bg-warn" />
      <span data-ended-text className="min-w-0 flex-1 truncate text-fg" title={text}>{text}</span>
      <button
        type="button"
        data-ended-resume
        disabled={busy}
        onClick={() => { void resume() }}
        title="Continue the same conversation in this tab"
        className="app-primary h-[22px] shrink-0 rounded-[6px] px-2.5 text-[12px] font-medium disabled:opacity-50"
      >
        {busy ? 'Resuming…' : 'Resume'}
      </button>
      <button
        type="button"
        data-ended-dismiss
        aria-label="Dismiss"
        title="Dismiss — the shell stays"
        onClick={onDismiss}
        className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  )
}
