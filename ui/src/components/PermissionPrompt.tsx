import { useEffect, useState } from 'react'
import { api, ApiError, errText, type Permission, type PermissionChoice } from '@/lib/api'
import { live, useLive } from '@/lib/live'
import { useCanControl } from '@/lib/useCanControl'

/**
 * The permission prompt a session waits on: from GET on mount and on every
 * reconnect of the live socket, then from its "permission" frames.
 */
export function usePermission(sessionId: string): [Permission | null, (p: Permission | null) => void] {
  const [prompt, setPrompt] = useState<Permission | null>(null)
  const { conn } = useLive()
  useEffect(() => {
    if (conn !== 'open') return
    let alive = true
    api.permission(sessionId)
      .then((r) => { if (alive) setPrompt(r.permission) })
      .catch(() => { /* an older daemon, or the session is gone: no buttons */ })
    return () => { alive = false }
  }, [sessionId, conn])
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'permission' && f.data.session_id === sessionId) setPrompt(f.data.permission)
  }), [sessionId])
  return [prompt, setPrompt]
}

/**
 * Buttons for a Claude Code permission prompt (ADR-035).
 *
 * The terminal draws the same menu, answered with arrows and Enter — fine at a
 * desk, a guessing game on a phone. Here it is the command or file being asked
 * about, in full, and one button per answer. A viewer sees what is being asked
 * and no buttons.
 */
export function PermissionPrompt({ sessionId }: { sessionId: string }) {
  const [prompt, setPrompt] = usePermission(sessionId)
  const canControl = useCanControl()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setError('') }, [prompt?.id])
  if (!prompt) return null

  const answer = async (choice: PermissionChoice) => {
    setBusy(true)
    setError('')
    try {
      await api.answerPermission(sessionId, prompt.id, choice)
      setPrompt(null)
    } catch (err) {
      // 409: answered in the terminal, or a newer prompt replaced it. The live
      // frame brings the newer one; this one is gone either way.
      if (err instanceof ApiError && err.status === 409) setPrompt(null)
      else setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const button = 'min-h-[48px] rounded-sm px-4 py-2 text-[15px] font-medium disabled:opacity-50'
  return (
    <div role="alertdialog" aria-label="Permission prompt" className="grid gap-2 border border-accent/60 bg-accent/10 rounded-sm px-3 py-3 mt-2">
      <p className="text-[13px] text-fg">
        Claude wants to use <span className="mono font-medium">{prompt.tool}</span>
      </p>
      {prompt.detail && (
        <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-panel-2 px-2 py-1.5 text-[12px] text-fg">
          {prompt.detail}
        </pre>
      )}
      {canControl ? (
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <button type="button" disabled={busy} onClick={() => void answer('allow')} className={`${button} bg-accent text-bg hover:brightness-110`}>
            Yes
          </button>
          {prompt.always && (
            <button type="button" disabled={busy} onClick={() => void answer('always')} className={`${button} border border-accent text-fg hover:bg-accent/15`}>
              {prompt.always}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void answer('deny')} className={`${button} border border-border-strong text-fg hover:border-danger hover:text-danger`}>
            No
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-fg-muted">Waiting for an answer on a device that controls sessions.</p>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}
