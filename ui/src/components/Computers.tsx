/**
 * Settings → Computers (ADR-067): the other computers this one reaches, and
 * how to add one.
 *
 * - **The list**: each computer by this machine's name for it, its state
 *   (online, linked, offline and why, waiting for Allow there, removed there,
 *   refused), the Caprock it runs, when it last answered. **Open** shows its
 *   sessions (#/m/<id>), **Rename** changes the name here only, **Forget**
 *   deletes it and its token here and asks it, best effort, to drop this one.
 * - **Add a computer**: paste the link the other computer shows. Pairing is
 *   one way: this one reaches that one, never back.
 * - **On the other computer**: install, `caprock remote on`, show the link —
 *   steps that work over SSH on a machine with no screen.
 * - **Let another computer reach this one**: the same link, shown here.
 *   Pressing it turns access from anywhere on (ADR-058, amended 2026-10-14).
 *
 * What it sends (ADR-047): adding a computer dials the relay its link names;
 * the relay carries ciphertext only. Said under the field, before the press.
 */
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, errText } from '@/lib/api'
import { machineLook, machinesApi, type Machine } from '@/lib/machines'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'
import { fmtAgo } from '@/lib/format'
import { href } from '@/lib/router'
import { COMPUTERS_SECTION } from './Pairing'
import { Section } from './SettingsParts'
import { Copyable } from './ui'

/** What a failed add means, for a person. */
export function addError(e: unknown): string {
  if (!(e instanceof ApiError)) return errText(e)
  const msg = (e.body as { error?: string } | undefined)?.error ?? e.message
  switch (e.status) {
    case 400: return `That link did not work: ${msg}. Show a new one on the other computer — a link works once, for five minutes.`
    case 409: return 'The other computer is not taking a computer now: show a new link there.'
    case 503: return `The other computer could not be reached: ${msg}. Is it awake, online, with Caprock running?`
    case 502: return `The other computer refused: ${msg}`
    case 504: return 'The other computer took too long to answer. Try again.'
  }
  return msg
}

export function Computers() {
  const now = useNow(30_000)
  const [check, setCheck] = useState(0)
  // Each computer is asked how it stands on open and on Check (up to 12 s);
  // the half-minute re-read in between is the local list only, so an open
  // Settings page does not hold every computer's channel up.
  const asked = useRef(-1)
  const list = useApi(() => {
    const fresh = asked.current !== check
    asked.current = check
    return machinesApi.list(fresh)
  }, [check], { live: false, intervalMs: 30_000 })
  const machines = list.data ?? []
  const [link, setLink] = useState('')
  const [adding, setAdding] = useState(false)
  const [addErr, setAddErr] = useState('')
  const [added, setAdded] = useState<Machine | null>(null)

  const add = async () => {
    const l = link.trim()
    if (!l) return
    setAdding(true)
    setAddErr('')
    setAdded(null)
    try {
      const m = await machinesApi.add(l)
      setAdded(m)
      setLink('')
      list.refresh()
    } catch (e) {
      setAddErr(addError(e))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Section id={COMPUTERS_SECTION} title="Computers" aside={machines.length > 0 ? <span className="num text-[12px] text-fg-faint">{machines.length} linked</span> : undefined}>
      <div className="grid gap-4 px-4 pb-4 pt-2 text-[13px]">
        <p className="text-fg-muted">
          Work on another computer&apos;s sessions from here — a Mac mini, a Linux box, a Windows PC. Each one you add is reached from this
          computer only; it does not reach back.
        </p>

        {list.error && !list.data && <p className="text-danger">Could not read the computers: {list.error.message}</p>}
        {machines.length > 0 && (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-fg-muted">Computers this one reaches</span>
              <button type="button" onClick={() => setCheck((c) => c + 1)} disabled={list.loading} className="text-[12px] text-accent hover:underline disabled:opacity-50" title="Ask each computer how it stands now">
                {list.loading ? 'checking…' : 'Check'}
              </button>
            </div>
            <ul className="grid gap-1.5" data-computers>
              {machines.map((m) => <ComputerRow key={m.id} m={m} now={now} onChanged={list.refresh} />)}
            </ul>
          </div>
        )}

        <div className="grid gap-2" data-add-computer>
          <label htmlFor="computer-link" className="text-[13.5px] font-medium text-fg">Add a computer</label>
          <div className="flex flex-wrap gap-2">
            <input
              id="computer-link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
              placeholder="Paste the link the other computer shows"
              spellCheck={false}
              autoComplete="off"
              className="mono min-w-0 flex-1 basis-64 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
            />
            <button type="button" onClick={() => void add()} disabled={adding || !link.trim()}
              className="shrink-0 rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50">
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
          <p data-keep className="text-[12px] text-fg-faint">
            Adding dials the relay the link names, the one the other computer chose. What goes through it is end-to-end encrypted: the relay
            sees that two machines talk, when and how much, never what.
          </p>
          {addErr && <p role="alert" className="text-[12.5px] text-danger">{addErr}</p>}
          {added && machines.find((x) => x.id === added.id)?.status !== 'online' && (
            <p data-keep role="status" className="text-[12.5px] text-fg-muted">
              {added.status === 'pending'
                ? <>Added <b className="text-fg">{added.name}</b>. Now allow it there: press <b>Allow</b> on the card its screen shows, or run <span className="mono">caprock machines allow</span> with this computer&apos;s name on it.</>
                : <>Added <b className="text-fg">{added.name}</b> — {machineLook(added).label}.</>}
            </p>
          )}
        </div>

        <OtherComputerSteps />
        <ReachThisOne />
      </div>
    </Section>
  )
}

function ComputerRow({ m, now, onChanged }: { m: Machine; now: number; onChanged: () => void }) {
  const look = machineLook(m)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(m.name)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (!renaming) setName(m.name) }, [m.name, renaming])

  const rename = async () => {
    const n = name.trim()
    setRenaming(false)
    if (!n || n === m.name) return
    try { await machinesApi.rename(m.id, n); onChanged() } catch (e) { setErr(errText(e)) }
  }
  const forget = async () => {
    setBusy(true)
    try { await machinesApi.forget(m.id); onChanged() } catch (e) { setErr(errText(e)) } finally { setBusy(false); setConfirm(false) }
  }
  const tone = { ok: 'text-ok', muted: 'text-fg-muted', warn: 'text-warn', bad: 'text-danger' }[look.tone]
  const dot = { ok: 'bg-ok', muted: 'bg-fg-faint', warn: 'bg-warn', bad: 'bg-danger' }[look.tone]
  let relayHost = m.relay
  try { relayHost = new URL(m.relay).host } catch { /* shown as given */ }
  return (
    <li data-computer={m.id} data-status={m.status} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2">
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} />
          {renaming ? (
            <input
              autoFocus
              aria-label="Computer name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename()
                if (e.key === 'Escape') { setName(m.name); setRenaming(false) }
              }}
              className="min-w-0 flex-1 rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-[13px] text-fg focus:outline-none"
            />
          ) : (
            <span className="min-w-0 truncate font-medium text-fg" title={m.name}>{m.name}</span>
          )}
          <span className={`shrink-0 text-[12px] ${tone}`} data-computer-state>{look.label}</span>
        </span>
        <span className="block text-[11px] text-fg-faint">
          {m.version ? `Caprock ${m.version} · ` : ''}
          {m.last_seen ? `answered ${fmtAgo(m.last_seen, now)}` : 'not heard from since this Caprock started'}
          {` · through ${relayHost}`}
        </span>
        {look.detail && <span className={`mt-0.5 block text-[12px] ${look.tone === 'muted' ? 'text-fg-faint' : 'text-fg-muted'}`} data-computer-detail>{look.detail}</span>}
        {err && <span role="alert" className="mt-0.5 block text-[12px] text-danger">{err}</span>}
      </span>
      {confirm ? (
        <span className="flex shrink-0 items-center gap-2 text-[12px]">
          <span className="text-fg-muted">Forget {m.name} here?</span>
          <button type="button" onClick={() => void forget()} disabled={busy} className="rounded-sm border border-danger px-2 py-1 text-danger disabled:opacity-50">{busy ? 'Forgetting…' : 'Forget'}</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-sm border border-border px-2 py-1 text-fg-muted">Cancel</button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5">
          {look.reachable && (
            <a href={href({ name: 'machine', id: m.id })} className="rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted hover:border-accent hover:text-accent">Open</a>
          )}
          <button type="button" onClick={() => setRenaming(true)} className="rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted hover:text-fg">Rename</button>
          <button type="button" onClick={() => setConfirm(true)} title="Deletes it and its key here, and asks it to drop this computer" className="rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted hover:border-danger hover:text-danger">Forget</button>
        </span>
      )}
    </li>
  )
}

/** The steps on the computer to be reached, from a terminal there (SSH is fine). */
function OtherComputerSteps() {
  return (
    <details className="group rounded-md border border-border px-3 py-2" data-computer-steps>
      <summary className="cursor-pointer text-[13px] font-medium text-fg">On the other computer</summary>
      <ol className="mt-2 grid list-decimal gap-2 pl-5 text-[12.5px] text-fg-muted">
        <li>
          Install Caprock there — the app, or the daemon alone on a machine with no screen:{' '}
          <Copyable command="brew install dspv/tap/caprock" /> (macOS, Linux), <Copyable command="scoop install caprock" /> (Windows), or a build from{' '}
          <a href="https://github.com/dspv/caprock/releases" target="_blank" rel="noreferrer" className="text-accent hover:underline">Releases</a>.
          Then <Copyable command="caprock up" />.
        </li>
        <li>Turn on access from anywhere: <Copyable command="caprock remote on" /></li>
        <li>
          Show the link: <Copyable command="caprock pair --computer" /> — it prints a link, valid five minutes, once (or, on its screen,
          Settings → Computers → <b>Show a link for another computer</b>). Paste it above.
        </li>
        <li>Allow this computer there by name: answer the question in that terminal, press <b>Allow</b> on its screen, or run <span className="mono">caprock machines allow &lt;name&gt;</span>.</li>
      </ol>
      <p className="mt-2 text-[12px] text-fg-faint">
        On Linux, a computer that should stay reachable with nobody logged in needs <span className="mono">loginctl enable-linger &lt;user&gt;</span> once.
      </p>
    </details>
  )
}

/** The other way round: a link for another computer to reach this one. */
function ReachThisOne() {
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<{ link: string; until: number } | null>(null)
  const [err, setErr] = useState('')
  const now = useNow(1000)
  const show = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.pairComputerCode()
      const link = r.remote?.link || `${r.url}/#/pair?code=${r.code}`
      setShown({ link, until: Date.now() + r.expires_in_sec * 1000 })
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const left = shown ? Math.max(0, Math.round((shown.until - now) / 1000)) : 0
  return (
    <div className="grid gap-1.5" data-reach-this-one>
      <span className="text-[13.5px] font-medium text-fg">Let another computer reach this one</span>
      {shown && left > 0 ? (
        <>
          <span className="text-[12.5px] text-fg-muted">Paste this in Settings → Computers on the other computer, or run <span className="mono">caprock machines add &apos;&lt;link&gt;&apos;</span> there. Valid {Math.ceil(left / 60)} more min, once:</span>
          <code data-computer-link className="mono block select-all break-all rounded-sm border border-border bg-panel-2 px-2 py-1.5 text-[11.5px] text-fg">{shown.link}</code>
          <span className="text-[12px] text-fg-faint">When it arrives, this screen asks you to <b>Allow</b> it by name. Until then it reaches nothing.</span>
        </>
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-muted">
          <button type="button" onClick={() => void show()} disabled={busy} className="rounded-sm border border-border px-2.5 py-1 text-[12.5px] text-fg hover:border-accent hover:text-accent disabled:opacity-50">
            {busy ? 'Making a link…' : 'Show a link for another computer'}
          </button>
          <span className="text-[12px] text-fg-faint">Turns on access from anywhere for this computer, if it is off.</span>
        </span>
      )}
      {err && <p role="alert" className="text-[12.5px] text-danger">{err}</p>}
    </div>
  )
}
