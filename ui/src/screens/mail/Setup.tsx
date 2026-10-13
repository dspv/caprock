import { useEffect, useState } from 'react'
import type { Account, ProviderGuess, Settings } from './mailApi'
import { api } from './mailApi'
import { Icon } from './icons'

// Adding an account: address and password; servers are filled in from the
// address and only shown when the guess is unknown or the user asks.
export function AddAccount({ onDone, onCancel, first }: { onDone: () => void; onCancel?: () => void; first?: boolean }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [guess, setGuess] = useState<ProviderGuess | null>(null)
  const [adv, setAdv] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
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
        setS({ imap_host: g.imap_host, imap_port: g.imap_port, imap_tls: g.imap_tls, smtp_host: g.smtp_host, smtp_port: g.smtp_port, smtp_tls: g.smtp_tls, username: g.needs_username ? '' : email })
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
      setAdv(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="setup" onSubmit={submit}>
      <h2>{first ? 'Caprock Mail' : 'Add a mail account'}</h2>
      {first && <p className="lead">Every inbox in one place: one unified inbox for Gmail, iCloud, Fastmail and your company's server, instant search, a keyboard for everything, and summaries from a model on your own computer.</p>}
      <p className="muted">Any IMAP account works. Caprock connects only to the mail servers you enter here; the password goes to your system keychain and your mail is kept on this computer. Nothing is sent to Caprock. Remove the account to stop.</p>
      <label className="field"><span>Your name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Morgan" /></label>
      <label className="field"><span>Email</span><input value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder="you@company.com" autoFocus required /></label>
      <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      {guess && (
        <div className="hint">
          <b>{guess.provider}</b>{guess.known ? ' — settings found.' : ' — settings guessed; check them below.'}
          {guess.note && <div>{guess.note} {guess.help_url && <a href={guess.help_url} target="_blank" rel="noreferrer">Make one</a>}</div>}
        </div>
      )}
      {!adv && guess && <button type="button" className="link small" onClick={() => setAdv(true)}>Server settings</button>}
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
      {err && <div className="error">{err}</div>}
      <div className="actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || !email || !password}>{busy ? 'Checking…' : 'Add account'}</button>
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

export function SettingsPanel({ accounts, settings, onSettings, onClose, onChanged }: {
  accounts: Account[]
  settings: Settings
  onSettings: (s: Settings) => void
  onClose: () => void
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [ai, setAi] = useState<{ available: boolean; models: string[]; error?: string } | null>(null)
  const [editing, setEditing] = useState<Account | null>(null)
  const set = (k: string, v: string) => api.putSettings({ [k]: v }).then(onSettings)

  useEffect(() => {
    api.aiStatus().then(setAi).catch(() => setAi(null))
  }, [settings.ai_url])

  if (adding) return <div className="sheet"><AddAccount onDone={() => { setAdding(false); onChanged() }} onCancel={() => setAdding(false)} /></div>

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
          <button className="btn" onClick={() => setEditing(a)}>Edit</button>
          <button className="btn danger" onClick={() => {
            if (window.confirm(`Remove ${a.email}? Mail stays on the server.`)) api.deleteAccount(a.id).then(onChanged)
          }}>Remove</button>
        </div>
      ))}
      {editing && <EditAccount a={editing} onDone={() => { setEditing(null); onChanged() }} />}
      <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add account</button>

      <h3>Privacy</h3>
      <label className="check">
        <input type="checkbox" checked={settings.remote_images === 'always'} onChange={(e) => set('remote_images', e.target.checked ? 'always' : 'ask')} />
        Load remote images automatically <span className="muted small">(off: senders cannot tell when you open their mail)</span>
      </label>

      <h3>Local AI</h3>
      <p className="muted small">Summaries and reply drafts from a model running on this computer (Ollama, LM Studio, llama.cpp). Mail is never sent to a cloud service.</p>
      <label className="check">
        <input type="checkbox" checked={settings.ai_enabled === '1'} onChange={(e) => set('ai_enabled', e.target.checked ? '1' : '0')} />
        Enable AI features
      </label>
      <label className="field"><span>Server</span><input defaultValue={settings.ai_url} onBlur={(e) => e.target.value !== settings.ai_url && set('ai_url', e.target.value)} /></label>
      <label className="field">
        <span>Model</span>
        <select value={settings.ai_model} onChange={(e) => set('ai_model', e.target.value)}>
          <option value="">First available</option>
          {ai?.models.map((m) => <option key={m}>{m}</option>)}
        </select>
      </label>
      <div className="small">
        {ai === null ? '…' : ai.available
          ? <span className="ok">● Connected, {ai.models.length} model{ai.models.length === 1 ? '' : 's'}</span>
          : <span className="muted">○ No model server found. Install <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a>, then run <code>ollama pull qwen3:8b</code>.</span>}
      </div>

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
      <label className="field"><span>New password</span><input type="password" placeholder="unchanged" value={x.password} onChange={(e) => setX({ ...x, password: e.target.value })} /></label>
      {err && <div className="error">{err}</div>}
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
