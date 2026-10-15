/**
 * Update automatically (Settings → Updates; ADR-042 as amended 2026-10-15).
 *
 * With the choice on, a newer version the daemon's release check found is
 * downloaded and verified in the background, then installed when it is safe
 * to restart (lib/autoupdate: no agent working or waiting on a permission
 * prompt, the user away for two minutes, nothing typed and unsent). Ten
 * seconds before the restart a card says so, with **Not now** (an hour) and
 * **Restart now**; touching a key or clicking also calls it off until the
 * next quiet moment. After the restart one line says **Updated to vX ·
 * What's new**.
 *
 * Sessions and tabs come back as on any update: each session's terminal
 * lives in its pty-host, which outlives the app and the daemon (ADR-033);
 * the page keeps its tabs in its storage.
 *
 * With Ask me (the default) none of this runs: AppUpdateToast asks.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/lib/api'
import { appUpdate, newerVersion, useAppUpdate, v } from '@/lib/appupdate'
import {
  COUNTDOWN_S, POSTPONE_MS, RECHECK_MS, RETRY_FAILED_MS,
  hasDraft, idleFor, rememberAutoInstall, restartBlocker, takeUpdatedNote, trackActivity,
} from '@/lib/autoupdate'
import { openExternal } from '@/lib/nudges'
import { NotesDialog } from './Shell'
import { useUpdateStatus } from './AppUpdateNotice'
import { usePlan } from './PlanPicker'

/** Not now, per version: until when it is held back. Kept for this page's life. */
const postponed = new Map<string, number>()

/** Tests only. */
export function resetAutoUpdate() { postponed.clear() }

async function busyCount(): Promise<number | undefined> {
  try { return (await api.updateBusy()).working } catch { return undefined }
}

export function AppAutoUpdate() {
  const info = useAppUpdate()
  const st = useUpdateStatus()
  const [plan] = usePlan()
  const auto = plan?.app_update === 'auto'
  const [countdown, setCountdown] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [notes, setNotes] = useState(false)
  const tried = useRef<{ version: string; at: number }>({ version: '', at: 0 })
  const [tick, setTick] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => { trackActivity() }, [])
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), RECHECK_MS)
    return () => window.clearInterval(t)
  }, [])

  // After a restart into an update this app installed on its own.
  const version = info?.version
  useEffect(() => {
    if (!version) return
    const n = takeUpdatedNote(version)
    if (n) setNote(n)
  }, [version])

  // 1. A newer version is known: download and verify it, once per version
  //    (again an hour after a failure).
  const supported = !!info?.supported
  const phase = info?.phase
  const latest = st?.enabled && st.latest && version && newerVersion(st.latest, version) ? st.latest : ''
  useEffect(() => {
    if (!auto || !supported || !latest) return
    if (phase !== 'idle' && phase !== 'up_to_date' && phase !== 'available' && phase !== 'failed') return
    const t = tried.current
    if (t.version === latest && (phase !== 'failed' || Date.now() - t.at < RETRY_FAILED_MS)) return
    tried.current = { version: latest, at: Date.now() }
    void appUpdate.download()
  }, [auto, supported, latest, phase, tick])

  // 2. Downloaded: look for a safe moment, every RECHECK_MS.
  const ready = auto && info?.phase === 'ready' ? v(info.next) : ''
  useEffect(() => {
    if (!ready || countdown !== null) return
    let alive = true
    void (async () => {
      const working = await busyCount()
      if (!alive) return
      const now = Date.now()
      const b = restartBlocker({ working, idleMs: idleFor(now), draft: hasDraft(), now, postponedUntil: postponed.get(ready) ?? 0 })
      if (!b) setCountdown(COUNTDOWN_S)
    })()
    return () => { alive = false }
  }, [ready, tick, countdown])

  // 3. The notice: a key or a click elsewhere calls it off; at zero, look
  //    once more.
  const counting = countdown !== null
  useEffect(() => {
    if (!counting) return
    const cancel = (e: Event) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return
      setCountdown(null)
    }
    window.addEventListener('keydown', cancel, true)
    window.addEventListener('pointerdown', cancel, true)
    return () => {
      window.removeEventListener('keydown', cancel, true)
      window.removeEventListener('pointerdown', cancel, true)
    }
  }, [counting])
  useEffect(() => {
    if (countdown === null || !ready) return
    if (countdown > 0) {
      const t = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000)
      return () => window.clearTimeout(t)
    }
    let alive = true
    void (async () => {
      const working = await busyCount()
      if (!alive) return
      const now = Date.now()
      // The countdown itself was the two minutes' grace: a key or a click
      // would have cancelled it, so only the agents and a draft are asked again.
      const b = restartBlocker({ working, idleMs: Infinity, draft: hasDraft(), now, postponedUntil: postponed.get(ready) ?? 0 })
      setCountdown(null)
      if (b) return
      rememberAutoInstall(ready)
      void appUpdate.install()
    })()
    return () => { alive = false }
  }, [countdown, ready])

  const notNow = () => {
    if (ready) postponed.set(ready, Date.now() + POSTPONE_MS)
    setCountdown(null)
  }
  const restartNow = () => {
    setCountdown(null)
    if (ready) rememberAutoInstall(ready)
    void appUpdate.install()
  }
  const whatsNew = () => {
    if (st?.notes && st.notes_for && v(st.notes_for) === note) setNotes(true)
    else openExternal(st?.url ?? 'https://caprock.dev/changelog')
  }

  // The update card's corner and look (AppUpdateToast), as a card and as a line.
  const corner = 'app-fade-in pointer-events-auto fixed bottom-[34px] right-3 z-40 max-w-[calc(100vw-24px)] rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel text-[13.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]'
  const card = `${corner} grid w-[340px] gap-2.5 p-4`
  return (
    <>
      {countdown !== null && ready && (
        <div ref={box} role="status" aria-label="Caprock is updating" data-auto-update className={card}>
          <p className="text-[16px] font-semibold">
            Updating to <span className="mono text-accent">{ready.replace(/^v/, '')}</span> in <span className="num">{countdown}</span> s
          </p>
          <p className="text-fg-muted">Sessions and tabs stay as they are.</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={notNow} className="ml-auto rounded-[7px] px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg">Not now</button>
            <button type="button" onClick={restartNow} className="rounded-[7px] bg-accent px-3 py-1.5 text-[13px] font-semibold text-panel hover:brightness-110">Restart now</button>
          </div>
        </div>
      )}
      {note && countdown === null && (
        <div role="status" aria-label="Caprock updated" data-auto-updated className={`${corner} flex items-center gap-2 py-2 pl-3.5 pr-2`}>
          <span>Updated to <span className="mono">{note.replace(/^v/, '')}</span></span>
          <span aria-hidden className="text-fg-faint">·</span>
          <button type="button" className="link" onClick={whatsNew}>What’s new</button>
          <button type="button" aria-label="Close" onClick={() => setNote(null)} className="ml-auto rounded-[6px] px-1.5 text-fg-faint hover:text-fg">×</button>
        </div>
      )}
      {notes && st && createPortal(<NotesDialog u={st} onClose={() => setNotes(false)} />, document.body)}
    </>
  )
}
