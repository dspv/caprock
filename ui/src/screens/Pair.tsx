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
 */
import { useState } from 'react'
import { api, errText, setDeviceToken } from '@/lib/api'

export function PairScreen() {
  const [code, setCode] = useState('')
  const [name, setName] = useState(defaultDeviceName())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const ready = code.replace(/\D/g, '').length === 6

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await api.pairRedeem(code.replace(/\D/g, ''), name.trim())
      setDeviceToken(r.token)
      // A full reload rather than a route change: every screen fetched and
      // failed while this device had no token, and the simplest way to have
      // them all ask again is to start the page over.
      window.location.reload()
    } catch (err) {
      setError(errText(err))
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4">
      <h1 className="text-[18px] text-fg">Pair this device</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
        On the machine running Caprock, open <span className="text-fg">status</span> and
        press <span className="text-fg">Show a code</span>. Type the six digits here.
      </p>

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

/** A first guess at the device's name, so the field is not empty on a phone. */
function defaultDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPad/.test(ua)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  return ''
}
