/**
 * A terminal pane whose program exited a moment after it started: what it
 * printed, and Try again or Close, in place of a socket that kept trying to
 * connect to a process that was gone (lib/earlyexit).
 *
 * The code comes with the exit frame; the rest — the last lines on its
 * screen, how long it ran, the request that started it — is read once from
 * GET /v1/agents/{id}/exit. *Try again* posts that same request again, which
 * for a fork or a fresh session is a new session id: the pane is handed it.
 */
import { useEffect, useState } from 'react'
import { api, ApiError, type AgentExit } from '@/lib/api'
import { earlyExitHeadline, earlyExitHint, earlyExitWhen } from '@/lib/earlyexit'
import { agentName } from './Projects'

export function EarlyExit({ sessionId, code, agent, onRetried, onClose }: {
  sessionId: string
  /** From the exit frame, before the report is read. */
  code: number
  /** The session's agent, when the pane knows it; the report says it too. */
  agent?: string
  /** Try again started this session in its place. */
  onRetried: (newId: string) => void
  /** Close the pane; absent, no Close is offered. */
  onClose?: () => void
}) {
  const [report, setReport] = useState<AgentExit | null>(null)
  const [readError, setReadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setReport(null)
    setReadError('')
    api.agentExit(sessionId).then(
      (r) => { if (live) setReport(r) },
      (e) => { if (live) setReadError(e instanceof ApiError ? e.message : String(e)) },
    )
    return () => { live = false }
  }, [sessionId])

  const name = agentName(report?.agent ?? agent)
  const tail = report?.tail ?? ''
  const hint = earlyExitHint(tail)

  async function retry() {
    if (!report?.retry) return
    setBusy(true)
    setError('')
    try {
      const res = await api.spawn(report.retry)
      onRetried(res.session_id)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-early-exit={sessionId} aria-live="polite" className="absolute inset-0 z-30 flex items-center justify-center overflow-auto bg-bg/95 p-4">
      <div className="w-full max-w-[78ch] rounded-[var(--radius-panel)] border border-border bg-panel px-4 py-3.5 text-fg shadow-sm">
        <p data-early-exit-headline className="text-[14px] font-medium leading-snug">{earlyExitHeadline(name, report?.code ?? code)}</p>
        <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
          {earlyExitWhen(report?.ran_ms)} {report ? (tail ? 'Its last lines:' : 'It printed nothing.') : readError ? '' : 'Reading what it printed…'}
        </p>
        {tail && (
          <pre data-early-exit-tail className="mono mt-2 max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-panel-2 px-3 py-2 text-[12px] leading-[1.45] text-fg">
            {tail}
          </pre>
        )}
        {report?.binary && (
          <p data-early-exit-binary className="mono mt-1.5 truncate text-[11.5px] text-fg-faint" title={report.binary}>ran {report.binary}</p>
        )}
        {hint && <p data-early-exit-hint className="mt-2 text-[12.5px] leading-snug text-fg">{hint}</p>}
        {readError && <p className="mt-2 text-[12px] text-fg-faint">Caprock could not read what it printed: {readError}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {report?.retry && (
            <button
              type="button"
              data-early-exit-retry
              onClick={retry}
              disabled={busy}
              title="Start it again the same way"
              className="rounded-[6px] bg-accent px-3 py-1 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Try again'}
            </button>
          )}
          {onClose && (
            <button type="button" data-early-exit-close onClick={onClose} className="rounded-[6px] border border-border px-3 py-1 text-[12.5px] text-fg-muted hover:text-fg">
              Close
            </button>
          )}
          {report && !report.retry && <span className="text-[12px] text-fg-faint">Caprock restarted since it started, so it cannot start it again the same way.</span>}
        </div>
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      </div>
    </div>
  )
}
