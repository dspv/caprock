/**
 * The update card in the corner (owner, 2026-10-07: "like Orca — a popup at
 * the bottom right that a new version is out, and it updates without losing
 * anything").
 *
 * The status strip's line (AppUpdateNotice) stays the place to come back to;
 * this card is the announcement. It appears once per version, in the desktop
 * app only and only where the app can replace itself (ADR-042): **Update and
 * restart** downloads with progress, checks the signature, installs and
 * relaunches with every session, tab, split and scroll position back where
 * it was. **Later** hides the card for that version; the strip keeps the
 * offer. It never takes focus from the terminal.
 */
import { useState } from 'react'
import { appUpdate, offerFor, useAppUpdate } from '@/lib/appupdate'
import { useUpdateStatus } from './AppUpdateNotice'

/** The version whose card was put away; the strip's offer is separate. */
export const TOAST_KEY = 'caprock.update.toastSeen'

function readSeen(): string {
  try { return localStorage.getItem(TOAST_KEY) ?? '' } catch { return '' }
}

export function AppUpdateToast() {
  const st = useUpdateStatus()
  const info = useAppUpdate()
  const [seen, setSeen] = useState(readSeen)
  const offer = offerFor(info, st, '')

  const next = offer.kind === 'install' || offer.kind === 'progress' || offer.kind === 'installing' ? offer.next : ''
  if (!next || (offer.kind === 'install' && seen === next)) return null

  const later = () => {
    try { localStorage.setItem(TOAST_KEY, next) } catch { /* hidden for this page only */ }
    setSeen(next)
  }

  return (
    <div
      role="status"
      aria-label="Caprock update"
      className="app-fade-in pointer-events-auto fixed bottom-[34px] right-3 z-40 grid w-[320px] max-w-[calc(100vw-24px)] gap-2 rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel p-3 text-[12.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
    >
      <p className="font-medium">Caprock {next} is available</p>
      {offer.kind === 'install' && (
        <>
          <p className="text-fg-muted">Restarting keeps every session running, and brings back your tabs, splits and scroll where they were.</p>
          <div className="flex items-center gap-2">
            <a className="link text-[12px]" href={st?.url ?? 'https://github.com/dspv/caprock/releases/latest'} target="_blank" rel="noreferrer">What’s new</a>
            <button type="button" onClick={later} className="ml-auto rounded-[6px] px-2 py-1 text-[12px] text-fg-muted hover:text-fg">Later</button>
            <button
              type="button"
              onClick={() => void appUpdate.install()}
              className="rounded-[6px] bg-accent px-2.5 py-1 text-[12px] font-medium text-panel hover:brightness-110"
            >
              Update and restart
            </button>
          </div>
        </>
      )}
      {offer.kind === 'progress' && (
        <div className="grid gap-1">
          <span className="text-fg-muted">Downloading{offer.pct !== null ? ` · ${offer.pct}%` : '…'} — keep working.</span>
          <span className="relative h-[4px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-200" style={{ width: `${offer.pct ?? 8}%` }} />
          </span>
        </div>
      )}
      {offer.kind === 'installing' && <p className="text-fg-muted">Installing — Caprock restarts in a moment.</p>}
    </div>
  )
}
