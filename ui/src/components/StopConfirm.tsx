/**
 * The one confirmation before Caprock stops a session or a shell it started:
 * the cockpit's Stop button and the sidebar's ■ and Stop… all open it.
 * Stopping ends the process (`POST /v1/agents/{id}/signal`, kill); the
 * conversation or the shell's record is kept. Callers offer it only for what
 * Caprock started (`owned`) — rule 7: never a process we did not start.
 */
import { useState } from 'react'
import { api, errText } from '@/lib/api'

export type StopWhat = 'session' | 'shell'

/** "Stop the session…" / "Stop the shell…": the words of every way in. */
export function stopLabel(what: StopWhat): string {
  return `Stop the ${what}…`
}

export function StopConfirm({ sessionId, what, onDone }: { sessionId: string; what: StopWhat; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      await api.signal(sessionId, 'kill')
      setBusy(false)
      onDone()
    } catch (e) {
      setBusy(false)
      setError(errText(e))
    }
  }
  return (
    <div role="alertdialog" aria-label="Confirm stop" className="grid gap-2 rounded-[9px] border border-danger/40 bg-danger/[0.06] p-3">
      <p className="text-[12.5px] text-fg">Stop this {what}? Its process ends; the {what === 'shell' ? 'shell' : 'conversation'} is kept{what === 'session' ? ' and can be continued' : ''}.</p>
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="h-[28px] rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[12.5px] text-fg hover:bg-[var(--app-row-hover)]">Keep it</button>
        <button type="button" autoFocus disabled={busy} onClick={() => void stop()} className="h-[28px] rounded-[7px] bg-danger px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50">
          {busy ? 'Stopping…' : `Stop ${what}`}
        </button>
      </div>
    </div>
  )
}
