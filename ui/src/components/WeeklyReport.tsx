/**
 * The weekly report: where it goes, and whether the last one arrived.
 *
 * Two fields and a status line, and the status line is the part that matters.
 * A weekly message that quietly stops arriving is the failure nobody notices —
 * an absence looks exactly like a quiet week — so the last outcome is on the
 * panel rather than in a log file. Telegram's own words are kept verbatim
 * ("chat not found", "bot was blocked by the user") because both are things
 * only the reader can fix.
 *
 * The bot itself — a write-only token (ADR-024) and a chat id — is
 * TelegramBotFields, shared with the free phone alerts in Settings (ADR-036).
 */
import { useState } from 'react'
import { api, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Panel } from '@/components/ui'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { TelegramBotFields } from '@/components/TelegramBot'

export function WeeklyReport() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const now = useNow(30_000)
  const [error, setError] = useState('')

  const s: Settings | undefined = settings.data

  const configured = !!s?.report_bot_set && !!s?.report_chat_id
  const [testing, setTesting] = useState(false)
  const [sent, setSent] = useState(false)

  async function sendNow() {
    setTesting(true)
    setSent(false)
    setError('')
    try {
      await api.testReport()
      setSent(true)
      window.setTimeout(() => setSent(false), 6000)
    } catch (e) {
      // Telegram's own words: "chat not found" and "bot was blocked by the
      // user" are both things only the reader can fix.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Panel
      title="Weekly report"
      right={
        <span className="text-[11px] text-fg-faint">
          {configured ? 'Mondays, or the next day you open the lid' : 'not set up'}
        </span>
      }
    >
      <div className="px-3 py-3 grid gap-3 text-[12px]">
        <p className="m-0 text-fg-muted">
          What moved this week, against your usual — sent to a Telegram bot you own. Nothing
          passes our server, and the message carries figures only: no prompts, no replies, no
          file names.
        </p>

        <TelegramBotFields s={s} onSaved={() => settings.refresh?.()} />

        <div className="flex items-center gap-3 flex-wrap">
          {/* Without this the only way to learn whether a token is right is to
            * wait for Monday and see nothing arrive — which is exactly what a
            * quiet week looks like. A button that sends one now turns a week
            * of doubt into five seconds. */}
          <button
            onClick={() => void sendNow()}
            disabled={testing || !configured}
            title={configured ? 'Send this week\'s report now' : 'Save a bot token and chat id first'}
            className="border border-border px-3 py-1 rounded-sm hover:border-fg-faint disabled:opacity-50"
          >
            {testing ? 'sending…' : 'Send one now'}
          </button>
          {sent && <span className="text-[11px] text-ok">sent — check Telegram</span>}
          {error && <span className="text-[11px] text-danger">{error}</span>}
        </div>

        {/* The whole reason this line exists: a message that stopped arriving
          * is invisible otherwise, and looks identical to a quiet week. */}
        {s?.report_last_error ? (
          <p className="m-0 text-[11px] text-danger">
            Last send failed: {s.report_last_error}
          </p>
        ) : s?.report_last_sent_ms ? (
          <p className="m-0 text-[11px] text-fg-faint">
            Last sent {fmtAgo(s.report_last_sent_ms, now)} ago.
          </p>
        ) : configured ? (
          <p className="m-0 text-[11px] text-fg-faint">
            Nothing sent yet — the first one goes out at the start of next week.
          </p>
        ) : null}
      </div>
    </Panel>
  )
}
