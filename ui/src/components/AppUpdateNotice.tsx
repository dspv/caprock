/**
 * The app's update notice (F12, F20): a quiet line in the status strip.
 *
 * In the desktop app, when this install can replace itself, a newer release
 * is one click — **Update to vX.Y.Z — Restart** downloads it with progress,
 * verifies its signature, installs it and relaunches; sessions carry on in
 * their pty-hosts while the app and its daemon restart (ADR-042). Where it
 * cannot (a browser, a .deb or .rpm install, a development build) the line
 * opens to the exact command for how Caprock was installed, as before.
 * Either way **Not now** hides that version, with the same key as the
 * dashboard's banner (UpdateBanner).
 *
 * Reading `/v1/update` never touches the network; the daemon's own check
 * (at most every 6 h, conditional, only while Settings → Privacy allows it)
 * is what finds a release. The app fetches `latest.json` only on a click.
 */
import { useEffect, useRef, useState } from 'react'
import { api, isPairedDevice, type UpdateStatus } from '@/lib/api'
import { appUpdate, offerFor, useAppUpdate, v } from '@/lib/appupdate'
import { Copyable } from './ui'
import { everyWhileVisible } from '@/lib/visible'

/** UpdateBanner's key: "not now" in either place hides that version in both. */
export const DISMISS_KEY = 'caprock.update.dismissed'
const POLL_MS = 10 * 60_000
/** How long "up to date" stays after a check the user asked for. */
export const UP_TO_DATE_MS = 6000

/** The commands to offer, app first; empty when no package manager owns either. */
export function upgradeCommands(st: UpdateStatus): { label: string; command: string }[] {
  const out: { label: string; command: string }[] = []
  if (st.app_command) out.push({ label: 'The app', command: st.app_command })
  if (st.command && st.command !== st.app_command) out.push({ label: st.app_command ? 'The daemon' : 'Caprock', command: st.command })
  return out
}

function readDismissed(): string {
  try { return localStorage.getItem(DISMISS_KEY) ?? '' } catch { return '' }
}

/** The daemon's release check as this page sees it: `/v1/update`, read on
 *  mount and every ten minutes while visible (no network I/O there). Not on a
 *  paired device, which cannot update the computer. */
export function useUpdateStatus(): UpdateStatus | undefined {
  const [st, setSt] = useState<UpdateStatus>()
  useEffect(() => {
    if (isPairedDevice()) return
    let alive = true
    const load = () => { api.update().then((s) => { if (alive) setSt(s) }).catch(() => { /* an older daemon: nothing to say */ }) }
    load()
    const stop = everyWhileVisible(load, POLL_MS)
    return () => { alive = false; stop() }
  }, [])
  return st
}

export function AppUpdateNotice() {
  const st = useUpdateStatus()
  const info = useAppUpdate()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [open, setOpen] = useState(false)
  // "Up to date" and a failure the user waved away stay hidden until the
  // updater moves again.
  const [settled, setSettled] = useState(false)
  const box = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const phase = info?.phase
  useEffect(() => {
    setSettled(false)
    // A check the user asked for is answered even for a version they said
    // "not now" to.
    if (phase === 'checking') setDismissed('')
    // A failure opens its own explanation.
    if (phase === 'failed') setOpen(true)
    if (phase !== 'up_to_date') return
    const t = window.setTimeout(() => setSettled(true), UP_TO_DATE_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  const offer = offerFor(info, st, dismissed)
  if (offer.kind === 'none' || (settled && (offer.kind === 'up_to_date' || offer.kind === 'failed'))) return null

  const dismiss = (version?: string) => {
    if (version) {
      try { localStorage.setItem(DISMISS_KEY, version) } catch { /* hidden for this page only */ }
      setDismissed(version)
    }
    setSettled(true)
    setOpen(false)
  }

  switch (offer.kind) {
    case 'checking':
      return <span role="status" className="text-fg-muted">Checking for updates…</span>
    case 'up_to_date':
      return <span role="status" className="text-fg-muted" title={`Caprock ${offer.version} is the newest release`}>Caprock is up to date</span>
    case 'progress':
      return (
        <span role="status" className="inline-flex items-center gap-1.5 text-fg-muted" title="Downloading in the background; sessions keep running">
          Downloading {offer.next}
          <span className="relative h-[4px] w-[46px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-200" style={{ width: `${offer.pct ?? 8}%` }} />
          </span>
          {offer.pct !== null && <span className="num text-fg">{offer.pct}%</span>}
        </span>
      )
    case 'installing':
      return <span role="status" className="text-fg-muted">Installing {offer.next} — restarting…</span>
    default:
      break
  }

  const latest = offer.kind === 'install' ? offer.next : offer.kind === 'commands' ? offer.latest : st?.latest
  const commands = st ? upgradeCommands(st) : []
  const current = info ? v(info.version) : st?.current

  return (
    <span ref={box} className="relative inline-flex items-center gap-1">
      {offer.kind === 'install' && (
        <>
          <button
            type="button"
            onClick={() => { setOpen(false); void appUpdate.install() }}
            className="text-accent hover:underline"
            title={`Download Caprock ${offer.next}, check its signature, install it and restart. Sessions keep running.`}
          >
            Update to {offer.next} — Restart
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label="More about this update"
            className="px-0.5 text-fg-faint hover:text-fg"
          >
            ▾
          </button>
        </>
      )}
      {offer.kind === 'commands' && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-accent hover:underline"
          title={`Caprock ${offer.latest} is available — you are on ${current}`}
        >
          {offer.latest} is out
        </button>
      )}
      {offer.kind === 'failed' && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-warn hover:underline">
          Update failed
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-label={offer.kind === 'failed' ? 'The update did not install' : `Caprock ${latest}`}
          className="app-fade-in absolute bottom-[22px] right-0 z-40 grid w-[400px] max-w-[calc(100vw-24px)] gap-2.5 rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel p-3 text-[12px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
        >
          {offer.kind === 'failed' ? (
            <>
              <p><span className="font-medium">The update did not install.</span> Caprock {current} keeps running.</p>
              <p className="break-words text-fg-muted">{offer.error}</p>
            </>
          ) : (
            <p>
              <span className="font-medium">Caprock {latest}</span> is available — you&apos;re on <span className="mono">{current}</span>.
              {offer.kind === 'install' && ' Restarting keeps every session running.'}
            </p>
          )}
          {offer.kind === 'commands' && info?.blocked && <p className="text-fg-muted">{info.blocked}</p>}
          {offer.kind !== 'install' && (commands.length > 0 ? (
            <div className="grid gap-1.5">
              <p className="text-fg-muted">Run in a terminal:</p>
              {commands.map((c) => (
                <div key={c.command} className="grid gap-0.5">
                  {commands.length > 1 && <span className="text-[11px] text-fg-faint">{c.label}</span>}
                  <Copyable command={c.command} className="break-all" />
                </div>
              ))}
            </div>
          ) : (
            !info?.blocked && offer.kind === 'commands' && <p className="text-fg-muted">Download it from the release page.</p>
          ))}
          <div className="flex items-center gap-2">
            <a className="link text-[12px]" href={st?.url ?? 'https://github.com/dspv/caprock/releases/latest'} target="_blank" rel="noreferrer">
              {offer.kind === 'failed' ? 'release page' : 'what’s new'}
            </a>
            {offer.kind === 'failed' && (
              <button type="button" onClick={() => { setOpen(false); void appUpdate.install() }} className="ml-auto rounded-[6px] border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent/20">
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(offer.kind === 'failed' ? undefined : latest)}
              className={`${offer.kind === 'failed' ? '' : 'ml-auto '}rounded-[6px] border border-[var(--app-hairline-strong)] px-2 py-0.5 text-[11.5px] text-fg-muted hover:text-fg`}
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
