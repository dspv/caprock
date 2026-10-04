/**
 * What a tablet sees before it is let in.
 *
 * Reached by opening the machine's address on another device. The daemon
 * serves the dashboard's files to anybody on the network — they carry no
 * figures — and refuses every request for data with 401 until this screen has
 * traded a code for a token.
 *
 * Deliberately the whole screen rather than a dialog over a dashboard full of
 * em-dashes. Nothing behind it works yet, and a page of empty panels with a
 * prompt on top invites someone to dismiss the prompt and then wonder why the
 * product is broken.
 *
 * One field, big enough to hit with a thumb, `inputMode="numeric"` so a phone
 * opens the number pad rather than a keyboard whose letters cannot be typed
 * here anyway.
 *
 * **Scanned, it pairs by itself.** The QR code on the machine opens
 * `#/pair?code=NNNNNN`; the code is read from the link, sent once, and wiped
 * from the address bar, so the phone's history keeps the dashboard and not a
 * spent code. A failure leaves the code in the field and says why.
 *
 * **From the home screen it pairs again, by typing.** iOS gives a home-screen
 * web app its own storage, so the token Safari holds is not there, and the
 * camera opens a scanned link in Safari rather than in the app. The screen
 * says so instead of offering a scan that would pair the wrong one, and the
 * name it suggests ends in "home screen", so the machine's list tells the two
 * apart.
 */
import { useEffect, useRef, useState } from 'react'
import { api, errText, setDeviceToken } from '@/lib/api'

/** The six digits a scanned link carries, or '' — `#/pair?code=123456`. */
export function codeFromHash(hash: string): string {
  const [path, query] = hash.replace(/^#\/?/, '').split('?')
  if (path !== 'pair') return ''
  const c = (new URLSearchParams(query ?? '').get('code') ?? '').replace(/\D/g, '')
  return c.length === 6 ? c : ''
}

/** Whether this page runs as a home-screen app rather than in a browser tab. */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
}

export function PairScreen() {
  const scanned = useRef(codeFromHash(window.location.hash))
  const homeScreen = useRef(isStandalone()).current
  const [code, setCode] = useState(scanned.current)
  const [name, setName] = useState(defaultDeviceName(navigator.userAgent, homeScreen))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const ready = code.replace(/\D/g, '').length === 6

  async function pair(digits: string, label: string) {
    setBusy(true)
    setError('')
    try {
      const r = await api.pairRedeem(digits, label)
      setDeviceToken(r.token)
      // A full reload rather than a route change: every screen fetched and
      // failed while this device had no token, and the simplest way to have
      // them all ask again is to start the page over. Onto the dashboard,
      // not back onto the pairing link.
      history.replaceState(null, '', window.location.pathname + '#/')
      window.location.reload()
    } catch (err) {
      setError(errText(err))
      setBusy(false)
    }
  }

  // Once, on arrival from a scanned code. The name is the browser's guess;
  // it can be renamed on the machine by removing and pairing again, and asking
  // for it first would put a form between the camera and the dashboard.
  useEffect(() => {
    const c = scanned.current
    if (!c) return
    scanned.current = ''
    history.replaceState(null, '', window.location.pathname + '#/')
    void pair(c, defaultDeviceName() || 'a phone')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready || busy) return
    await pair(code.replace(/\D/g, ''), name.trim())
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 pt-[env(safe-area-inset-top)]">
      <h1 className="text-[18px] text-fg">{busy ? 'Pairing…' : 'Pair this device'}</h1>
      {homeScreen ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
          Opened from the home screen, Caprock keeps its own sign-in, apart from the
          browser&apos;s, so it pairs once more here. On the computer, open{' '}
          <span className="text-fg">Settings</span>, press <span className="text-fg">Show a code</span>{' '}
          and type the six digits. Don&apos;t scan it: the camera opens the browser, not this app.
        </p>
      ) : (
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
          On the computer running Caprock, open <span className="text-fg">Settings</span> and
          press <span className="text-fg">Show a code</span>. Scan it with the camera, or type the
          six digits here.
        </p>
      )}

      <form onSubmit={submit} className="mt-5 grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={7}
            autoFocus
            className="mono w-full rounded-md border border-border-strong bg-panel px-3 py-3 text-center text-[26px] tracking-[0.3em] text-fg outline-none focus:border-accent"
          />
        </label>

        <label className="grid gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">
            what to call this device
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="a device"
            className="w-full rounded-md border border-border-strong bg-panel px-3 py-2.5 text-[15px] text-fg outline-none focus:border-accent"
          />
          <span className="text-[11px] text-fg-faint">
            Shown in the list on the machine, so you know which one to revoke later.
          </span>
        </label>

        <button
          type="submit"
          disabled={!ready || busy}
          className="rounded-md bg-accent px-4 py-3 text-[15px] font-medium text-accent-fg disabled:opacity-40"
        >
          {busy ? 'pairing…' : 'Pair'}
        </button>

        {error && <div className="text-[13px] text-danger">{error}</div>}
      </form>

      <p className="mt-6 text-[12px] leading-relaxed text-fg-faint">
        A code works once and expires after five minutes. Nothing leaves your network:
        this device is talking to your own machine, not to us.
      </p>
    </div>
  )
}

/** A first guess at the device's name, so the field is not empty on a phone:
 *  the kind of device and the browser, which is what tells two of them apart
 *  in the machine's list ("iPhone · Safari", "iPhone · Chrome"). A home-screen
 *  app is "iPhone · home screen": it pairs separately from Safari on the same
 *  phone, and the list should say which entry is which. */
export function defaultDeviceName(ua: string = navigator.userAgent, homeScreen = false): string {
  const kind = deviceKind(ua)
  const browser = homeScreen ? 'home screen' : browserOf(ua)
  return kind && browser ? `${kind} · ${browser}` : kind
}

function deviceKind(ua: string): string {
  if (/iPad/.test(ua)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  return ''
}

// Order matters: Chrome on iOS says Safari too, Edge says Chrome.
function browserOf(ua: string): string {
  if (/EdgiOS|EdgA|Edg\//.test(ua)) return 'Edge'
  if (/FxiOS|Firefox\//.test(ua)) return 'Firefox'
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return ''
}
