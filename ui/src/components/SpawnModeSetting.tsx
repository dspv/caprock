/**
 * Settings → New sessions: the permission mode a new session starts in.
 * Stored by the daemon (`spawn_permission_mode` in /v1/settings), so the app,
 * the browser and the phone agree. The new-session dialogs open on it, and a
 * start with no mode named — the project terminal's "new", a quick chat —
 * gets it. Continuing a session is different: that picks up in the mode the
 * session was last running in, and this applies only when nothing was
 * recorded.
 *
 * *End idle chats after* (`end_idle_after`, .ai/03-contracts.md § Ending idle
 * sessions): an agent session Caprock started that no tab shows has its
 * process ended once it has sat idle this long; the conversation stays
 * listed and is continued from where it stopped (lib/idleEnd.ts).
 */
import { useState } from 'react'
import { api, errText, type EndIdleAfter, type Settings } from '@/lib/api'
import { END_IDLE_OPTIONS } from '@/lib/idleEnd'
import { useApi } from '@/lib/useApi'
import { DEFAULT_MODE, modeOptions } from './SpawnDialog'
import { Choice, Section } from './SettingsParts'

export function SpawnModeSetting() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [picked, setPicked] = useState<string | null>(null)
  const [idlePicked, setIdlePicked] = useState<EndIdleAfter | null>(null)
  const [error, setError] = useState('')
  if (!settings.data) return null
  const value = picked ?? (settings.data.spawn_permission_mode || DEFAULT_MODE)
  const idle: EndIdleAfter = idlePicked ?? settings.data.end_idle_after ?? '12h'
  const save = async (mode: string) => {
    setError('')
    setPicked(mode)
    try {
      await api.saveSettings({ spawn_permission_mode: mode } as Partial<Settings> as Settings)
    } catch (e) {
      setError(errText(e))
    }
  }
  const saveIdle = async (v: EndIdleAfter) => {
    setError('')
    setIdlePicked(v)
    try {
      await api.saveSettings({ end_idle_after: v } as Partial<Settings> as Settings)
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
      <Choice<EndIdleAfter> label="End idle chats after" value={idle} options={END_IDLE_OPTIONS} onChange={(v) => void saveIdle(v)} />
      <p className="text-[12px] text-fg-muted" data-end-idle-hint>
        {idle === 'never'
          ? 'Chats and agents Caprock started keep running with no tab until you stop them.'
          : 'A chat or agent Caprock started that has no tab, has not done anything and waits on nothing for this long is ended to free memory. Its conversation stays in the list and continues from where it stopped when you open it. One with a tab, or started in your own terminal, is never ended.'}
      </p>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
