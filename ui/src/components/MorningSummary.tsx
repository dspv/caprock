/**
 * The Morning summary (ADR-092), in the Telegram section: one message a day
 * from the same bot — the mail Caprock Mail's sorting marked important, the
 * sessions that finished overnight per project, and what is waiting for
 * you. Off until switched on; 08:00 local until another time is chosen.
 *
 * The sentence under the switch says what goes to Telegram, here where it
 * is switched on (ADR-047): sender names and subjects, project names and
 * counts — never a mail's body.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Toggle } from '@/components/SettingsParts'

export const MORNING_DEFAULT_AT = '08:00'

/** "HH:MM", 24-hour: what the daemon accepts. */
export function validAt(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

export function MorningSummary({
  s,
  now,
  save,
  refresh,
}: {
  s: Settings
  now: number
  save: (patch: Partial<Settings>) => void
  refresh?: () => void
}) {
  const [testing, setTesting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const on = s.morning_summary === true
  const at = s.morning_summary_at || MORNING_DEFAULT_AT

  async function sendTest() {
    setTesting(true)
    setSent(false)
    setError('')
    try {
      await api.testMorning()
      setSent(true)
      window.setTimeout(() => setSent(false), 6000)
    } catch (e) {
      setError(errText(e))
    } finally {
      setTesting(false)
      refresh?.()
    }
  }

  return (
    <div className="grid gap-2.5 border-t border-border pt-3.5" data-morning-summary="">
      <Toggle
        checked={on}
        onChange={(v) => save({ morning_summary: v })}
        label="Morning summary"
        hint="One message each morning: important mail, what your agents finished overnight, and what is waiting for you. Sent once a day; if the computer was asleep at that time, on waking, until noon."
      />
      <label className="flex flex-wrap items-center gap-2.5 pl-[28px] text-[13.5px] text-fg-muted">
        Send at
        <input
          type="time"
          className="input h-8 tabular-nums"
          // .input is unlayered and full width; a time needs a few characters.
          style={{ width: '7.5rem' }}
          value={at}
          disabled={!on}
          aria-label="Morning summary time"
          onChange={(e) => {
            if (validAt(e.target.value)) save({ morning_summary_at: e.target.value })
          }}
        />
        <span className="text-[12.5px] text-fg-faint">your computer’s time</span>
      </label>
      {/* Kept with the explanations folded: where it is switched on, it says what it sends (ADR-047). */}
      <p className="pl-[28px] text-[12.5px] leading-relaxed text-fg-muted" data-keep="">
        What goes to Telegram: the sender’s name and subject of mail Caprock Mail marked important, project names, and
        how many sessions finished, failed or are waiting. Never a mail’s body or what an agent wrote.
      </p>
      <div className="flex flex-wrap items-center gap-3 pl-[28px]">
        <button
          onClick={() => void sendTest()}
          disabled={testing}
          className="h-9 rounded-[8px] border border-[var(--app-hairline-strong)] px-4 text-[13.5px] font-medium hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {testing ? 'Sending…' : 'Send a test summary now'}
        </button>
        {sent && <span className="text-[12.5px] text-ok">sent — check Telegram</span>}
        {error && <span className="text-[12.5px] text-danger">{error}</span>}
      </div>
      {!error && s.morning_summary_last_error ? (
        <p className="pl-[28px] text-[12.5px] text-danger">Last summary: {s.morning_summary_last_error}</p>
      ) : on && s.morning_summary_last_sent_ms ? (
        <p className="pl-[28px] text-[12.5px] text-fg-faint" data-keep="">
          Last summary sent {fmtAgo(s.morning_summary_last_sent_ms, now)}.
        </p>
      ) : null}
    </div>
  )
}
