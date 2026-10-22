import { useEffect, useRef, useState } from 'react'
import type { ImportSource, OAuthProviders } from './mailApi'
import { api, missingRoute } from './mailApi'
import { AddAccount } from './Setup'
import { ImportAll } from './ImportAll'
import { Icon } from './icons'
import { openExternal } from '@/lib/nudges'
import { extTitle } from '@/lib/externalLinks'

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

export type Step = 'choose' | 'import' | 'add'

/** The first screen while no account exists. `provider` opens the add step
 *  on that provider's sign-in or form (the sample banner's *Add account*). */
export function FirstRun({ initial = 'choose', provider, onDone, onSample, onBusy }: {
  initial?: Step
  provider?: ProviderId
  onDone: () => void
  onSample: () => Promise<void>
  /** Import everything is walking its sign-ins: keep this screen up as accounts land. */
  onBusy?: (busy: boolean) => void
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

  if (step === 'add' && provider) return <Card><AddFlow initial={provider} onDone={onDone} onCancel={() => setStep('choose')} /></Card>
  if (step === 'import') return <Card><ImportAll onDone={onDone} onBack={() => setStep('choose')} onBusy={onBusy} /></Card>
  if (step === 'add') return <Card><AddFlow onDone={onDone} onCancel={() => setStep('choose')} /></Card>

  // Only sources with accounts it could read are named.
  const readable = Array.isArray(sources) ? sources.filter((s) => (s.accounts?.length ?? 0) > 0) : []
  const found = readable.reduce((n, s) => n + s.accounts.length, 0)
  const from = readable.map((s) => s.label).join(', ')
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
              <b>Import everything</b>
              <span>{sources === null ? 'Looking for other mail apps…'
                : found > 0 ? `${found} account${found === 1 ? '' : 's'} found in ${from}. Tick them; each needs at most one sign-in.`
                  : 'Every account in Apple Mail or Thunderbird on this computer.'}</span>
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
export function AddFlow({ initial, loginHint, onDone, onCancel }: { initial?: ProviderId; loginHint?: string; onDone: () => void; onCancel?: () => void }) {
  const [p, setP] = useState<Provider | null>(() => PROVIDERS.find((x) => x.id === initial) ?? null)
  const [importing, setImporting] = useState(false)
  const [oauth, setOauth] = useState<OAuthProviders | null>(null)
  const [oauthError, setOauthError] = useState('')
  const [probe, setProbe] = useState(0)
  useEffect(() => {
    let live = true
    api.oauthProviders().then((o) => live && setOauth(o ?? {})).catch((e) => {
      if (!live) return
      if (missingRoute(e)) setOauth({})
      else setOauthError((e as Error).message)
    })
    return () => { live = false }
  }, [probe])

  if (importing) return <ImportAll onDone={onDone} onBack={() => setImporting(false)} />
  if (p) {
    const back = () => setP(null)
    // Signing an existing account in again has no tiles to go back to.
    const leave = loginHint ? (onCancel ?? back) : back
    const title = <h2><Mark p={p} size={26} /> {p.name}</h2>
    if (p.oauth && oauthError) return <>
      {title}
      <p role="alert" className="error">Could not check sign-in options: {oauthError}</p>
      <div className="actions">
        <button type="button" className="btn" onClick={leave}>Back</button>
        <button type="button" className="btn primary" onClick={() => { setOauthError(''); setProbe((v) => v + 1) }}>Try again</button>
      </div>
    </>
    if (p.oauth && oauth === null) return <>{title}<p role="status" className="muted">Checking sign-in options…</p></>
    if (p.oauth && oauth?.[p.oauth]) return <OAuthSignIn p={p} loginHint={loginHint} onDone={onDone} onBack={leave} />
    if (p.oauth && loginHint) return <>
      {title}
      <p role="status" className="hint">Sign-in with {p.id === 'google' ? 'Google' : 'Microsoft'} isn't set up in this build, so {loginHint} cannot sign in again here. Use a build with sign-in enabled; the account and its mail stay as they are.</p>
      <div className="actions"><button type="button" className="btn" onClick={leave}>Back</button></div>
    </>
    // Say why there is no sign-in button inside the provider's own steps.
    const why = p.oauth && oauth ? `Sign-in with ${p.id === 'google' ? 'Google' : 'Microsoft'} isn't set up in this build; your normal account password will not work here.` : undefined
    return <AddAccount provider={why ? { ...p, why } : p} onDone={onDone} onCancel={back} />
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
      <button type="button" className="link small fromhere" onClick={() => setImporting(true)}>
        <Icon name="download" size={13} /> Import every account from Apple Mail or Thunderbird on this computer
      </button>
      {onCancel && <div className="actions"><button type="button" className="btn" onClick={onCancel}>Back</button></div>}
    </>
  )
}

/** Sign in at the provider; the account appears here once approved. */
function OAuthSignIn({ p, loginHint, onDone, onBack }: { p: Provider; loginHint?: string; onDone: () => void; onBack: () => void }) {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const [manual, setManual] = useState(false)
  const [busy, setBusy] = useState(false)
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  const stop = () => {
    generation.current++
    if (poll.current) clearTimeout(poll.current)
    poll.current = null
  }
  useEffect(() => stop, [])

  if (manual) return <AddAccount provider={p} onDone={onDone} onCancel={() => { setBusy(false); setManual(false) }} />

  const start = async () => {
    stop()
    const attempt = generation.current
    const live = () => generation.current === attempt
    setBusy(true)
    setErr('')
    try {
      const before = new Set((await api.state()).accounts.map((a) => a.id))
      if (!live()) return
      const r = await api.oauthStart(p.oauth!, loginHint)
      if (!live()) return
      setUrl(r.auth_url)
      openExternal(r.auth_url)
      const check = async () => {
        try {
          if (r.flow) {
            const out = await api.oauthFlow(r.flow)
            if (!live()) return
            if (out.status === 'ok') { stop(); onDone(); return }
            if (out.status !== 'pending') {
              stop()
              setUrl('')
              setErr(out.error || 'The sign-in did not finish. Try again.')
              return
            }
          } else {
            // Older daemons have no flow id; retain their account-list fallback.
            const s = await api.state()
            if (!live()) return
            if (s.accounts.some((a) => !before.has(a.id))) { stop(); onDone(); return }
          }
        } catch (e) {
          if (!live()) return
          stop()
          setUrl('')
          setErr((e as Error).message)
          return
        }
        if (live()) poll.current = setTimeout(() => { void check() }, 1500)
      }
      poll.current = setTimeout(() => { void check() }, 1500)
    } catch (e) {
      if (!live()) return
      if (missingRoute(e) && !loginHint) { setManual(true); return }
      setErr((e as Error).message)
    } finally {
      if (live()) setBusy(false)
    }
  }

  return (
    <>
      <h2><Mark p={p} size={26} /> {p.name}</h2>
      {url ? (
        <div className="waiting">
          <div><span className="pulse" /> Waiting for you to approve in the browser…</div>
          <p className="muted small">Approve Caprock on the {p.name} page; your mailbox appears here by itself. <a href={url} target="_blank" title={extTitle()} rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternal(url) }}>Open the page again</a></p>
        </div>
      ) : (
        loginHint
          ? <p className="muted">Sign in again as {loginHint} in your browser and approve Caprock. The account keeps its mail, name and signature.</p>
          : <p className="muted">Sign in with {p.name} in your browser and approve Caprock. Caprock gets a token for your mail only, kept in the system keychain; no password is typed here.</p>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      <div className="actions">
        {!loginHint && <button type="button" className="link small" onClick={() => { stop(); setManual(true) }}>Use an app password instead</button>}
        <span className="grow" />
        {url
          ? <button type="button" className="btn" onClick={() => { stop(); setUrl('') }}>Cancel</button>
          : <button type="button" className="btn" onClick={onBack}>Back</button>}
        {!url && <button type="button" className="btn primary" disabled={busy} onClick={start}>Sign in with {p.name === 'Outlook' ? 'Microsoft' : p.name}</button>}
      </div>
    </>
  )
}

/** Where the sample banner's *Add account* leads: a provider's sign-in or
 *  form, every provider's tile (`other`: Yahoo and Fastmail keep their own
 *  app-password steps there), or the import list. */
export type AddChoice = 'google' | 'microsoft' | 'icloud' | 'other' | 'import'

const ADD_CHOICES: { id: AddChoice; label: string; sub: string }[] = [
  { id: 'google', label: 'Google', sub: 'Gmail, Workspace' },
  { id: 'microsoft', label: 'Microsoft', sub: 'Outlook, Microsoft 365, Hotmail' },
  { id: 'icloud', label: 'iCloud', sub: 'icloud.com, me.com' },
  { id: 'other', label: 'Other', sub: 'Yahoo, Fastmail, any IMAP server' },
  { id: 'import', label: 'Import from this computer', sub: 'Apple Mail, Thunderbird' },
]

/**
 * The calm line on top of the sample inbox, which is what Mail opens on while
 * no account exists (owner, 2026-10-14, translated: "I want to click the
 * button and see how cool it is … button → something opens at once"). *Add
 * account* names the ways in; *Exit sample* goes back to the first run.
 */
export function SampleBanner({ onExit, onAdd }: { onExit: () => void; onAdd: (choice: AddChoice) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="samplebar" role="status">
      <span className="sampletag"><Icon name="sparkle" size={13} /> Sample</span>
      <span className="sampletext">This is a sample inbox — add your account to see your own mail.</span>
      <span className="grow" />
      <button className="link small" onClick={onExit} title="Leave the sample: back to the ways to start">Exit sample</button>
      <div className="addwrap" ref={box}>
        <button className="btn primary small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="plus" size={13} /> Add account
        </button>
        {open && (
          <div className="addmenu" role="menu" aria-label="Add account">
            {ADD_CHOICES.map((c) => (
              <button key={c.id} role="menuitem" className={c.id === 'import' ? 'sep' : undefined} onClick={() => { setOpen(false); onAdd(c.id) }}>
                <b>{c.label}</b><span>{c.sub}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
