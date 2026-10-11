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
import { createPortal } from 'react-dom'
import { appUpdate, offerFor, useAppUpdate, v } from '@/lib/appupdate'
import { openExternal } from '@/lib/nudges'
import { NotesDialog } from './Shell'
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
  const [notes, setNotes] = useState(false)
  const offer = offerFor(info, st, '')

  const next = offer.kind === 'install' || offer.kind === 'progress' || offer.kind === 'installing' ? offer.next : ''
  const current = info?.version ? v(info.version).replace(/^v/, '') : ''
  if (!next || (offer.kind === 'install' && seen === next)) return null

  const later = () => {
    try { localStorage.setItem(TOAST_KEY, next) } catch { /* hidden for this page only */ }
    setSeen(next)
  }

  return (
    <div
      role="status"
      aria-label="Caprock update"
      className="app-fade-in pointer-events-auto fixed bottom-[34px] right-3 z-40 grid w-[340px] max-w-[calc(100vw-24px)] gap-2.5 rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel p-4 text-[13.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
    >
      {/* From what to what, large (owner, 2026-10-11: "short — an arrow from
        * one version to the other, so I see I'm asked to go from this to that"). */}
      <p className="flex flex-wrap items-baseline gap-x-2 text-[16px] font-semibold" data-update-from-to>
        <span>Update</span>
        {current && <span className="mono text-fg-muted">{current}</span>}
        {current && <span aria-label="to" className="text-fg-faint">→</span>}
        <span className="mono text-accent">{v(next).replace(/^v/, '')}</span>
      </p>
      {offer.kind === 'install' && (
        <>
          <p className="text-fg-muted">Sessions and tabs stay as they are.</p>
          <div className="flex items-center gap-2">
            {/* In the app, not a GitHub tab: the notes come with the release
              * check that found the update, and a link out of a webview did
              * not always open. */}
            {st?.notes && st.notes_for && v(st.notes_for) === next ? (
              <button type="button" className="link text-[13px]" onClick={() => setNotes(true)}>What’s new</button>
            ) : (
              <button type="button" className="link text-[13px]" onClick={() => openExternal(st?.url ?? 'https://caprock.dev/changelog')}>What’s new</button>
            )}
            <button type="button" onClick={later} className="ml-auto rounded-[7px] px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg">Later</button>
            <button
              type="button"
              onClick={() => void appUpdate.install()}
              className="rounded-[7px] bg-accent px-3 py-1.5 text-[13px] font-semibold text-panel hover:brightness-110"
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
      {/* Portalled: the card animates in, and a transformed parent would trap a fixed dialog. */}
      {notes && st && createPortal(<NotesDialog u={st} onClose={() => setNotes(false)} />, document.body)}
    </div>
  )
}
