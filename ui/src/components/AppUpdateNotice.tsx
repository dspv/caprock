/**
 * The app's update notice (F12): a quiet line in the status strip when a
 * newer Caprock is published, opening to the exact command for how it was
 * installed — the app's cask, the daemon's formula, or both — and dismissed
 * per version, like the dashboard's banner (UpdateBanner, the same key).
 *
 * Reading `/v1/update` never touches the network; the daemon's own check
 * (at most every 6 h, conditional, only while Settings → Privacy allows it)
 * is the one outbound call. With checks off it reports nothing to show.
 * Nothing installs itself: F20 is where that is decided.
 */
import { useEffect, useRef, useState } from 'react'
import { api, isPairedDevice, type UpdateStatus } from '@/lib/api'
import { Copyable } from './ui'
import { everyWhileVisible } from '@/lib/visible'

/** UpdateBanner's key: "not now" in either place hides that version in both. */
export const DISMISS_KEY = 'caprock.update.dismissed'
const POLL_MS = 10 * 60_000

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

export function AppUpdateNotice() {
  const [st, setSt] = useState<UpdateStatus>()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (isPairedDevice()) return
    let alive = true
    const load = () => { api.update().then((s) => { if (alive) setSt(s) }).catch(() => { /* an older daemon: nothing to say */ }) }
    load()
    const stop = everyWhileVisible(load, POLL_MS)
    return () => { alive = false; stop() }
  }, [])
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

  if (!st?.enabled || !st.update_available || !st.latest || dismissed === st.latest) return null
  const commands = upgradeCommands(st)
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, st.latest!) } catch { /* hidden for this page only */ }
    setDismissed(st.latest!)
    setOpen(false)
  }
  return (
    <span ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-accent hover:underline"
        title={`Caprock ${st.latest} is available — you are on ${st.current}`}
      >
        {st.latest} is out
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Caprock ${st.latest}`}
          className="app-fade-in absolute bottom-[22px] right-0 z-40 grid w-[400px] max-w-[calc(100vw-24px)] gap-2.5 rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel p-3 text-[12px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
        >
          <p>
            <span className="font-medium">Caprock {st.latest}</span> is available — you&apos;re on <span className="mono">{st.current}</span>.
          </p>
          {commands.length > 0 ? (
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
            <p className="text-fg-muted">Download it from the release page.</p>
          )}
          <div className="flex items-center gap-2">
            <a className="link text-[12px]" href={st.url} target="_blank" rel="noreferrer">what&apos;s new</a>
            <button type="button" onClick={dismiss} className="ml-auto rounded-[6px] border border-[var(--app-hairline-strong)] px-2 py-0.5 text-[11.5px] text-fg-muted hover:text-fg">
              Not now
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
