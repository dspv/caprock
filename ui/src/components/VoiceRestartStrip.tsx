/**
 * The strip an agent tab gets when its terminal shows Claude Code's voice
 * failing (lib/termvoice.ts): *Voice works after restarting this session.*
 * with *Restart here* and ×. macOS only, a Claude Code session Caprock
 * started only; the pane decides that before it mounts this.
 *
 * Restart is the permission-mode restart (ADR-054) in the mode the session
 * is in now: the same conversation resumed under its own id, in this tab.
 * The daemon refuses it mid-turn, so while the agent works or a prompt waits
 * the button reads *Restart when idle*; pressed, it waits, and restarts once
 * the turn is over. The session is asked every POLL_MS while the strip shows.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errText, type PermissionModeView } from '@/lib/api'
import { restartMode, restartWhen, VOICE_STRIP_TEXT } from '@/lib/termvoice'

/** How often the session's state is read while the strip shows. */
export const POLL_MS = 2000

export function VoiceRestartStrip({ sessionId, onRestarted, onDismiss }: {
  sessionId: string
  /** The restart was made: the strip goes and is not offered again for this session. */
  onRestarted: () => void
  onDismiss: () => void
}) {
  const [view, setView] = useState<PermissionModeView | null>(null)
  // Pressed while the agent worked: restart when its turn is over.
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const going = useRef(false)

  const restart = useCallback(async (v: PermissionModeView) => {
    if (going.current) return
    going.current = true
    setBusy(true)
    setError('')
    try {
      await api.setPermissionMode(sessionId, restartMode(v), true)
      setArmed(false)
      onRestarted()
    } catch (e) {
      setArmed(false)
      setError(errText(e))
    } finally {
      going.current = false
      setBusy(false)
    }
  }, [sessionId, onRestarted])

  useEffect(() => {
    let alive = true
    let timer = 0
    const read = () => {
      api.permissionMode(sessionId)
        .then((v) => { if (alive) setView(v) })
        .catch(() => { /* the next read */ })
        .finally(() => { if (alive) timer = window.setTimeout(read, POLL_MS) })
    }
    read()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [sessionId])

  // Armed, and the turn is over: the restart goes, once.
  useEffect(() => {
    if (armed && view && restartWhen(view) === 'now') void restart(view)
  }, [armed, view, restart])

  if (view && !view.switchable) return null
  const when = restartWhen(view)
  const label = busy ? 'Restarting…' : armed ? 'Restarts when idle' : when === 'idle' ? 'Restart when idle' : 'Restart here'
  return (
    <div role="status" aria-label="Voice" data-voice-restart className="flex h-[30px] shrink-0 items-center gap-2 overflow-hidden border-t border-term-border bg-term-bg px-3 text-[12px]">
      <span className="min-w-0 shrink truncate text-accent/90" title={VOICE_STRIP_TEXT}>{VOICE_STRIP_TEXT}</span>
      {error && <span role="alert" className="min-w-0 shrink truncate text-danger" title={error}>{error}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={!view || busy || armed}
          title={when === 'idle' && !armed ? 'The agent is working: it restarts once its turn ends' : 'Ends this process and resumes the same conversation in this tab'}
          onClick={() => {
            if (!view) return
            if (restartWhen(view) === 'now') void restart(view)
            else setArmed(true)
          }}
          className="flex h-[22px] items-center gap-1 rounded-[6px] border border-border px-1.5 text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50"
        >
          {label}
        </button>
        <button
          type="button"
          aria-label="Dismiss — voice restart"
          title="Hide for this session"
          onClick={onDismiss}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-fg-faint hover:text-fg"
        >
          ×
        </button>
      </span>
    </div>
  )
}
