/**
 * Desktop notifications (#/settings, in the app only): an OS notification when
 * a session needs approval or has finished (WP-09). Apart from the Telegram
 * switches: a notification stays on this machine. Approval is on unless
 * switched off — a blocked agent is what the app is for; finished is off
 * unless switched on.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Section, Toggle } from '@/components/SettingsParts'

export function DesktopNotifications() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [patch, setPatch] = useState<Partial<Settings>>({})
  const [error, setError] = useState('')
  const loaded = settings.data
  if (!loaded) return null
  const s: Settings = { ...loaded, ...patch }

  const toggle = (key: 'notify_approval' | 'notify_finished', on: boolean) => {
    setPatch((p) => ({ ...p, [key]: on }))
    void api.saveSettings({ [key]: on } as Partial<Settings> as Settings).catch((e) => setError(errText(e)))
  }

  return (
    <Section title="Desktop notifications">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        A notification from this app when a session needs you: its project and session, and the command or
        file it asks about. Nothing for the session you are looking at. Clicking one opens the session with
        its Yes and No buttons. Same limits as phone alerts: one per session in 3 minutes, 20 an hour.
      </p>
      <Toggle
        checked={s.notify_approval !== false}
        onChange={(on) => toggle('notify_approval', on)}
        label="When a session is waiting for approval"
        hint="At once, once per question."
      />
      <Toggle
        checked={s.notify_finished === true}
        onChange={(on) => toggle('notify_finished', on)}
        label="When a session has finished"
        hint="After a minute with nothing new, so replying straight away shows nothing."
      />
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </Section>
  )
}
