import { useEffect, useRef, useState } from 'react'
import type { ImportResult, ImportSource, OAuthProviders } from './mailApi'
import { api, missingRoute } from './mailApi'
import { AddAccount } from './Setup'
import { Icon } from './icons'
import { openExternal } from '@/lib/nudges'

// How Mail starts: try it on sample mail, import the accounts another mail
// app already knows, or add one — by signing in where the provider allows it,
// else with an app password and the steps to make one.

export type ProviderId = 'google' | 'icloud' | 'microsoft' | 'yahoo' | 'fastmail' | 'other'

export type Provider = {
  id: ProviderId
  name: string
  sub: string
  mark: string
  color: string
  /** Sign-in through the provider (POST /v1/mail/oauth/start), when offered. */
  oauth?: 'google' | 'microsoft'
  placeholder: string
  /** Where an app password is made, and how. */
  steps?: string
  help?: string
  helpLabel?: string
  /** Why this provider takes a password rather than a sign-in. */
  why?: string
}

export const PROVIDERS: Provider[] = [
  { id: 'google', name: 'Google', sub: 'Gmail, Workspace', mark: 'G', color: '#4285f4', oauth: 'google', placeholder: 'you@gmail.com',
    steps: 'Without sign-in, Gmail takes an app password: turn on 2-Step Verification, then make one for Caprock.',
    help: 'https://myaccount.google.com/apppasswords', helpLabel: 'myaccount.google.com/apppasswords' },
  { id: 'icloud', name: 'iCloud', sub: 'icloud.com, me.com', mark: '', color: '#3693f3', placeholder: 'you@icloud.com',
    why: 'Apple has no sign-in for other mail apps, so iCloud takes an app-specific password.',
    steps: 'account.apple.com → Sign-In and Security → App-Specific Passwords → +. Not your Apple Account password.',
    help: 'https://account.apple.com/account/manage', helpLabel: 'account.apple.com' },
  { id: 'microsoft', name: 'Outlook', sub: 'Microsoft 365, Hotmail', mark: 'O', color: '#0078d4', oauth: 'microsoft', placeholder: 'you@outlook.com',
    steps: 'Without sign-in, Outlook takes an app password (account.microsoft.com → Security → Advanced security options → App passwords, with two-step verification on). A work account needs IMAP allowed by its admin.',
    help: 'https://account.microsoft.com/security', helpLabel: 'account.microsoft.com/security' },
  { id: 'yahoo', name: 'Yahoo', sub: 'yahoo.com, ymail.com', mark: 'Y', color: '#6001d2', placeholder: 'you@yahoo.com',
    steps: 'Yahoo takes an app password: Account security → Generate app password.',
    help: 'https://login.yahoo.com/account/security', helpLabel: 'login.yahoo.com/account/security' },
  { id: 'fastmail', name: 'Fastmail', sub: 'fastmail.com', mark: 'F', color: '#0067b9', placeholder: 'you@fastmail.com',
    steps: 'Fastmail takes an app password: Settings → Privacy & Security → App passwords → New app password.',
    help: 'https://app.fastmail.com/settings/security/apps', helpLabel: 'Fastmail settings' },
  { id: 'other', name: 'Other', sub: 'Any IMAP server', mark: '@', color: 'var(--muted)', placeholder: 'you@company.com' },
]

/** Which provider an imported account's server belongs to, for its password steps. */
export function providerForHost(host: string): Provider | undefined {
  const h = host.toLowerCase()
  const id: ProviderId | undefined =
    h.endsWith('gmail.com') || h.endsWith('googlemail.com') ? 'google'
      : h.endsWith('mail.me.com') ? 'icloud'
        : h.includes('office365.com') || h.includes('outlook.') ? 'microsoft'
          : h.endsWith('yahoo.com') ? 'yahoo'
            : h.endsWith('fastmail.com') ? 'fastmail' : undefined
  return PROVIDERS.find((p) => p.id === id)
}

function Mark({ p, size = 30 }: { p: Provider; size?: number }) {
  return (
    <span className="pmark" style={{ width: size, height: size, color: p.color, borderColor: `color-mix(in srgb, ${p.color} 35%, var(--line))` }}>
      {p.id === 'icloud' ? <Icon name="cloud" size={16} /> : p.mark}
    </span>
  )
}

type Step = 'choose' | 'import' | 'add'

/** The first screen while no account exists. */
export function FirstRun({ initial = 'choose', onDone, onSample }: {
  initial?: Step
  onDone: () => void
  onSample: () => Promise<void>
}) {
  const [step, setStep] = useState<Step>(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Importing is offered only by a daemon that has the route; the probe also
  // says how many accounts there are to bring in.
  const [sources, setSources] = useState<ImportSource[] | null | 'missing'>(null)
  useEffect(() => {
    let live = true
    api.importSources().then((r) => live && setSources(r.sources ?? []))
      .catch((e) => live && setSources(missingRoute(e) ? 'missing' : []))
    return () => { live = false }
  }, [])

  if (step === 'import' && Array.isArray(sources)) {
    return <Card><ImportPanel initial={sources} onDone={onDone} onBack={() => setStep('choose')} /></Card>
  }
  if (step === 'add') return <Card><AddFlow onDone={onDone} onCancel={() => setStep('choose')} /></Card>

  const found = Array.isArray(sources) ? sources.reduce((n, s) => n + (s.accounts?.length ?? 0), 0) : 0
  const from = Array.isArray(sources) ? sources.map((s) => s.label).join(', ') : ''
  return (
    <Card>
      <h2>Caprock Mail</h2>
      <p className="lead">Every inbox in one place: one unified inbox, instant search, a key for everything, and summaries from a model on your own computer.</p>
      <div className="choices" role="list">
        <button className="choice" role="listitem" disabled={busy} onClick={async () => {
          setBusy(true)
          setErr('')
          try { await onSample() } catch (e) { setErr((e as Error).message); setBusy(false) }
        }}>
          <span className="cicon"><Icon name="sparkle" /></span>
          <span className="ctext"><b>{busy ? 'Starting sample mail…' : 'Try it with sample mail'}</b><span>Two made-up inboxes on a server inside Caprock. Nothing real is read or sent.</span></span>
          <Icon name="chevron" className="muted" />
        </button>
        {sources !== 'missing' && (
          <button className="choice" role="listitem" disabled={sources === null} onClick={() => setStep('import')}>
            <span className="cicon"><Icon name="download" /></span>
            <span className="ctext">
              <b>Import my accounts</b>
              <span>{sources === null ? 'Looking for other mail apps…'
                : found > 0 ? `${found} account${found === 1 ? '' : 's'} found in ${from}. Pick which to bring over.`
                  : 'From Apple Mail or Thunderbird on this computer.'}</span>
            </span>
            <Icon name="chevron" className="muted" />
          </button>
        )}
        <button className="choice" role="listitem" onClick={() => setStep('add')}>
          <span className="cicon"><Icon name="plus" /></span>
          <span className="ctext"><b>Add an account</b><span>Google, iCloud, Outlook, Yahoo, Fastmail or any IMAP server.</span></span>
          <Icon name="chevron" className="muted" />
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      <p className="muted small foot">Mail connects only to your own mail servers. Passwords go to the system keychain, mail stays on this computer, nothing is sent to Caprock.</p>
    </Card>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="setup onboard">{children}</div>
}

/** Provider tiles, then that provider's sign-in or password form. */
export function AddFlow({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [p, setP] = useState<Provider | null>(null)
  const [oauth, setOauth] = useState<OAuthProviders>({})
  useEffect(() => {
    let live = true
    api.oauthProviders().then((o) => live && setOauth(o ?? {})).catch(() => live && setOauth({}))
    return () => { live = false }
  }, [])

  if (p) {
    const back = () => setP(null)
    if (p.oauth && oauth[p.oauth]) return <OAuthSignIn p={p} onDone={onDone} onBack={back} />
    return <AddAccount provider={p} onDone={onDone} onCancel={back} />
  }
  return (
    <>
      <h2>Add an account</h2>
      <div className="tiles">
        {PROVIDERS.map((x) => (
          <button key={x.id} className="tile" onClick={() => setP(x)}>
            <Mark p={x} />
            <span><b>{x.name}</b><span className="muted small">{x.sub}</span></span>
          </button>
        ))}
      </div>
      {onCancel && <div className="actions"><button type="button" className="btn" onClick={onCancel}>Back</button></div>}
    </>
  )
}

/** Sign in at the provider; the account appears here once approved. */
function OAuthSignIn({ p, onDone, onBack }: { p: Provider; onDone: () => void; onBack: () => void }) {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const [manual, setManual] = useState(false)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)
  const stop = () => { if (poll.current) clearInterval(poll.current); poll.current = null }
  useEffect(() => stop, [])

  if (manual) return <AddAccount provider={p} onDone={onDone} onCancel={() => setManual(false)} />

  const start = async () => {
    setErr('')
    try {
      const before = new Set((await api.state()).accounts.map((a) => a.id))
      const r = await api.oauthStart(p.oauth!)
      setUrl(r.auth_url)
      openExternal(r.auth_url)
      stop()
      poll.current = setInterval(() => {
        api.state().then((s) => {
          if (s.accounts.some((a) => !before.has(a.id))) { stop(); onDone() }
        }).catch(() => {})
      }, 2000)
    } catch (e) {
      if (missingRoute(e)) { setManual(true); return }
      setErr((e as Error).message)
    }
  }

  return (
    <>
      <h2><Mark p={p} size={26} /> {p.name}</h2>
      {url ? (
        <div className="waiting">
          <div><span className="pulse" /> Waiting for you to approve in the browser…</div>
          <p className="muted small">Approve Caprock on the {p.name} page; your mailbox appears here by itself. <a href={url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternal(url) }}>Open the page again</a></p>
        </div>
      ) : (
        <p className="muted">Sign in with {p.name} in your browser and approve Caprock. Caprock gets a token for your mail only, kept in the system keychain; no password is typed here.</p>
      )}
      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button type="button" className="link small" onClick={() => { stop(); setManual(true) }}>Use an app password instead</button>
        <span className="grow" />
        {url
          ? <button type="button" className="btn" onClick={() => { stop(); setUrl('') }}>Cancel</button>
          : <button type="button" className="btn" onClick={onBack}>Back</button>}
        {!url && <button type="button" className="btn primary" onClick={start}>Sign in with {p.name === 'Outlook' ? 'Microsoft' : p.name}</button>}
      </div>
    </>
  )
}

/** Accounts other mail apps on this computer know, ticked to bring over. */
export function ImportPanel({ initial, onDone, onBack }: { initial: ImportSource[]; onDone: () => void; onBack: () => void }) {
  const [sources, setSources] = useState(initial)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [pw, setPw] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, ImportResult>>({})
  const [err, setErr] = useState('')
  const key = (s: ImportSource, email: string) => s.kind + ':' + email
  const on = (s: ImportSource, email: string) => picked[key(s, email)] ?? !results[email]?.ok

  const retry = async () => {
    setErr('')
    try { setSources((await api.importSources()).sources ?? []) } catch (e) { setErr((e as Error).message) }
  }

  const chosen = sources.flatMap((s) => s.accounts.filter((a) => on(s, a.email) && !results[a.email]?.ok).map((a) => ({ s, a })))
  const missingPw = chosen.some(({ a }) => !a.has_password && !pw[a.email])
  const anyOk = Object.values(results).some((r) => r.ok)

  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      const out: Record<string, ImportResult> = { ...results }
      for (const s of sources) {
        const emails = chosen.filter((c) => c.s === s).map((c) => c.a.email)
        if (emails.length === 0) continue
        const passwords: Record<string, string> = {}
        for (const e of emails) if (pw[e]) passwords[e] = pw[e]
        const r = await api.importAccounts(s.kind, emails, Object.keys(passwords).length ? passwords : undefined)
        for (const x of r.results ?? []) out[x.email] = x
      }
      setResults(out)
      if (Object.values(out).every((r) => r.ok)) onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Import accounts</h2>
      <p className="muted">Servers, names and saved passwords come from the mail apps on this computer. Each account is checked before it is added.</p>
      {sources.length === 0 && <div className="hint">No other mail app with accounts was found. Add one by hand instead.</div>}
      {sources.map((s) => (
        <div key={s.kind} className="source">
          <div className="srchead"><b>{s.label}</b> <span className="muted small">{(s.accounts ?? []).length} account{(s.accounts ?? []).length === 1 ? '' : 's'}</span></div>
          {s.needs_permission === 'full_disk_access' && (
            <div className="hint">
              macOS keeps {s.label}'s settings behind Full Disk Access. Open <b>System Settings → Privacy &amp; Security → Full Disk Access</b>, turn on Caprock (or the terminal that runs <code>caprock</code>), then retry.
              <div className="actions left"><button type="button" className="btn" onClick={retry}>Retry</button></div>
            </div>
          )}
          {s.error && <div className="error">{s.error}</div>}
          {s.accounts.map((a) => {
            const r = results[a.email]
            const p = providerForHost(a.imap_host)
            return (
              <div key={a.email} className="improw">
                <label className="check">
                  <input type="checkbox" checked={on(s, a.email)} disabled={busy || r?.ok}
                    onChange={(e) => setPicked({ ...picked, [key(s, a.email)]: e.target.checked })} />
                  <span><b>{a.email}</b> <span className="muted small">{a.imap_host}</span></span>
                  <span className="grow" />
                  {r && (r.ok ? <span className="ok small">Added</span> : <span className="err small">Failed</span>)}
                </label>
                {!a.has_password && on(s, a.email) && !r?.ok && (
                  <label className="field indent">
                    <span>Password {p?.help && <>— {p.id === 'icloud' ? 'an app-specific password' : 'an app password'}, made at <a href={p.help} target="_blank" rel="noreferrer">{p.helpLabel}</a></>}</span>
                    <input type="password" aria-label={`Password for ${a.email}`} value={pw[a.email] ?? ''} onChange={(e) => setPw({ ...pw, [a.email]: e.target.value })} />
                  </label>
                )}
                {r && !r.ok && r.error && <div className="error indent">{r.error}</div>}
              </div>
            )
          })}
        </div>
      ))}
      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button type="button" className="btn" onClick={anyOk ? onDone : onBack}>{anyOk ? 'Open Mail' : 'Back'}</button>
        <button type="button" className="btn primary" disabled={busy || chosen.length === 0 || missingPw} onClick={run}>
          {busy ? 'Checking…' : chosen.length === 1 ? 'Import 1 account' : `Import ${chosen.length || ''} accounts`.replace('  ', ' ')}
        </button>
      </div>
    </>
  )
}

/** The slim line shown while the screen serves sample mail. */
export function SampleBanner({ onExit, onAdd }: { onExit: () => void; onAdd: () => void }) {
  return (
    <div className="samplebar" role="status">
      <Icon name="sparkle" size={14} />
      <span><b>Sample mail</b> — nothing here is real.</span>
      <span className="grow" />
      <button className="link small" onClick={onExit}>Exit</button>
      <button className="btn primary small" onClick={onAdd}>Add my account</button>
    </div>
  )
}
