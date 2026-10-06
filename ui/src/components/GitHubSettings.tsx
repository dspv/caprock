/**
 * Settings → GitHub (F14, WP-19): connect, see who and with what, and whether
 * it works.
 *
 * Three ways in, the easiest first (ADR-039): the GitHub CLI's login, read
 * by the daemon when it needs it and never stored; a pasted token, kept in
 * the macOS Keychain (a 0600 file elsewhere); and "Sign in with GitHub", the
 * device flow, offered once a Caprock OAuth app's client id is configured.
 * Connected, the section says which source is in use, the scopes, and a
 * health line — when GitHub last answered, the last error with what was
 * being done, and the rate limit. Disconnect removes only what Caprock
 * stored. A paired device sees the state and is told where to change it.
 */
import { useEffect, useState } from 'react'
import { isPairedDevice } from '@/lib/api'
import {
  agoText, clockText, githubApi, githubErrorText, sourceLabel, useGitHubStatus,
  type GitHubDevice, type GitHubStatus,
} from '@/lib/github'
import { Section, Toggle } from './SettingsParts'

const BUTTON = 'h-[30px] rounded-[7px] border border-border-strong px-3 text-[12.5px] text-fg hover:bg-panel-2 disabled:opacity-50'
const PRIMARY = 'h-[30px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50'

export function GitHubSettings() {
  const { status, error, set } = useGitHubStatus()
  const owner = !isPairedDevice()
  return (
    <Section title="GitHub" aside={status ? <HealthDot s={status} /> : undefined}>
      {error && !status && <p role="alert" className="text-danger">{error}</p>}
      {!status && !error && <p className="text-fg-muted">Reading…</p>}
      {status && (status.connected ? <Connected s={status} owner={owner} onStatus={set} /> : owner ? <Connect s={status} onStatus={set} /> : (
        <p className="text-fg-muted">Not connected. GitHub is connected on the machine Caprock runs on.</p>
      ))}
    </Section>
  )
}

/** Green when the last call worked, red when it failed, grey before any. */
function HealthDot({ s }: { s: GitHubStatus }) {
  if (!s.connected) return <span className="text-[12px] text-fg-faint">not connected</span>
  const bad = !!s.health.error
  return (
    <span className={`flex items-center gap-1.5 text-[12px] ${bad ? 'text-danger' : 'text-ok'}`}>
      <span aria-hidden className={`inline-block h-[7px] w-[7px] rounded-full ${bad ? 'bg-danger' : 'bg-ok'}`} />
      {bad ? 'last call failed' : 'working'}
    </span>
  )
}

function Connect({ s, onStatus }: { s: GitHubStatus; onStatus: (s: GitHubStatus) => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'' | 'gh' | 'token' | 'device'>('')
  const [error, setError] = useState('')
  const [device, setDevice] = useState<GitHubDevice | null>(s.device?.state === 'pending' ? s.device : null)

  const run = async (what: 'gh' | 'token') => {
    setBusy(what)
    setError('')
    try {
      onStatus(await githubApi.connect(what, what === 'token' ? token.trim() : undefined))
      setToken('')
    } catch (e) {
      setError(githubErrorText(e))
    } finally {
      setBusy('')
    }
  }

  const signIn = async () => {
    setBusy('device')
    setError('')
    try {
      setDevice(await githubApi.startDevice())
    } catch (e) {
      setError(githubErrorText(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="grid gap-4">
      <p className="text-[12.5px] leading-relaxed text-fg-muted">
        Clone from your repositories, open pull requests from a worktree, and see their checks and reviews. Caprock
        talks to GitHub only once you connect, and only to api.github.com; the token stays in Caprock's daemon.
      </p>
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARY} disabled={!s.sources.gh || !!busy} onClick={() => void run('gh')}>
            {busy === 'gh' ? 'Connecting…' : 'Use my GitHub CLI login'}
          </button>
          {!s.sources.gh && <span className="text-[12px] text-fg-faint">The GitHub CLI (gh) is not installed here.</span>}
        </div>
        <p className="text-[12px] text-fg-faint">
          Caprock asks <span className="mono">gh auth token</span> when it needs the token and never writes it down.
        </p>
      </div>
      <form className="grid gap-1.5" onSubmit={(e) => { e.preventDefault(); if (token.trim()) void run('token') }}>
        <span className="text-fg-muted">Or paste a token</span>
        <div className="flex min-w-0 flex-wrap gap-2">
          <input
            className="input min-w-0 flex-1"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="GitHub token"
            placeholder="github_pat_… or ghp_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" className={BUTTON} disabled={!token.trim() || !!busy}>{busy === 'token' ? 'Checking…' : 'Connect'}</button>
        </div>
        <p className="text-[12px] leading-relaxed text-fg-faint">
          A fine-grained token with <span className="text-fg-muted">Contents</span> and{' '}
          <span className="text-fg-muted">Pull requests</span> read and write, and <span className="text-fg-muted">Commit statuses</span>,{' '}
          <span className="text-fg-muted">Checks</span> and <span className="text-fg-muted">Metadata</span> read — or a classic one with{' '}
          <span className="mono">repo</span> and <span className="mono">read:org</span>.{' '}
          <a className="text-accent underline-offset-2 hover:underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Make one on github.com</a>.
          {' '}Kept in the {s.sources.store === 'keychain' ? 'macOS Keychain' : 'data directory, readable by you only'}, never in Caprock's database or logs.
        </p>
      </form>
      {s.sources.oauth && (
        <div className="grid gap-1.5">
          {device ? <DeviceCode d={device} onDone={onStatus} onCancel={() => { void githubApi.cancelDevice(); setDevice(null) }} /> : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BUTTON} disabled={!!busy} onClick={() => void signIn()}>{busy === 'device' ? 'Asking GitHub…' : 'Sign in with GitHub'}</button>
              <span className="text-[12px] text-fg-faint">You approve Caprock on github.com; no password goes through Caprock.</span>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-[12.5px] leading-snug text-danger [overflow-wrap:anywhere]">{error}</p>}
    </div>
  )
}

/** The device flow's code, until it is entered, refused or expires. */
function DeviceCode({ d: first, onDone, onCancel }: { d: GitHubDevice; onDone: (s: GitHubStatus) => void; onCancel: () => void }) {
  const [d, setD] = useState(first)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (d.state !== 'pending') return
    const t = window.setInterval(() => {
      githubApi.device().then((x) => {
        if (!x) return
        setD(x)
        if (x.state === 'done') void githubApi.status().then(onDone)
      }).catch(() => { /* the next tick tries again */ })
    }, 2000)
    return () => window.clearInterval(t)
  }, [d.state, onDone])
  if (d.state !== 'pending') {
    return (
      <div className="grid gap-1.5">
        <p role="alert" className="text-[12.5px] text-danger">{d.error ? `${d.error.doing}: ${d.error.message}` : `Sign-in ${d.state}.`}</p>
        <button type="button" className={`${BUTTON} justify-self-start`} onClick={onCancel}>Start again</button>
      </div>
    )
  }
  return (
    <div className="grid gap-2 rounded-[9px] border border-border p-3">
      <p className="text-[12.5px] text-fg-muted">Enter this code on github.com:</p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="mono select-all text-[22px] font-semibold tracking-[0.12em] text-fg" aria-label="Your code">{d.user_code}</span>
        <button type="button" className={BUTTON} onClick={() => { void navigator.clipboard?.writeText(d.user_code ?? '').then(() => setCopied(true)) }}>{copied ? 'Copied' : 'Copy'}</button>
        <a className={`${PRIMARY} inline-flex items-center`} href={d.verification_uri} target="_blank" rel="noreferrer">Open github.com/login/device</a>
      </div>
      <p className="text-[12px] text-fg-faint">
        Waiting for you to approve{d.expires_at ? ` — the code works until ${clockText(d.expires_at)}` : ''}.{' '}
        <button type="button" className="underline" onClick={onCancel}>Cancel</button>
      </p>
    </div>
  )
}

function Connected({ s, owner, onStatus }: { s: GitHubStatus; owner: boolean; onStatus: (s: GitHubStatus) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(t)
  }, [])
  const disconnect = async () => {
    setBusy(true)
    setError('')
    try {
      onStatus(await githubApi.disconnect())
    } catch (e) {
      setError(githubErrorText(e))
    } finally {
      setBusy(false)
    }
  }
  const notify = async (on: boolean) => {
    try { onStatus(await githubApi.setNotify(on)) } catch (e) { setError(githubErrorText(e)) }
  }
  const h = s.health
  return (
    <div className="grid gap-3">
      <div className="grid gap-0.5">
        <p className="text-fg">
          {s.user ? (
            <>Connected as <a className="font-medium text-accent hover:underline" href={s.user.html_url ?? `https://github.com/${s.user.login}`} target="_blank" rel="noreferrer">@{s.user.login}</a>{s.user.name ? <span className="text-fg-muted"> ({s.user.name})</span> : null}</>
          ) : 'Connected'}
          <span className="text-fg-muted"> · through {sourceLabel(s.source)}</span>
        </p>
        <p className="text-[12px] text-fg-muted">
          {s.scopes_known
            ? (s.scopes.length ? <>Scopes: <span className="mono text-fg">{s.scopes.join(', ')}</span>{!s.scopes.includes('repo') && <span className="text-warn"> — without <span className="mono">repo</span>, private repositories and pull requests are refused</span>}</> : 'This token has no scopes: public, read-only.')
            : s.token_kind === 'fine-grained' ? 'A fine-grained token: its permissions are set on github.com.' : 'Scopes: not read yet.'}
        </p>
      </div>
      <HealthLine s={s} />
      {h.error && (
        <p role="alert" className="rounded-[8px] border border-danger/40 bg-danger/[0.06] px-2.5 py-2 text-[12.5px] leading-snug text-fg [overflow-wrap:anywhere]">
          <span className="text-danger">{clockText(h.error.at)} · </span>{h.error.doing}: {h.error.message}
        </p>
      )}
      {owner && (
        <>
          <Toggle
            checked={s.notify}
            onChange={(on) => void notify(on)}
            label="Tell me when CI fails or a review arrives"
            hint="A notification from the desktop app for the pull requests of your worktrees. Caprock checks each at most once a minute."
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void disconnect()}>{busy ? 'Disconnecting…' : 'Disconnect'}</button>
            <span className="text-[12px] text-fg-faint">
              {s.source === 'gh' ? 'Caprock stops using it. Your GitHub CLI login is not touched.' : `Removes the token from the ${s.sources.store === 'keychain' ? 'Keychain' : 'data directory'}.`}
            </span>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
    </div>
  )
}

/** When GitHub last answered, the rate limit, and any pause. */
export function HealthLine({ s }: { s: GitHubStatus }) {
  const h = s.health
  const parts: string[] = []
  parts.push(h.last_ok_at ? `last worked ${agoText(h.last_ok_at)}` : 'no call yet')
  if (h.rate) parts.push(`${h.rate.remaining.toLocaleString()} of ${h.rate.limit.toLocaleString()} requests left, resets ${clockText(h.rate.reset_at)}`)
  if (s.tracked > 0) parts.push(`following ${s.tracked} pull request${s.tracked === 1 ? '' : 's'}`)
  return (
    <p className="num text-[12px] text-fg-muted" aria-label="GitHub health">
      {parts.join(' · ')}
      {h.paused_until && h.paused_until > Date.now() ? <span className="text-warn"> · paused by GitHub's rate limit until {clockText(h.paused_until)}</span> : null}
    </p>
  )
}
