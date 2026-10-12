/**
 * The version in the status strip, and what a click on it opens: whether an
 * update is out, when Caprock last looked, the update itself in one click
 * where this install can replace itself, and a link to the release notes
 * (owner, 2026-10-11, translated: "why do I need what's new — I want to see
 * whether there is an update and when it was last checked, a small dialog").
 * The notes themselves were in the panel too until the same evening, wrapped
 * as raw markdown, and the owner found them unreadable: "keep it simple about
 * the version; whoever needs the release notes will click".
 *
 * Reading /v1/update never touches the network; *Check now* asks the daemon
 * to look (and, in the app, the app's own updater), as the menu's Check for
 * Updates does.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type UpdateStatus } from '@/lib/api'
import { appUpdate, newerVersion, offerFor, useAppUpdate, v } from '@/lib/appupdate'
import { openExternal } from '@/lib/nudges'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { upgradeCommands } from './AppUpdateNotice'
import { Copyable } from './ui'

export function VersionPanel({ shown, title, status, onStatus }: {
  /** The version on screen: the app's own, else the daemon's. */
  shown: string
  title: string
  status?: UpdateStatus
  onStatus: (s: UpdateStatus) => void
}) {
  const info = useAppUpdate()
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLSpanElement>(null)
  const now = useNow(open ? 15_000 : 3_600_000)
  // The update card sits in the same corner; while this panel is open it says
  // the same thing with its own Update button, so the card steps aside
  // (owner, 2026-10-12: the two stacked on top of each other).
  useEffect(() => {
    const root = document.documentElement
    root.toggleAttribute('data-version-open', open)
    return () => root.removeAttribute('data-version-open')
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  const st = status
  const latest = st?.latest ? v(st.latest) : undefined
  const available = Boolean(latest && newerVersion(latest, shown))
  const offer = offerFor(info, st, '')
  const commands = st ? upgradeCommands(st) : []
  // The app and the daemon behind it should run one version: the app replaces
  // its own daemon on launch (ADR-040). When they still differ, say so.
  const daemon = st?.current ? v(st.current) : undefined
  const apart = Boolean(info?.version && daemon && v(info.version) !== daemon)
  const check = async () => {
    setChecking(true)
    setError('')
    try {
      const [s] = await Promise.all([api.checkUpdate(), appUpdate.check()])
      onStatus(s)
      if (s.error) setError(s.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" data-version onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 text-fg-faint hover:text-accent" title={[apart ? `The daemon runs ${daemon}` : available ? `Caprock ${latest} is available` : 'Version and updates', title].filter(Boolean).join('\n')}>
        {(available || apart) && <span aria-hidden data-version-apart={apart || undefined} className={`h-[6px] w-[6px] rounded-full ${apart ? 'bg-warn' : 'bg-accent'}`} />}
        <span className="mono">{shown}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Caprock version" data-version-panel
          className="app-fade-in absolute bottom-[22px] right-0 z-40 grid w-[320px] max-w-[calc(100vw-24px)] gap-3 rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel p-4 text-[13.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[16px] font-semibold">Caprock <span className="mono">{shown}</span></span>
            {available
              ? <span className="font-medium text-accent">{latest} is out</span>
              : st?.enabled === false
                ? <span className="text-fg-faint">checks are off</span>
                : latest ? <span className="font-medium text-ok">✓ up to date</span> : null}
          </div>
          <p className="text-fg-muted" data-checked>
            {st?.enabled === false
              ? 'Release checks are off in Settings → Privacy.'
              : st?.checked_at ? `Checked ${fmtAgo(st.checked_at, now)}` : 'Not checked yet'}
          </p>
          {apart && (
            <p data-apart className="rounded-[7px] border border-warn/40 bg-warn/10 px-2.5 py-2 text-[13px] text-fg">
              The app is <span className="mono">{v(info!.version)}</span>, its daemon <span className="mono">{daemon}</span>. Quit and reopen Caprock to update the daemon — sessions keep running.
            </p>
          )}
          {available && offer.kind === 'install' && (
            <div className="grid gap-1">
              <button type="button" onClick={() => { setOpen(false); void appUpdate.install() }}
                className="rounded-[7px] bg-accent px-3 py-1.5 text-center text-[14px] font-semibold text-panel hover:opacity-90">
                Update to {offer.next}
              </button>
              <p className="text-center text-[12px] text-fg-muted">Restarts the app · sessions keep running</p>
            </div>
          )}
          {available && offer.kind !== 'install' && commands.length > 0 && (
            <div className="grid gap-1.5">
              <p className="text-fg-muted">Run in a terminal:</p>
              {commands.map((c) => <Copyable key={c.command} command={c.command} className="break-all" />)}
            </div>
          )}
          {error && <p className="break-words text-warn">{error}</p>}
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void check()} disabled={checking || st?.enabled === false}
              className="rounded-[7px] border border-[var(--app-hairline-strong)] px-3 py-1.5 text-fg hover:border-accent disabled:opacity-50">
              {checking ? 'Checking…' : 'Check now'}
            </button>
            <button type="button" onClick={() => openExternal('https://caprock.dev/changelog')} className="text-fg-muted hover:text-accent">
              Release notes →
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
