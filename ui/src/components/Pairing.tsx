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
 * listening stops when Caprock restarts; the paired list is kept.
 *
 * The QR code is drawn here, in the browser, by ui/src/lib/qr.ts: the link
 * carries a code that lets a device in, and it is not sent anywhere to be
 * rendered.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type PairedDevice, type PairState } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Section } from '@/components/SettingsParts'
import { fmtAgo, fmtWhen } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { encodeQR, qrPath } from '@/lib/qr'

/** The link a phone's camera opens: the address, with the code to redeem. */
export function pairLink(url: string, code: string): string {
  return `${url.replace(/\/+$/, '')}/#/pair?code=${encodeURIComponent(code)}`
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

  async function showCode() {
    setBusy(true)
    setError('')
    setJoined(null)
    try {
      // One press does both: the listener has to be up before a phone can
      // reach the page the code opens.
      if (!s?.enabled) await api.setLAN(true)
      const r = await api.pairCode()
      setCodeUntil(Date.now() + r.expires_in_sec * 1000)
      state.refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function turn(on: boolean) {
    setBusy(true)
    setError('')
    setJoined(null)
    try {
      await api.setLAN(on)
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
      <Section title="Open Caprock on your phone">
        <div className="text-[12px] text-fg-faint">reading…</div>
      </Section>
    )
  }

  const status = phoneStatus(s)
  const secondsLeft = codeUntil ? Math.max(0, Math.ceil((codeUntil - now) / 1000)) : 0
  const showingCode = Boolean(code && s.url && secondsLeft > 0)
  const machine = thisMachine()

  return (
    <Section title="Open Caprock on your phone" aside={<StatusPill status={status} />}>
      <div className="grid gap-4">
        {showingCode ? (
          <CodeView url={s.url!} code={code} secondsLeft={secondsLeft} onNew={showCode} onCancel={cancelCode} busy={busy} />
        ) : (
          <>
            <ol className="grid gap-2">
              <Step n={1}>
                {s.enabled && s.tunnelled
                  ? <>Tailscale is on, on your phone and {machine}.</>
                  : <>Your phone and {machine} are on the same Wi-Fi.</>}
              </Step>
              <Step n={2}>
                Press <span className="text-fg font-medium">Show a code</span> and point your phone&apos;s camera at it.
              </Step>
              <Step n={3}>Your phone appears below. Remove it here any time.</Step>
            </ol>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                onClick={showCode}
                disabled={busy}
                className="rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-fg disabled:opacity-50"
              >
                {busy ? 'One moment…' : s.devices.length > 0 ? 'Show a code for another phone' : 'Show a code'}
              </button>
              {!s.enabled && s.devices.length > 0 && (
                <button onClick={() => turn(true)} disabled={busy} className="text-[12px] text-accent hover:underline disabled:opacity-50">
                  Turn on for paired phones only
                </button>
              )}
            </div>
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

        <Devices devices={s.devices} now={now} onRemove={remove} onRole={setRole} />

        <div className="grid gap-1 border-t border-border pt-3 text-[12px] leading-relaxed text-fg-muted">
          <p>
            Only phones you pair get in, and they can look but not change anything — unless you let one control sessions below. It switches off when Caprock restarts.
          </p>
          {s.enabled && s.tunnelled ? (
            <p>This {machine.replace('this ', '')} is on Tailscale, so it works from anywhere your phone has Tailscale too — even on mobile data.</p>
          ) : (
            <p>
              Not on the same Wi-Fi? Install{' '}
              <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="text-accent">Tailscale</a>{' '}
              on both — then it works from anywhere.
            </p>
          )}
          {s.enabled && !showingCode && (
            <div className="flex flex-wrap items-center gap-x-3 pt-1">
              {s.url && <span className="text-fg-faint">Listening at <span className="mono break-all">{s.url}</span></span>}
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

function StatusPill({ status }: { status: PhoneStatus }) {
  const dot = status.tone === 'ok' ? 'bg-ok' : status.tone === 'waiting' ? 'bg-warn animate-pulse' : status.tone === 'on' ? 'bg-accent' : 'bg-fg-faint'
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-fg" aria-live="polite">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {status.label}
    </span>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-2.5">
      <span className="num inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-strong text-[11px] text-fg-muted">
        {n}
      </span>
      <span className="text-fg">{children}</span>
    </li>
  )
}

function CodeView({
  url,
  code,
  secondsLeft,
  onNew,
  onCancel,
  busy,
}: {
  url: string
  code: string
  secondsLeft: number
  onNew: () => void
  onCancel: () => void
  busy: boolean
}) {
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
        className="h-auto w-full max-w-[240px] shrink-0 rounded-md bg-white"
        shapeRendering="crispEdges"
      >
        <path d={qr.d} fill="#000" />
      </svg>
      <div className="grid min-w-0 flex-1 basis-[220px] gap-3">
        <div>
          <div className="text-[15px] text-fg">Point your phone&apos;s camera at the code.</div>
          <div className="mt-0.5 text-[12px] text-fg-muted">Tap the link it shows. The phone pairs by itself.</div>
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
