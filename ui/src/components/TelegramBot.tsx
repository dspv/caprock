/**
 * The owner's Telegram bot, set up in three steps (ADR-047): copy the token
 * from BotFather, paste it here (Caprock checks it with Telegram), then send
 * the bot a one-time code that pairs the chat. The first private chat to send
 * the code is the only one the bot listens to — which replaces the old "open
 * getUpdates in a browser and copy chat.id", a step that asked the reader to
 * read raw JSON.
 *
 * Shared by the weekly report and the phone alerts, which send through the
 * same bot (ADR-024, ADR-036). The alerts are free and the report is not, so
 * the setup cannot live only behind the report's lock.
 *
 * The token is write-only. It goes in, it is never sent back; the screen
 * shows a mask of its last four characters and the bot's @name, which is how
 * a person tells two bots apart.
 *
 * One card, three numbered steps, each ticking when done (owner, 2026-10-18,
 * translated: "everything worked, but the instruction is complicated"). It
 * shows while there is no bot, while the token is being changed or Telegram
 * refuses it, and until a chat is paired. Set up, the whole thing is one
 * line — *Connected to @bot · alerts to <chat>* — with real Change bot, Pair
 * again and Disconnect buttons; where the token is kept is behind the (i),
 * not a paragraph on the page.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errText, type Settings, type TelegramStatus } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'
import { openExternal } from '@/lib/nudges'
import { SecretInfo, SecretInput, SecretPill, type SecretProvider } from './SecretField'
import { extProps, extTitle } from '@/lib/externalLinks'

export const TELEGRAM_PROVIDER: SecretProvider = {
  name: 'Telegram',
  host: 'api.telegram.org',
  sentWhen: 'with each message the bot sends or reads: alerts, the weekly report, chat replies, and a share card you send with Share → Send to my Telegram (the card and its words, nothing else).',
  revokeAt: '@BotFather',
  revokeHow: 'send /revoke and pick the bot, or /deletebot.',
}

/** What a pasted BotFather token looks like: the bot's number, a colon, 35 characters. */
export function looksLikeToken(v: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(v.trim())
}

/** One numbered step of the setup card; its number turns into a tick when done. */
function Step({ n, done, title, children }: { n: number; done: boolean; title: ReactNode; children?: ReactNode }) {
  return (
    <li data-step={n} data-done={done ? '' : undefined} className="grid grid-cols-[32px_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
      <span
        aria-label={done ? `Step ${n}, done` : `Step ${n}`}
        className={`num row-span-2 flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-semibold ${done ? 'bg-ok text-panel' : 'border-2 border-accent text-accent'}`}
      >
        {done ? '✓' : n}
      </span>
      <span className={`pt-1 text-[16px] font-medium leading-snug ${done ? 'text-fg-muted' : 'text-fg'}`}>{title}</span>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </li>
  )
}

const SMALL = 'h-8 rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[13px] font-medium text-fg hover:border-accent hover:text-accent disabled:opacity-50'
const BIG = 'h-11 rounded-[10px] border border-[var(--app-hairline-strong)] px-4 text-[14px] font-medium text-fg hover:border-accent hover:text-accent disabled:opacity-50'
const PRIMARY = 'inline-flex h-11 items-center rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110 disabled:opacity-50'

export function TelegramBotFields({ s, onSaved, rejected: refused }: {
  s?: Settings
  onSaved: () => void
  /** Telegram refuses the saved token (PhoneAlerts' tokenRejected): the card again, to put in a new one. */
  rejected?: boolean
}) {
  const tg = useApi(() => api.telegram(), [], { live: false })
  const [state, setState] = useState<TelegramStatus | undefined>(undefined)
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)
  // A token saved here since the refusal: the refusal was about the old one.
  const [replaced, setReplaced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pasteNote, setPasteNote] = useState('')
  const field = useRef<HTMLSpanElement>(null)
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
    return <p className="text-[12.5px] text-danger">Could not read the Telegram setup: {tg.error.message}</p>
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

  const saveToken = async (value = token) => {
    const st = await run(() => api.telegramToken(value.trim()))
    if (!st) return
    setToken('')
    setEditing(false)
    setReplaced(true)
    setPasteNote('')
    // Straight on to pairing: a token with no chat sends nothing anywhere.
    if (!st.chat_set) await run(() => api.telegramPair())
  }

  const focusField = () => field.current?.querySelector('input')?.focus()

  // The Paste button: the clipboard straight into the field, and a token
  // that looks whole is checked at once. Where the clipboard cannot be read
  // (a browser that asks and is refused), the field takes the cursor instead.
  const paste = async () => {
    setPasteNote('')
    try {
      const v = (await navigator.clipboard.readText()).trim()
      if (!v) { setPasteNote('The clipboard is empty: copy the token in BotFather first.'); return }
      setToken(v)
      if (looksLikeToken(v)) await saveToken(v)
      else focusField()
    } catch {
      setPasteNote('This window cannot read the clipboard: click the field and paste.')
      focusField()
    }
  }

  const rejected = !!refused && !replaced
  const err = error && <p className="text-[13px] text-danger">{error}</p>
  const bot = state.bot_username ? `@${state.bot_username}` : 'your bot'
  const tokenOk = state.bot_set && !editing && !rejected
  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
  const info = <SecretInfo what="bot token" provider={TELEGRAM_PROVIDER} where={s?.report_bot_where} />

  if (tokenOk && state.chat_set && !pairing) {
    return (
      <div className="grid gap-1.5" data-telegram-connected="">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 text-[15px] text-fg">
            <span className="text-ok">✓</span> Connected to <span className="font-medium">{bot}</span>
            {' · '}alerts to{' '}
            {state.manual_chat
              ? <span title="Pair again to have the chat named here">a chat id typed in by hand</span>
              : <span className="font-medium">{state.chat_name || 'your chat'}</span>}
          </p>
          <span className="flex flex-wrap items-center gap-2">
            {info}
            <button type="button" onClick={() => { setEditing(true); setToken(''); setError('') }} className={SMALL}>
              Change bot
            </button>
            <button type="button" onClick={() => void run(() => api.telegramPair())} disabled={busy} className={SMALL}>
              Pair again
            </button>
            <button type="button" onClick={() => void run(() => api.telegramDisconnect())} disabled={busy}
              className="h-8 rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[13px] font-medium text-fg hover:border-danger hover:text-danger disabled:opacity-50">
              Disconnect
            </button>
          </span>
        </div>
        {state.last_error && <p className="text-[12.5px] text-danger">Telegram: {state.last_error}</p>}
        {err}
      </div>
    )
  }

  const left = pairing ? Math.max(0, Math.round((pairing.expires_ms - now) / 1000)) : 0
  return (
    <div
      data-telegram-setup=""
      data-telegram-rejected={rejected ? '' : undefined}
      role={rejected ? 'alert' : undefined}
      className={`grid gap-4 rounded-[12px] border px-4 py-4 ${rejected ? 'border-danger/50 bg-danger/10' : 'border-border bg-panel-2/50'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-[17px] font-semibold text-fg" data-keep>
            {rejected ? "Telegram no longer accepts this bot's token" : editing ? 'Change the bot' : 'Connect your Telegram bot'}
          </p>
          {rejected && (
            <p className="text-[13.5px] leading-snug text-fg-muted" data-keep>
              The token was regenerated in BotFather, or the bot was deleted. Put in the new one: nothing else is lost.
            </p>
          )}
        </div>
        {info}
      </div>
      <ol className="grid gap-4">
        <Step n={1} done={tokenOk} title={<>In Telegram open <span className="mono">@BotFather</span> → <span className="mono">/mybots</span> (or <span className="mono">/newbot</span>) → your bot → <b>API Token</b> → Copy</>}>
          {!tokenOk && (
            <button type="button" onClick={() => { openExternal('https://t.me/BotFather'); focusField() }} {...extProps()} className={BIG}>
              Open @BotFather
            </button>
          )}
        </Step>
        <Step n={2} done={tokenOk} title={tokenOk ? <>Token in: <span className="text-fg">{bot}</span></> : 'Paste it here'}>
          {tokenOk ? (
            <SecretPill hint={state.token_masked} where={s?.report_bot_where} />
          ) : (
            <>
              <span ref={field} className="flex min-w-[14rem] flex-1">
                <SecretInput size="lg" label="Bot token" placeholder="Paste the bot token" value={token} onChange={setToken}
                  onEnter={() => void saveToken()} autoFocus={editing} />
              </span>
              {canPaste && (
                <button type="button" onClick={() => void paste()} disabled={busy} className={BIG}>
                  Paste
                </button>
              )}
              <button type="button" onClick={() => void saveToken()} disabled={busy || !token.trim()} className={PRIMARY}>
                {busy ? 'Checking…' : 'Connect'}
              </button>
              {editing && (
                <button type="button" onClick={() => { setEditing(false); setToken(''); setError('') }} className={SMALL}>
                  Cancel
                </button>
              )}
              {pasteNote && <p className="basis-full text-[12.5px] text-fg-muted" data-keep>{pasteNote}</p>}
            </>
          )}
        </Step>
        <Step
          n={3}
          done={tokenOk && state.chat_set && !pairing}
          title={pairing
            ? <>Send this code to {bot}: <span className="mono ml-1 text-[28px] font-semibold tracking-[0.16em] text-fg" aria-label="Pairing code">{pairing.code}</span></>
            : `Send a code to ${bot}`}
        >
          {!tokenOk ? (
            <span className="text-[13px] text-fg-faint">The code shows here once the token is in.</span>
          ) : pairing ? (
            <>
              {pairing.link && (
                <a href={pairing.link} target="_blank" title={extTitle()} rel="noreferrer" className={PRIMARY}>
                  Open {bot}
                </a>
              )}
              <span className="text-[13px] text-fg-muted" data-keep>
                or type <span className="mono">/start {pairing.code}</span> · {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'expired'}
              </span>
              <button type="button" onClick={() => void run(() => api.telegramCancelPair())} className={SMALL}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void run(() => api.telegramPair())} disabled={busy} className={PRIMARY}>
              Get a code
            </button>
          )}
        </Step>
      </ol>
      {state.last_error && !rejected && <p className="text-[12.5px] text-danger">Telegram: {state.last_error}</p>}
      {err}
    </div>
  )
}
