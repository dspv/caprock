/**
 * New server (ADR-109 P1, .ai/26-server.md): beside *Add with a key* in
 * *Add a computer*. The user rents the server on their own provider account;
 * Caprock writes its setup script.
 *
 * - **New server** opens the panel: what the script does, *I log in with an
 *   SSH key* (SSH stays on, keys only; otherwise it is stopped there) and
 *   **Make the script**.
 * - **Make the script** is `POST /v1/machines/server-script`: a join key that
 *   lives 60 minutes, inside a script that installs Caprock at this
 *   computer's version. Shown in full with **Copy**, where each provider's
 *   create form takes it, the run-it-over-SSH line, a countdown and how the
 *   key stands (`GET /v1/machines/join-key` every 2 s). Once the server
 *   joins, its page opens (`#/m/<id>?joined=1`). **Cancel** withdraws the
 *   key. The script lives in this component's state alone: never in
 *   storage, gone on reload.
 *
 * No price is shown: each provider line links to the provider's own page.
 */
import { useEffect, useState } from 'react'
import { joinApi, MAC_SERVER_ISSUE, serverApi, SERVER_PROVIDERS, SERVER_SYSTEMS, type JoinKeyState, type ServerScript } from '@/lib/machines'
import { errText } from '@/lib/api'
import { navigate } from '@/lib/router'
import { useNow } from '@/lib/useNow'
import { extTitle } from '@/lib/externalLinks'
import { JOIN_POLL_MS, joinLine } from './JoinKey'
import { OwnServer } from './OwnServer'
import { serverJoin } from '@/lib/serverJoinWatch'

/** A state that belongs to a key of the other kind reads as this key withdrawn. */
export function ownServerState(s: JoinKeyState): JoinKeyState {
  return s.server || s.state === 'none' ? s : { state: 'none' }
}

/** How the archive is checked, as the screen says it. */
export function checkLine(made: Pick<ServerScript, 'version' | 'signed'>): string {
  return made.signed
    ? `It installs Caprock ${made.version}, checked by its signature and its SHA-256 before anything runs.`
    : `It installs Caprock ${made.version}, checked by its SHA-256 before anything runs (this release's Linux archives are not signed).`
}

export function NewServer() {
  // A server being set up over SSH (lib/serverJoinWatch): back in Settings,
  // its wait is shown again.
  const [open, setOpen] = useState(() => serverJoin() !== null)
  const [sshKey, setSshKey] = useState(false)
  const [path, setPath] = useState<'provider' | 'own'>(() => serverJoin() ? 'own' : 'provider')
  const [made, setMade] = useState<ServerScript | null>(null)
  const [st, setSt] = useState<JoinKeyState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const now = useNow(1000)
  const waiting = made !== null && (st?.state === 'waiting' || st?.state === 'joining')

  useEffect(() => {
    if (!waiting) return
    let gone = false
    const t = window.setInterval(() => {
      joinApi.state().then((s) => { if (!gone) setSt(ownServerState(s)) }, () => { /* the next read says */ })
    }, JOIN_POLL_MS)
    return () => { gone = true; window.clearInterval(t) }
  }, [waiting])

  const joined = st?.state === 'joined' ? st.machine?.id : undefined
  useEffect(() => {
    if (joined) navigate({ name: 'machine', id: joined, joined: true })
  }, [joined])

  const make = async () => {
    setBusy(true)
    setErr('')
    try {
      const m = await serverApi.make(sshKey)
      setMade(m)
      setSt(m)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    const had = made !== null && waiting
    setMade(null)
    setSt(null)
    setOpen(false)
    if (had) {
      try { await joinApi.withdraw() } catch (e) { setErr(errText(e)) }
    }
  }
  const copy = () => {
    if (!made) return
    void navigator.clipboard?.writeText(made.script).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  if (!open) {
    return (
      <div className="grid min-w-0 gap-1.5" data-new-server="closed">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" onClick={() => setOpen(true)} className="shrink-0 rounded-sm border border-border-strong px-3 py-1.5 text-[13px] font-medium text-fg hover:border-accent" data-new-server-open>
            New server
          </button>
          <span className="text-[12.5px] text-fg-muted">Rent one on your own provider account; Caprock writes the script that sets it up and links it here.</span>
        </span>
      </div>
    )
  }

  if (!made || !st || st.state === 'none' || (!waiting && st.state !== 'joined')) {
    const ended = made && st && st.state !== 'none'
    return (
      <div className="grid min-w-0 gap-2.5 rounded-md border border-border bg-panel-2 px-3 py-2.5" data-new-server="setup">
        <span className="text-[13px] font-medium text-fg">New server</span>
        <div role="radiogroup" aria-label="Where the server is" className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[13px]" data-new-server-path>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="new-server-path" checked={path === 'provider'} onChange={() => setPath('provider')} />
            I&apos;ll create it at a provider
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="new-server-path" checked={path === 'own'} onChange={() => setPath('own')} />
            I already have a server
          </label>
        </div>
        <span className="text-[12.5px] text-fg-muted">
          The script runs once on the new server as root: a user <code className="mono">caprock</code> with no password and no sudo, unattended security upgrades,
          a firewall that admits nothing inbound, Git, Node.js, Claude Code with Anthropic&apos;s installer, Codex, a headless Chromium for the agents, Caprock at this computer&apos;s version, and then it links the server here.
          {SERVER_SYSTEMS}.
        </span>
        <span className="text-[12.5px] text-fg-muted" data-new-server-mac>
          Need a Mac server?{' '}
          <a href={MAC_SERVER_ISSUE} target="_blank" rel="noreferrer" title={extTitle('A new GitHub issue, filled in for you to read and submit')} className="text-accent hover:underline">Ask for it</a>
        </span>
        {path === 'own' ? <OwnServer onClose={() => void cancel()} /> : <>
        <label className="flex min-w-0 items-start gap-2 text-[13px]">
          <input type="checkbox" checked={sshKey} onChange={(e) => setSshKey(e.target.checked)} className="mt-0.5" data-new-server-ssh />
          <span>I log in with an SSH key (I gave the provider one, or I&apos;ll run the script over SSH). <span className="text-fg-muted">SSH stays on for keys only; unticked, SSH is stopped there and the provider&apos;s web console is the way in.</span></span>
        </label>
        {ended && <span role="status" className="text-[12.5px] text-danger" data-new-server-ended>{joinLine(st)}</span>}
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" onClick={() => void make()} disabled={busy} className="shrink-0 rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50" data-new-server-make>
            {busy ? 'Making the script…' : ended ? 'Make a new script' : 'Make the script'}
          </button>
          <button type="button" onClick={() => void cancel()} className="text-[12.5px] text-fg-faint underline hover:text-fg">Close</button>
        </span>
        </>}
        <span className="text-[12px] text-fg-muted">
          Making the script reads that release&apos;s checksums from GitHub and opens a key for 60 minutes, waiting at this computer&apos;s relay, end-to-end encrypted.
        </span>
        {err && <span role="alert" className="text-[12.5px] text-danger">{err}</span>}
      </div>
    )
  }

  const left = st.expires_at ? Math.max(0, Math.ceil((st.expires_at - now) / 60_000)) : 0
  return (
    <div className="grid min-w-0 gap-2.5 rounded-md border border-border bg-panel-2 px-3 py-2.5" data-new-server={st.state}>
      <ol className="grid min-w-0 list-decimal gap-2 pl-5 text-[13px] text-fg">
        <li className="grid min-w-0 gap-1">
          <span>Create the server at your provider and paste this script where its form takes one:</span>
          <span className="grid min-w-0 gap-0.5 text-[12.5px] text-fg-muted" data-new-server-providers>
            {SERVER_PROVIDERS.map((p) => (
              <span key={p.name}>
                {p.name}: <b>{p.field}</b> · <a href={p.prices} target="_blank" rel="noreferrer" title={extTitle(`${p.name}'s own prices`)} className="text-accent hover:underline">their prices</a>
              </span>
            ))}
            <span>Any provider that runs cloud-init: its user data field. No cloud-init (a dedicated server, a box at home): save it as <code className="mono">caprock-setup.sh</code> and run <code className="mono">sudo sh caprock-setup.sh</code> once.</span>
          </span>
        </li>
        <li className="grid min-w-0 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <button type="button" onClick={copy} className="shrink-0 rounded-sm bg-accent px-3 py-1 text-[13px] font-medium text-panel" data-new-server-copy>
              {copied ? 'Copied' : 'Copy script'}
            </button>
            <span className="text-[12.5px] text-fg-muted">{checkLine(made)}</span>
          </span>
          <pre data-new-server-script className="mono max-h-72 min-w-0 overflow-auto whitespace-pre rounded-sm border border-border bg-bg px-2 py-1.5 text-[11.5px] text-fg">{made.script}</pre>
        </li>
      </ol>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <span role="status" className="text-fg" data-new-server-line>{st.state === 'waiting' && st.relay_status === 'online' ? 'Waiting for the server to boot, install and join…' : joinLine(st)}</span>
        <span className="text-fg-muted" data-new-server-left>works once, {left} more min ·</span>
        <button type="button" onClick={() => void cancel()} className="text-fg-faint underline hover:text-danger" data-new-server-cancel>Cancel</button>
      </span>
      <span className="text-[12px] text-fg-muted" data-new-server-safe>
        Keep Caprock running and online here until the server joins. The script carries a one-time key and no token or credential.
        You sign in to Claude Code and Codex there from this computer once it has joined. Whoever controls the server — you, and the provider, as any host can — can read what is on it.
      </span>
      {err && <span role="alert" className="text-[12.5px] text-danger">{err}</span>}
    </div>
  )
}
