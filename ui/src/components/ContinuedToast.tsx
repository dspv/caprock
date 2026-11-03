/**
 * The toast after a session moved to another provider or sign-in (ADR-090):
 * "Moved to Kimi · same session · back to Claude at 18:40 · Undo". It follows
 * a click on the limit strip and Caprock's own move (limit_action "auto")
 * alike — both arrive through lib/continueOn's announceContinued. Undo
 * continues the new session back on what it ran on before.
 */
import { useEffect, useState } from 'react'
import { api, errText, type ContinueOnResult } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { announceContinued, movedText, onContinued } from '@/lib/continueOn'

/** How long the toast stays: long enough to reach Undo, short enough to leave. */
export const CONTINUED_TOAST_MS = 15_000

export function ContinuedToast() {
  const [moved, setMoved] = useState<ContinueOnResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => onContinued((r) => { setMoved(r); setError(''); setBusy(false) }), [])
  useEffect(() => {
    if (!moved || busy) return
    const t = window.setTimeout(() => setMoved(null), error ? CONTINUED_TOAST_MS * 2 : CONTINUED_TOAST_MS)
    return () => window.clearTimeout(t)
  }, [moved, busy, error])
  // Names for a sign-in's id ("Claude · Work"); asked only while a toast is up.
  const subs = useApi(() => (moved ? api.subscriptions() : Promise.resolve(undefined)), [!!moved], { live: false })
  if (!moved) return null
  const undo = async () => {
    setBusy(true)
    setError('')
    try {
      announceContinued(await api.continueOn(moved.session_id, moved.from))
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }
  return (
    <div role="status" data-continued-toast className="app-fade-in pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center px-4">
      <p className="pointer-events-auto max-w-[620px] rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel px-4 py-2.5 text-[12.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">
        {movedText(moved, subs.data)}
        {' · '}
        <button type="button" disabled={busy} onClick={() => void undo()} className="text-accent underline-offset-2 hover:underline disabled:opacity-50">
          {busy ? 'Undoing…' : 'Undo'}
        </button>
        {error && <span role="alert" className="block text-[12px] text-danger">{error}</span>}
      </p>
    </div>
  )
}
