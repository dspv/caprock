import { useCallback, useEffect, useRef, useState } from 'react'
import type { FoundAccount, ImportScan, ImportSource, OAuthProviders, Signin } from './mailApi'
import { api } from './mailApi'
import { connected, finished, plan, step, type Flow, type FlowEvent, type Row } from './importFlow'
import { Icon } from './icons'
import { openExternal } from '@/lib/nudges'
import { extTitle } from '@/lib/externalLinks'
import { ICloudSteps } from './ICloudSteps'
import { AddAccount } from './Setup'
import { PROVIDERS } from './Onboarding'

// "Import everything" (owner, 2026-10-14, translated): Caprock finds every
// mail account on the computer, the user ticks them and presses Import, and
// Caprock walks through each account's one remaining sign-in in turn —
// Google and Microsoft in the browser, iCloud with an app-specific password,
// any other server with its password; Thunderbird's come with theirs.

const PROVIDER_NAME: Record<string, string> = {
  google: 'Google', microsoft: 'Microsoft', icloud: 'iCloud', yahoo: 'Yahoo', fastmail: 'Fastmail',
}

/** A profile untouched this long is probably not in use: its accounts start unticked. */
export const STALE_MS = 90 * 24 * 3600 * 1000

/** Whether an account's profile was used recently enough to tick it by default. */
export function fresh(lastUsed: number | undefined, now = Date.now()): boolean {
  return !lastUsed || now - lastUsed < STALE_MS
}

/** 12 Mar 2025. */
export function day(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const usedLabel = (kind: string) => (kind === 'apple_mail' ? 'account list last changed' : 'profile last used')

/** Where an app password is made, and the one line of how. */
export const APP_PASSWORD: Record<string, { url: string; label: string; how: string; kind: string }> = {
  icloud: {
    url: 'https://account.apple.com', label: 'account.apple.com', kind: 'an app-specific password',
    how: 'Sign in, open Sign-In and Security → App-Specific Passwords, press +, name it Caprock and paste the password it shows. Not your Apple Account password.',
  },
  google: {
    url: 'https://myaccount.google.com/apppasswords', label: 'myaccount.google.com/apppasswords', kind: 'an app password',
    how: 'With 2-Step Verification on, make an app password named Caprock and paste it here.',
  },
  microsoft: {
    url: 'https://account.microsoft.com/security', label: 'account.microsoft.com/security', kind: 'an app password',
    how: 'Security → Advanced security options → App passwords (two-step verification on). A work account needs IMAP allowed by its admin.',
  },
  yahoo: {
    url: 'https://login.yahoo.com/account/security', label: 'login.yahoo.com/account/security', kind: 'an app password',
    how: 'Account security → Generate app password, name it Caprock and paste it here.',
  },
  fastmail: {
    url: 'https://app.fastmail.com/settings/security/apps', label: 'Fastmail settings', kind: 'an app password',
    how: 'Settings → Privacy & Security → App passwords → New app password, then paste it here.',
  },
}

/** The line that replaces a sign-in button this build cannot offer. */
export function notSetUp(provider: string): string {
  return `Sign-in with ${PROVIDER_NAME[provider] ?? provider} isn't set up in this build — use an app password.`
}

/** What a row still needs, in words. */
export function needLabel(need: Signin, provider: string): string {
  switch (need) {
    case 'ready': return 'Password saved'
    case 'oauth': return `Sign in with ${PROVIDER_NAME[provider] ?? provider}`
    case 'app_password': return provider === 'icloud' ? 'Needs an app password' : 'App password'
    default: return 'Password'
  }
}

const lower = (s: string) => s.trim().toLowerCase()

export function ImportAll({ onDone, onBack, onBusy }: {
  onDone: () => void
  onBack?: () => void
  /** True while the walk is on screen, so Mail keeps it there after the first account lands. */
  onBusy?: (busy: boolean) => void
}) {
  const [scan, setScan] = useState<ImportScan | null>(null)
  const [have, setHave] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [flow, setFlow] = useState<Flow | null>(null)
  const [err, setErr] = useState('')
  const [byHand, setByHand] = useState(false)
  const scanning = useRef(false)
  const dispatch = useCallback((e: FlowEvent) => setFlow((f) => (f ? step(f, e) : f)), [])

  const rescan = useCallback(async () => {
    if (scanning.current) return
    scanning.current = true
    try {
      const [s, st] = await Promise.all([api.importScan(), api.state().catch(() => null)])
      setScan(s)
      setHave(new Set((st && !st.sample ? st.accounts : []).map((a) => lower(a.email))))
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
      setScan((s) => s ?? { sources: [], accounts: [], oauth: {} })
    } finally {
      scanning.current = false
    }
  }, [])
  useEffect(() => { void rescan() }, [rescan])

  // Back in the window (an account added in another mail app meanwhile): look again.
  useEffect(() => {
    if (flow) return
    const again = () => { if (document.visibilityState === 'visible') void rescan() }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again) }
  }, [flow, rescan])

  // An account whose password came with it connects without a click.
  const connect = useCallback(async (r: Row, password?: string) => {
    dispatch({ type: 'begin', email: r.email })
    try {
      const out = await api.importAccounts(r.source, [r.email], password ? { [r.email]: password } : undefined)
      const res = out.results?.find((x) => lower(x.email) === lower(r.email))
      if (res?.ok) dispatch({ type: 'ok', email: r.email, note: res.already ? 'Already in Mail' : undefined })
      else dispatch({ type: 'fail', email: r.email, error: res?.error || 'Not added' })
    } catch (e) {
      dispatch({ type: 'fail', email: r.email, error: (e as Error).message })
    }
  }, [dispatch])
  const auto = flow?.rows.find((r) => r.email === flow.active && r.need === 'ready' && r.status === 'waiting')
  const started = useRef(new Set<string>())
  useEffect(() => {
    if (!auto || started.current.has(auto.email)) return
    started.current.add(auto.email)
    void connect(auto)
  }, [auto, connect])

  if (!scan) return <p className="muted"><span className="pulse" /> Looking for mail accounts on this computer…</p>
  if (byHand) {
    const icloud = PROVIDERS.find((p) => p.id === 'icloud')
    return <AddAccount provider={icloud} onDone={onDone} onCancel={() => setByHand(false)} />
  }

  // Only what can be read is listed (owner, 2026-10-14, translated: "don't
  // even show me this; the Apple integration is unclear, not concrete about
  // what to do"). The one exception is Apple Mail without Full Disk Access:
  // hidden, it read as "no iCloud account here" (owner, 2026-10-22), so it
  // says why, and what to press, in one box.
  const blocked = scan.sources.find((s) => s.needs_permission === 'full_disk_access' && s.accounts.length === 0)
  const groups = scan.sources
    .map((s) => ({ s, accounts: scan.accounts.filter((a) => a.source === s.kind) }))
    .filter((g) => g.accounts.length > 0)
  const isOn = (a: FoundAccount) => !have.has(lower(a.email)) && (picked[a.email] ?? fresh(a.last_used))

  if (!flow) {
    const chosen = scan.accounts.filter(isOn)
    const start = () => {
      setFlow(plan(scan.accounts, (e) => chosen.some((a) => a.email === e)))
      onBusy?.(true)
    }
    return (
      <>
        <h2>Import everything</h2>
        <p className="muted">Mail accounts found in the mail apps on this computer. Tick the ones to bring over; each then needs at most one sign-in, one at a time.</p>
        {blocked && <FullDiskAccess source={blocked} onICloud={() => setByHand(true)} />}
        {groups.length === 0 && !blocked && <div className="hint">No mail app on this computer has accounts Caprock can read. Add one by hand instead.</div>}
        {groups.map(({ s, accounts }) => (
          <div key={s.kind} className="srcgroup">
            <div className="srchead"><b>{s.label}</b>{s.last_used ? <span className="muted"> · {usedLabel(s.kind)} {day(s.last_used)}</span> : null}</div>
            <div className="found" role="list" aria-label={`Accounts in ${s.label}`}>
              {accounts.map((a) => {
                const there = have.has(lower(a.email))
                return (
                  <label key={a.email} className="foundrow" role="listitem">
                    <input type="checkbox" checked={isOn(a)} disabled={there}
                      aria-label={`Import ${a.email}`}
                      onChange={(e) => setPicked({ ...picked, [a.email]: e.target.checked })} />
                    <span className="who"><b>{a.email}</b></span>
                    <span className={'need ' + (there ? 'done' : a.signin)}
                      title={a.signin === 'app_password' && (a.provider === 'google' || a.provider === 'microsoft') ? notSetUp(a.provider) : undefined}>
                      {there ? 'Already in Mail' : needLabel(a.signin, a.provider ?? '')}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
        {err && <div className="error">{err}</div>}
        <div className="actions">
          {onBack && <button type="button" className="btn" onClick={onBack}>Back</button>}
          <span className="grow" />
          <button type="button" className="btn primary" disabled={chosen.length === 0} onClick={start}>
            {chosen.length === 1 ? 'Import 1 account' : `Import ${chosen.length} accounts`}
          </button>
        </div>
      </>
    )
  }

  const active = flow.rows.find((r) => r.email === flow.active)
  const n = connected(flow)
  const close = () => { onBusy?.(false); onDone() }
  return (
    <>
      <h2>Import everything</h2>
      <p className="muted">{n} of {flow.rows.length} connected{finished(flow) ? '.' : ' — one sign-in at a time.'}</p>
      {active && active.need !== 'ready' && (
        <ActiveStep key={active.email + active.need} r={active} oauth={scan.oauth} dispatch={dispatch} connect={connect}
          others={flow.rows.filter((x) => x.status !== 'ok').map((x) => x.email)} />
      )}
      {active && active.need === 'ready' && (
        <div className="stepbox"><span className="pulse" /> Connecting {active.email} with its saved password…</div>
      )}
      {finished(flow) && (
        <div className="hint">{n === flow.rows.length ? 'Every account is connected. Mail is fetching them now.' : 'Done for now. Retry a failed account or come back to a skipped one below, or open Mail.'}</div>
      )}
      <ol className="progress" aria-label="Import progress">
        {flow.rows.map((r) => <ProgressRow key={r.email} r={r} on={r.email === flow.active} dispatch={dispatch} />)}
      </ol>
      <div className="actions">
        <span className="grow" />
        <button type="button" className={'btn' + (finished(flow) ? ' primary' : '')} disabled={n === 0 && !finished(flow)} onClick={close}>
          {n === 0 && finished(flow) ? 'Close' : 'Open Mail'}
        </button>
      </div>
    </>
  )
}

function ProgressRow({ r, on, dispatch }: { r: Row; on: boolean; dispatch: (e: FlowEvent) => void }) {
  const state = r.status === 'ok' ? 'Connected'
    : r.status === 'failed' ? 'Failed'
      : r.status === 'skipped' ? 'Skipped'
        : r.status === 'working' ? 'Connecting…'
          : on ? 'Now' : 'Waiting'
  return (
    <li className={'prow st-' + r.status + (on ? ' on' : '')}>
      <span className="mark" aria-hidden="true">
        {r.status === 'ok' ? <Icon name="check" size={14} /> : r.status === 'failed' ? <Icon name="close" size={14} /> : r.status === 'working' ? <span className="pulse" /> : <span className="dot" />}
      </span>
      <span className="who">
        <b>{r.email}</b>
        {r.status === 'failed' && r.error && !on && <span className="err small">{r.error}</span>}
        {r.status === 'ok' && r.note && <span className="muted small">{r.note}</span>}
      </span>
      <span className="state small">{state}</span>
      {!on && r.status === 'failed' && <button type="button" className="btn small" onClick={() => dispatch({ type: 'open', email: r.email })}>Retry</button>}
      {!on && r.status === 'skipped' && <button type="button" className="btn small" onClick={() => dispatch({ type: 'open', email: r.email })}>Come back</button>}
    </li>
  )
}

/** The one sign-in the account on screen needs. */
function ActiveStep({ r, oauth, dispatch, connect, others }: {
  r: Row
  oauth: OAuthProviders
  dispatch: (e: FlowEvent) => void
  connect: (r: Row, password?: string) => Promise<void>
  others: string[]
}) {
  const [pw, setPw] = useState('')
  const busy = r.status === 'working'
  const skip = <button type="button" className="link small" disabled={busy} onClick={() => dispatch({ type: 'skip', email: r.email })}>Skip for now</button>
  const name = PROVIDER_NAME[r.provider] ?? r.provider

  if (r.need === 'oauth') return <OAuthStep r={r} dispatch={dispatch} others={others} skip={skip} />

  const app = r.need === 'app_password' ? APP_PASSWORD[r.provider] : undefined
  const unconfigured = r.need === 'app_password' && (r.provider === 'google' || r.provider === 'microsoft') && !oauth[r.provider as 'google' | 'microsoft']
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (pw) void connect(r, pw) }
  return (
    <form className="stepbox" onSubmit={submit}>
      <div className="stephead"><b>{r.email}</b> <span className="muted small">{name || r.imapHost}</span></div>
      {unconfigured && <p className="small">{notSetUp(r.provider)}</p>}
      {r.provider === 'icloud' ? <ICloudSteps /> : app ? (
        <p className="small">Make {app.kind} at <a href={app.url} target="_blank" title={extTitle()} rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternal(app.url) }}>{app.label}</a>. {app.how}</p>
      ) : (
        <p className="small muted">The password you sign in to {r.imapHost} with. It goes to that server and the system keychain, nowhere else.</p>
      )}
      <label className="field">
        <span>{app ? (r.provider === 'icloud' ? 'App-specific password' : 'App password') : 'Password'}</span>
        <input type="password" autoFocus aria-label={`Password for ${r.email}`} value={pw}
          placeholder={r.provider === 'icloud' ? 'abcd-efgh-ijkl-mnop' : undefined} onChange={(e) => setPw(e.target.value)} disabled={busy} />
      </label>
      {r.status === 'failed' && r.error && <div className="error">{r.error}</div>}
      <div className="actions">
        {skip}
        <span className="grow" />
        <button type="submit" className="btn primary" disabled={busy || !pw}>{busy ? 'Checking…' : r.status === 'failed' ? 'Try again' : 'Connect'}</button>
      </div>
    </form>
  )
}

/** Sign in at Google or Microsoft in the browser; the flow id says how it went. */
function OAuthStep({ r, dispatch, others, skip }: { r: Row; dispatch: (e: FlowEvent) => void; others: string[]; skip: React.ReactNode }) {
  const [url, setUrl] = useState('')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null }
  useEffect(() => stop, [])
  const name = PROVIDER_NAME[r.provider] ?? r.provider

  const start = async () => {
    dispatch({ type: 'begin', email: r.email })
    try {
      const out = await api.oauthStart(r.provider, r.email)
      setUrl(out.auth_url)
      openExternal(out.auth_url)
      stop()
      if (!out.flow) return
      const id = out.flow
      timer.current = setInterval(() => {
        api.oauthFlow(id).then((s) => {
          if (s.status === 'pending') return
          stop()
          if (s.status === 'ok') {
            const got = s.email ?? r.email
            if (lower(got) !== lower(r.email)) {
              // Signed in as another address: that one is connected; this row
              // still says which, and a row for that address is done too.
              const twin = others.find((e) => lower(e) === lower(got))
              if (twin) dispatch({ type: 'ok', email: twin })
              dispatch({ type: 'ok', email: r.email, note: `Signed in as ${got}` })
            } else {
              dispatch({ type: 'ok', email: r.email })
            }
          } else {
            dispatch({ type: 'fail', email: r.email, error: s.error || 'The sign-in did not finish.' })
          }
        }).catch(() => {})
      }, 1500)
    } catch (e) {
      const msg = (e as Error).message
      dispatch({ type: 'fail', email: r.email, error: msg })
    }
  }
  const waiting = r.status === 'working' && url

  return (
    <div className="stepbox">
      <div className="stephead"><b>{r.email}</b> <span className="muted small">{name}</span></div>
      {waiting ? (
        <div className="waiting">
          <div><span className="pulse" /> Waiting for you to approve in the browser…</div>
          <p className="muted small">Approve Caprock on the {name} page; this step finishes by itself. <a href={url} target="_blank" title={extTitle()} rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternal(url) }}>Open the page again</a></p>
        </div>
      ) : (
        <p className="small muted">Sign in with {name} in your browser and approve Caprock. It gets a token for mail only, kept in the system keychain; no password is typed here.</p>
      )}
      {r.status === 'failed' && r.error && <div className="error">{r.error}</div>}
      <div className="actions">
        {skip}
        <button type="button" className="link small" onClick={() => { stop(); dispatch({ type: 'need', email: r.email, need: 'app_password' }) }}>Use an app password instead</button>
        <span className="grow" />
        {waiting
          ? <button type="button" className="btn" onClick={() => { stop(); setUrl(''); dispatch({ type: 'cancel', email: r.email }) }}>Cancel</button>
          : <button type="button" className="btn primary" disabled={r.status === 'working'} onClick={start}>{r.status === 'failed' ? 'Sign in again' : `Sign in with ${name}`}</button>}
      </div>
    </div>
  )
}

/** Apple Mail's account list is behind Full Disk Access: say so, and open the setting. */
function FullDiskAccess({ source, onICloud }: { source: ImportSource; onICloud: () => void }) {
  const [opened, setOpened] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const open = async () => {
    setErr('')
    try { setOpened((await api.importGrant()).program || '') } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="hint steps fda" role="note" aria-label="Apple Mail needs Full Disk Access">
      <b>{source.error || FDA_HELP}</b>
      {opened === null ? (
        <span className="muted">Then come back here: the list fills in by itself. Caprock reads only the account list — addresses and servers, never mail or passwords.</span>
      ) : (
        <span>
          In the list, turn on <b>caprock</b>. If it isn't there, press + (or drag in the file Finder just showed{opened ? <> — <code className="small">{opened}</code></> : null}). Then come back here.
        </span>
      )}
      {err && <span className="err small">{err}</span>}
      <div className="actions">
        <button type="button" className="btn" onClick={open}>Open Full Disk Access</button>
        <span className="grow" />
        <button type="button" className="link small" onClick={onICloud}>Add iCloud with an app password instead</button>
      </div>
    </div>
  )
}

/** The daemon's line, for a daemon that sends none. */
export const FDA_HELP = "Caprock can't read Apple Mail's account list. To allow it: System Settings → Privacy & Security → Full Disk Access → Caprock."
