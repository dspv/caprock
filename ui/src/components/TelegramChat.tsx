/**
 * Talking to the agents from Telegram (ADR-047; free since 2026-11-27, owner
 * decision: parity with Orca): the paired chat
 * may reply to a session's message to type into it, list the live sessions,
 * start Claude Code in a project, stop a session, and answer a question with
 * Approve or Deny.
 *
 * Off until switched on: it is control of this computer
 * from outside it, and nobody should find it on by surprise. Rule 7 is said
 * on the screen because it is the first thing a reader asks — what about the
 * session in my own terminal? It is watched, never typed into.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Section, Toggle } from '@/components/SettingsParts'

export function TelegramChat() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [patch, setPatch] = useState<Partial<Settings>>({})
  const [error, setError] = useState('')
  const s: Settings | undefined = settings.data ? { ...settings.data, ...patch } : undefined
  const paired = (!!s?.report_bot_set && !!s?.report_chat_id) || !!s?.telegram_via

  const toggle = (key: 'telegram_chat' | 'telegram_code', on: boolean) => {
    setPatch((p) => ({ ...p, [key]: on }))
    void api.saveSettings({ [key]: on } as Partial<Settings> as Settings).catch((e) => setError(errText(e)))
  }

  return (
    <Section title="Talk to your agents from Telegram">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Reply to a session's message in Telegram and Caprock types it in and presses Enter; the answer comes back in the
        same chat as soon as the turn ends. Approve and Deny appear under a question, read off the session's own screen
        the way the card answers it.
      </p>
      <ul className="grid gap-0.5 text-[12px] text-fg-muted">
        <li>
          <span className="mono text-fg">/sessions</span> — the live ones, numbered; tap a number to talk to it
        </li>
        <li>
          <span className="mono text-fg">/new caprock fix the flaky test</span> — start Claude Code in a project, in your
          default mode (Bypass asks first)
        </li>
        <li>
          <span className="mono text-fg">/stop 2</span> — stop a session, after a confirm
        </li>
      </ul>
      <Toggle
        checked={s?.telegram_chat === true}
        onChange={(on) => toggle('telegram_chat', on)}
        label="Let my paired chat talk to sessions"
        hint="Only sessions Caprock started: one in your own terminal is watched, never typed into."
      />
      <Toggle
        checked={s?.telegram_code === true}
        onChange={(on) => toggle('telegram_code', on)}
        label="Send code blocks in replies"
        hint="Off: each block is one line saying how long it was. Telegram can read whatever is sent."
      />
      {s && !paired && <p className="text-[11px] text-fg-faint">Set up and pair a bot in the Telegram section above first.</p>}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </Section>
  )
}
