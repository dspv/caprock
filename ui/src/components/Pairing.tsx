/**
 * Open Caprock on your phone.
 *
 * The owner's verdict on the panel this replaced (translated): "honestly,
 * NOTHING here is understandable, and it should be easy and simple." It asked
 * the reader to "let this network in", then to find an address, then to ask
 * for a code, then to type both — four ideas before anything happened, and the
 * one thing a person holding a phone wants to do (point the camera at the
 * screen) was not offered at all.
 *
 * So it is three steps and one button. **Show a code** turns on access from
 * anywhere (ADR-058) and issues a pairing code in the same press, and the code
 * is drawn as a QR code whose link carries it: the camera opens the phone's
 * page, the page pairs through the relay, and the phone appears in the list
 * below.
 *
 * One way in, not a choice of three (owner, 2026-10-14, translated: "I'd
 * remove every option except the normal online one — who cares about working
 * only inside your own Wi-Fi; everyone wants to work online"). The same
 * morning his phone had paired on the Wi-Fi address a minute before he turned
 * on access from anywhere, kept that link, and went dead on mobile data with
 * nothing anywhere saying why. The Wi-Fi and Tailscale addresses are no longer
 * offered; a phone still on one is marked in the list with the code that moves
 * it (`via` in the state), and its own page says the same (LanOnlyNotice).
 *
 * What did not change is the security model (ADR-029, ADR-058): pairing is
 * required; access from anywhere is turned on only here or by `caprock remote
 * on`, never from a phone.
 *
 * **Control is chosen with the code** (ADR-034, amended 2026-10-14). The
 * owner, translated: "I see the QR code, scan it with the phone, install the
 * app, go in — and I can't do anything, and say I've already left the house."
 * A paired phone was a viewer until a second click here, which nobody makes
 * from the street. So beside Show a code sits **This phone can type and start
 * agents**, ticked by default and remembered on this computer; the code
 * carries that role, and the phone is a controller the moment it pairs.
 * Unticked, it pairs to view only, as before. Either way the decision is made
 * here, on the machine, by the person showing the code — never by the phone.
 *
 * While a code is out, and after the phone pairs, a checklist says what is
 * done and what is left: access from anywhere, the phone paired (by name),
 * whether it can type (with the one button that fixes it), and whether it runs
 * as the installed app.
 *
 * The QR code is drawn here, in the browser, by ui/src/lib/qr.ts: the link
 * carries a code that lets a device in, and it is not sent anywhere to be
 * rendered.
 *
 * **A paired phone finds its way back** (Vova, 2026-10-15, translated: "I
 * opened the phone app, then closed the tab … today I want to open it again
 * but I don't remember the link — and that's it"). The phone keeps its token
 * on the page's own origin, so opening the page's address again is all it
 * takes; every paired device's row says so — the address to type, a QR of
 * that address alone (no code, no key: it pairs nothing), and, with a
 * Telegram bot set up, **Send the link to my phone**.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type PairAddress, type PairedDevice, type PairState, type RemoteState } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { REVEAL_EVENT, Section } from '@/components/SettingsParts'
import { fmtAgo, fmtWhen } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { encodeQR, qrPath } from '@/lib/qr'
import type { SettingsSection } from '@/lib/router'

/** The phone section's id: the palette's *Open Caprock on your phone* scrolls to it. */
export const PHONE_SECTION = 'settings-phone'
/** The Telegram section's id (PhoneAlerts), right after the phone's. */
export const TELEGRAM_SECTION = 'telegram'

/** Settings → Computers (components/Computers.tsx, ADR-067). */
export const COMPUTERS_SECTION = 'settings-computers'

const SECTION_IDS: Record<SettingsSection, string> = { phone: PHONE_SECTION, telegram: TELEGRAM_SECTION, computers: COMPUTERS_SECTION }

// Set by a click that means "show me the code" (the sidebar's *phone*, the
// palette); read once by the phone section, mounted or not yet. Never set by
// a URL: a link anyone can send must not turn network access on.
let codeOnArrival = false
const CODE_EVENT = 'caprock:phone-code'

/** Whether the phone section should show a code now, asked once. */
export function takeCodeOnArrival(): boolean {
  const v = codeOnArrival
  codeOnArrival = false
  return v
}

/**
 * Open Settings on the phone or Telegram (#/settings/phone, /telegram): the
 * section unfolded, scrolled to the top and lit for a moment. `showCode`
 * also puts a pairing code on screen, as pressing *Show a code* would (owner,
 * 2026-10-13, translated: "I go in there and don't understand where phone and
 * Telegram are").
 */
export function openSettingsSection(section: SettingsSection, opts: { showCode?: boolean } = {}): void {
  if (section === 'phone' && opts.showCode) {
    codeOnArrival = true
    window.dispatchEvent(new Event(CODE_EVENT))
  }
  openSettingsAt(SECTION_IDS[section], `#/settings/${section}`)
}

/** The palette's *Open Caprock on your phone*: the section, with a code. */
export function openPhoneSettings(): void {
  openSettingsSection('phone', { showCode: true })
}

/** The element id of a deep-linkable section. */
export function settingsSectionId(section: SettingsSection): string {
  return SECTION_IDS[section]
}

/** Open Settings and bring the section with this id into view once it has rendered. */
export function openSettingsAt(id: string, hash = '#/settings'): void {
  location.hash = hash
  revealWhenDrawn(id)
}

/** Reveal the section with this id as soon as it is on the page (up to a second). */
export function revealWhenDrawn(id: string): void {
  let tries = 0
  const look = () => {
    // The page can be gone before the section renders (a test's teardown).
    if (typeof document === 'undefined') return
    const el = document.getElementById(id)
    if (el) revealSection(el)
    else if (++tries < 40) setTimeout(look, 25)
  }
  setTimeout(look, 0)
}

/** Unfold a Settings section, scroll it to the top and light its edge briefly. */
export function revealSection(el: HTMLElement): void {
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: el.id }))
  el.scrollIntoView?.({ block: 'start' })
  el.dataset.settingsLit = ''
  el.style.transition = 'box-shadow 700ms ease-out'
  el.style.boxShadow = '0 0 0 2px var(--color-accent)'
  setTimeout(() => { el.style.boxShadow = '' }, 1400)
  setTimeout(() => { delete el.dataset.settingsLit; el.style.transition = '' }, 2200)
}

/** The link a phone's camera opens: the address, with the code to redeem. */
export function pairLink(url: string, code: string): string {
  return `${url.replace(/\/+$/, '')}/#/pair?code=${encodeURIComponent(code)}`
}

/**
 * Every address the network listener answers on, from the daemon's list or,
 * from an older daemon, its one url. Tailscale's first: of the two, it is the
 * one that works off this Wi-Fi. Only used without access from anywhere — a
 * build without the relay, or `caprock up --lan` (docs/app.md).
 */
export function addressesOf(s: Pick<PairState, 'url' | 'tunnelled' | 'addresses'>): PairAddress[] {
  const all: PairAddress[] = s.addresses?.length ? s.addresses : s.url ? [{ url: s.url, kind: s.tunnelled ? 'tailscale' : 'lan' }] : []
  const rank = { anywhere: -1, tailscale: 0, magicdns: 1, lan: 2 } as const
  return [...all].sort((a, b) => rank[a.kind] - rank[b.kind])
}

/**
 * The phone's page as a person types it — "m.caprock.dev" — and as a QR opens
 * it — "https://m.caprock.dev/". Nothing after the address: the QR beside a
 * paired device must pair nothing and carry nothing secret; the phone's own
 * stored token does the rest.
 */
export function phonePage(app: string): { host: string; url: string } {
  try {
    const u = new URL(app)
    return { host: u.host + u.pathname.replace(/\/+$/, ''), url: u.origin + u.pathname.replace(/\/*$/, '/') }
  } catch {
    return { host: app, url: app }
  }
}

/** Whether a row gets "Open on the phone again": a device that reaches the machine through the relay, not the machine's own browser. */
export function offersOpenAgain(d: Pick<PairedDevice, 'name' | 'via'>): boolean {
  return d.via !== 'lan' && !/^This computer/.test(d.name)
}

/** Whether a paired device's name says it is a phone or a tablet. */
export function looksLikePhone(name: string): boolean {
  return /phone|android|ipad|tablet/i.test(name)
}

export type PhoneStatus = { tone: 'off' | 'waiting' | 'ok' | 'on'; label: string }

/** What the corner of the panel says, from the daemon's state alone. */
export function phoneStatus(s: Pick<PairState, 'enabled' | 'code' | 'devices' | 'remote'>): PhoneStatus {
  const n = s.devices.length
  const noun = deviceNoun(s.devices)
  if (!s.enabled && !s.remote?.enabled) {
    return { tone: 'off', label: n > 0 ? `Off · ${n} ${noun}${n === 1 ? '' : 's'} paired` : 'Off' }
  }
  if (s.code) return { tone: 'waiting', label: 'Waiting for your phone…' }
  if (n > 0) return { tone: 'ok', label: `${n} ${noun}${n === 1 ? '' : 's'} connected` }
  return { tone: 'on', label: 'On · nothing paired yet' }
}

/** "phone" when every paired device looks like one, "device" otherwise. */
function deviceNoun(devices: PairedDevice[]): string {
  return devices.length > 0 && devices.every((d) => /phone|android/i.test(d.name)) ? 'phone' : 'device'
}

/**
 * Whether a paired device is on a link that works on the home Wi-Fi only and
 * should pair once more through the relay: it last came over the network
 * listener from a private address, and no device of the same name has since
 * come through the relay (the re-paired twin, which makes this one leftover).
 */
export function needsRepair(d: PairedDevice, all: readonly PairedDevice[]): boolean {
  if (d.via !== 'lan') return false
  return !all.some((o) => o.id !== d.id && o.name === d.name && o.via === 'relay')
}

/** Where the tick beside Show a code is remembered, on this computer. */
export const ALLOW_TYPE_KEY = 'caprock.pair.allowType'

/** The remembered tick: on unless the owner unticked it here before. */
export function readAllowType(): boolean {
  try {
    return localStorage.getItem(ALLOW_TYPE_KEY) !== '0'
  } catch {
    return true
  }
}

function keepAllowType(on: boolean) {
  try {
    localStorage.setItem(ALLOW_TYPE_KEY, on ? '1' : '0')
  } catch { /* not remembered: ticked again next time */ }
}

/** One row of the checklist: done, waiting on something, missing, or optional. */
export type CheckState = 'done' | 'waiting' | 'missing' | 'optional'
export interface CheckRow { key: 'anywhere' | 'paired' | 'type' | 'app'; state: CheckState; title: string; detail: string }

/**
 * What is done and what is left, from the daemon's state and the phone that
 * paired while the panel was open (or null while waiting for it). Pure, for
 * the tests.
 */
export function pairChecklist(s: Pick<PairState, 'enabled' | 'remote' | 'code_role'>, phone: PairedDevice | null, allowType: boolean): CheckRow[] {
  const remote = s.remote
  const anywhere: CheckRow = !remote
    ? { key: 'anywhere', state: s.enabled ? 'done' : 'waiting', title: 'Network access', detail: s.enabled ? 'On' : 'Off' }
    : !remote.enabled
      ? { key: 'anywhere', state: 'waiting', title: 'Access from anywhere', detail: 'Off: Show a code turns it on' }
      : remote.status === 'online'
        ? { key: 'anywhere', state: 'done', title: 'Access from anywhere', detail: 'On' }
        : remote.status === 'connecting'
          ? { key: 'anywhere', state: 'waiting', title: 'Access from anywhere', detail: 'Connecting to the relay…' }
          : { key: 'anywhere', state: 'missing', title: 'Access from anywhere', detail: remote.error ? `Offline: ${remote.error}` : 'Offline, retrying' }
  const paired: CheckRow = phone
    ? { key: 'paired', state: 'done', title: 'Phone paired', detail: phone.name }
    : { key: 'paired', state: 'waiting', title: 'Phone paired', detail: 'Waiting for the phone to scan the code…' }
  // Before the phone pairs, what it will get is what the outstanding code
  // carries (or, with none, the tick).
  const willType = s.code_role ? s.code_role === 'controller' : allowType
  const type: CheckRow = phone
    ? phone.role === 'controller'
      ? { key: 'type', state: 'done', title: 'Can type from the phone', detail: 'Yes: start agents, type, approve, stop' }
      : { key: 'type', state: 'missing', title: 'Can type from the phone', detail: 'No: view only' }
    : willType
      ? { key: 'type', state: 'waiting', title: 'Can type from the phone', detail: 'Yes, once it pairs' }
      : { key: 'type', state: 'missing', title: 'Can type from the phone', detail: 'No: this code pairs it to view only' }
  const app: CheckRow = phone?.app
    ? { key: 'app', state: 'done', title: 'App installed on the phone', detail: 'Yes' }
    : { key: 'app', state: 'optional', title: 'App installed on the phone', detail: 'Optional: install it on the phone when it offers' }
  return [anywhere, paired, type, app]
}

/** "this Mac" on a Mac: the steps name the machine the reader is looking at. */
function thisMachine(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Macintosh/.test(ua)) return 'this Mac'
  if (/Windows/.test(ua)) return 'this PC'
  return 'this computer'
}

/**
 * Settings → Use on your phone.
 *
 * One way in: from anywhere, through the relay (ADR-058, amended 2026-10-14 —
 * owner, translated: "I'd remove every option except the normal online one —
 * who cares about working only inside your own Wi-Fi; everyone wants to work
 * online"). Pressing **Show a code** here is the decision on the machine that
 * turns it on, and the line under the button says so. The Wi-Fi listener
 * stays in the daemon for a machine without internet (`caprock up --lan`,
 * `caprock pair`), and the panel shows it only while it is on, to turn off.
 */
export function Pairing() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [codeUntil, setCodeUntil] = useState(0)
  const [joined, setJoined] = useState<PairedDevice | null>(null)
  // The checklist shows from Show a code until the owner closes it.
  const [checking, setChecking] = useState(false)
  const [allowType, setAllowType] = useState(readAllowType)
  const now = useNow(1000)

  // Polled fast only while a code is on screen, so the phone shows up in the
  // list within a couple of seconds of being paired.
  const [fast, setFast] = useState(false)
  const state = useApi(() => api.pairState(), [], { live: false, intervalMs: fast ? 1500 : 5000 })
  const s = state.data
  const code = s?.code ?? ''

  useEffect(() => {
    setFast(Boolean(code))
    // A code issued in another tab, or still live from before this panel was
    // opened, is the same code — its expiry comes from the daemon.
    if (code && s?.expires_in_sec) setCodeUntil(Date.now() + s.expires_in_sec * 1000)
  }, [code, s?.expires_in_sec])

  // A device that appears while a code is showing is the phone that just
  // scanned it. Say so in words, beside the list it joined.
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!s) return
    const ids = new Set(s.devices.map((d) => d.id))
    if (known.current) {
      const fresh = s.devices.find((d) => !known.current!.has(d.id))
      if (fresh) setJoined(fresh)
    }
    known.current = ids
  }, [s])

  // Arrived by a click on *phone* (openSettingsSection): show the code at
  // once, unless one is already on screen — but only when it turns nothing
  // on. A click on a sidebar row is not the decision to open the machine to
  // the relay; the button that says so is.
  const [arrived, setArrived] = useState(() => takeCodeOnArrival())
  useEffect(() => {
    const on = () => { if (takeCodeOnArrival()) setArrived(true) }
    window.addEventListener(CODE_EVENT, on)
    return () => window.removeEventListener(CODE_EVENT, on)
  }, [])
  useEffect(() => {
    if (!arrived || !s) return
    setArrived(false)
    const opensNothing = s.remote ? s.remote.enabled : s.enabled
    if (!s.code && opensNothing) void showCode()
    // showCode reads the state just loaded; running it once per arrival is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived, s])

  async function showCode() {
    setBusy(true)
    setError('')
    setJoined(null)
    setChecking(true)
    try {
      // One press does both: access from anywhere has to be on before a
      // phone can reach the page the code opens. A build without the relay
      // falls back to the network listener, as before.
      if (s?.remote) {
        if (!s.remote.enabled) await api.setRemote(true)
      } else if (!s?.enabled) {
        await api.setLAN(true)
      }
      // The role is the tick's, decided here (ADR-034, amended 2026-10-14).
      const r = await api.pairCode(allowType ? 'controller' : 'viewer')
      setCodeUntil(Date.now() + r.expires_in_sec * 1000)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function turnLANOff() {
    setBusy(true)
    setError('')
    try {
      await api.setLAN(false)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function turnRemote(on: boolean) {
    setBusy(true)
    setError('')
    try {
      await api.setRemote(on)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // Withdraws the code on the daemon, not just from the screen: a code hidden
  // here but still valid there would be a door left open behind the reader.
  async function cancelCode() {
    setBusy(true)
    setError('')
    try {
      await api.pairCancelCode()
      setCodeUntil(0)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setError('')
    try {
      await api.pairRevoke(id)
      if (joined?.id === id) setJoined(null)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    }
  }

  // Control is a second decision, made here and nowhere else (ADR-034):
  // pairing makes a viewer, and taking control away is one button.
  async function setRole(id: string, role: PairedDevice['role']) {
    setError('')
    try {
      await api.pairSetRole(id, role)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    }
  }

  if (!s) {
    return (
      <Section id={PHONE_SECTION} title="Use on your phone">
        <div className="text-[12px] text-fg-faint">reading…</div>
      </Section>
    )
  }

  const status = phoneStatus(s)
  const secondsLeft = codeUntil ? Math.max(0, Math.ceil((codeUntil - now) / 1000)) : 0
  const remote = s.remote
  const anywhere = Boolean(remote?.enabled)
  const addresses = addressesOf(s)
  const showingCode = Boolean(code && (anywhere || (!remote && s.url)) && secondsLeft > 0)
  const machine = thisMachine()
  const hasPhone = s.devices.some((d) => looksLikePhone(d.name))
  // The joined phone as the daemon has it now: its role and app change live.
  const phone = joined ? s.devices.find((d) => d.id === joined.id) ?? null : null
  const showChecklist = checking && (showingCode || Boolean(phone))
  const tick = (on: boolean) => {
    setAllowType(on)
    keepAllowType(on)
  }

  return (
    <Section id={PHONE_SECTION} title="Use on your phone" aside={<StatusPill status={status} />}>
      <div className="grid gap-4">
        {showChecklist && (
          <Checklist rows={pairChecklist(s, phone, allowType)} onAllowType={phone ? () => setRole(phone.id, 'controller') : undefined} onClose={phone ? () => setChecking(false) : undefined} />
        )}
        {showingCode ? (
          <CodeView remote={anywhere ? remote : undefined} address={addresses[0]} code={code} secondsLeft={secondsLeft} onNew={showCode} onCancel={cancelCode} busy={busy} />
        ) : (
          <>
            {/* One line a step, the same words as the phone's page (m.caprock.dev):
              * the owner left the house with a phone that could only look
              * (2026-10-14), so the tick that lets it type is step one. */}
            <p className="text-[15px] leading-snug text-fg-muted">
              The same Caprock on your phone, on any network — Wi-Fi or mobile data. Read what agents wrote, type into a session, approve, stop.
            </p>
            <ol data-testid="pair-steps" className="grid gap-1.5 text-[14px] leading-snug text-fg">
              <Step n={1}>Tick <b className="font-medium">This phone can type and start agents</b> (on by default)</Step>
              <Step n={2}>Press <b className="font-medium">Show a code</b> and scan it with the phone&apos;s camera</Step>
              <Step n={3}>Open the link; the phone pairs</Step>
              <Step n={4}><span className="text-fg-muted">Optional:</span> Install the app when the phone offers it</Step>
            </ol>
            <div className="grid gap-2">
              <label className="flex w-fit cursor-pointer items-center gap-2 text-[14px] text-fg">
                <input
                  type="checkbox"
                  data-testid="allow-type"
                  className="h-4 w-4 accent-[var(--color-accent)]"
                  checked={allowType}
                  onChange={(e) => tick(e.target.checked)}
                />
                This phone can type and start agents
              </label>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <button
                  onClick={showCode}
                  disabled={busy}
                  className="h-11 rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? 'One moment…' : hasPhone ? 'Show a code for another phone' : 'Show a code'}
                </button>
                {anywhere && <RelayState remote={remote!} busy={busy} onOff={() => turnRemote(false)} />}
              </div>
              <p className="text-[13px] leading-snug text-fg-muted">
                {allowType
                  ? 'It can start agents, type into sessions, approve and stop them. Settings and pairing stay on this computer.'
                  : 'Unticked, the phone can only look. You can let it type later, next to it in the list below.'}
              </p>
              {/* ADR-058: on only by a decision on the machine. This press is
                * that decision, so the line beside it says what it turns on. */}
              {remote && !anywhere && (
                <p data-testid="anywhere-consent" data-keep className="text-[13px] leading-snug text-fg-muted">
                  Showing a code turns on access from anywhere for {machine}, and keeps it on: an encrypted relay that passes bytes it cannot read.
                </p>
              )}
            </div>
            <details className="group rounded-[10px] border border-border px-4 py-2.5 text-[14px]">
              <summary className="cursor-pointer select-none font-medium text-fg">Then: home screen, carrying on a session</summary>
              <ul className="mt-2 grid gap-2 text-fg-muted">
                <li><b className="font-medium text-fg">Home screen.</b> On Android, tap <b className="font-medium text-fg">Install</b> on the phone&apos;s page. On an iPhone, Share → Add to Home Screen; the home-screen app keeps its own storage, so copy the link under the code and paste it there once.</li>
                <li><b className="font-medium text-fg">Carry on a session.</b> On the phone: Home → the session → Chat, and type. Approve and stop from there too.</li>
              </ul>
            </details>
          </>
        )}

        {error && <div className="text-[12px] text-danger">{error}</div>}


        {/* A paired Mac is not a phone (owner's screenshot, 2026-10-14: the
          * only row was "Mac", seen 41 days ago), so say there is none yet. */}
        {!showingCode && s.devices.length > 0 && !hasPhone && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-fg">
            <span>No phone paired yet.</span>
            <button onClick={showCode} disabled={busy} className="font-medium text-accent hover:underline disabled:opacity-50">Show a code</button>
          </div>
        )}
        <Devices
          devices={s.devices}
          now={now}
          onRemove={remove}
          onRole={setRole}
          onRepair={remote ? showCode : undefined}
          openAgain={remote?.app ? { app: remote.app, anywhere, telegram: Boolean(s.telegram), onTurnOn: () => turnRemote(true) } : undefined}
          busy={busy}
        />

        <div className="grid gap-1 border-t border-border pt-3 text-[12px] leading-relaxed text-fg-muted">
          <p>Only phones you pair get in, each with the role you chose here; take control away or remove one with a click.</p>
          {/* The Wi-Fi listener is not offered here any more; when it is on
            * (`caprock up --lan`, or switched on before), say so and offer off. */}
          {s.enabled && remote && (
            <div data-testid="wifi-listener" className="flex flex-wrap items-center gap-x-3 pt-1">
              <span className="min-w-0 text-fg-faint">
                Also open on this Wi-Fi at <span className="mono break-all">{s.url}</span> — that link works only on the same network.
              </span>
              <button onClick={turnLANOff} disabled={busy} className="text-fg-faint underline hover:text-danger disabled:opacity-50">
                Turn off
              </button>
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}

/** One numbered line of the steps. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-2.5">
      <span className="num w-4 shrink-0 text-right font-semibold text-accent">{n}.</span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}

const CHECK_MARK: Record<CheckState, { mark: string; cls: string }> = {
  done: { mark: '✓', cls: 'bg-ok/15 text-ok' },
  waiting: { mark: '…', cls: 'bg-warn/15 text-warn' },
  missing: { mark: '✗', cls: 'bg-danger/15 text-danger' },
  optional: { mark: '○', cls: 'bg-panel-2 text-fg-faint' },
}

/**
 * What is done and what is left, live while a code is out and after the phone
 * pairs: the owner should not walk out of the door to find the phone can only
 * look (2026-10-14).
 */
function Checklist({ rows, onAllowType, onClose }: { rows: CheckRow[]; onAllowType?: () => void; onClose?: () => void }) {
  const allDone = rows.every((r) => r.state === 'done' || r.state === 'optional')
  return (
    <div data-testid="pair-checklist" className="grid gap-1 rounded-[12px] border border-border bg-panel-2/40 px-4 py-3" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-medium text-fg">{allDone ? 'Ready: the phone is set up' : 'Setting up your phone'}</span>
        {onClose && (
          <button onClick={onClose} className="ml-auto text-[12px] text-fg-faint hover:text-fg">
            {allDone ? 'Done' : 'Hide'}
          </button>
        )}
      </div>
      <ol className="grid gap-1.5">
        {rows.map((r, i) => {
          const m = CHECK_MARK[r.state]
          return (
            <li key={r.key} data-testid={`check-${r.key}`} data-state={r.state} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px]">
              <span className={`num inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${m.cls}`} aria-hidden>
                {m.mark}
              </span>
              <span className="text-fg">
                <span className="num text-fg-faint">{i + 1}.</span> {r.title}
              </span>
              <span className="min-w-0 text-fg-muted">— {r.detail}</span>
              {r.key === 'type' && r.state === 'missing' && onAllowType && (
                <button onClick={onAllowType} className="rounded-sm border border-accent px-2 py-0.5 text-[12px] font-medium text-accent hover:bg-accent/10">
                  Let it control sessions
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Whether the relay is up, and its off switch, beside Show a code. */
function RelayState({ remote, busy, onOff }: { remote: RemoteState; busy: boolean; onOff: () => void }) {
  const st = remote.status === 'online'
    ? { dot: 'bg-ok', text: remote.phones > 0 ? `Anywhere · online · ${remote.phones} connected now` : 'Anywhere · online' }
    : remote.status === 'connecting'
      ? { dot: 'bg-warn animate-pulse', text: 'Anywhere · connecting to the relay…' }
      : { dot: 'bg-danger', text: remote.error ? `Anywhere · offline: ${remote.error}` : 'Anywhere · offline, retrying' }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden />
        <span className="min-w-0 break-words">{st.text}</span>
      </span>
      <button onClick={onOff} disabled={busy} className="text-[12px] text-fg-faint underline hover:text-danger disabled:opacity-50">
        Turn off
      </button>
    </span>
  )
}

function StatusPill({ status }: { status: PhoneStatus }) {
  const dot = status.tone === 'ok' ? 'bg-ok' : status.tone === 'waiting' ? 'bg-warn animate-pulse' : status.tone === 'on' ? 'bg-accent' : 'bg-fg-faint'
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-fg" aria-live="polite">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {status.label}
    </span>
  )
}

export function BigStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid content-start gap-1 rounded-[12px] border border-border bg-panel-2/50 px-4 py-3.5">
      <span className="num text-[26px] font-semibold leading-none text-accent">{n}</span>
      <span className="mt-1 text-[16px] font-medium text-fg">{title}</span>
      <span className="text-[13px] leading-snug text-fg-muted">{children}</span>
    </li>
  )
}

function CodeView({
  remote,
  address,
  code,
  secondsLeft,
  onNew,
  onCancel,
  busy,
}: {
  /** Access from anywhere: the QR opens the phone's page through the relay. */
  remote?: RemoteState
  /** Without the relay in this build: the network listener's address. */
  address?: PairAddress
  code: string
  secondsLeft: number
  onNew: () => void
  onCancel: () => void
  busy: boolean
}) {
  const viaRelay = Boolean(remote?.link)
  const url = viaRelay ? remote!.app : address?.url ?? ''
  const link = viaRelay ? remote!.link! : pairLink(url, code)
  const [copied, setCopied] = useState(false)
  const qr = useMemo(() => qrPath(encodeQR(link)), [link])
  const mm = Math.floor(secondsLeft / 60)
  const ss = String(secondsLeft % 60).padStart(2, '0')
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
      {/* Black on white whatever the theme: a phone camera reads a dark code
        * on a light ground, and an inverted one fails on many of them. */}
      <svg
        viewBox={qr.viewBox}
        role="img"
        aria-label={`QR code that opens ${url} and pairs with code ${code}`}
        className="h-auto w-full max-w-[280px] shrink-0 rounded-md bg-white p-2"
        shapeRendering="crispEdges"
      >
        <path d={qr.d} fill="#000" />
      </svg>
      <div className="grid min-w-0 flex-1 basis-[220px] gap-3">
        <div>
          <div className="text-[15px] text-fg">Point your phone&apos;s camera at the code.</div>
          <div className="mt-0.5 text-[12px] text-fg-muted">Tap the link it shows. The phone pairs by itself.</div>
        </div>
        <div data-testid="pair-reach" className="text-[13px] leading-snug text-fg">
          {viaRelay
            ? <>Anywhere — Wi-Fi or mobile data, nothing to install. Encrypted end to end; the relay cannot read it.</>
            : address?.kind === 'lan'
              ? <>Only on this Wi-Fi: the phone has to be on the same network as {thisMachine()}.</>
              : <>Anywhere, as long as Tailscale is on, on both your phone and {thisMachine()}.</>}
        </div>
        {viaRelay ? (
          <div className="grid gap-1 text-[12px] text-fg-muted">
            {/* A home-screen app on iOS keeps its own storage and the camera
              * opens links in Safari, so the link is offered to paste there. */}
            <div>Added Caprock to the phone&apos;s home screen? Copy the link and paste it there.</div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }}
              className="w-fit rounded-md border border-border px-2.5 py-1 text-[12px] text-fg hover:border-accent"
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
        ) : (
          <div className="grid gap-1">
            <div className="text-[12px] text-fg-muted">
              No camera? Open <span className="mono text-fg select-all break-all">{url}</span> on the phone and type
            </div>
            <div className="mono text-[40px] leading-none tracking-[0.18em] text-accent select-all" aria-label={`pairing code ${code.split('').join(' ')}`}>
              {code.slice(0, 3)}&thinsp;{code.slice(3)}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-muted">
          <span className="num">Works once · {mm}:{ss} left</span>
          <button onClick={onNew} disabled={busy} className="text-accent hover:underline disabled:opacity-50">New code</button>
          <button onClick={onCancel} disabled={busy} className="text-fg-faint hover:text-danger disabled:opacity-50">Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** How a device reaches the machine, in a few words, from how it last did. */
const VIA_LABEL: Record<NonNullable<PairedDevice['via']>, string> = {
  relay: 'anywhere',
  tailscale: 'anywhere with Tailscale',
  lan: 'Wi-Fi link',
}

interface OpenAgainProps {
  /** The phone's page, remote.app. */
  app: string
  /** Access from anywhere is on: without it the page reaches nothing. */
  anywhere: boolean
  /** A Telegram bot is set up, so the link can be sent there. */
  telegram: boolean
  onTurnOn: () => void
}

function Devices({
  devices,
  now,
  onRemove,
  onRole,
  onRepair,
  openAgain,
  busy,
}: {
  devices: PairedDevice[]
  now: number
  onRemove: (id: string) => void
  onRole: (id: string, role: PairedDevice['role']) => void
  /** Shows the code a Wi-Fi-linked phone re-pairs with; absent without the relay. */
  onRepair?: () => void
  /** The way back to the phone's page for a paired device; absent without the relay. */
  openAgain?: OpenAgainProps
  busy: boolean
}) {
  const [expanded, setExpanded] = useState('')
  if (devices.length === 0) return null
  return (
    <div className="grid gap-1.5">
      <div className="text-[12px] text-fg-muted">Paired devices</div>
      <ul className="grid gap-1.5">
        {devices.map((d) => {
          const repair = Boolean(onRepair) && needsRepair(d, devices)
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2">
              <span className="min-w-0 flex-1 basis-40">
                {/* Two phones of one model share a name, so each row also says
                  * when it was paired and the start of its id — enough to tell
                  * which one to take control away from. */}
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="min-w-0 truncate text-fg" title={d.name}>{d.name}</span>
                  {/* Outside the truncation: on a narrow row the name gives way,
                    * never the part that tells two of them apart. */}
                  <span className="mono shrink-0 text-[11px] text-fg-faint" title={`device id ${d.id}`}>#{d.id.slice(0, 4)}</span>
                </span>
                <span className="block text-[11px] text-fg-faint">
                  {/* Another computer's Caprock (ADR-067): Allow is the card
                    * it asks with, and Remove ends it. */}
                  {d.kind === 'machine'
                    ? (d.pending
                      ? <span data-testid="device-computer" className="text-warn">a computer, waiting for Allow</span>
                      : <span data-testid="device-computer" className="text-accent">a computer that controls this one</span>)
                    : d.role === 'controller' ? <span className="text-accent">can control sessions</span> : 'view only'}
                  {d.via && (
                    <>
                      {' · '}
                      <span data-testid="device-via" className={d.via === 'lan' ? 'text-warn' : undefined}>{VIA_LABEL[d.via]}</span>
                    </>
                  )}
                  {d.app && <>{' · '}<span data-testid="device-app">app installed</span></>}
                  {' · '}
                  {d.last_seen ? `last seen ${fmtAgo(d.last_seen, now)}` : 'not seen yet'}
                  {d.paired_at ? ` · paired ${fmtWhen(d.paired_at, now)}` : ''}
                </span>
                {/* The owner's phone, 2026-10-14: paired on the Wi-Fi address,
                  * dead on mobile data, and nothing said why. One quiet line. */}
                {repair && (
                  <span data-testid="device-repair" className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
                    <span>Works on this Wi-Fi only. Pair it once more to use it anywhere:</span>
                    <button onClick={onRepair} disabled={busy} className="font-medium text-accent hover:underline disabled:opacity-50">
                      Show the code
                    </button>
                  </span>
                )}
                {openAgain && !repair && d.kind !== 'machine' && offersOpenAgain(d) && (
                  <span data-testid="device-open-again" className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
                    <span>
                      Already paired — just open <b className="mono font-medium text-fg select-all">{phonePage(openAgain.app).host}</b> on that phone.
                    </span>
                    <button
                      onClick={() => setExpanded((x) => (x === d.id ? '' : d.id))}
                      aria-expanded={expanded === d.id}
                      className="font-medium text-accent hover:underline"
                    >
                      {expanded === d.id ? 'Hide' : 'Open on the phone again'}
                    </button>
                  </span>
                )}
              </span>
              {d.kind === 'machine' ? null : d.role === 'controller' ? (
                <button
                  onClick={() => onRole(d.id, 'viewer')}
                  title="It goes back to view only on its next request, and an open terminal stops taking keys"
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted hover:border-danger hover:text-danger"
                >
                  Take control away
                </button>
              ) : (
                <button
                  onClick={() => onRole(d.id, 'controller')}
                  title="It can start sessions in your projects, type into them, answer approvals and stop them. Settings and pairing stay on this machine."
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted hover:border-accent hover:text-accent"
                >
                  Let it control sessions
                </button>
              )}
              <button
                onClick={() => onRemove(d.id)}
                title="It stops working on its next request"
                className="shrink-0 rounded-sm border border-border px-2 py-1 text-[12px] text-fg-muted hover:border-danger hover:text-danger"
              >
                Remove
              </button>
              {openAgain && expanded === d.id && d.kind !== 'machine' && offersOpenAgain(d) && <OpenAgain {...openAgain} name={d.name} busy={busy} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * "Open on the phone again", under a paired device: the plain address, a QR
 * of that address alone, and the link sent to Telegram when a bot is set up.
 * Vova, 2026-10-15: a paired phone, a closed tab, and no way back but
 * removing it and pairing again.
 */
export function OpenAgain({ app, anywhere, telegram, onTurnOn, name, busy }: OpenAgainProps & { name: string; busy: boolean }) {
  const page = phonePage(app)
  const qr = useMemo(() => qrPath(encodeQR(page.url)), [page.url])
  const [sent, setSent] = useState<'' | 'sending' | 'sent'>('')
  const [error, setError] = useState('')
  async function send() {
    setSent('sending')
    setError('')
    try {
      await api.pairSendLink()
      setSent('sent')
    } catch (e) {
      setSent('')
      setError(errText(e))
    }
  }
  return (
    <div data-testid="open-again" className="flex w-full basis-full flex-wrap items-start gap-x-5 gap-y-3 border-t border-border pt-3">
      {/* Black on white whatever the theme, as the pairing QR. The address
        * alone: scanning it pairs nothing. */}
      <svg
        viewBox={qr.viewBox}
        role="img"
        aria-label={`QR code that opens ${page.host}`}
        data-qr-text={page.url}
        className="h-auto w-full max-w-[160px] shrink-0 rounded-md bg-white p-1.5"
        shapeRendering="crispEdges"
      >
        <path d={qr.d} fill="#000" />
      </svg>
      <div className="grid min-w-0 flex-1 basis-[220px] gap-2 text-[13px] leading-snug text-fg-muted">
        <p className="text-[14px] text-fg">
          Already paired — just open <b className="mono font-medium select-all">{page.host}</b> on {name ? <>“{name}”</> : 'that phone'}.
        </p>
        <p>
          Type the address, or scan this code with that phone&apos;s camera. It carries the address only, no code: the phone connects with the
          pairing it keeps, in the same browser it paired in.
        </p>
        <p>
          <b className="font-medium text-fg">Tip:</b> Share → <b className="font-medium text-fg">Add to Home Screen</b> to keep it as an app (on Android, ⋮ →{' '}
          <b className="font-medium text-fg">Install app</b>).
        </p>
        {!anywhere && (
          <p data-testid="open-again-off" className="text-warn">
            Access from anywhere is off, so the page cannot reach this computer.{' '}
            <button onClick={onTurnOn} disabled={busy} className="font-medium text-accent underline disabled:opacity-50">
              Turn it on
            </button>
          </p>
        )}
        {/* Kept with explanations off: it is the answer to "the link doesn't load". */}
        <p className="text-fg-faint" data-keep>
          The phone needs to reach {page.host} and the relay. A VPN or a network that blocks either shows on the phone as “Can’t reach the relay”.
        </p>
        {telegram && (
          <div className="grid gap-1">
            <button
              data-testid="send-link"
              onClick={() => void send()}
              disabled={sent === 'sending'}
              className="w-fit rounded-md border border-border px-2.5 py-1 text-[12px] text-fg hover:border-accent disabled:opacity-50"
            >
              {sent === 'sent' ? 'Sent to Telegram ✓' : sent === 'sending' ? 'Sending…' : 'Send the link to my phone'}
            </button>
            {/* Rule 4: say where it goes and what it carries. */}
            <span className="text-[12px] text-fg-faint">
              One message to your Telegram chat through your own bot (Settings → Telegram): the address {page.url}, no code and no key.
            </span>
            {error && <span className="text-[12px] text-danger">{error}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
