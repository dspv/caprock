/**
 * The answer to a check for updates the user asked for, big enough to be
 * seen (lib/checkbanner): *You're up to date — Caprock X is the latest*,
 * checked just now, with Close; it goes by itself after 8 seconds unless
 * the pointer is on it. A failed check stays, with the error and Retry.
 * The background check (every 15 minutes, and on focus) never shows it.
 *
 * The browser dashboard's only: the desktop app answers in its status strip,
 * beside the version (AppUpdateNotice; owner 2026-10-16, translated: "I
 * expect the update result at the bottom right, near the version").
 */
import { useEffect, useRef, useState } from 'react'
import { inBackground, useAppUpdate } from '@/lib/appupdate'
import { answerFor, checkByHand, checkingByHand, reportCheck, useCheckResult } from '@/lib/checkbanner'

/** How long *You're up to date* stays without the pointer on it. */
export const UP_TO_DATE_BANNER_MS = 8000

export function UpdateCheckBanner() {
  const result = useCheckResult()
  const info = useAppUpdate()
  const [hover, setHover] = useState(false)
  const [retrying, setRetrying] = useState(false)

  // A check from the app or tray menu: the shell's phase goes from checking
  // to its answer. Not while a check by hand or a background download runs.
  const prev = useRef(info?.phase)
  useEffect(() => {
    const was = prev.current
    prev.current = info?.phase
    if (!info || was !== 'checking' || checkingByHand() || inBackground()) return
    if (info.phase === 'up_to_date' || info.phase === 'failed') reportCheck(answerFor(new Error('unused'), info))
  }, [info])

  useEffect(() => {
    if (result?.kind !== 'up_to_date' || hover) return
    const t = window.setTimeout(() => reportCheck(null), UP_TO_DATE_BANNER_MS)
    return () => window.clearTimeout(t)
  }, [result, hover])

  if (!result || result.kind === 'checking') return null
  const close = () => reportCheck(null)
  const retry = async () => {
    setRetrying(true)
    try { await checkByHand() } finally { setRetrying(false) }
  }
  const ok = result.kind === 'up_to_date'
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-50 flex justify-center px-4">
      <div
        role={ok ? 'status' : 'alert'}
        aria-label={ok ? 'You’re up to date' : 'Could not check for updates'}
        data-check-banner={result.kind}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={`app-fade-in pointer-events-auto flex w-[520px] max-w-full items-center gap-4 rounded-[14px] border bg-panel px-5 py-4 text-fg shadow-[0_20px_50px_-20px_rgba(0,0,0,0.55)] ${ok ? 'border-ok/50' : 'border-warn/60'}`}
      >
        <span aria-hidden className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-[20px] font-semibold ${ok ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`}>
          {ok ? '✓' : '!'}
        </span>
        <div className="min-w-0 flex-1">
          {ok ? (
            <>
              <p className="text-[17px] font-semibold">You’re up to date</p>
              <p className="text-[13px] text-fg-muted">
                Caprock <span className="mono text-fg">{result.version.replace(/^v/, '')}</span> is the latest · checked just now
              </p>
            </>
          ) : (
            <>
              <p className="text-[17px] font-semibold">Could not check for updates</p>
              <p className="break-words text-[13px] text-fg-muted">{result.error}</p>
            </>
          )}
        </div>
        {!ok && (
          <button type="button" onClick={() => void retry()} disabled={retrying}
            className="shrink-0 rounded-[8px] border border-accent/50 bg-accent/10 px-3 py-1.5 text-[13px] text-accent hover:bg-accent/20 disabled:opacity-50">
            {retrying ? 'Checking…' : 'Retry'}
          </button>
        )}
        <button type="button" onClick={close}
          className="shrink-0 rounded-[8px] border border-[var(--app-hairline-strong)] px-3 py-1.5 text-[13px] text-fg-muted hover:text-fg">
          Close
        </button>
      </div>
    </div>
  )
}
