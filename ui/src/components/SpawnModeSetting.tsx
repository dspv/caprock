/**
 * Settings → New sessions: the permission mode a new session starts in.
 * Stored by the daemon (`spawn_permission_mode` in /v1/settings), so the app,
 * the browser and the phone agree. The new-session dialogs open on it, and a
 * start with no mode named — the project terminal's "new", a quick chat —
 * gets it. Continuing a session is different: that picks up in the mode the
 * session was last running in, and this applies only when nothing was
 * recorded.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { DEFAULT_MODE, modeOptions } from './SpawnDialog'
import { Choice, Section } from './SettingsParts'

export function SpawnModeSetting() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState('')
  if (!settings.data) return null
  const value = picked ?? (settings.data.spawn_permission_mode || DEFAULT_MODE)
  const save = async (mode: string) => {
    setError('')
    setPicked(mode)
    try {
      await api.saveSettings({ spawn_permission_mode: mode } as Partial<Settings> as Settings)
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <Section title="New sessions">
      <Choice
        label="Start in"
        value={value}
        options={modeOptions(value).map(([v, label]) => ({ value: v, label }))}
        onChange={(m) => void save(m)}
      />
      <p className="text-[12px] text-fg-muted">
        What a new agent may do without asking. Continuing a session keeps the mode it was last running in.
      </p>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
