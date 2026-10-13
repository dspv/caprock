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
 * So it is three steps and one button. **Show a code** turns network access on
 * and issues a pairing code in the same press, and the code is drawn as a QR
 * code whose link carries it: the camera opens the page, the page pairs, and
 * the phone appears in the list below. The six digits are still shown in big
 * type for a phone whose camera will not cooperate.
 *
 * The state is said at a glance in the panel's corner — Off, Waiting for your
 * phone…, 1 phone connected — because "is it on?" is the first question
 * anyone asks of a switch that lets other devices in.
 *
 * What did not change is the security model (ADR-029), only how it is said:
 * one line. Pairing is required; a paired phone reads and does not control;
 * listening stops when Caprock restarts unless the owner ticks *Keep on after
 * Caprock restarts* (ADR-060); the paired list is kept.
 *
 * Where the phone will work leads the panel (owner, 2026-10-14, translated:
 * "is it normal that we still have this feeling that there's no connection
 * with the phone such that you can reach it from different networks?"). The
 * answer was folded under *Then: ...*. Over the network listener, "anywhere"
 * is Tailscale on both devices, and the panel says which of the
 * two it is before anything is turned on: `tailscale` in the state is read
 * from the interface list on every poll while the panel is open, so
 * installing Tailscale flips it without a restart.
 *
 * The QR code is drawn here, in the browser, by ui/src/lib/qr.ts: the link
 * carries a code that lets a device in, and it is not sent anywhere to be
 * rendered.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type PairAddress, type PairedDevice, type PairState } from '@/lib/api'
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

const SECTION_IDS: Record<SettingsSection, string> = { phone: PHONE_SECTION, telegram: TELEGRAM_SECTION }

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
 * Every address a phone can open, from the daemon's list or, from an older
 * daemon, its one url. The LAN one first: it is what a phone on the same
 * Wi-Fi uses without installing anything.
 */
export function addressesOf(s: Pick<PairState, 'url' | 'tunnelled' | 'addresses'>): PairAddress[] {
  const all: PairAddress[] = s.addresses?.length ? s.addresses : s.url ? [{ url: s.url, kind: s.tunnelled ? 'tailscale' : 'lan' }] : []
  const rank = { lan: 0, tailscale: 1, magicdns: 2 } as const
  return [...all].sort((a, b) => rank[a.kind] - rank[b.kind])
}

const ADDRESS_LABEL: Record<PairAddress['kind'], string> = { lan: 'Wi-Fi', tailscale: 'Tailscale', magicdns: 'Tailscale name' }
const ADDRESS_NOTE: Record<PairAddress['kind'], string> = {
  lan: 'Works while your phone is on the same Wi-Fi.',
  tailscale: 'Works anywhere your phone has Tailscale on — even on mobile data.',
  magicdns: 'The Tailscale address by name; needs MagicDNS on in Tailscale.',
}
const ADDRESS_KEY = 'caprock.pair.address'

/** Tailscale's own download pages: this computer's, and the two phones'. */
export const TAILSCALE_LINKS = {
  mac: 'https://tailscale.com/download/mac',
  windows: 'https://tailscale.com/download/windows',
  linux: 'https://tailscale.com/download/linux',
  iphone: 'https://apps.apple.com/app/tailscale/id1470499037',
  android: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
} as const

/**
 * The address a new code opens when the owner has not picked one: Tailscale's
 * when there is one. A phone's token is kept per address, so a phone paired on
 * the Wi-Fi address works on that Wi-Fi and nowhere else (the partner who
 * found it gone on mobile data, 2026-10-11, had paired that way).
 */
export function preferredAddress(addresses: PairAddress[], picked: PairAddress['kind'] | ''): PairAddress | undefined {
  return addresses.find((a) => a.kind === picked) ?? addresses.find((a) => a.kind === 'tailscale') ?? addresses[0]
}

/** Whether a paired device's name says it is a phone or a tablet. */
export function looksLikePhone(name: string): boolean {
  return /phone|android|ipad|tablet/i.test(name)
}

export type PhoneStatus = { tone: 'off' | 'waiting' | 'ok' | 'on'; label: string }

/** What the corner of the panel says, from the daemon's state alone. */
export function phoneStatus(s: Pick<PairState, 'enabled' | 'code' | 'devices'>): PhoneStatus {
  const n = s.devices.length
  const noun = deviceNoun(s.devices)
  if (!s.enabled) {
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

/** Which Tailscale download this computer wants, from the browser. */
function thisMachineLink(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Macintosh/.test(ua)) return TAILSCALE_LINKS.mac
  if (/Windows/.test(ua)) return TAILSCALE_LINKS.windows
  return TAILSCALE_LINKS.linux
}

/** "this Mac" on a Mac: the steps name the machine the reader is looking at. */
function thisMachine(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Macintosh/.test(ua)) return 'this Mac'
  if (/Windows/.test(ua)) return 'this PC'
  return 'this computer'
}

export function Pairing() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Offered beside Turn on: the owner decides at the moment they open the door
  // whether it stays open across restarts (ADR-060).
  const [keepOnTurn, setKeepOnTurn] = useState(false)
  const [codeUntil, setCodeUntil] = useState(0)
  const [joined, setJoined] = useState<PairedDevice | null>(null)
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

  // Tailscale came up while access was on (installed with the panel open):
  // asking the daemon to turn access on again makes it listen on the
  // Tailscale address too, and leaves the Wi-Fi one alone. Once per address
  // set, so a daemon that cannot bind it is not asked on every poll.
  const adopted = useRef('')
  useEffect(() => {
    if (!s?.enabled || !s.tailscale) return
    const listed = addressesOf(s)
    if (listed.length === 0 || listed.some((a) => a.kind !== 'lan')) return
    const key = listed.map((a) => a.url).join(' ')
    if (adopted.current === key) return
    adopted.current = key
    void api.setLAN(true).then(() => state.refresh(), () => {})
    // state.refresh is stable for the hook's life; s is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s])

  // Arrived by a click on *phone* (openSettingsSection): show the code at
  // once, unless one is already on screen. Listening too, for a Settings tab
  // that was open already.
  const [arrived, setArrived] = useState(() => takeCodeOnArrival())
  useEffect(() => {
    const on = () => { if (takeCodeOnArrival()) setArrived(true) }
    window.addEventListener(CODE_EVENT, on)
    return () => window.removeEventListener(CODE_EVENT, on)
  }, [])
  useEffect(() => {
    if (!arrived || !s) return
    setArrived(false)
    if (!s.code) void showCode()
    // showCode reads the state just loaded; running it once per arrival is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived, s])

  async function showCode() {
    setBusy(true)
    setError('')
    setJoined(null)
    try {
      // One press does both: the listener has to be up before a phone can
      // reach the page the code opens.
      if (!s?.enabled) await (keepOnTurn ? api.setLAN(true, true) : api.setLAN(true))
      const r = await api.pairCode()
      setCodeUntil(Date.now() + r.expires_in_sec * 1000)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function turn(on: boolean, keep?: boolean) {
    setBusy(true)
    setError('')
    setJoined(null)
    try {
      await (keep === undefined ? api.setLAN(on) : api.setLAN(on, keep))
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
  const showingCode = Boolean(code && s.url && secondsLeft > 0)
  const machine = thisMachine()
  const addresses = addressesOf(s)
  const hasTailscale = addresses.some((a) => a.kind !== 'lan')
  const tunnelOnly = s.enabled && addresses.length > 0 && !addresses.some((a) => a.kind === 'lan')
  // Anywhere when this machine has Tailscale, listened on yet or not; an older
  // daemon without the field is read from the addresses it listens on.
  const viaTailscale = Boolean(s.tailscale) || hasTailscale
  const hasPhone = s.devices.some((d) => looksLikePhone(d.name))

  return (
    <Section id={PHONE_SECTION} title="Use on your phone" aside={<StatusPill status={status} />}>
      <div className="grid gap-4">
        {/* Big and in three words a step: the owner could not read the old
          * five-sentence list (2026-10-10, "make it super large and clear"). */}
        {!showingCode && (
          <p className="text-[15px] leading-snug text-fg-muted">
            The same Caprock on your phone: read what agents wrote, type into a session, approve, stop.
          </p>
        )}
        {!showingCode && <Reach tailscale={viaTailscale} machine={machine} />}
        {!showingCode && !s.enabled && s.devices.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 rounded-[12px] border border-warn/50 bg-warn/10 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-[17px] font-medium text-fg">Phone access is off</div>
              <div className="text-[13px] text-fg-muted">It switches off when Caprock restarts, unless you keep it on. Your phones stay paired.</div>
              <KeepOnBox checked={keepOnTurn} onChange={setKeepOnTurn} disabled={busy} />
            </div>
            <button onClick={() => turn(true, keepOnTurn ? true : undefined)} disabled={busy} className="h-11 rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110 disabled:opacity-50">
              {busy ? 'One moment…' : 'Turn on'}
            </button>
          </div>
        )}
        {showingCode ? (
          <CodeView addresses={addresses} code={code} secondsLeft={secondsLeft} onNew={showCode} onCancel={cancelCode} busy={busy} />
        ) : (
          <>
            <ol className="grid gap-3 sm:grid-cols-3">
              {tunnelOnly ? (
                <BigStep n={1} title="Tailscale on both">Tailscale on your phone and {machine}; then it works anywhere.</BigStep>
              ) : viaTailscale ? (
                <BigStep n={1} title="Tailscale on both">Your phone and {machine} in one Tailscale account. The same Wi-Fi works too.</BigStep>
              ) : (
                <BigStep n={1} title="Same Wi-Fi">Your phone and {machine} on one network.</BigStep>
              )}
              <BigStep n={2} title="Scan the code">
                Press <b className="font-medium text-fg">Show a code</b>, point the phone&apos;s camera at it.
              </BigStep>
              <BigStep n={3} title="Add to Home Screen">
                iPhone: Share → Add to Home Screen. Android: menu → Add to Home screen.
              </BigStep>
            </ol>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                onClick={showCode}
                disabled={busy}
                className="h-11 rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110 disabled:opacity-50"
              >
                {busy ? 'One moment…' : hasPhone ? 'Show a code for another phone' : 'Show a code'}
              </button>
              <span className="text-[13px] text-fg-muted">
                To start chats and save from it, press <b className="font-medium text-fg">Let it control sessions</b> next to your phone below.
              </span>
            </div>
            <details className="group rounded-[10px] border border-border px-4 py-2.5 text-[14px]">
              <summary className="cursor-pointer select-none font-medium text-fg">Then: home screen, carrying on a session</summary>
              <ul className="mt-2 grid gap-2 text-fg-muted">
                <li><b className="font-medium text-fg">Home screen.</b> On an iPhone the home-screen app keeps its own storage: open it from there and type a new code once.</li>
                <li><b className="font-medium text-fg">Carry on a session.</b> On the phone: Now → the session → Chat, and type. Approve and stop from there too.</li>
              </ul>
            </details>
          </>
        )}

        {error && <div className="text-[12px] text-danger">{error}</div>}

        {joined && !showingCode && (
          <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-[13px] text-fg">
            <span className="text-ok">✓</span> {joined.name} is connected. On it, Caprock is at{' '}
            <span className="mono select-all break-all">{s.url}</span> — add it to the home screen to keep it one tap away.
            On an iPhone the home-screen app pairs once more: show another code and type it there.
          </div>
        )}

        {/* A paired Mac is not a phone (owner's screenshot, 2026-10-14: the
          * only row was "Mac", seen 41 days ago), so say there is none yet. */}
        {!showingCode && s.devices.length > 0 && !hasPhone && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-fg">
            <span>No phone paired yet.</span>
            <button onClick={showCode} disabled={busy} className="font-medium text-accent hover:underline disabled:opacity-50">Show a code</button>
          </div>
        )}
        <Devices devices={s.devices} now={now} onRemove={remove} onRole={setRole} />

        <div className="grid gap-1 border-t border-border pt-3 text-[12px] leading-relaxed text-fg-muted">
          <p>Only phones you pair get in, and they only look until you let one control sessions.</p>
          {s.enabled && (
            <KeepOnBox checked={Boolean(s.keep_on)} onChange={(v) => turn(true, v)} disabled={busy} />
          )}
          {s.enabled && !showingCode && (
            <div className="flex flex-wrap items-center gap-x-3 pt-1">
              {addresses.length > 0 && (
                <span className="min-w-0 text-fg-faint">
                  Listening at{' '}
                  {addresses.map((a, i) => (
                    <span key={a.url}>{i > 0 && ' · '}<span className="mono break-all">{a.url}</span></span>
                  ))}
                </span>
              )}
              <button onClick={() => turn(false)} disabled={busy} className="text-fg-faint underline hover:text-danger disabled:opacity-50">
                Turn off
              </button>
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}

/**
 * Where the phone will work, said first: this Wi-Fi only, or anywhere
 * Tailscale is on. Without Tailscale, the one step that changes that, with
 * the three downloads a person needs.
 */
function Reach({ tailscale, machine }: { tailscale: boolean; machine: string }) {
  if (tailscale) {
    return (
      <div data-testid="phone-reach" className="rounded-[12px] border border-ok/40 bg-ok/10 px-4 py-3">
        <div className="text-[16px] font-medium text-fg">Works anywhere (Tailscale)</div>
        <div className="mt-0.5 text-[13px] leading-snug text-fg-muted">
          Works anywhere Tailscale is on, on both {machine} and your phone, even on mobile data.
        </div>
      </div>
    )
  }
  const link = 'text-accent hover:underline'
  return (
    <div data-testid="phone-reach" className="rounded-[12px] border border-border bg-panel-2/50 px-4 py-3">
      <div className="text-[16px] font-medium text-fg">Works on this Wi-Fi only</div>
      <div className="mt-0.5 text-[13px] leading-snug text-fg-muted">
        To use it away from home: install Tailscale on {machine} and on the phone, sign in to the same account.
        This panel notices it by itself, nothing to restart.
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <span className="text-fg-muted">Tailscale for</span>
        <a href={thisMachineLink()} target="_blank" rel="noreferrer" className={link}>{machine.replace(/^this /, '')}</a>
        <a href={TAILSCALE_LINKS.iphone} target="_blank" rel="noreferrer" className={link}>iPhone</a>
        <a href={TAILSCALE_LINKS.android} target="_blank" rel="noreferrer" className={link}>Android</a>
      </div>
    </div>
  )
}

/** *Keep on after Caprock restarts* (ADR-060). */
function KeepOnBox({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label
      className="mt-1.5 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-fg"
      title="Only phones you paired get in either way. This keeps the pairing page reachable on your network after a restart."
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-accent" />
      Keep on after Caprock restarts
    </label>
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
  addresses,
  code,
  secondsLeft,
  onNew,
  onCancel,
  busy,
}: {
  addresses: PairAddress[]
  code: string
  secondsLeft: number
  onNew: () => void
  onCancel: () => void
  busy: boolean
}) {
  // Which address the QR opens, remembered for this viewer: the owner who
  // pairs over Tailscale once will want it again.
  const [kind, setKind] = useState<PairAddress['kind'] | ''>(() => {
    try { return (localStorage.getItem(ADDRESS_KEY) as PairAddress['kind'] | null) ?? '' } catch { return '' }
  })
  const chosen = preferredAddress(addresses, kind)!
  const choose = (k: PairAddress['kind']) => {
    setKind(k)
    try { localStorage.setItem(ADDRESS_KEY, k) } catch { /* remembered for this page only */ }
  }
  const url = chosen.url
  const link = pairLink(url, code)
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
        {addresses.length > 1 && (
          <div className="grid gap-1">
            <div role="radiogroup" aria-label="Address the code opens" className="flex flex-wrap gap-1">
              {addresses.map((a) => (
                <button
                  key={a.url}
                  type="button"
                  role="radio"
                  aria-checked={a.url === url}
                  onClick={() => choose(a.kind)}
                  className={`rounded-md border px-2.5 py-1 text-[12px] ${a.url === url ? 'border-accent bg-accent/15 text-accent' : 'border-border text-fg-muted hover:text-fg'}`}
                >
                  {ADDRESS_LABEL[a.kind]}
                </button>
              ))}
            </div>
            <div className="text-[12px] text-fg-muted">{ADDRESS_NOTE[chosen.kind]}</div>
          </div>
        )}
        <div>
          <div className="text-[15px] text-fg">Point your phone&apos;s camera at the code.</div>
          <div className="mt-0.5 text-[12px] text-fg-muted">Tap the link it shows. The phone pairs by itself.</div>
        </div>
        {/* Where the phone will work, in one line beside the code: the owner's
          * partner paired on the Wi-Fi and found it gone everywhere else
          * (2026-10-11). Caprock relays nothing, so "anywhere" is Tailscale. */}
        <div data-testid="pair-reach" className="text-[13px] leading-snug text-fg">
          {chosen.kind !== 'lan'
            ? <>Anywhere, as long as Tailscale is on, on both your phone and {thisMachine()}.</>
            : addresses.some((a) => a.kind !== 'lan')
              ? <>Only on this Wi-Fi. For anywhere, pick Tailscale above — it has to be on on both devices.</>
              : <>Only on this Wi-Fi. For anywhere, mobile data too: <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="text-accent">Tailscale</a> on both your phone and {thisMachine()} (Caprock picks it up by itself).</>}
        </div>
        <div className="grid gap-1">
          <div className="text-[12px] text-fg-muted">
            No camera? Open <span className="mono text-fg select-all break-all">{url}</span> on the phone and type
          </div>
          <div className="mono text-[40px] leading-none tracking-[0.18em] text-accent select-all" aria-label={`pairing code ${code.split('').join(' ')}`}>
            {code.slice(0, 3)}&thinsp;{code.slice(3)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-muted">
          <span className="num">Works once · {mm}:{ss} left</span>
          <button onClick={onNew} disabled={busy} className="text-accent hover:underline disabled:opacity-50">New code</button>
          <button onClick={onCancel} disabled={busy} className="text-fg-faint hover:text-danger disabled:opacity-50">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Devices({
  devices,
  now,
  onRemove,
  onRole,
}: {
  devices: PairedDevice[]
  now: number
  onRemove: (id: string) => void
  onRole: (id: string, role: PairedDevice['role']) => void
}) {
  if (devices.length === 0) return null
  return (
    <div className="grid gap-1.5">
      <div className="text-[12px] text-fg-muted">Paired devices</div>
      <ul className="grid gap-1.5">
        {devices.map((d) => (
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
                {d.role === 'controller' ? <span className="text-accent">can control sessions</span> : 'view only'}
                {' · '}
                {d.last_seen ? `last seen ${fmtAgo(d.last_seen, now)}` : 'not seen yet'}
                {d.paired_at ? ` · paired ${fmtWhen(d.paired_at, now)}` : ''}
              </span>
            </span>
            {d.role === 'controller' ? (
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
          </li>
        ))}
      </ul>
    </div>
  )
}
