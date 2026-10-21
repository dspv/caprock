/**
 * Desktop notifications (#/settings, in the app only): an OS notification when
 * a session needs you (WP-09; .ai/04-ui.md § Needs you and Done). Apart from
 * the Telegram switches: a notification stays on this machine. On unless
 * switched off. A turn that ended asking nothing (Done) never raises one, so
 * the old "has finished" switch is gone; notify_finished is no longer read.
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

  const toggle = (key: 'notify_approval', on: boolean) => {
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
        label="When a session needs you"
        hint="A permission, a question or a plan to approve at once. A turn that ended on a question (Needs your answer) or an error, after a minute with nothing new."
      />
      <p className="text-[11.5px] leading-relaxed text-fg-faint">
        A turn that ended asking nothing is Done: it stays listed on Home and sends no notification.
      </p>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </Section>
  )
}
