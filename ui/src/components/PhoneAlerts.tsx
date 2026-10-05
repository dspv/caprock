/**
 * Phone alerts (#/settings): a Telegram message when a session is waiting for
 * approval, and when one has finished (ADR-036).
 *
 * Free, through the bot the weekly report uses — so the bot is set up here as
 * well, outside the report's lock. Both switches are off until switched on,
 * so a bot saved for the weekly report never starts alerting on its own. The test button exists for the same reason as
 * the report's: the failure mode of an alert is silence.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { Details, Section, Toggle } from '@/components/SettingsParts'
import { TelegramBotFields } from '@/components/TelegramBot'

export function PhoneAlerts() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const now = useNow(30_000)
  const [patch, setPatch] = useState<Partial<Settings>>({})
  const [testing, setTesting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const loaded = settings.data
  if (!loaded) return null
  const s: Settings = { ...loaded, ...patch }
  const configured = !!s.report_bot_set && !!s.report_chat_id

  const toggle = (key: 'alert_approval' | 'alert_finished' | 'alert_reply', on: boolean) => {
    setPatch((p) => ({ ...p, [key]: on }))
    void api.saveSettings({ [key]: on } as Partial<Settings> as Settings).catch((e) => setError(errText(e)))
  }

  async function sendTest() {
    setTesting(true)
    setSent(false)
    setError('')
    try {
      await api.testAlert()
      setSent(true)
      window.setTimeout(() => setSent(false), 6000)
    } catch (e) {
      // Telegram's own words: "chat not found" is something only the reader can fix.
      setError(errText(e))
    } finally {
      setTesting(false)
      settings.refresh?.()
    }
  }

  const bot = <TelegramBotFields s={s} onSaved={() => settings.refresh?.()} />
  return (
    <Section
      title="Phone alerts"
      aside={<span className="text-[12px] text-fg-muted">{configured ? 'via your Telegram bot' : 'needs a Telegram bot'}</span>}
    >
      <p className="text-[12px] leading-relaxed text-fg-muted">
        A Telegram message when a session needs you, from any terminal. It names the session (its title, or
        its first prompt), its folder and branch, with a link when your phone can open this dashboard. A
        dialog adds the tool and the command or file it asks about; a finished run adds its time, cost, tool
        calls and changed files. Telegram can read every message; code and tool output are never sent.
      </p>
      <Toggle
        checked={s.alert_approval === true}
        onChange={(on) => toggle('alert_approval', on)}
        label="When a session is waiting for approval"
        hint="At once, once per question. A burst of questions in one session is one message."
      />
      <Toggle
        checked={s.alert_finished === true}
        onChange={(on) => toggle('alert_finished', on)}
        label="When a session has finished"
        hint="After a minute with nothing new, so replying straight away sends nothing."
      />
      <Toggle
        checked={s.alert_reply !== false}
        onChange={(on) => toggle('alert_reply', on)}
        label="Include the last reply's first line"
        hint="Up to 120 characters of what the agent said last, in the finished message."
      />
      {configured ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void sendTest()}
              disabled={testing}
              className="rounded-sm border border-border px-3 py-1 text-[12px] hover:border-fg-faint disabled:opacity-50"
            >
              {testing ? 'sending…' : 'Send a test alert'}
            </button>
            {sent && <span className="text-[11px] text-ok">sent — check Telegram</span>}
            {error && <span className="text-[11px] text-danger">{error}</span>}
          </div>
          {!error && s.alert_last_error ? (
            <p className="text-[11px] text-danger">Last alert failed: {s.alert_last_error}</p>
          ) : s.alert_last_sent_ms ? (
            <p className="text-[11px] text-fg-faint">Last alert sent {fmtAgo(s.alert_last_sent_ms, now)}.</p>
          ) : null}
          <Details summary="Telegram bot">
            <div className="grid gap-3 text-[12px]">{bot}</div>
          </Details>
        </>
      ) : (
        <div className="grid gap-3 border-t border-border pt-3 text-[12px]">{bot}</div>
      )}
    </Section>
  )
}
