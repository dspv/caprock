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
 * offer. **Always update automatically** switches Settings → Updates to
 * Update automatically (AppAutoUpdate), and from then on this card does not
 * ask. It never takes focus from the terminal.
 *
 * The chevron in its corner, or Esc while focus is in it, folds the card
 * into the status strip for that version (owner 2026-10-22, after Orca;
 * lib/updatecard): the strip's update line shows *↓ 0.149.0 · 22%* with a
 * thin bar, then *0.149.0 ready · Restart*, or the failure in the warn
 * colour, and a click on it unfolds the card. The card never unfolds by
 * itself; a newer version starts unfolded.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { appUpdate, offerFor, useAppUpdate, v } from '@/lib/appupdate'
import { openExternal } from '@/lib/nudges'
import { NotesDialog } from './Shell'
import { useUpdateStatus } from './AppUpdateNotice'
import { usePlan } from './PlanPicker'
import { extProps } from '@/lib/externalLinks'
import { updateCard, useUpdateCard } from '@/lib/updatecard'

/** The fold control's tooltip and accessible name. */
export const FOLD_LABEL = 'Hide; progress stays in the status bar'

/** The version whose card was put away; the strip's offer is separate. */
export const TOAST_KEY = 'caprock.update.toastSeen'

function readSeen(): string {
  try { return localStorage.getItem(TOAST_KEY) ?? '' } catch { return '' }
}

export function AppUpdateToast() {
  const st = useUpdateStatus()
  const info = useAppUpdate()
  const [plan, savePlan] = usePlan()
  const [seen, setSeen] = useState(readSeen)
  const [notes, setNotes] = useState(false)
  const card = useUpdateCard()
  const offer = offerFor(info, st, '')

  // The version on its way in, which a failure (no version of its own) is put to.
  const inFlight = info?.supported && (info.phase === 'downloading' || info.phase === 'ready' || info.phase === 'installing') ? v(info.next) : ''
  useEffect(() => { if (inFlight) updateCard.note(inFlight) }, [inFlight])

  // A failure shows here only when the card was opened on it from the strip.
  const failed = offer.kind === 'failed' && card.error && card.lastNext ? offer.error : ''
  const next = offer.kind === 'install' || offer.kind === 'progress' || offer.kind === 'installing' ? offer.next : failed ? card.lastNext : ''
  const current = info?.version ? v(info.version).replace(/^v/, '') : ''
  if (!next || (offer.kind === 'install' && seen === next)) return null
  // Folded into the strip for this version: AppUpdateNotice shows it there.
  if (card.folded === next) return null
  // Update automatically: AppAutoUpdate downloads in the background and
  // gives its own notice before the restart; this card does not ask.
  if (plan?.app_update === 'auto') return null

  const later = () => {
    try { localStorage.setItem(TOAST_KEY, next) } catch { /* hidden for this page only */ }
    setSeen(next)
  }

  const fold = () => updateCard.fold(next)

  return (
    <div
      role="status"
      aria-label="Caprock update"
      data-update-toast
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); fold() } }}
      className="app-fade-in pointer-events-auto fixed bottom-[34px] right-3 z-40 grid w-[340px] max-w-[calc(100vw-24px)] gap-2.5 rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel p-4 text-[13.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
    >
      {/* From what to what, large (owner, 2026-10-11: "short — an arrow from
        * one version to the other, so I see I'm asked to go from this to that"). */}
      <button
        type="button"
        data-update-fold
        onClick={fold}
        aria-label={FOLD_LABEL}
        title={FOLD_LABEL}
        className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-[6px] text-fg-faint hover:bg-[var(--app-hairline)] hover:text-fg"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      <p className="flex flex-wrap items-baseline gap-x-2 pr-6 text-[16px] font-semibold" data-update-from-to>
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
              <button type="button" className="link text-[13px]" {...extProps()} onClick={() => openExternal(st?.url ?? 'https://caprock.dev/changelog')}>What’s new</button>
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
          {/* The standing answer, one click (owner, 2026-10-15): flips
            * Settings → Updates to Update automatically, which needs the
            * release check on. It does not restart now. */}
          <button
            type="button"
            data-always-auto
            onClick={() => savePlan({ app_update: 'auto', update_checks: true })}
            className="justify-self-start text-[12px] text-fg-muted hover:text-accent"
            title="From now on, download updates in the background and restart into them when no agent is busy and you are away"
          >
            Always update automatically
          </button>
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
      {failed && (
        <>
          <p><span className="font-medium text-warn">The update did not install.</span>{current && <> Caprock {current} keeps running.</>}</p>
          <p className="break-words text-[12.5px] text-fg-muted" data-update-error>{failed}</p>
          <div className="flex items-center gap-2">
            <button type="button" className="link text-[13px]" {...extProps()} onClick={() => openExternal(st?.url ?? 'https://github.com/dspv/caprock/releases/latest')}>Release page</button>
            <button type="button" onClick={() => updateCard.closeError()} className="ml-auto rounded-[7px] px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg">Close</button>
            <button
              type="button"
              onClick={() => void appUpdate.install()}
              className="rounded-[7px] bg-accent px-3 py-1.5 text-[13px] font-semibold text-panel hover:brightness-110"
            >
              Try again
            </button>
          </div>
        </>
      )}
      {/* Portalled: the card animates in, and a transformed parent would trap a fixed dialog. */}
      {notes && st && createPortal(<NotesDialog u={st} onClose={() => setNotes(false)} />, document.body)}
    </div>
  )
}
