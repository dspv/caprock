/**
 * New server → **I already have a server** (ADR-109, amended 2026-11-28): a
 * server the user reaches over SSH, by its address and a user.
 *
 * - The form: *Address* (IP or host name), *User* (root by default; another
 *   user runs the script with sudo), *Port* (22 when empty). Each is checked
 *   here as the daemon checks it (`checkTarget`, serverscript.SSHTarget):
 *   nothing a shell or ssh could read as anything else.
 * - **Set up** is `POST /v1/machines/server-ssh`: a server key (60 minutes),
 *   the script saved by the daemon to a 0600 file, and the user's own ssh
 *   command, which opens in a shell tab here typed and not run (the app's
 *   `SetupShell`; in a browser, the command to copy). ssh asks there for
 *   the server's password or key; Caprock never sees it. The tab shows the
 *   script's steps as they run. The wait for the join outlives this panel
 *   (lib/serverJoinWatch.ts): the user is in that tab, and the server's page
 *   opens from there once it joins; back in Settings, the panel shows the
 *   wait again. **Cancel** withdraws the key, and the file goes with it.
 */
import { useEffect, useState } from 'react'
import { joinApi, serverApi } from '@/lib/machines'
import { errText } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { useSetupShell } from '@/lib/setupShell'
import { endServerJoin, onServerJoin, serverJoin, watchServerJoin } from '@/lib/serverJoinWatch'
import { Copyable } from './ui'
import { joinLine } from './JoinKey'

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/
const USER = /^[a-z_][a-z0-9_-]{0,31}$/

/** What is wrong with the form, as the daemon would say it; '' when nothing is. */
export function checkTarget(address: string, user: string, port: string): string {
  const a = address.trim()
  const ok = a.includes(':') ? IPV6.test(a) && a.split(':').length >= 3 : HOST.test(a)
  if (!ok) {
    return 'The address is an IP address or a host name: letters, digits, dots and hyphens, nothing else.'
  }
  if (!USER.test(user.trim())) return 'The user is a Linux user name: lowercase letters, digits, _ and -.'
  const p = port.trim()
  if (p && (!/^\d{1,5}$/.test(p) || +p < 1 || +p > 65535)) return 'The port is a number from 1 to 65535.'
  return ''
}

export function OwnServer({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState('')
  const [user, setUser] = useState('root')
  const [port, setPort] = useState('')
  // The watch (lib/serverJoinWatch) outlives this panel: Set up opens a
  // terminal tab, and the server's page opens from there once it joins.
  const [watch, setWatch] = useState(serverJoin)
  useEffect(() => onServerJoin(() => setWatch(serverJoin())), [])
  const made = watch?.made ?? null
  const st = watch?.st ?? null
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const setupShell = useSetupShell()
  const now = useNow(1000)
  const waiting = made !== null && (st?.state === 'waiting' || st?.state === 'joining')

  const problem = address.trim() ? checkTarget(address, user, port) : ''
  const setUp = async () => {
    const why = checkTarget(address, user, port)
    if (why) { setErr(why); return }
    setBusy(true)
    setErr('')
    try {
      const m = await serverApi.ssh({ address: address.trim(), user: user.trim(), ...(port.trim() ? { port: +port.trim() } : {}) })
      watchServerJoin(m)
      setupShell?.(m.command, m.home)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    const had = waiting
    endServerJoin()
    if (had) {
      try { await joinApi.withdraw() } catch (e) { setErr(errText(e)) }
    }
    onClose()
  }

  if (made && st && waiting) {
    const left = st.expires_at ? Math.max(0, Math.ceil((st.expires_at - now) / 60_000)) : 0
    return (
      <div className="grid min-w-0 gap-2" data-own-server={st.state}>
        <span className="text-[13px] text-fg" data-own-server-next>
          {setupShell
            ? <>A terminal tab opened with this command typed in. <b>Press Enter there</b>:</>
            : <>Run this in a terminal on this computer:</>}
        </span>
        <Copyable command={made.command} className="block min-w-0 break-all" />
        <span className="text-[12.5px] text-fg-muted" data-own-server-ssh>
          ssh asks there for the server&apos;s password, or uses your key; Caprock never sees either. The tab shows each step as the server runs it.
          {made.command.includes('sudo sh') && ' As another user, the script is copied first and run with sudo, so ssh and sudo may each ask.'}
        </span>
        <span className="text-[12.5px] text-warn" data-own-server-after>
          When it is done, password login to this server is off: you reach it through Caprock, or over SSH with a key.
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          <span role="status" className="text-fg" data-own-server-line>{st.state === 'waiting' && st.relay_status === 'online' ? 'Waiting for the server to install and join…' : joinLine(st)}</span>
          <span className="text-fg-muted" data-own-server-left>works once, {left} more min ·</span>
          <button type="button" onClick={() => void cancel()} className="text-fg-faint underline hover:text-danger" data-own-server-cancel>Cancel</button>
        </span>
        {err && <span role="alert" className="text-[12.5px] text-danger">{err}</span>}
      </div>
    )
  }

  const ended = made && st && st.state !== 'none'
  const field = 'mono min-w-0 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none'
  return (
    <div className="grid min-w-0 gap-2" data-own-server="form">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 basis-48 gap-0.5 text-[12.5px] text-fg-muted">
          Address
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.7 or server.example.com" spellCheck={false} autoComplete="off" className={field} data-own-server-address />
        </label>
        <label className="grid w-28 min-w-0 gap-0.5 text-[12.5px] text-fg-muted">
          User
          <input value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoComplete="off" className={field} data-own-server-user />
        </label>
        <label className="grid w-20 min-w-0 gap-0.5 text-[12.5px] text-fg-muted">
          Port
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" inputMode="numeric" spellCheck={false} autoComplete="off" className={field} data-own-server-port />
        </label>
      </div>
      <span className="text-[12px] text-fg-muted">
        Root, or a user with sudo (the script then runs with sudo). It keeps SSH on for keys only and turns password login off.
      </span>
      {(problem || err) && <span role="alert" className="text-[12.5px] text-danger">{problem || err}</span>}
      {ended && <span role="status" className="text-[12.5px] text-danger">{joinLine(st)}</span>}
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={() => void setUp()} disabled={busy || !address.trim() || !!problem} className="shrink-0 rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50" data-own-server-go>
          {busy ? 'Setting up…' : 'Set up'}
        </button>
        <button type="button" onClick={() => void cancel()} className="text-[12.5px] text-fg-faint underline hover:text-fg">Close</button>
      </span>
    </div>
  )
}
