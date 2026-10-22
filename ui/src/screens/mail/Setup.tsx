import { useEffect, useRef, useState } from 'react'
import type { Account, AIStatus, ProviderGuess, Settings } from './mailApi'
import { api, removeAccountPrompt, whoText } from './mailApi'
import { Icon } from './icons'
import type { Provider } from './Onboarding'
import { AddFlow } from './Onboarding'
import { APPLE_ACCOUNT_URL, ICloudSteps } from './ICloudSteps'
import { openExternal } from '@/lib/nudges'
import { extTitle } from '@/lib/externalLinks'

// Adding an account: address and password; servers are filled in from the
// address and only shown when the guess is unknown or the user asks. A
// provider picked from the tiles brings its app-password steps along.
export function AddAccount({ onDone, onCancel, provider }: { onDone: () => void; onCancel?: () => void; provider?: Provider }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [guess, setGuess] = useState<ProviderGuess | null>(null)
  const [adv, setAdv] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const icloud = provider?.id === 'icloud' || guess?.imap_host === 'imap.mail.me.com'
  // A refusal, never a timeout: the server's AUTHENTICATIONFAILED, or the
  // hint the daemon adds to any iCloud refusal (SMTP's 535 included).
  const icloudRefused = icloud && /\bauthenticationfailed\b|authentication failed|iCloud needs an app-specific password/i.test(err)
  const [s, setS] = useState({ imap_host: '', imap_port: 993, imap_tls: 'tls', smtp_host: '', smtp_port: 465, smtp_tls: 'tls', username: '' })

  useEffect(() => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setGuess(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      api.guess(email).then((g) => {
        if (!live) return
        setGuess(g)
        // iCloud+ on a custom domain signs in with the @icloud.com address:
        // leave Username empty and show it, so it is typed, not assumed.
        setS({ imap_host: g.imap_host, imap_port: g.imap_port, imap_tls: g.imap_tls, smtp_host: g.smtp_host, smtp_port: g.smtp_port, smtp_tls: g.smtp_tls, username: g.username || (g.needs_username ? '' : email) })
        if (!g.known || g.needs_username) setAdv(true)
      }).catch(() => {})
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [email])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api.addAccount({ name, email, password, ...s, username: s.username || email })
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="addform" onSubmit={submit}>
      <h2>{provider && provider.id !== 'other' ? provider.name : 'Add a mail account'}</h2>
      {provider?.id === 'icloud' ? (!icloudRefused && <ICloudSteps />) : provider?.steps ? (
        <div className="hint steps">
          {provider.why && <div className="muted">{provider.why}</div>}
          <div>{provider.steps} {provider.help && <a href={provider.help} target="_blank" title={extTitle()} rel="noreferrer">Open {provider.helpLabel}</a>}</div>
        </div>
      ) : (
        <p className="muted">Any IMAP account works. Caprock connects only to the mail servers you enter here; the password goes to your system keychain and your mail is kept on this computer. Nothing is sent to Caprock. Remove the account to stop.</p>
      )}
      <label className="field"><span>Your name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Morgan" /></label>
      <label className="field"><span>Email</span><input value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder={provider?.placeholder ?? 'you@company.com'} autoFocus required /></label>
      <label className="field"><span>{provider?.steps ? (provider.id === 'icloud' ? 'App-specific password' : 'App password') : 'Password'}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={provider?.id === 'icloud' ? 'abcd-efgh-ijkl-mnop' : undefined} required /></label>
      {guess && (
        <div className="hint">
          <b>{guess.provider}</b>{guess.known ? ' — settings found.' : ' — settings guessed; check them below.'}
          {guess.note && !provider?.steps && <div>{guess.note} {guess.help_url && <a href={guess.help_url} target="_blank" title={extTitle()} rel="noreferrer">Make one</a>}</div>}
        </div>
      )}
      {(guess || adv) && <button type="button" className="link small" aria-expanded={adv} onClick={() => setAdv((v) => !v)}>{adv ? 'Hide server settings' : 'Server settings'}</button>}
      {adv && (
        <div className="servers">
          <label className="field"><span>Username</span><input value={s.username} onChange={(e) => setS({ ...s, username: e.target.value })} placeholder={guess?.needs_username ? 'you@icloud.com' : email} /></label>
          <div className="row3">
            <label className="field"><span>IMAP server</span><input value={s.imap_host} onChange={(e) => setS({ ...s, imap_host: e.target.value })} /></label>
            <label className="field"><span>Port</span><input type="number" value={s.imap_port} onChange={(e) => setS({ ...s, imap_port: Number(e.target.value) })} /></label>
            <label className="field"><span>Security</span><Sec v={s.imap_tls} on={(v) => setS({ ...s, imap_tls: v })} /></label>
          </div>
          <div className="row3">
            <label className="field"><span>SMTP server</span><input value={s.smtp_host} onChange={(e) => setS({ ...s, smtp_host: e.target.value })} /></label>
            <label className="field"><span>Port</span><input type="number" value={s.smtp_port} onChange={(e) => setS({ ...s, smtp_port: Number(e.target.value) })} /></label>
            <label className="field"><span>Security</span><Sec v={s.smtp_tls} on={(v) => setS({ ...s, smtp_tls: v })} /></label>
          </div>
        </div>
      )}
      {err && <div className="error" role="alert">
        {icloudRefused ? <>
          <strong>iCloud rejected this sign-in</strong>
          <p>Check the email address and use a new app-specific password from the Apple Account that owns this mailbox.</p>
          <a className="btn" href={APPLE_ACCOUNT_URL} target="_blank" title={extTitle()} rel="noreferrer"
            onClick={(e) => { e.preventDefault(); openExternal(APPLE_ACCOUNT_URL) }}>Create a new app-specific password</a>
          <details className="small"><summary>Why this can happen</summary>
            <p>Apple did not say whether the email address or password was wrong. Changing your Apple Account password revokes the old app-specific passwords.</p>
            <div className="error-detail">{err}</div>
          </details>
        </> : <>
          {err}
          {!provider?.steps && guess?.help_url && <div><a href={guess.help_url} target="_blank" title={extTitle()} rel="noreferrer">{guess.provider} connection help</a></div>}
        </>}
      </div>}
      <div className="actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || !email || !password}>{busy ? 'Checking…' : err ? 'Try again' : 'Add account'}</button>
      </div>
    </form>
  )
}

function Sec({ v, on }: { v: string; on: (v: string) => void }) {
  return (
    <select value={v} onChange={(e) => on(e.target.value)}>
      <option value="tls">SSL/TLS</option>
      <option value="starttls">STARTTLS</option>
      <option value="none">None</option>
    </select>
  )
}

export function SettingsPanel({ accounts, settings, onSettings, onClose, onChanged, onAddAccount, section = 'top' }: {
  accounts: Account[]
  /** Where it opens: at the top, or scrolled to the AI section. */
  section?: 'top' | 'ai'
  settings: Settings
  onSettings: (s: Settings) => void
  onClose: () => void
  onChanged: () => void
  /** Replaces the add flow (sample mode leaves the sample first). */
  onAddAccount?: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [reconnecting, setReconnecting] = useState<Account | null>(null)
  const [editing, setEditing] = useState<Account | null>(null)
  const set = (k: string, v: string) => api.putSettings({ [k]: v }).then(onSettings)

  if (reconnecting) return <div className="sheet"><div className="setup onboard"><AddFlow
    initial={reconnecting.auth === 'oauth2:google' ? 'google' : 'microsoft'} loginHint={reconnecting.email}
    onDone={() => { setReconnecting(null); onChanged() }} onCancel={() => setReconnecting(null)} /></div></div>

  if (adding) return <div className="sheet"><div className="setup onboard"><AddFlow onDone={() => { setAdding(false); onChanged() }} onCancel={() => setAdding(false)} /></div></div>

  return (
    <div className="sheet settings" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="chead"><h2>Settings</h2><button className="icon" onClick={onClose}><Icon name="close" /></button></div>

      <h3>Accounts</h3>
      {accounts.map((a) => (
        <div key={a.id} className="acctrow">
          <div>
            <b>{a.email}</b>
            <div className="muted small">
              {a.imap_host} · {a.last_error ? <span className="err">{a.last_error}</span> : a.last_sync ? 'synced' : 'syncing…'}
            </div>
          </div>
          <div className="grow" />
          {(a.auth === 'oauth2:google' || a.auth === 'oauth2:microsoft') &&
            <button className="btn" onClick={() => setReconnecting(a)}>Sign in again</button>}
          <button className="btn" onClick={() => setEditing(a)}>Edit</button>
          <button className="btn danger" onClick={() => {
            if (window.confirm(removeAccountPrompt(a))) api.deleteAccount(a.id).then(onChanged)
          }}>Remove</button>
        </div>
      ))}
      {editing && <EditAccount a={editing} onDone={() => { setEditing(null); onChanged() }} />}
      <button className="btn" onClick={() => (onAddAccount ? onAddAccount() : setAdding(true))}><Icon name="plus" size={14} /> Add account</button>

      <h3>Privacy</h3>
      <label className="check">
        <input type="checkbox" checked={settings.remote_images === 'always'} onChange={(e) => set('remote_images', e.target.checked ? 'always' : 'ask')} />
        Load remote images automatically <span className="muted small">(off: senders cannot tell when you open their mail)</span>
      </label>

      <AISettings settings={settings} set={set} focus={section === 'ai'} />

      <h3>Keyboard</h3>
      <div className="keys small">
        {[['c', 'Compose'], ['/', 'Search'], ['j k', 'Next / previous'], ['e', 'Archive'], ['#', 'Delete'], ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['s', 'Star'], ['u', 'Mark unread'], ['!', 'Spam'], ['g i', 'Go to inbox']].map(([k, v]) => (
          <div key={k}><kbd>{k}</kbd> {v}</div>
        ))}
      </div>
    </div>
  )
}

function EditAccount({ a, onDone }: { a: Account; onDone: () => void }) {
  const [x, setX] = useState({ ...a, password: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="servers">
      <label className="field"><span>Name</span><input value={x.name} onChange={(e) => setX({ ...x, name: e.target.value })} /></label>
      <label className="field"><span>Signature</span><textarea rows={3} value={x.signature} onChange={(e) => setX({ ...x, signature: e.target.value })} /></label>
      {!a.auth?.startsWith('oauth2:') && <label className="field"><span>New password</span><input type="password" placeholder="unchanged" value={x.password} onChange={(e) => setX({ ...x, password: e.target.value })} /></label>}
      {err && <div className="error" role="alert">{err}</div>}
      <div className="actions">
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await api.updateAccount(x); onDone() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
        }}>Save</button>
      </div>
    </div>
  )
}

// The assistant: which provider answers, its model, its key, and — always
// shown — where the mail text goes when Summarise or Draft reply runs.
/** ai_language's choices; the daemon takes only these (internal/mail/ai Languages). */
export const AI_LANGUAGES: [string, string][] = [
  ['auto', 'Same as the email'], ['en', 'English'], ['ru', 'Russian'], ['es', 'Spanish'], ['de', 'German'],
]

function AISettings({ settings, set, focus = false }: { settings: Settings; set: (k: string, v: string) => Promise<void>; focus?: boolean }) {
  const head = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (focus) head.current?.scrollIntoView?.({ block: 'start' }) }, [focus])
  const [st, setSt] = useState<AIStatus | null>(null)
  const [key, setKey] = useState('')
  const [keyErr, setKeyErr] = useState('')
  const [tick, setTick] = useState(0)
  const modelKeys = Object.keys(settings).filter((k) => k.startsWith('ai_model')).map((k) => settings[k]).join('|')

  useEffect(() => {
    let live = true
    api.aiStatus().then((s) => live && setSt(s)).catch(() => live && setSt(null))
    return () => { live = false }
  }, [settings.ai_url, settings.ai_provider, modelKeys, tick])

  const chosen = settings.ai_provider ?? ''
  const shownId = chosen || st?.provider || ''
  const p = st?.providers.find((x) => x.id === shownId)
  const modelKey = p?.kind === 'local' ? 'ai_model' : 'ai_model_' + shownId

  const saveKey = async (v: string) => {
    if (!p) return
    setKeyErr('')
    try {
      await api.aiKey(p.id, v)
      setKey('')
      setTick((t) => t + 1)
    } catch (e) {
      setKeyErr((e as Error).message)
    }
  }

  return (
    <>
      <h3 ref={head} id="mail-ai-settings">AI assistant</h3>
      <p className="muted small">Inbox sorting, summaries and reply drafts, all through the provider chosen here and nowhere else. While AI is on, Mail sorts new inbox conversations in the background: the sender, subject and the start of each conversation go to that provider. A whole thread is sent only when you click Summarise or Draft reply.</p>
      <label className="check">
        <input type="checkbox" checked={settings.ai_enabled === '1'} onChange={(e) => set('ai_enabled', e.target.checked ? '1' : '0')} />
        Enable AI features
      </label>
      <label className="field">
        <span>Provider</span>
        <select aria-label="AI provider" value={chosen} onChange={(e) => { setKey(''); set('ai_provider', e.target.value) }}>
          <option value="">Automatic{!chosen && st?.label ? ` (${st.label})` : ''}</option>
          {st?.providers.map((x) => (
            <option key={x.id} value={x.id}>{x.label}{x.available ? '' : x.kind === 'cli' ? ' (not installed)' : x.kind === 'api' && !x.key_set ? ' (needs a key)' : ''}</option>
          ))}
        </select>
      </label>
      {p?.kind === 'api' && (
        <div className="field">
          <span>API key</span>
          <div className="keyrow">
            <input type="password" autoComplete="off" aria-label={`${p.label} key`} value={key} onChange={(e) => setKey(e.target.value)}
              placeholder={p.key_set ? (p.key_where?.kind === 'file' ? 'Saved in a file only you can read' : 'Saved in your keychain') : 'Paste your API key'} />
            <button type="button" className="btn" disabled={!key.trim()} onClick={() => saveKey(key.trim())}>Save</button>
            {p.key_set && <button type="button" className="btn danger" onClick={() => saveKey('')}>Remove</button>}
          </div>
          {keyErr && <div className="error">{keyErr}</div>}
        </div>
      )}
      {p?.kind === 'local' && (
        <label className="field"><span>Server</span><input defaultValue={settings.ai_url} onBlur={(e) => e.target.value !== settings.ai_url && set('ai_url', e.target.value)} /></label>
      )}
      {p?.kind === 'local' ? (
        <label className="field">
          <span>Model</span>
          <select value={settings.ai_model ?? ''} onChange={(e) => set('ai_model', e.target.value)}>
            <option value="">First available</option>
            {st?.models.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
      ) : p && (
        <label className="field">
          <span>Model</span>
          <input key={modelKey} aria-label="AI model" defaultValue={settings[modelKey] ?? ''} placeholder={p.model_hint}
            onBlur={(e) => e.target.value.trim() !== (settings[modelKey] ?? '') && set(modelKey, e.target.value.trim())} />
        </label>
      )}
      <label className="field">
        <span>Language</span>
        <select aria-label="AI language" value={settings.ai_language || 'auto'} onChange={(e) => set('ai_language', e.target.value)}>
          {AI_LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <p className="muted small">What summaries and inbox one-liners are written in. A drafted reply stays in the language of the mail it answers unless you say otherwise in its instruction.</p>
      <div className="small">
        {st === null ? '…' : st.available
          ? <span className="ok">● {whoText(st)}. Mail text goes to {st.sends_to}.</span>
          : <span className="muted">○ {st.error}{p && p.kind !== 'local' && <>. Once set up, mail text goes to {p.sends_to}.</>}{p?.kind === 'local' && <> Install <a href="https://ollama.com" target="_blank" title={extTitle()} rel="noreferrer">Ollama</a>, then run <code>ollama pull qwen3:8b</code>.</>}</span>}
      </div>
    </>
  )
}
