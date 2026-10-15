/**
 * The owner's Telegram bot, set up in three steps (ADR-047): paste the token
 * BotFather gave you, Caprock checks it with Telegram, then a one-time code
 * pairs the chat. The first private chat to send the code is the only one
 * the bot listens to — which replaces the old "open getUpdates in a browser
 * and copy chat.id", a step that asked the reader to read raw JSON.
 *
 * Shared by the weekly report and the phone alerts, which send through the
 * same bot (ADR-024, ADR-036). The alerts are free and the report is not, so
 * the setup cannot live only behind the report's lock.
 *
 * The token is write-only. It goes in, it is never sent back; the screen
 * shows a mask of its last four characters and the bot's @name, which is how
 * a person tells two bots apart.
 */
import { useEffect, useRef, useState } from 'react'
import { api, errText, type Settings, type TelegramStatus } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'
import { openExternal } from '@/lib/nudges'
import { BigStep } from './Pairing'
import { SecretInfo, SecretInput, SecretNote, SecretPill, type SecretProvider } from './SecretField'

export const TELEGRAM_PROVIDER: SecretProvider = {
  name: 'Telegram',
  host: 'api.telegram.org',
  sentWhen: 'with each message the bot sends or reads: alerts, the weekly report, chat replies, and a share card you send with Share → To me (the card and its words, nothing else).',
  revokeAt: '@BotFather',
  revokeHow: 'send /revoke and pick the bot, or /deletebot.',
}

export function TelegramBotFields({ s, onSaved }: { s?: Settings; onSaved: () => void }) {
  const tg = useApi(() => api.telegram(), [], { live: false })
  const [state, setState] = useState<TelegramStatus | undefined>(undefined)
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(1000)
  const saved = useRef(onSaved)
  useEffect(() => {
    saved.current = onSaved
  })

  useEffect(() => {
    if (tg.data) setState(tg.data)
  }, [tg.data])

  // While a code waits, ask every two seconds whether it has been sent: the
  // moment the chat pairs, the screen says so.
  const pairing = state?.pairing
  useEffect(() => {
    if (!pairing) return
    const t = window.setInterval(() => {
      void api.telegram().then((st) => {
        setState(st)
        if (st.chat_set && !st.pairing) saved.current()
      }).catch(() => {})
    }, 2000)
    return () => window.clearInterval(t)
  }, [pairing])

  if (tg.error && !state) {
    return <p className="text-[11px] text-danger">Could not read the Telegram setup: {tg.error.message}</p>
  }
  if (!state) return null

  const run = async (f: () => Promise<TelegramStatus>) => {
    setBusy(true)
    setError('')
    try {
      const st = await f()
      setState(st)
      onSaved()
      return st
    } catch (e) {
      // Telegram's own words: "does not recognise this token" is something
      // only the reader can fix.
      setError(errText(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const saveToken = async () => {
    const st = await run(() => api.telegramToken(token.trim()))
    if (!st) return
    setToken('')
    setEditing(false)
    // Straight on to pairing: a token with no chat sends nothing anywhere.
    if (!st.chat_set) await run(() => api.telegramPair())
  }

  const err = error && <p className="text-[11px] text-danger">{error}</p>
  const bot = state.bot_username ? `@${state.bot_username}` : 'your bot'

  if (!state.bot_set || editing) {
    // Three large steps, as the phone section has (owner, 2026-10-11: the
    // instructions must be inside the app, where the setup is done).
    return (
      <div className="grid gap-4">
        <ol className="grid gap-3 sm:grid-cols-3">
          <BigStep n={1} title="Make a bot">
            In Telegram, open <span className="mono text-fg">@BotFather</span>, send <span className="mono text-fg">/newbot</span>{' '}
            and pick any name.
          </BigStep>
          <BigStep n={2} title="Paste its token">
            BotFather replies with a token like <span className="mono text-fg">123456:ABC…</span>. Paste it below.
          </BigStep>
          <BigStep n={3} title="Send it a code">
            Caprock shows six digits. Send them to your bot, one tap from here.
          </BigStep>
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openExternal('https://t.me/BotFather')}
            className="h-11 rounded-[10px] border border-[var(--app-hairline-strong)] px-5 text-[15px] font-medium text-fg hover:border-accent hover:text-accent"
          >
            Open @BotFather
          </button>
          <SecretInput
            size="lg"
            label="Bot token"
            placeholder="Paste the bot token"
            value={token}
            onChange={setToken}
            onEnter={() => void saveToken()}
          />
          <SecretInfo what="bot token" provider={TELEGRAM_PROVIDER} where={s?.report_bot_where} />
          <button
            onClick={() => void saveToken()}
            disabled={busy || !token.trim()}
            className="h-11 rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Connect'}
          </button>
          {editing && (
            <button onClick={() => setEditing(false)} className="text-[13px] text-fg-muted hover:text-fg">
              Cancel
            </button>
          )}
        </div>
        <p className="text-[12.5px] text-fg-muted">
          Your own bot: messages go from this computer straight to Telegram, never through a server of ours. The token is
          checked with Telegram, kept on this computer only and never shown again.
        </p>
        <SecretNote where={s?.report_bot_where} host="api.telegram.org" />
        {err}
      </div>
    )
  }

  const botLine = (
    <div className="grid gap-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg">
        <span>{bot}</span>
        <SecretPill hint={state.token_masked} where={s?.report_bot_where} />
        <SecretInfo what="bot token" provider={TELEGRAM_PROVIDER} where={s?.report_bot_where} />
        <button onClick={() => setEditing(true)} className="text-[12px] text-fg-muted hover:text-fg">
          Change bot
        </button>
      </p>
      <SecretNote where={s?.report_bot_where} host="api.telegram.org" removeLabel="Disconnect" />
    </div>
  )

  if (pairing) {
    const left = Math.max(0, Math.round((pairing.expires_ms - now) / 1000))
    return (
      <div className="grid gap-2">
        {botLine}
        <p className="text-[16px] font-medium text-fg">
          <span className="num mr-2 text-accent">3</span>Send {bot} this code
        </p>
        <p className="text-[13px] leading-relaxed text-fg-muted">
          The first private chat that sends it becomes the only one the bot listens to.
        </p>
        <p className="flex flex-wrap items-center gap-3">
          <span className="mono text-[36px] font-semibold tracking-[0.18em] text-fg" aria-label="Pairing code">
            {pairing.code}
          </span>
          {pairing.link && (
            <a
              href={pairing.link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110"
            >
              Open {bot} and send it
            </a>
          )}
        </p>
        <p className="text-[12.5px] text-fg-muted">
          Or type <span className="mono">/start {pairing.code}</span> to {bot}. Waiting… {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'expired'}
          {' · '}
          <button onClick={() => void run(() => api.telegramCancelPair())} className="text-fg-muted hover:text-fg">
            Cancel
          </button>
        </p>
        {state.last_error && <p className="text-[11px] text-danger">Telegram: {state.last_error}</p>}
        {err}
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      {botLine}
      {state.chat_set ? (
        <p className="text-[13px] text-fg-muted">
          {state.manual_chat ? (
            <>Sends to a chat id typed in by hand. Pair again to have the chat named here.</>
          ) : (
            <>
              <span className="text-ok">✓</span> Connected to <span className="text-fg">{state.chat_name || 'your chat'}</span>. Messages
              from any other chat are ignored. A share card goes there only when you press Share → To me: the picture and
              the words under it, anonymous unless you ticked Show repo name.
            </>
          )}
        </p>
      ) : (
        <p className="text-[12px] text-fg-muted">No chat yet: pair one so the bot knows where to write.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void run(() => api.telegramPair())}
          disabled={busy}
          className="rounded-sm border border-border px-3 py-1 text-[12px] hover:border-fg-faint disabled:opacity-50"
        >
          {state.chat_set ? 'Pair again' : 'Pair a chat'}
        </button>
        <button
          onClick={() => void run(() => api.telegramDisconnect())}
          disabled={busy}
          className="text-[12px] text-fg-muted hover:text-danger disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
      {state.last_error && <p className="text-[11px] text-danger">Telegram: {state.last_error}</p>}
      {err}
    </div>
  )
}
