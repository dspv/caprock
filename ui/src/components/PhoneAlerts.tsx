/**
 * Telegram (#/settings): a message when a session is waiting for approval,
 * and when one has finished (ADR-036), from the owner's own bot — set up and
 * paired right here (ADR-047).
 *
 * Free, through the bot the weekly report uses — so the bot is set up here as
 * well, outside the report's lock. Both switches are off until switched on,
 * so a bot saved for the weekly report never starts alerting on its own. The
 * test button exists for the same reason as the report's: the failure mode of
 * an alert is silence. Talking back from Telegram is Premium and lives in the
 * section under this one (TelegramChat).
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { Details, Section, Toggle } from '@/components/SettingsParts'
import { TelegramBotFields } from '@/components/TelegramBot'
import { openExternal } from '@/lib/nudges'

/**
 * Telegram refusing the bot's token ("Unauthorized", or "Not Found" for a
 * deleted bot): the token was regenerated in BotFather or the bot is gone.
 * Only a new token fixes it, so the section says that, big, with the steps
 * (owner, 2026-10-18, translated: "why doesn't the token work … it needs a
 * clear, short, big instruction of what to do with it").
 */
export function tokenRejected(err: string | undefined): boolean {
  return !!err && /telegram: (unauthorized|not found|http 401|http 404)/i.test(err)
}

function TokenRejected() {
  return (
    <div data-telegram-rejected role="alert" className="grid gap-2.5 rounded-[10px] border border-danger/50 bg-danger/10 px-4 py-3.5">
      <p className="text-[16px] font-semibold text-fg">Telegram no longer accepts this bot's token</p>
      <p className="text-[13.5px] leading-relaxed text-fg-muted">
        It happens when the token is regenerated in BotFather or the bot is deleted. Nothing is lost: put in the new token.
      </p>
      <ol className="grid list-decimal gap-1 pl-5 text-[14px] leading-relaxed text-fg">
        <li>In Telegram open <span className="mono">@BotFather</span> → <span className="mono">/mybots</span> → your bot → <b>API Token</b>, and copy it.</li>
        <li>Below, click <b>Change bot</b> and paste it.</li>
      </ol>
      <button type="button" onClick={() => openExternal('https://t.me/BotFather')}
        className="h-9 justify-self-start rounded-[8px] bg-accent px-4 text-[13.5px] font-semibold text-panel hover:opacity-90">
        Open @BotFather
      </button>
    </div>
  )
}

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
  const rejected = tokenRejected(error) || tokenRejected(s.alert_last_error)
  return (
    <Section
      id="telegram"
      title="Telegram"
      aside={<span className="text-[12px] text-fg-muted">{configured ? 'via your Telegram bot' : 'needs a Telegram bot'}</span>}
    >
      <p className="text-[13px] leading-relaxed text-fg-muted">
        A Telegram message when a session needs you or has finished, from any terminal, with buttons to mute it or open it
        on your phone. Free.
      </p>
      {!configured && <div className="grid gap-3">{bot}</div>}
      {configured && (
        <Details summary="What a message says">
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            Each one opens with whose it is — the agent, the project and the session's title — then its folder and branch,
            with a link when your phone can open this dashboard. A dialog adds the tool and the command or file it asks
            about; a finished run adds its time, cost, tool calls and changed files. Telegram can read every message; tool
            output is never sent, and code only if you switch it on.
          </p>
        </Details>
      )}
      {configured ? (
        <>
          {rejected && <TokenRejected />}
          {!rejected && s.alert_approval !== true && s.alert_finished !== true && (
            <p className="rounded-[8px] border border-accent/50 bg-accent/10 px-3 py-2 text-[13px] text-fg">
              The bot is connected. Turn on at least one alert below, or nothing is sent.
            </p>
          )}
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
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void sendTest()}
              disabled={testing}
              className="h-9 rounded-[8px] border border-[var(--app-hairline-strong)] px-4 text-[13.5px] font-medium hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {testing ? 'Sending…' : 'Send a test alert'}
            </button>
            {sent && <span className="text-[12.5px] text-ok">sent — check Telegram</span>}
            {error && <span className="text-[12.5px] text-danger">{error}</span>}
          </div>
          {!error && s.alert_last_error ? (
            <p className="text-[12.5px] text-danger">Last alert failed: {s.alert_last_error}</p>
          ) : s.alert_last_sent_ms ? (
            <p className="text-[12.5px] text-fg-faint">Last alert sent {fmtAgo(s.alert_last_sent_ms, now)}.</p>
          ) : null}
          <p className="text-[12.5px] text-fg-faint">
            Each message has a <span className="text-fg-muted">Mute this session</span> button; <span className="mono">/mute all</span> in
            the chat silences everything until <span className="mono">/unmute</span>.
          </p>
          {rejected
            ? <div className="grid gap-3 text-[12px]">{bot}</div>
            : (
              <Details summary="Telegram bot">
                <div className="grid gap-3 text-[12px]">{bot}</div>
              </Details>
            )}
        </>
      ) : null}
    </Section>
  )
}
