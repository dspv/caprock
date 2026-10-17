/**
 * Settings → Use on your phone.
 *
 * The owner, 2026-10-18 (translated), on the panel this replaced: "I don't
 * understand at all what's going on here — not one clear piece of info." It
 * had a status pill, a four-step checklist, a QR with three paragraphs beside
 * it, and a device list whose every row carried a role, a route, two dates,
 * an id, a sentence about m.caprock.dev and three buttons. Each piece was
 * true; together they did not answer the one question a person opening this
 * has: is my phone connected?
 *
 * So the section is, top to bottom:
 *
 * - **One sentence** that answers it (`phoneSummary`): *iPhone · Safari is
 *   connected and can control sessions · seen 2 min ago*, or *No phone
 *   connected yet.* When something is in the way it says so in the same
 *   sentence, with the one button that fixes it (access from anywhere off:
 *   **Turn it on**; a phone that can only view: **Allow control**).
 * - **One button**, **Connect a phone**. It turns on access from anywhere
 *   (ADR-058) when it is off — the line under it says so, which is the
 *   decision on the machine that ADR asks for — and issues a code drawn as a
 *   QR, with one line beside it: *Scan with your phone's camera. Works once,
 *   4:43 left.* and a quiet **New code · Cancel**. Under the button, the
 *   tick that decides whether the phone can control sessions (ADR-034,
 *   amended 2026-10-14): the code carries the role, decided here, never by
 *   the phone.
 * - **How it works**, folded: what happens when you scan, why it works on
 *   any network and what the relay can and cannot see, the link for an
 *   iPhone home-screen app, the way back to the page for a phone already
 *   connected (Vova, 2026-10-15: "I don't remember the link — and that's
 *   it"), and the switch that turns access from anywhere off.
 * - **Your devices**: one row each — the name, *Can control* or *View only*,
 *   when it was last seen, and two small buttons. Devices not seen for 30
 *   days fold into *N old devices* with **Remove all**, confirmed once.
 *
 * What did not change is the security model (ADR-029, ADR-058): pairing is
 * required; access from anywhere is turned on only here or by `caprock remote
 * on`, never from a phone. The QR code is drawn in the browser by
 * ui/src/lib/qr.ts: the link carries a code that lets a device in, and it is
 * not sent anywhere to be rendered.
 *
 * One way in, through the relay (owner, 2026-10-14). The Wi-Fi listener stays
 * in the daemon for a machine without internet (`caprock up --lan`, `caprock
 * pair`); a build without the relay falls back to it, and a phone still on a
 * Wi-Fi link is marked in its row with **Reconnect**.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type PairAddress, type PairedDevice, type PairState, type RemoteState } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { REVEAL_EVENT, Section } from '@/components/SettingsParts'
import { fmtWhen } from '@/lib/format'
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

/** Where the tick beside Connect a phone is remembered, on this computer. */
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

const DAY = 86_400_000

/** A device not seen for this long folds into *old devices*. */
export const OLD_AFTER_MS = 30 * DAY

/** Seen this recently, a phone reads as *connected*; before that, *set up*. */
export const CONNECTED_MS = 5 * 60_000

/** Whether a device has not been seen for 30 days (one never seen: since it paired). */
export function isOldDevice(d: Pick<PairedDevice, 'last_seen' | 'paired_at' | 'pending'>, now: number): boolean {
  if (d.pending) return false
  const t = d.last_seen || d.paired_at
  return Boolean(t) && now - t >= OLD_AFTER_MS
}

/** "just now", "2 min ago", "3 hours ago", "4 days ago": for a person, not a log. */
export function seenAgo(t: number, now: number): string {
  const m = Math.floor(Math.max(0, now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/**
 * The sentence at the top of the section, answering "is my phone
 * connected?": who, what it can do, and when it was last seen; or that none
 * is; or what is in the way, with the one fix (`fix`) beside it.
 */
export interface PhoneSummary {
  tone: 'none' | 'waiting' | 'ok' | 'idle' | 'warn'
  /** The device the sentence is about, its name said first. */
  device?: PairedDevice
  text: string
  meta?: string
  fix?: 'turn-on' | 'allow'
}

/** Pure, for the tests: the daemon's state, the clock, and the phone that just joined (first, if any). */
export function phoneSummary(s: Pick<PairState, 'code' | 'devices' | 'remote'>, now: number, joinedId = ''): PhoneSummary {
  if (s.code) return { tone: 'waiting', text: 'Waiting for your phone to scan the code…' }
  const recent = s.devices
    .filter((d) => d.kind !== 'machine' && !isOldDevice(d, now))
    .sort((a, b) => (b.id === joinedId ? 1 : 0) - (a.id === joinedId ? 1 : 0) || (b.last_seen || 0) - (a.last_seen || 0))
  const d = recent[0]
  if (!d) return { tone: 'none', text: 'No phone connected yet.' }
  const can = d.role === 'controller' ? 'can control sessions' : 'can only view'
  const more = recent.length > 1 ? `${recent.length - 1} more device${recent.length === 2 ? '' : 's'}` : ''
  const remote = s.remote
  if (remote && !remote.enabled) {
    return { tone: 'warn', device: d, text: "is set up, but access from anywhere is off, so it can't reach this computer.", fix: 'turn-on' }
  }
  if (remote?.status === 'offline') {
    return { tone: 'warn', device: d, text: `is set up, but this computer can't get online right now${remote.error ? ` (${remote.error})` : ''}. Retrying.` }
  }
  const fresh = Boolean(d.last_seen) && now - d.last_seen <= CONNECTED_MS
  const seen = d.last_seen ? `${fresh ? 'seen' : 'last seen'} ${seenAgo(d.last_seen, now)}` : 'not opened yet'
  return {
    tone: fresh ? 'ok' : 'idle',
    device: d,
    text: `is ${fresh ? 'connected' : 'set up'} and ${can}`,
    meta: [seen, more].filter(Boolean).join(' · '),
    fix: d.role === 'controller' ? undefined : 'allow',
  }
}

/** "this Mac" on a Mac: the lines name the machine the reader is looking at. */
function thisMachine(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Macintosh/.test(ua)) return 'this Mac'
  if (/Windows/.test(ua)) return 'this PC'
  return 'this computer'
}

const SMALL_BTN = 'shrink-0 rounded-md border border-border px-2.5 py-1 text-[12px] text-fg-muted disabled:opacity-50'

export function Pairing() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [codeUntil, setCodeUntil] = useState(0)
  const [joined, setJoined] = useState('')
  const [allowType, setAllowType] = useState(readAllowType)
  const now = useNow(1000)

  // Polled fast only while a code is on screen, so the phone shows up within
  // a couple of seconds of being paired.
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

  // A device that appears while the panel is open is the phone that just
  // scanned the code: the sentence at the top is about it.
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!s) return
    const ids = new Set(s.devices.map((d) => d.id))
    if (known.current) {
      const fresh = s.devices.find((d) => !known.current!.has(d.id))
      if (fresh) setJoined(fresh.id)
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

  // Every action: busy while it runs, its error in the one error line.
  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      state.refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const showCode = () => act(async () => {
    setJoined('')
    // One press does both: access from anywhere has to be on before a phone
    // can reach the page the code opens. A build without the relay falls
    // back to the network listener.
    if (s?.remote) {
      if (!s.remote.enabled) await api.setRemote(true)
    } else if (!s?.enabled) {
      await api.setLAN(true)
    }
    // The role is the tick's, decided here (ADR-034, amended 2026-10-14).
    const r = await api.pairCode(allowType ? 'controller' : 'viewer')
    setCodeUntil(Date.now() + r.expires_in_sec * 1000)
  })
  // Withdraws the code on the daemon, not just from the screen: a code hidden
  // here but still valid there would be a door left open behind the reader.
  const cancelCode = () => act(async () => {
    await api.pairCancelCode()
    setCodeUntil(0)
  })
  const turnRemote = (on: boolean) => act(() => api.setRemote(on))
  const turnLANOff = () => act(() => api.setLAN(false))
  const remove = (ids: string[]) => act(() => Promise.all(ids.map((id) => api.pairRevoke(id))))
  // Control is decided here and nowhere else (ADR-034).
  const setRole = (id: string, role: PairedDevice['role']) => act(() => api.pairSetRole(id, role))

  if (!s) {
    return (
      <Section id={PHONE_SECTION} title="Use on your phone">
        <div className="text-[12px] text-fg-faint">reading…</div>
      </Section>
    )
  }

  const secondsLeft = codeUntil ? Math.max(0, Math.ceil((codeUntil - now) / 1000)) : 0
  const remote = s.remote
  const anywhere = Boolean(remote?.enabled)
  const addresses = addressesOf(s)
  const showingCode = Boolean(code && (anywhere || (!remote && s.url)) && secondsLeft > 0)
  const summary = phoneSummary(showingCode ? s : { ...s, code: undefined }, now, joined)
  const link = showingCode && anywhere ? remote?.link ?? '' : ''
  const openAgain = remote?.app && s.devices.some((d) => d.kind !== 'machine' && offersOpenAgain(d))
    ? { app: remote.app, anywhere, telegram: Boolean(s.telegram), onTurnOn: () => void turnRemote(true) }
    : undefined
  const tick = (on: boolean) => {
    setAllowType(on)
    keepAllowType(on)
  }

  return (
    <Section id={PHONE_SECTION} title="Use on your phone">
      <div className="grid gap-4">
        <StatusLine summary={summary} busy={busy} onTurnOn={() => void turnRemote(true)} onAllow={(id) => void setRole(id, 'controller')} />

        {showingCode ? (
          <CodeView remote={anywhere ? remote : undefined} address={addresses[0]} code={code} secondsLeft={secondsLeft} onNew={() => void showCode()} onCancel={() => void cancelCode()} busy={busy} />
        ) : (
          <div className="grid gap-2">
            <button
              onClick={() => void showCode()}
              disabled={busy}
              className="h-11 w-fit rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-panel hover:brightness-110 disabled:opacity-50"
            >
              {busy ? 'One moment…' : summary.device ? 'Connect another phone' : 'Connect a phone'}
            </button>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-fg-muted">
              <input
                type="checkbox"
                data-testid="allow-type"
                className="h-4 w-4 accent-[var(--color-accent)]"
                checked={allowType}
                onChange={(e) => tick(e.target.checked)}
              />
              {allowType ? 'It can control sessions: type, start agents, approve, stop' : 'View only: it can read, not type'}
            </label>
            {/* ADR-058: on only by a decision on the machine. This press is
              * that decision, so the line beside it says what it turns on. */}
            {remote && !anywhere && (
              <p data-testid="anywhere-consent" data-keep className="text-[12px] leading-snug text-fg-muted">
                This also turns on access from anywhere for {thisMachine()}, so the phone works on any network. It stays on until you turn it off.
              </p>
            )}
          </div>
        )}

        {error && <div className="text-[12px] text-danger">{error}</div>}

        <Devices devices={s.devices} now={now} busy={busy} onRemove={(ids) => void remove(ids)} onRole={(id, r) => void setRole(id, r)} onRepair={remote ? () => void showCode() : undefined} />

        <HowItWorks
          link={link}
          remote={remote}
          busy={busy}
          onRemoteOff={() => void turnRemote(false)}
          openAgain={openAgain}
          wifi={s.enabled && remote ? { url: s.url ?? '', onOff: () => void turnLANOff() } : undefined}
        />
      </div>
    </Section>
  )
}

const DOT: Record<PhoneSummary['tone'], string> = {
  none: 'bg-fg-faint',
  waiting: 'bg-warn animate-pulse',
  ok: 'bg-ok',
  idle: 'bg-accent',
  warn: 'bg-danger',
}

/** The one sentence at the top, and the one fix beside it when something is in the way. */
function StatusLine({ summary, busy, onTurnOn, onAllow }: { summary: PhoneSummary; busy: boolean; onTurnOn: () => void; onAllow: (id: string) => void }) {
  const d = summary.device
  return (
    <div data-testid="phone-status" data-tone={summary.tone} aria-live="polite" className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
      <span className="min-w-0 text-[16px] leading-snug text-fg">
        <span className={`mr-2 inline-block h-2.5 w-2.5 rounded-full align-[1px] ${DOT[summary.tone]}`} aria-hidden />
        {d && <b className="font-semibold">{d.name} </b>}
        {summary.text}
        {summary.meta && <span className="text-fg-muted"> · {summary.meta}</span>}
      </span>
      {summary.fix === 'turn-on' && (
        <button onClick={onTurnOn} disabled={busy} className={`${SMALL_BTN} border-accent text-accent hover:bg-accent/10`}>Turn it on</button>
      )}
      {summary.fix === 'allow' && d && (
        <button onClick={() => onAllow(d.id)} disabled={busy} className={`${SMALL_BTN} hover:border-accent hover:text-accent`}>Allow control</button>
      )}
    </div>
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
  const qr = useMemo(() => qrPath(encodeQR(link)), [link])
  const mm = Math.floor(secondsLeft / 60)
  const ss = String(secondsLeft % 60).padStart(2, '0')
  return (
    <div data-testid="pair-code" className="flex flex-wrap items-center gap-x-6 gap-y-3">
      {/* Black on white whatever the theme: a phone camera reads a dark code
        * on a light ground, and an inverted one fails on many of them. */}
      <svg
        viewBox={qr.viewBox}
        role="img"
        aria-label={`QR code that opens ${url} and pairs with code ${code}`}
        className="h-auto w-full max-w-[240px] shrink-0 rounded-md bg-white p-2"
        shapeRendering="crispEdges"
      >
        <path d={qr.d} fill="#000" />
      </svg>
      <div className="grid min-w-0 flex-1 basis-[220px] gap-2">
        <div className="text-[15px] leading-snug text-fg">
          Scan with your phone&apos;s camera. <span className="whitespace-nowrap tabular-nums">Works once, {mm}:{ss} left.</span>
        </div>
        {!viaRelay && (
          // A build without the relay: the address and the digits to type,
          // and that it works on this Wi-Fi only.
          <div data-testid="pair-reach" className="grid gap-1 text-[12px] text-fg-muted">
            <div>
              {address?.kind === 'lan'
                ? <>Only on this Wi-Fi: the phone has to be on the same network as {thisMachine()}.</>
                : <>Anywhere, as long as Tailscale is on, on both your phone and {thisMachine()}.</>}
              {' '}No camera? Open <span className="mono text-fg select-all break-all">{url}</span> on the phone and type
            </div>
            <div className="mono text-[40px] leading-none tracking-[0.18em] text-accent select-all" aria-label={`pairing code ${code.split('').join(' ')}`}>
              {code.slice(0, 3)}&thinsp;{code.slice(3)}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
          <button onClick={onNew} disabled={busy} className="text-accent hover:underline disabled:opacity-50">New code</button>
          <button onClick={onCancel} disabled={busy} className="text-fg-faint hover:text-danger disabled:opacity-50">Cancel</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Everything that is true and useful but not needed to connect a phone,
 * folded: what happens, why any network works, the home-screen link, the way
 * back for a phone already connected, and the off switch. Its lines are
 * `data-keep`/divs, so Settings' explanations switch does not hide them
 * inside a disclosure the reader opened on purpose.
 */
function HowItWorks({
  link,
  remote,
  busy,
  onRemoteOff,
  openAgain,
  wifi,
}: {
  /** The pairing link while a code is on screen through the relay. */
  link: string
  remote?: RemoteState
  busy: boolean
  onRemoteOff: () => void
  openAgain?: OpenAgainProps
  wifi?: { url: string; onOff: () => void }
}) {
  const [copied, setCopied] = useState(false)
  const [again, setAgain] = useState(false)
  const host = remote?.app ? phonePage(remote.app).host : 'the phone page'
  return (
    <details data-testid="phone-how" className="group border-t border-border pt-3 text-[13px]">
      <summary className="w-fit cursor-pointer select-none text-fg-muted hover:text-fg">How it works</summary>
      <div className="mt-3 grid gap-3 leading-snug text-fg-muted">
        <ol className="grid gap-1 text-fg">
          <li>1. Press <b className="font-medium">Connect a phone</b> and point the phone&apos;s camera at the code.</li>
          <li>2. Tap the link it shows. The phone opens {host} and connects by itself.</li>
          <li>3. Optional: keep it as an app. On an iPhone, Share → Add to Home Screen; on Android, ⋮ → Install app.</li>
        </ol>
        {remote && (
          <div data-testid="pair-reach">
            It works on Wi-Fi or mobile data, with nothing to install. What passes between the phone and {thisMachine()} is encrypted end to end;
            the relay in between forwards it without being able to read it. Only devices you connect here get in, and each can be removed with one click.
          </div>
        )}
        {link && (
          // A home-screen app on iOS keeps its own storage and the camera
          // opens links in Safari, so the link is offered to paste there.
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Added Caprock to the iPhone home screen before connecting? Copy the link and paste it there.</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }}
              className={`${SMALL_BTN} text-fg hover:border-accent`}
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
        )}
        {openAgain && (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Closed the page on a phone you already connected? Just open {host} on it again.</span>
              <button onClick={() => setAgain((v) => !v)} aria-expanded={again} className="font-medium text-accent hover:underline">
                {again ? 'Hide' : 'Show the address as a code'}
              </button>
            </div>
            {again && <OpenAgain {...openAgain} name="" busy={busy} />}
          </div>
        )}
        {remote?.enabled && <RelayState remote={remote} busy={busy} onOff={onRemoteOff} />}
        {/* The Wi-Fi listener is not offered here any more; when it is on
          * (`caprock up --lan`, or switched on before), say so and offer off. */}
        {wifi && (
          <div data-testid="wifi-listener" className="flex flex-wrap items-center gap-x-3">
            <span className="min-w-0">
              Also open on this Wi-Fi at <span className="mono break-all">{wifi.url}</span> — that link works only on the same network.
            </span>
            <button onClick={wifi.onOff} disabled={busy} className="text-fg-faint underline hover:text-danger disabled:opacity-50">Turn off</button>
          </div>
        )}
      </div>
    </details>
  )
}

/** Whether access from anywhere is up, and its off switch, inside How it works. */
function RelayState({ remote, busy, onOff }: { remote: RemoteState; busy: boolean; onOff: () => void }) {
  const st = remote.status === 'online'
    ? { dot: 'bg-ok', text: 'Access from anywhere is on.' }
    : remote.status === 'connecting'
      ? { dot: 'bg-warn animate-pulse', text: 'Access from anywhere is connecting…' }
      : { dot: 'bg-danger', text: remote.error ? `Access from anywhere is offline: ${remote.error}` : 'Access from anywhere is offline, retrying.' }
  return (
    <div data-testid="relay-state" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-fg">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden />
        <span className="min-w-0 break-words">{st.text}</span>
      </span>
      <button onClick={onOff} disabled={busy} className="text-[12px] text-fg-faint underline hover:text-danger disabled:opacity-50">
        Turn off
      </button>
    </div>
  )
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

/** "Can control" / "View only" / a computer's state: one word or two, plain. */
function capability(d: PairedDevice): { word: string; cls: string } {
  if (d.kind === 'machine') return d.pending ? { word: 'Computer · waiting for Allow', cls: 'text-warn' } : { word: 'Computer · controls this one', cls: 'text-accent' }
  return d.role === 'controller' ? { word: 'Can control', cls: 'text-accent' } : { word: 'View only', cls: 'text-fg-muted' }
}

/** How a device reaches the machine, for the row's tooltip. */
const VIA_LABEL: Record<NonNullable<PairedDevice['via']>, string> = {
  relay: 'from anywhere',
  tailscale: 'over Tailscale',
  lan: 'on the home Wi-Fi only',
}

function Devices({
  devices,
  now,
  busy,
  onRemove,
  onRole,
  onRepair,
}: {
  devices: PairedDevice[]
  now: number
  busy: boolean
  onRemove: (ids: string[]) => void
  onRole: (id: string, role: PairedDevice['role']) => void
  /** Shows the code a Wi-Fi-linked phone reconnects with; absent without the relay. */
  onRepair?: () => void
}) {
  const [showOld, setShowOld] = useState(false)
  const [confirmOld, setConfirmOld] = useState(false)
  if (devices.length === 0) return null
  const byRecent = [...devices].sort((a, b) => (b.last_seen || b.paired_at || 0) - (a.last_seen || a.paired_at || 0))
  const current = byRecent.filter((d) => !isOldDevice(d, now))
  const old = byRecent.filter((d) => isOldDevice(d, now))
  const row = (d: PairedDevice) => (
    <DeviceRow key={d.id} d={d} all={devices} now={now} busy={busy} onRemove={() => onRemove([d.id])} onRole={(r) => onRole(d.id, r)} onRepair={onRepair} />
  )
  const n = old.length
  return (
    <div className="grid gap-1.5">
      <div className="text-[12px] text-fg-muted">Your devices</div>
      {current.length > 0 && <ul className="grid gap-1.5">{current.map(row)}</ul>}
      {n > 0 && (
        <div data-testid="old-devices" className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <button onClick={() => setShowOld((v) => !v)} aria-expanded={showOld} className="flex items-center gap-1.5 text-fg-muted hover:text-fg">
              <span aria-hidden className={`text-[11px] transition-transform ${showOld ? 'rotate-90' : ''}`}>›</span>
              {n} old device{n === 1 ? '' : 's'} · not seen for 30+ days
            </button>
            {confirmOld ? (
              <span data-testid="old-confirm" className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-fg">Remove {n === 1 ? 'it' : `all ${n}`}? {n === 1 ? 'It stops' : 'They stop'} working at once.</span>
                <button onClick={() => { setConfirmOld(false); onRemove(old.map((d) => d.id)) }} disabled={busy} className={`${SMALL_BTN} border-danger text-danger hover:bg-danger/10`}>
                  Remove {n}
                </button>
                <button onClick={() => setConfirmOld(false)} className="text-[12px] text-fg-faint hover:text-fg">Keep</button>
              </span>
            ) : (
              <button onClick={() => { setConfirmOld(true); setShowOld(true) }} disabled={busy} className="text-[12px] text-fg-faint underline hover:text-danger disabled:opacity-50">
                Remove all
              </button>
            )}
          </div>
          {showOld && <ul className="grid gap-1.5">{old.map(row)}</ul>}
        </div>
      )}
    </div>
  )
}

function DeviceRow({
  d,
  all,
  now,
  busy,
  onRemove,
  onRole,
  onRepair,
}: {
  d: PairedDevice
  all: PairedDevice[]
  now: number
  busy: boolean
  onRemove: () => void
  onRole: (role: PairedDevice['role']) => void
  onRepair?: () => void
}) {
  const cap = capability(d)
  const repair = Boolean(onRepair) && needsRepair(d, all)
  // Two phones of one model share a name: only then does the row show the
  // start of its id, enough to tell which one to take control away from.
  const twin = all.some((o) => o.id !== d.id && o.name === d.name)
  const detail = [
    d.paired_at ? `Connected ${fmtWhen(d.paired_at, now)}` : '',
    d.via ? `reaches this computer ${VIA_LABEL[d.via]}` : '',
    d.app ? 'app installed' : '',
    `device ${d.id}`,
  ].filter(Boolean).join(' · ')
  return (
    <li data-testid="device-row" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2">
      <span className="min-w-0 flex-1 basis-44">
        <span className="flex min-w-0 items-baseline gap-1.5" title={detail}>
          <span className="min-w-0 truncate text-[14px] text-fg">{d.name}</span>
          {twin && <span className="mono shrink-0 text-[11px] text-fg-faint">#{d.id.slice(0, 4)}</span>}
        </span>
        <span className="block text-[12px] text-fg-faint">
          <span data-testid="device-can" className={cap.cls}>{cap.word}</span>
          {' · '}
          {d.last_seen ? `seen ${seenAgo(d.last_seen, now)}` : 'not opened yet'}
        </span>
        {/* The owner's phone, 2026-10-14: paired on the Wi-Fi address, dead
          * on mobile data, and nothing said why. One quiet line. */}
        {repair && (
          <span data-testid="device-repair" className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-warn">
            <span>Works on your home Wi-Fi only.</span>
            <button onClick={onRepair} disabled={busy} className="font-medium text-accent hover:underline disabled:opacity-50">Reconnect</button>
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {d.kind === 'machine' ? null : d.role === 'controller' ? (
          <button
            onClick={() => onRole('viewer')}
            disabled={busy}
            title="It goes back to view only on its next request, and an open terminal stops taking keys"
            className={`${SMALL_BTN} hover:border-danger hover:text-danger`}
          >
            Take control away
          </button>
        ) : (
          <button
            onClick={() => onRole('controller')}
            disabled={busy}
            title="It can start sessions in your projects, type into them, answer approvals and stop them. Settings and pairing stay on this computer."
            className={`${SMALL_BTN} hover:border-accent hover:text-accent`}
          >
            Allow control
          </button>
        )}
        <button onClick={onRemove} disabled={busy} title="It stops working on its next request" className={`${SMALL_BTN} hover:border-danger hover:text-danger`}>
          Remove
        </button>
      </span>
    </li>
  )
}

/**
 * "Closed the page on a phone you already connected?", inside How it works: the plain address, a QR
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
