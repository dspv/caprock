import { useState } from 'react'
import { api, errText, isPairedDevice } from '@/lib/api'
import { fmtUSD } from '@/lib/format'
import { navigate } from '@/lib/router'

/**
 * "Remove from Caprock": takes a session — a test run's leftovers, usually —
 * out of every screen and total, for good (ADR-037). The machine only: a
 * phone is never offered it, and the daemon refuses one.
 *
 * Two clicks, the second on a line that says what goes: the session, its
 * events and its cost. The transcript stays on disk and is not read again.
 */
export function RemoveSession({ sessionID, costUSD, running }: { sessionID: string; costUSD: number; running: boolean }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (isPairedDevice() || running) return null

  async function remove() {
    setBusy(true)
    setError('')
    try {
      const res = await api.removeSessions({ ids: [sessionID] })
      if (res.sessions.length === 0) {
        setError(res.skipped[0]?.reason ?? 'nothing was removed')
        return
      }
      navigate({ name: 'now' })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const button = 'text-[11px] border px-1.5 rounded-sm disabled:opacity-50'
  if (!confirm) {
    return (
      <button type="button" onClick={() => setConfirm(true)} className={`${button} border-border text-fg-faint hover:text-danger hover:border-danger`}>
        Remove from Caprock
      </button>
    )
  }
  return (
    <span role="alertdialog" aria-label="Remove this session" className="inline-flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-fg-muted">
        Remove this session, its events and {fmtUSD(costUSD)} from every total? The transcript stays on disk; Caprock won’t read it again. This can’t be undone.
      </span>
      <button type="button" disabled={busy} onClick={remove} className={`${button} border-danger text-danger hover:bg-danger/10`}>
        {busy ? 'removing…' : 'Remove'}
      </button>
      <button type="button" disabled={busy} onClick={() => { setConfirm(false); setError('') }} className={`${button} border-border text-fg-muted`}>
        Cancel
      </button>
      {error && <span className="text-danger">{error}</span>}
    </span>
  )
}
