/**
 * Desktop notifications (#/settings, in the app only): an OS notification when
 * a session needs you (WP-09; .ai/04-ui.md § Needs you and Done). Apart from
 * the Telegram switches: a notification stays on this machine. On unless
 * switched off. A turn that ended asking nothing (Done) never raises one, so
 * the old "has finished" switch is gone; notify_finished is no longer read.
 *
 * On macOS also the peek: the menu bar panel shows itself when a session
 * Caprock started waits on a dialog (lib/tray.ts `mayPeek`). Off unless
 * switched on, and saved in this app only (localStorage).
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { isMacPlatform } from '@/lib/appmode'
import { usePeek } from '@/lib/tray'
import { Section, Toggle } from '@/components/SettingsParts'

export function DesktopNotifications() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [patch, setPatch] = useState<Partial<Settings>>({})
  const [error, setError] = useState('')
  const [peek, savePeek] = usePeek()
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
      {isMacPlatform() && (
        <Toggle
          checked={peek}
          onChange={savePeek}
          label="Show the menu bar panel when an agent needs you"
          hint="For a session Caprock started that waits on a permission, a question or a plan: the menu bar panel opens under the icon with Approve and Deny, without taking the keyboard from the app you are in. A click elsewhere, Escape, an answer or 15 seconds untouched closes it; once closed unanswered, it stays away for a minute. Never for the session in front of you. Saved in this app only."
        />
      )}
      <p className="text-[11.5px] leading-relaxed text-fg-faint">
        A turn that ended asking nothing is Done: it stays listed on Home and sends no notification.
      </p>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </Section>
  )
}
