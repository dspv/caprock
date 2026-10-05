/**
 * Settings → Global shortcut (WP-10, F09): the one key that brings the
 * desktop app up from any other app. Shown only inside the app; the shell
 * registers it and keeps the choice (app/src-tauri/src/hotkey.rs).
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { isMacPlatform } from '@/lib/appmode'
import { formatAccelerator, recordAccelerator } from '@/lib/accelerator'
import { shell, type HotkeyStatus } from '@/lib/shell'
import { Section } from '@/components/SettingsParts'

function platformName(): 'macos' | 'windows' | 'linux' {
  if (isMacPlatform()) return 'macos'
  return typeof navigator !== 'undefined' && /Win/.test(navigator.platform) ? 'windows' : 'linux'
}

const BUTTON = 'rounded-sm border border-border px-3 py-1 text-[12px] hover:border-fg-faint disabled:opacity-50'

export function GlobalHotkey() {
  const [status, setStatus] = useState<HotkeyStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const platform = platformName()

  useEffect(() => {
    let alive = true
    shell.hotkeyStatus()
      .then((s) => { if (alive) setStatus(s) })
      .catch((e: unknown) => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [])

  const apply = (accelerator: string | null) => {
    setBusy(true)
    setError('')
    shell.registerHotkey(accelerator)
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => { setBusy(false); setRecording(false) })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) { setRecording(false); return }
    const r = recordAccelerator(e)
    if (r.kind === 'modifier-only') return
    if (r.kind === 'needs-modifier') { setError('Hold Control, Option or Command with the key, so typing it elsewhere still works.'); return }
    if (r.kind === 'unsupported') { setError(`${r.code} cannot be a global shortcut: use a letter, a digit, F1–F12, Space or an arrow.`); return }
    apply(r.accelerator)
  }

  if (!status) {
    return error ? <Section title="Global shortcut"><p className="text-[12px] text-danger">{error}</p></Section> : null
  }
  const current = status.accelerator ? formatAccelerator(status.accelerator, platform) : 'Off'
  const isDefault = status.accelerator === status.default
  return (
    <Section title="Global shortcut">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Brings Caprock to the front from any app; pressed again, it hides it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <kbd className="mono rounded-sm border border-border px-2 py-0.5 text-[13px] text-fg" data-testid="hotkey-current">{current}</kbd>
        <button
          type="button"
          className={`${BUTTON} ${recording ? 'border-accent text-accent' : ''}`}
          disabled={busy}
          onClick={() => { setError(''); setRecording((r) => !r) }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
        >
          {recording ? 'Press the new shortcut… (Esc cancels)' : 'Change'}
        </button>
        {!isDefault && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => apply(status.default)}>
            Use {formatAccelerator(status.default, platform)}
          </button>
        )}
        {status.accelerator && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => apply(null)}>
            Turn off
          </button>
        )}
      </div>
      {status.accelerator && !status.registered && status.error && (
        <p className="text-[12px] text-danger">Not active: {status.error}</p>
      )}
      {status.wayland && (
        <p className="text-[12px] text-fg-muted">
          On Wayland the desktop does not let apps take a global key, so this may not work; the tray menu’s Show Caprock
          still brings it up.
        </p>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
