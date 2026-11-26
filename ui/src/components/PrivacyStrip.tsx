/**
 * The strip a terminal gets when macOS refused its session a guarded folder
 * (lib/termprivacy, ADR-106): which folder, which entry to switch on in
 * System Settings, **Open Settings** and ×. macOS daemons only; the pane
 * decides that before it mounts this.
 *
 * The entry is asked of the daemon once (`GET /v1/sessions/{id}/privacy`):
 * the program macOS holds responsible for the session's process, named as
 * System Settings lists it. **Open Settings** opens the Full Disk Access
 * pane on the Mac the session runs on and shows that program in Finder, so
 * it can be dragged into the list when it is not there. Nothing opens
 * without the click.
 */
import { useEffect, useState } from 'react'
import { api, errText } from '@/lib/api'
import { privacyText, type GuardedFolder } from '@/lib/termprivacy'

export function PrivacyStrip({ sessionId, folder, onDismiss }: {
  sessionId: string
  folder: GuardedFolder
  onDismiss: () => void
}) {
  const [name, setName] = useState('')
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    api.sessionPrivacy(sessionId)
      .then((p) => { if (alive) setName(p.name) })
      .catch(() => { /* the sentence names no program */ })
    return () => { alive = false }
  }, [sessionId])

  const text = opened
    ? `Switch on ${name || 'the program'} in the list, then try again.`
    : privacyText(folder, name)
  return (
    <div role="status" aria-label="Folder access" data-privacy-strip className="flex h-[30px] shrink-0 items-center gap-2 overflow-hidden border-t border-term-border bg-term-bg px-3 text-[12px]">
      <span className="min-w-0 shrink truncate text-accent/90" title={text}>{text}</span>
      {error && <span role="alert" className="min-w-0 shrink truncate text-danger" title={error}>{error}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          title="Opens System Settings › Privacy & Security › Full Disk Access on this Mac and shows the program in Finder"
          onClick={() => {
            setBusy(true)
            setError('')
            api.openSessionPrivacy(sessionId, 'full_disk')
              .then((p) => { if (p.name) setName(p.name); setOpened(true) })
              .catch((e) => setError(errText(e)))
              .finally(() => setBusy(false))
          }}
          className="flex h-[22px] items-center gap-1 rounded-[6px] border border-border px-1.5 text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50"
        >
          Open Settings
        </button>
        <button
          type="button"
          aria-label="Dismiss — folder access"
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
