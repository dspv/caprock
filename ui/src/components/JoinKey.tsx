/**
 * Join keys (ADR-108, issue #1095): one paste links a new computer.
 *
 * - **AddWithKey**, at the top of *Add a computer* on the computer the user
 *   works on: **Add with a key** makes a key (`POST /v1/machines/join-key`)
 *   and shows it once, with `caprock join <key>` for the new computer's
 *   terminal, where to paste it in the app there instead, and the install
 *   command per system for a computer without Caprock. It reads how the key
 *   stands every 2 s while open; when the new computer has joined it opens
 *   that computer's page (`#/m/<id>?joined=1`), where its checklist and Send
 *   secrets wait for clicks. **Cancel** withdraws the key. The key lives in
 *   this component's state alone: never in storage, and gone on reload.
 * - **JoinWithKey**, in the link item of *Set up this computer* on the new
 *   computer: paste the key, **Join** (`POST /v1/join`), and it says what it
 *   did and what is next.
 */
import { useEffect, useState } from 'react'
import { INSTALL_COMMANDS, joinApi, joinCommand, joinError, type JoinKeyState, type JoinResult } from '@/lib/machines'
import { errText } from '@/lib/api'
import { navigate } from '@/lib/router'
import { useNow } from '@/lib/useNow'
import { Copyable } from './ui'

/** How often an open key is read while it waits. */
export const JOIN_POLL_MS = 2000

function relayHost(relay?: string): string {
  if (!relay) return 'its relay'
  try { return new URL(relay).host } catch { return relay }
}

/** What the open key's line says, for a state the server gave. */
export function joinLine(st: Pick<JoinKeyState, 'state' | 'relay' | 'relay_status' | 'joiner' | 'error' | 'machine'>): string {
  switch (st.state) {
    case 'waiting':
      return st.relay_status === 'online'
        ? 'Waiting for the new computer…'
        : st.relay_status === 'offline'
          ? `Cannot reach ${relayHost(st.relay)} from here${st.error ? `: ${st.error}` : ''}. Retrying.`
          : `Connecting to ${relayHost(st.relay)}…`
    case 'joining': return `${st.joiner || 'The new computer'} has the key. Linking…`
    case 'joined': return `${st.machine?.name ?? st.joiner ?? 'The new computer'} joined.`
    case 'expired': return 'The key expired unused. Make a new one.'
    case 'failed': return st.error ? `The key no longer works: ${st.error}` : 'The key no longer works. Make a new one.'
  }
  return ''
}

export function AddWithKey() {
  const [key, setKey] = useState<string | null>(null)
  const [st, setSt] = useState<JoinKeyState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const now = useNow(1000)
  const open = key !== null && (st?.state === 'waiting' || st?.state === 'joining')

  useEffect(() => {
    if (!open) return
    let gone = false
    const t = window.setInterval(() => {
      // A server key (New server) withdrew this one: it reads as gone.
      joinApi.state().then((s) => { if (!gone) setSt(s.server ? { state: 'none' } : s) }, () => { /* the next read says */ })
    }, JOIN_POLL_MS)
    return () => { gone = true; window.clearInterval(t) }
  }, [open])

  // Joined: its page, where what is left there is offered as clicks.
  const joined = st?.state === 'joined' ? st.machine?.id : undefined
  useEffect(() => {
    if (joined) navigate({ name: 'machine', id: joined, joined: true })
  }, [joined])

  const make = async () => {
    setBusy(true)
    setErr('')
    try {
      const k = await joinApi.make()
      setKey(k.key)
      setSt(k)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    setKey(null)
    setSt(null)
    try { await joinApi.withdraw() } catch (e) { setErr(errText(e)) }
  }

  if (!key || !st || st.state === 'none') {
    return (
      <div className="grid min-w-0 gap-1.5" data-join-key="none">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" onClick={() => void make()} disabled={busy} className="shrink-0 rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50" data-join-key-make>
            {busy ? 'Making a key…' : 'Add with a key'}
          </button>
          <span className="text-[12.5px] text-fg-muted">One key, pasted on the new computer, links it. No link to carry back, no Allow to press there.</span>
        </span>
        {err && <span role="alert" className="text-[12.5px] text-danger">{err}</span>}
      </div>
    )
  }

  if (!open) {
    // Expired, burned, or joined (its page opens): the key is gone.
    return (
      <div className="grid min-w-0 gap-1.5" data-join-key={st.state}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          <span role="status" className={st.state === 'joined' ? 'text-ok' : 'text-danger'} data-join-key-line>{joinLine(st)}</span>
          <button type="button" onClick={() => void make()} disabled={busy} className="text-accent hover:underline disabled:opacity-50">Make a new key</button>
        </span>
        {err && <span role="alert" className="text-[12.5px] text-danger">{err}</span>}
      </div>
    )
  }
  const left = st.expires_at ? Math.max(0, Math.ceil((st.expires_at - now) / 60_000)) : 0
  const cmd = joinCommand(key)
  return (
    <div className="grid min-w-0 gap-2.5 rounded-md border border-border bg-panel-2 px-3 py-2.5" data-join-key={st.state}>
      <ol className="grid min-w-0 list-decimal gap-2 pl-5 text-[13px] text-fg">
        <li className="grid min-w-0 gap-1">
          <span>No Caprock on the new computer yet? Install it there first:</span>
          <span className="grid min-w-0 gap-1 text-[12.5px] text-fg-muted" data-join-install>
            {INSTALL_COMMANDS.map((c) => (
              <span key={c.os} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="w-16 shrink-0">{c.os}</span>
                <Copyable command={c.command} className="min-w-0 break-all" />
              </span>
            ))}
          </span>
        </li>
        <li className="grid min-w-0 gap-1">
          <span>On the new computer, run this in a terminal:</span>
          <Copyable command={cmd} className="block min-w-0 break-all" />
          <span className="text-[12.5px] text-fg-muted">
            Or, in the Caprock app there, paste the key in Settings → Computers → <b>Run agents for another computer</b> → <b>Join with a key</b>:
          </span>
          <code data-join-key-value className="mono block min-w-0 select-all break-all rounded-sm border border-border bg-bg px-2 py-1.5 text-[11.5px] text-fg">{key}</code>
        </li>
      </ol>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <span role="status" className="text-fg" data-join-key-line>{joinLine(st)}</span>
        <span className="text-fg-muted" data-join-key-left>works once, {left} more min ·</span>
        <button type="button" onClick={() => void cancel()} className="text-fg-faint underline hover:text-danger" data-join-key-cancel>Cancel</button>
      </span>
      <span className="text-[12px] text-fg-muted" data-join-key-safe>
        While the key is open, this computer waits for the new one at {relayHost(st.relay)}, end-to-end encrypted: the relay sees that two computers talk, never what.
        The key carries no secrets, and lets the new computer be started and watched from here — nothing more than a link and Allow.
      </span>
      {err && <span role="alert" className="text-[12.5px] text-danger">{err}</span>}
    </div>
  )
}

export function JoinWithKey({ onJoined }: { onJoined: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<JoinResult | null>(null)

  const join = async () => {
    const k = key.trim()
    if (!k) return
    setBusy(true)
    setErr('')
    try {
      const r = await joinApi.join(k)
      setDone(r)
      setKey('')
      onJoined()
    } catch (e) {
      setErr(joinError(e))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    const main = done.controller_name || 'The other computer'
    return (
      <div role="status" className="grid min-w-0 gap-1 text-[13px]" data-joined>
        <span className="text-ok">✓ Joined. {main} can now start and watch agents on this computer.</span>
        <span className="text-[12.5px] text-fg-muted">
          {done.turned_on_remote ? `Access from anywhere is on now, through ${relayHost(done.relay)}. ` : ''}
          Nothing was installed and no secret came with the key. Next, on {main}: this computer&apos;s page lists what is still missing here, each step run here on a click there, and Send secrets.
        </span>
      </div>
    )
  }
  return (
    <div className="grid min-w-0 gap-1.5" data-join-with-key>
      <label htmlFor="join-key" className="text-[13px]"><b>Join with a key</b> — have one from the computer you work on? Paste it here:</label>
      <div className="flex min-w-0 flex-wrap gap-2">
        <input
          id="join-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void join() }}
          placeholder="cj1-…"
          spellCheck={false}
          autoComplete="off"
          className="mono min-w-0 flex-1 basis-56 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
        />
        <button type="button" onClick={() => void join()} disabled={busy || !key.trim()} className="shrink-0 rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50" data-join-go>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </div>
      <span className="text-[12px] text-fg-muted">Turns on access from anywhere here and lets that one computer in. It can take up to a minute.</span>
      {err && <span role="alert" className="text-[12.5px] text-danger">{err}</span>}
    </div>
  )
}
