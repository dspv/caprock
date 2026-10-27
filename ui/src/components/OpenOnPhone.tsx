/**
 * *Open on my phone* on phone mode's device bar (ADR-087): a local dev
 * server's page on a real phone on the same Wi-Fi. The click asks the daemon
 * to share the tab's origin behind a link (lib/devshare.ts) and opens a sheet
 * with its QR; while it is shared the button says so with a live dot, and
 * the sheet has *Stop sharing*.
 *
 * The sheet is a `role="dialog"`, so the page's native window hides while it
 * is open (lib/browsertab overlayOpen), as under any menu.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { encodeQR, qrPath } from '@/lib/qr'
import { useDevShare } from '@/lib/devshare'
import type { DevShare } from '@/lib/api'
import { CopyIcon, PhoneIcon } from './AppIcons'

export const OPEN_LABEL = 'Open on my phone'
export const ON_LABEL = 'On my phone'
/** The sheet's width, px. */
const SHEET_W = 380

export function OpenOnPhone({ url }: { url: string }) {
  const { shareable, share, idleMin, start, stop } = useDevShare(url)
  const [open, setOpen] = useState(false)
  // The sheet opens toward whichever side has room for it.
  const [toLeft, setToLeft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (!shareable) return null

  const click = async () => {
    if (open) { setOpen(false); return }
    const r = ref.current?.getBoundingClientRect()
    setToLeft(!!r && r.left + SHEET_W + 16 > window.innerWidth)
    setOpen(true)
    setError('')
    if (share) return
    setBusy(true)
    try { await start() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const onStop = async () => {
    setBusy(true)
    try { await stop(); setOpen(false) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const on = !!share
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-pressed={on}
        data-open-on-phone
        onClick={() => { void click() }}
        title={on ? `Shared on this Wi-Fi at ${share.address}: show the QR, or stop sharing` : 'Open this page on your phone, on the same Wi-Fi: a QR code to scan'}
        className={`flex h-[24px] shrink-0 items-center gap-1 rounded-[6px] border px-2 text-[12px] ${on ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-fg' : 'border-[var(--app-hairline)] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
      >
        {on ? <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-ok" data-share-dot /> : <PhoneIcon size={13} />}
        {on ? ON_LABEL : OPEN_LABEL}
      </button>
      {open && (
        <div role="dialog" aria-label="Open on your phone" data-open-on-phone-sheet className={`absolute ${toLeft ? 'right-0' : 'left-0'} top-[28px] z-50 w-[min(380px,calc(100vw-32px))] rounded-[8px] border border-[var(--app-hairline)] bg-panel p-3 text-[12.5px] leading-snug text-fg-muted shadow-lg`}>
          <b className="mb-2 block text-[12px] font-semibold uppercase tracking-[.06em] text-fg-faint">Open on your phone</b>
          {share ? <Shared share={share} idleMin={idleMin} busy={busy} onStop={() => { void onStop() }} /> : busy ? (
            <p role="status">Sharing this page on your Wi-Fi…</p>
          ) : null}
          {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}

function Shared({ share, idleMin, busy, onStop }: { share: DevShare; idleMin: number; busy: boolean; onStop: () => void }) {
  const qr = useMemo(() => qrPath(encodeQR(share.url)), [share.url])
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(share.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  return (
    <div className="grid gap-2">
      <div className="flex items-start gap-3">
        {/* Black on white whatever the theme, as the pairing QR. */}
        <svg viewBox={qr.viewBox} role="img" aria-label={`QR code that opens this page on your phone at ${share.address}`} data-qr-text={share.url} className="h-auto w-[132px] shrink-0 rounded-md bg-white p-1.5" shapeRendering="crispEdges">
          <path d={qr.d} fill="#000" />
        </svg>
        <div className="grid min-w-0 gap-1.5">
          <p className="text-[13px] text-fg">Scan with your phone’s camera.</p>
          <p>The phone must be on <b className="font-medium text-fg">the same Wi-Fi</b> as this computer.</p>
          <p className="flex items-center gap-1">
            <span className="mono truncate text-fg" data-share-address>{share.address}</span>
            <button type="button" onClick={copy} title="Copy the link, to send it to yourself" aria-label="Copy the link" className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"><CopyIcon size={12} /></button>
            {copied && <span className="text-[11.5px] text-ok">Copied</span>}
          </p>
          {share.tunnelled && <p>This is a Tailscale address: the phone needs Tailscale on.</p>}
        </div>
      </div>
      <p>Only a phone with this link gets in. Sharing stops after {idleMin} minutes unused, when Caprock quits, or now:</p>
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={onStop} data-stop-sharing className="rounded-[6px] border border-[var(--app-hairline)] px-2 py-0.5 text-[12px] text-fg hover:border-danger hover:text-danger">Stop sharing</button>
      </div>
      <details className="text-[11.5px]">
        <summary className="cursor-pointer text-fg-muted hover:text-fg">It does not load on the phone?</summary>
        <ul className="m-0 mt-1 list-disc pl-4">
          <li>A guest network, or the router’s <i>client isolation</i> (<i>AP isolation</i>), keeps devices apart: join the main network.</li>
          <li>A VPN on the phone or on this computer can route around the Wi-Fi: turn it off for now.</li>
          <li>Only this page’s server is shared. An API on another local port that the page calls is not reachable from the phone.</li>
        </ul>
      </details>
    </div>
  )
}
