/**
 * The owner's Telegram bot: token and chat id, and a Save.
 *
 * Shared by the weekly report and the phone alerts, which send through the
 * same bot (ADR-024, ADR-035). The alerts are free and the report is not, so
 * the setup cannot live only behind the report's lock.
 *
 * The token is write-only. It goes in, it is never sent back, and the field
 * says that one is stored rather than showing it — which means it starts
 * empty on a machine that already has a working bot, and the line above it
 * has to say so or it reads as unsaved.
 */
import { useEffect, useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'

export function TelegramBotFields({ s, onSaved }: { s: Settings | undefined; onSaved: () => void }) {
  const [token, setToken] = useState('')
  const [chat, setChat] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

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
      onSaved()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
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
          Your own bot, so messages go straight from this machine to Telegram — never through
          anybody's server.
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
          <strong>Message your bot first</strong> — find it by username, press Start, send
          anything. Then open{' '}
          <span className="mono">api.telegram.org/bot&lt;token&gt;/getUpdates</span> and copy{' '}
          <span className="mono">chat.id</span>.
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
        {saved && !error && <span className="text-[11px] text-ok">saved</span>}
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
    </>
  )
}
