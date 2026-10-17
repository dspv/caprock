/**
 * The bar an agent's "update available" notice gets near the bottom of its
 * terminal (lib/termupdate.ts): *Codex 0.162.0 available · Copy command ·
 * Open a terminal · ×*. Copy puts the printed command on the clipboard and
 * says *Copied*; Open a terminal asks for a plain shell tab in the session's
 * folder and types nothing into it; × hides it for that agent and version.
 * Nothing here runs the command.
 */
import { useEffect, useState } from 'react'
import { copyText } from '@/lib/mdreader'
import { noticeLabel, type UpdateNotice } from '@/lib/termupdate'

export function UpdateNoticeBar({ notice, onOpenShell, onDismiss, copy = copyText }: {
  notice: UpdateNotice
  onOpenShell: () => void
  onDismiss: () => void
  /** For tests. */
  copy?: (text: string) => Promise<boolean>
}) {
  const [said, setSaid] = useState<'' | 'Copied' | 'Could not copy'>('')
  useEffect(() => {
    if (!said) return
    const t = window.setTimeout(() => setSaid(''), 1600)
    return () => window.clearTimeout(t)
  }, [said])
  const btn = 'rounded px-1.5 leading-[20px] text-fg hover:bg-[var(--app-row-hover)] focus-visible:outline-1 focus-visible:outline-accent'
  return (
    <div
      data-update-notice={notice.agent}
      role="status"
      className="pointer-events-auto inline-flex max-w-full items-center gap-1 rounded-md border border-border-strong bg-panel/95 py-0.5 pl-2.5 pr-1 text-[11.5px] text-fg-muted shadow-[var(--shadow-panel)] backdrop-blur-sm"
      title={notice.command}
    >
      <span className="truncate">{noticeLabel(notice)}</span>
      <span aria-hidden className="text-fg-faint">·</span>
      <button
        type="button"
        className={btn}
        onClick={() => { void copy(notice.command).then((ok) => setSaid(ok ? 'Copied' : 'Could not copy')) }}
      >
        {said || 'Copy command'}
      </button>
      <span aria-hidden className="text-fg-faint">·</span>
      <button type="button" className={btn} onClick={onOpenShell}>Open a terminal</button>
      <button
        type="button"
        aria-label={`Dismiss — ${noticeLabel(notice)}`}
        title="Hide for this version"
        className="ml-0.5 flex h-[20px] w-[20px] items-center justify-center rounded text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}
