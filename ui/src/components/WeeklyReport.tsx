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
 * The token is write-only (ADR-024). It goes in, it is never sent back, and
 * this panel shows that one is stored rather than showing it — which means the
 * field starts empty on a machine that already has a working bot, and the line
 * underneath has to say so or it reads as unsaved.
 */
import { useEffect, useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Panel } from '@/components/ui'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'

export function WeeklyReport() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const now = useNow(30_000)
  const [token, setToken] = useState('')
  const [chat, setChat] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const s: Settings | undefined = settings.data

  // The chat id is seeded because it comes back; the token is not, because it
  // does not. Seeded once, so a poll cannot overwrite what someone is typing.
  useEffect(() => {
    if (seeded || s === undefined) return
    setChat(s.report_chat_id ?? '')
    setSeeded(true)
  }, [s, seeded])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      // Only send the token when one was typed: an empty string is a clear,
      // and a blank field is the normal state on a machine that already has a
      // working bot.
      await api.saveSettings({
        report_chat_id: chat.trim(),
        ...(token.trim() ? { report_bot_token: token.trim() } : {}),
      } as Partial<Settings> as Settings)
      setToken('')
      setSaved(true)
      settings.refresh?.()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

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

        <label className="grid gap-1">
          <span className="text-fg-muted">
            Bot token
            {s?.report_bot_set && <span className="text-ok"> · one is stored</span>}
          </span>
          <input
            className="input"
            type="password"
            placeholder={s?.report_bot_set ? 'leave blank to keep the current one' : '123456:ABC-DEF…'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="text-[11px] text-fg-faint">
            Message <span className="mono">@BotFather</span> on Telegram, send{' '}
            <span className="mono">/newbot</span>, and paste what it gives you. Caprock stores it
            on this machine and never sends it back to this page.
          </span>
          {/* The question everybody asks, answered where it is asked. Without
            * this it reads as three minutes of setup for no reason, and the
            * reason is the whole point of the product. */}
          <span className="text-[11px] text-fg-faint">
            It is your own bot, not one of ours, and that is deliberate: the message goes
            straight from this machine to Telegram, so your figures never pass through
            anybody's server. A shared bot would mean shipping its token inside a public
            binary, and routing what you spend through us to deliver it.
          </span>
        </label>

        <label className="grid gap-1">
          <span className="text-fg-muted">Chat id</span>
          <input
            className="input"
            placeholder="123456789"
            value={chat}
            onChange={(e) => setChat(e.target.value)}
          />
          <span className="text-[11px] text-fg-faint">
            <strong>Write to your bot first</strong> — find it by its username, press Start, send
            anything. Telegram does not let a bot message you until you have. Then open{' '}
            <span className="mono">api.telegram.org/bot&lt;token&gt;/getUpdates</span> and copy{' '}
            <span className="mono">chat.id</span>. For a channel instead, add the bot as an
            administrator; its id starts with a minus.
          </span>
        </label>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => void save()}
            disabled={saving || !chat.trim()}
            className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50"
          >
            {saving ? 'saving…' : 'Save'}
          </button>
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
          {saved && !error && <span className="text-[11px] text-ok">saved</span>}
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
