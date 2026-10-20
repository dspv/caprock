/**
 * Settings → Computers (ADR-067): the computers linked with this one, what
 * this computer is in that, and the three steps to add one.
 *
 * The owner, 2026-10-19 (translated), of the screen this replaced: "here it's
 * unclear what to do". It was a list, a paste field, a folded terminal recipe
 * and a second button for the other direction, with the relay explained under
 * each. Rebuilt on the mockup he approved, top to bottom:
 *
 * - **Connected computers**: this one first (*this one · main* or *this one ·
 *   connects to another*), then each computer this one reaches (from
 *   `GET /v1/machines`: its state, version, when it last answered, **Open**,
 *   **Rename** here, **Disconnect** = the old Forget), then each computer that
 *   reaches this one (the `kind: "machine"` devices of `GET /v1/pair/state`:
 *   **Allow** while it waits, **Disconnect** = remove the device here).
 * - **What is this computer?** Two cards. *The main one* is the side that
 *   pastes a link and reaches the others (the controller in ADR-067); *Connects
 *   to another* is the side that shows a link and is reached (the target).
 *   There is no such mode in the daemon: pairing is per link, one way, and a
 *   computer can be both. The cards only pick which three steps are shown; the
 *   choice is kept in this browser, and until one is made it follows what is
 *   linked (`defaultRole`).
 * - **Add a computer**, three numbered steps whose number turns into a tick
 *   when it is done (`mainSteps`, `secondarySteps`). On the main one: install
 *   Caprock there and choose *Connects to another*; paste the link it shows;
 *   allow this one there. On the other: turn on access from anywhere; choose
 *   *The main one* on the main computer; enter this link there and Allow it.
 * - **(i)** beside *Add a computer* opens what the relay is, where access from
 *   anywhere is switched on and off, and what it sends (rule 4, ADR-047) —
 *   the text that used to sit under the field, kept whole, folded.
 *
 * Nothing about the protocol changed: the same `POST /v1/machines` with the
 * link, `POST /v1/pair/code {kind: "machine"}` (which turns access from
 * anywhere on, ADR-058 amended), `POST /v1/pair/remote`, Allow and revoke.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, errText, type PairedDevice, type RemoteState } from '@/lib/api'
import { machineLook, machinesApi, type Machine } from '@/lib/machines'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'
import { fmtAgo } from '@/lib/format'
import { href } from '@/lib/router'
import { extTitle } from '@/lib/externalLinks'
import { live } from '@/lib/live'
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

/** *The main one* reaches the others (it pastes their links); *Connects to another* is reached (it shows a link). */
export type ComputerRole = 'main' | 'secondary'

export const ROLE_KEY = 'caprock.computers.role'

export const ROLE_LABEL: Record<ComputerRole, string> = { main: 'main', secondary: 'connects to another' }

/** The card picked in this browser, if one was. */
export function readRole(): ComputerRole | null {
  try {
    const v = localStorage.getItem(ROLE_KEY)
    return v === 'main' || v === 'secondary' ? v : null
  } catch { return null }
}

function keepRole(r: ComputerRole) {
  try { localStorage.setItem(ROLE_KEY, r) } catch { /* private window */ }
}

/**
 * The card shown as chosen before anyone chose: a computer that only is
 * reached (computers paired into it, none added here) connects to another;
 * anything else — nothing linked yet, or computers added here — is the main one.
 */
export function defaultRole(reaches: number, reachedBy: number): ComputerRole {
  return reachedBy > 0 && reaches === 0 ? 'secondary' : 'main'
}

/** The computers that paired this one as a computer (ADR-067): they reach it. */
export function reachedBy(devices: readonly PairedDevice[] | undefined): PairedDevice[] {
  return (devices ?? []).filter((d) => d.kind === 'machine')
}

/**
 * The main one's three steps, done or not: 1 install there and choose
 * *Connects to another* — seen here only once its link was pasted; 2 paste
 * the link; 3 Allow there — any computer added that no longer waits for it
 * and was not removed or refused there.
 */
export function mainSteps(machines: readonly Pick<Machine, 'status'>[]): [boolean, boolean, boolean] {
  const added = machines.length > 0
  const allowed = machines.some((m) => m.status !== 'pending' && m.status !== 'revoked' && m.status !== 'refused')
  return [added, added, allowed]
}

/**
 * The other one's three steps: 1 access from anywhere on; 2 the main one
 * chose its card and took the link — seen here as a computer that redeemed
 * it; 3 that computer is allowed here.
 */
export function secondarySteps(remote: Pick<RemoteState, 'enabled'> | undefined, devices: readonly PairedDevice[] | undefined): [boolean, boolean, boolean] {
  const here = reachedBy(devices)
  return [Boolean(remote?.enabled), here.length > 0, here.some((d) => !d.pending)]
}

function thisComputer(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Macintosh/.test(ua)) return 'This Mac'
  if (/Windows/.test(ua)) return 'This PC'
  return 'This computer'
}

const SMALL_BTN = 'shrink-0 rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted disabled:opacity-50'
const ACCENT_BTN = 'shrink-0 rounded-sm border border-accent px-2 py-1 text-[12px] text-accent hover:bg-accent/10 disabled:opacity-50'

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
  // Access from anywhere and the computers that reach this one; read fast
  // while a link is on screen, so the arriving computer shows at once.
  const [linkUp, setLinkUp] = useState(false)
  const pair = useApi(() => api.pairState(), [], { live: false, intervalMs: linkUp ? 2000 : 10_000 })
  const refreshPair = pair.refresh
  useEffect(() => live.onFrame((f) => { if (f.type === 'devices') refreshPair() }), [refreshPair])
  const here = reachedBy(pair.data?.devices)

  const [chosen, setChosen] = useState<ComputerRole | null>(readRole)
  const role = chosen ?? defaultRole(machines.length, here.length)
  const choose = (r: ComputerRole) => { setChosen(r); keepRole(r) }
  const [info, setInfo] = useState(false)
  const total = machines.length + here.length

  return (
    <Section id={COMPUTERS_SECTION} title="Computers" aside={total > 0 ? <span className="num text-[12px] text-fg-faint">{total} linked</span> : undefined}>
      <div className="grid min-w-0 gap-5 text-[13px]">
        <div className="grid min-w-0 gap-1.5" data-connected-computers>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13.5px] font-medium text-fg">Connected computers</span>
            {machines.length > 0 && (
              <button type="button" onClick={() => setCheck((c) => c + 1)} disabled={list.loading} className="text-[12px] text-accent hover:underline disabled:opacity-50" title="Ask each computer this one reaches how it stands now">
                {list.loading ? 'checking…' : 'Check'}
              </button>
            )}
          </div>
          {list.error && !list.data && <div className="text-danger">Could not read the computers: {list.error.message}</div>}
          <ul className="grid min-w-0 gap-1.5" data-computers>
            <li data-this-computer className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-3 py-2">
              <span aria-hidden className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-ok" />
              <span className="font-medium text-fg">{thisComputer()}</span>
              <span className="text-fg-muted" data-this-role>· this one · {ROLE_LABEL[role]}</span>
            </li>
            {machines.map((m) => <ComputerRow key={m.id} m={m} now={now} onChanged={list.refresh} />)}
            {here.map((d) => <ReachesHereRow key={d.id} d={d} now={now} onChanged={refreshPair} />)}
          </ul>
          {total === 0 && list.data && <div className="text-[12.5px] text-fg-faint">No other computer yet. {role === 'main' ? 'Add one below.' : 'Connect this one to the main one below.'}</div>}
        </div>

        <div className="grid min-w-0 gap-2" data-computer-role>
          <span className="text-[13.5px] font-medium text-fg" id="computer-role-label">What is this computer?</span>
          <div role="radiogroup" aria-labelledby="computer-role-label" className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <RoleCard role="main" on={role === 'main'} onPick={choose} title="The main one">Other computers and the phone connect to it</RoleCard>
            <RoleCard role="secondary" on={role === 'secondary'} onPick={choose} title="Connects to another">Its sessions show on the main one</RoleCard>
          </div>
        </div>

        <div className="grid min-w-0 gap-2" data-add-computer>
          <div className="flex items-center gap-1.5">
            <span className="text-[13.5px] font-medium text-fg">Add a computer</span>
            <button
              type="button"
              data-relay-info-toggle
              onClick={() => setInfo((v) => !v)}
              aria-expanded={info}
              aria-controls="computers-relay-info"
              aria-label="How computers connect, and what goes through the relay"
              title="How computers connect, and what goes through the relay"
              className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[11px] font-semibold ${info ? 'border-accent text-accent' : 'border-border-strong text-fg-faint hover:text-fg'}`}
            >
              i
            </button>
          </div>
          {info && <RelayInfo remote={pair.data?.remote} />}
          {role === 'main'
            ? <MainSteps machines={machines} onAdded={list.refresh} />
            : <SecondarySteps remote={pair.data?.remote} devices={pair.data?.devices} loaded={Boolean(pair.data)} onChanged={refreshPair} onLink={setLinkUp} />}
        </div>
      </div>
    </Section>
  )
}

function RoleCard({ role, on, onPick, title, children }: { role: ComputerRole; on: boolean; onPick: (r: ComputerRole) => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-role={role}
      onClick={() => onPick(role)}
      className={`grid min-w-0 gap-0.5 rounded-md border px-3 py-2.5 text-left ${on ? 'border-accent bg-accent/10' : 'border-border hover:border-border-strong'}`}
    >
      <b className="font-semibold text-fg">{title}</b>
      <span className="text-[12.5px] text-fg-muted">{children}</span>
    </button>
  )
}

/** One numbered step; the number is a tick once it is done. */
function Step({ n, done, children }: { n: number; done: boolean; children: ReactNode }) {
  return (
    <li data-step={n} data-done={done ? 'yes' : 'no'} className="flex min-w-0 gap-2.5">
      <span
        aria-label={done ? `Step ${n}, done` : `Step ${n}`}
        className={`mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${done ? 'bg-ok text-panel' : 'bg-panel-2 text-fg-muted'}`}
      >
        {done ? '✓' : n}
      </span>
      <div className="grid min-w-0 flex-1 gap-1.5 pt-[2px] text-[13px] text-fg">{children}</div>
    </li>
  )
}

/** On the main one: install there, paste its link, allow this one there. */
function MainSteps({ machines, onAdded }: { machines: Machine[]; onAdded: () => void }) {
  const [link, setLink] = useState('')
  const [adding, setAdding] = useState(false)
  const [addErr, setAddErr] = useState('')
  const [added, setAdded] = useState<Machine | null>(null)
  const done = mainSteps(machines)

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
      onAdded()
    } catch (e) {
      setAddErr(addError(e))
    } finally {
      setAdding(false)
    }
  }

  return (
    <ol className="grid min-w-0 gap-3" data-steps="main">
      <Step n={1} done={done[0]}>
        <span>On the other computer, install Caprock and choose <b>Connects to another</b> in Settings → Computers.</span>
        <OtherComputerSteps />
      </Step>
      <Step n={2} done={done[1]}>
        <label htmlFor="computer-link">Paste the link it shows:</label>
        <div className="flex min-w-0 flex-wrap gap-2">
          <input
            id="computer-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
            placeholder="Paste the link here"
            spellCheck={false}
            autoComplete="off"
            className="mono min-w-0 flex-1 basis-56 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
          <button type="button" onClick={() => void add()} disabled={adding || !link.trim()}
            className="shrink-0 rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-panel disabled:opacity-50">
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
        {addErr && <span role="alert" className="text-[12.5px] text-danger">{addErr}</span>}
      </Step>
      <Step n={3} done={done[2]}>
        <span>Allow this computer there: press <b>Allow</b> on the card its screen shows, or run <span className="mono">caprock machines allow</span> with this computer&apos;s name.</span>
        {added && machines.find((x) => x.id === added.id)?.status !== 'online' && (
          <span role="status" className="text-[12.5px] text-fg-muted">
            {added.status === 'pending'
              ? <>Added <b className="text-fg">{added.name}</b>. Now allow it there.</>
              : <>Added <b className="text-fg">{added.name}</b> — {machineLook(added).label}.</>}
          </span>
        )}
      </Step>
    </ol>
  )
}

/** On the computer that connects to another: access from anywhere, the main one's card, this link. */
function SecondarySteps({ remote, devices, loaded, onChanged, onLink }: { remote?: RemoteState; devices?: PairedDevice[]; loaded: boolean; onChanged: () => void; onLink: (up: boolean) => void }) {
  const done = secondarySteps(remote, devices)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [shown, setShown] = useState<{ link: string; until: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const tick = useNow(1000)
  const left = shown ? Math.max(0, Math.round((shown.until - tick) / 1000)) : 0
  const up = Boolean(shown && left > 0)
  useEffect(() => { onLink(up) }, [up, onLink])
  useEffect(() => () => onLink(false), [onLink])

  const turn = async (on: boolean) => {
    setBusy(true)
    setErr('')
    try { await api.setRemote(on); onChanged() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const show = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.pairComputerCode()
      const link = r.remote?.link || `${r.url}/#/pair?code=${r.code}`
      setShown({ link, until: Date.now() + r.expires_in_sec * 1000 })
      onChanged()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const copy = () => {
    if (!shown) return
    void navigator.clipboard?.writeText(shown.link).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  const status = remote?.status === 'online' ? '' : remote?.status === 'connecting' ? ' · connecting…' : remote?.enabled ? ` · offline${remote.error ? `: ${remote.error}` : ', retrying'}` : ''

  return (
    <ol className="grid min-w-0 gap-3" data-steps="secondary">
      <Step n={1} done={done[0]}>
        {!loaded ? <span>Turn on access from anywhere</span> : !remote ? (
          <span>Access from anywhere is not in this build of Caprock, so this computer cannot be reached from another.</span>
        ) : remote.enabled ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-anywhere="on">
            <span>Turn on access from anywhere <span className="text-ok">— on</span><span className="text-fg-muted">{status}</span></span>
            <button type="button" onClick={() => void turn(false)} disabled={busy} className="text-[12px] text-fg-faint underline hover:text-danger disabled:opacity-50">Turn off</button>
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-anywhere="off">
            <span>Turn on access from anywhere</span>
            <button type="button" onClick={() => void turn(true)} disabled={busy} className={ACCENT_BTN}>Turn on</button>
          </span>
        )}
      </Step>
      <Step n={2} done={done[1]}>
        <span>On the main computer, open Settings → Computers and choose <b>The main one</b>.</span>
      </Step>
      <Step n={3} done={done[2]}>
        {up && shown ? (
          <>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span>Enter this link there:</span>
              <span className="text-[12px] text-fg-muted" data-link-valid>valid {Math.ceil(left / 60)} more min, once ·</span>
              <button type="button" onClick={copy} className="text-[12px] text-accent hover:underline">{copied ? 'Copied ✓' : 'Copy'}</button>
            </span>
            <code data-computer-link className="mono block min-w-0 select-all break-all rounded-sm border border-border bg-panel-2 px-2 py-1.5 text-[11.5px] text-fg">{shown.link}</code>
            <span className="text-[12px] text-fg-muted">When it arrives, this screen asks you to <b>Allow</b> it by name. Until then it reaches nothing.</span>
          </>
        ) : (
          <>
            <span>Enter this computer&apos;s link there, then allow it here.</span>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <button type="button" onClick={() => void show()} disabled={busy} className="rounded-sm border border-border px-2.5 py-1 text-[12.5px] text-fg hover:border-accent hover:text-accent disabled:opacity-50">
                {busy ? 'Making a link…' : 'Show the link'}
              </button>
              {remote && !remote.enabled && <span className="text-[12px] text-fg-faint">Turns on access from anywhere for this computer, if it is off.</span>}
            </span>
          </>
        )}
      </Step>
      {err && <li role="alert" className="text-[12.5px] text-danger">{err}</li>}
    </ol>
  )
}

/**
 * Behind the (i): how the two connect, where access from anywhere is switched
 * on and off, and what the relay carries (rule 4, ADR-047, ADR-058). Divs, so
 * Settings' explanations switch does not hide what the reader opened.
 */
function RelayInfo({ remote }: { remote?: RemoteState }) {
  let relayHost = remote?.relay ?? ''
  try { if (relayHost) relayHost = new URL(relayHost).host } catch { /* shown as given */ }
  return (
    <div id="computers-relay-info" data-relay-info className="grid min-w-0 gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5 text-[12.5px] leading-snug text-fg-muted">
      <div>
        Work on another computer&apos;s sessions from the main one — a Mac mini, a Linux box, a Windows PC. Each link is one way: the main one
        reaches the computer that showed it, which does not reach back. A computer can be both.
      </div>
      <div>
        The two talk through a relay. The computer that connects to another waits there with access from anywhere on — switched on in step 1
        here, by <b>Show the link</b>, by <b>Connect a phone</b> in Settings → Use on your phone, or by <span className="mono">caprock remote on</span>;
        off the same way, or <span className="mono">caprock remote off</span>.{relayHost && <> This computer&apos;s relay is <span className="mono">{relayHost}</span>.</>}
      </div>
      <div data-relay-sends>
        Adding dials the relay the link names, the one the other computer chose. What goes through it is end-to-end encrypted: the relay sees
        that two machines talk, when and how much, never what.
      </div>
    </div>
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
    <li data-computer={m.id} data-status={m.status} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2">
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
        <span className="block break-words text-[11px] text-fg-faint">
          {'reached from here · '}
          {m.version ? `Caprock ${m.version} · ` : ''}
          {m.last_seen ? `answered ${fmtAgo(m.last_seen, now)}` : 'not heard from since this Caprock started'}
          {` · through ${relayHost}`}
        </span>
        {look.detail && <span className={`mt-0.5 block text-[12px] ${look.tone === 'muted' ? 'text-fg-faint' : 'text-fg-muted'}`} data-computer-detail>{look.detail}</span>}
        {err && <span role="alert" className="mt-0.5 block text-[12px] text-danger">{err}</span>}
      </span>
      {confirm ? (
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
          <span className="text-fg-muted">Disconnect {m.name}?</span>
          <button type="button" onClick={() => void forget()} disabled={busy} className="rounded-sm border border-danger px-2 py-1 text-danger disabled:opacity-50">{busy ? 'Disconnecting…' : 'Disconnect'}</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-sm border border-border px-2 py-1 text-fg-muted">Cancel</button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5">
          {look.reachable && (
            <a href={href({ name: 'machine', id: m.id })} className="rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted hover:border-accent hover:text-accent">Open</a>
          )}
          <button type="button" onClick={() => setRenaming(true)} className={`${SMALL_BTN} hover:text-fg`}>Rename</button>
          <button type="button" onClick={() => setConfirm(true)} title="Forgets it and its key here, and asks it to drop this computer" className={`${SMALL_BTN} hover:border-danger hover:text-danger`}>Disconnect</button>
        </span>
      )}
    </li>
  )
}

/** A computer that paired this one as a computer: it reaches this one. */
function ReachesHereRow({ d, now, onChanged }: { d: PairedDevice; now: number; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr('')
    try { await fn(); onChanged() } catch (e) { setErr(errText(e)) } finally { setBusy(false); setConfirm(false) }
  }
  return (
    <li data-reaches-here={d.id} data-pending={d.pending ? 'yes' : undefined} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2">
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${d.pending ? 'bg-warn' : 'bg-ok'}`} />
          <span className="min-w-0 truncate font-medium text-fg" title={d.name}>{d.name}</span>
          <span className={`shrink-0 text-[12px] ${d.pending ? 'text-warn' : 'text-fg-muted'}`}>{d.pending ? 'waiting for Allow' : 'reaches this one'}</span>
        </span>
        <span className="block text-[11px] text-fg-faint">
          {d.last_seen ? `connected ${fmtAgo(d.last_seen, now)}` : d.paired_at ? `paired ${fmtAgo(d.paired_at, now)}` : 'not connected yet'}
        </span>
        {err && <span role="alert" className="mt-0.5 block text-[12px] text-danger">{err}</span>}
      </span>
      {confirm ? (
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
          <span className="text-fg-muted">Disconnect {d.name}? It stops reaching this one at once.</span>
          <button type="button" onClick={() => void act(() => api.pairRevoke(d.id))} disabled={busy} className="rounded-sm border border-danger px-2 py-1 text-danger disabled:opacity-50">{busy ? 'Disconnecting…' : 'Disconnect'}</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-sm border border-border px-2 py-1 text-fg-muted">Cancel</button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5">
          {d.pending && (
            <button type="button" onClick={() => void act(() => api.pairAllow(d.id))} disabled={busy} className={ACCENT_BTN}>Allow</button>
          )}
          <button type="button" onClick={() => setConfirm(true)} title="Removes it here: it stops reaching this computer on its next request" className={`${SMALL_BTN} hover:border-danger hover:text-danger`}>Disconnect</button>
        </span>
      )}
    </li>
  )
}

/** The same on the other computer, from a terminal there (SSH is fine). */
function OtherComputerSteps() {
  return (
    <details className="group min-w-0 rounded-md border border-border px-3 py-2" data-computer-steps>
      <summary className="cursor-pointer text-[12.5px] text-fg-muted hover:text-fg">How to install, or do it from its terminal</summary>
      <ol className="mt-2 grid list-decimal gap-2 pl-5 text-[12.5px] text-fg-muted">
        <li>
          Install Caprock there — the app, or the daemon alone on a machine with no screen:{' '}
          <Copyable command="brew install dspv/tap/caprock" /> (macOS, Linux), <Copyable command="scoop install caprock" /> (Windows), or a build from{' '}
          <a href="https://github.com/dspv/caprock/releases" target="_blank" rel="noreferrer" title={extTitle()} className="text-accent hover:underline">Releases</a>.
          Then <Copyable command="caprock up" />.
        </li>
        <li>Turn on access from anywhere: <Copyable command="caprock remote on" /></li>
        <li>
          Show the link: <Copyable command="caprock pair --computer" /> — it prints a link, valid five minutes, once (or, on its screen,
          Settings → Computers → <b>Connects to another</b> → <b>Show the link</b>). Paste it here.
        </li>
        <li>Allow this computer there by name: answer the question in that terminal, press <b>Allow</b> on its screen, or run <span className="mono">caprock machines allow &lt;name&gt;</span>.</li>
      </ol>
      <div className="mt-2 text-[12px] text-fg-faint">
        On Linux, a computer that should stay reachable with nobody logged in needs <span className="mono">loginctl enable-linger &lt;user&gt;</span> once.
      </div>
    </details>
  )
}
