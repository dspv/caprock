/**
 * The resource meter's faces (lib/resources.ts): the front session's CPU and
 * memory on the status bar, a quiet "hot" mark on a session's sidebar row
 * and tab, its busiest processes in the inspector, and Caprock's own cost in
 * Settings with the button that stops orphaned terminal holders.
 *
 * Figures are the daemon's, sampled every 5 s while a dashboard is open. CPU
 * is summed over the session's process tree, so 250% is two and a half cores.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@/lib/api'
import { api, errText } from '@/lib/api'
import { fmtCPU, fmtMem, refreshResources, useResources, useSessionHot, useSessionResources, type ReapResult, type SessionResources } from '@/lib/resources'
import { SectionLabel } from './Cockpit'
import { FitSummary } from './FitSummary'
import { ResourcePopover } from './ResourcePopover'

function topLines(r: SessionResources): string {
  return r.top.map((p) => `${p.name} · ${fmtCPU(p.cpu_pct, r.warm)} · ${fmtMem(p.mem_bytes)}`).join('\n')
}

/** How long the pointer rests on the figures before the popover opens, and how long it may leave before it closes. */
export const OPEN_DELAY_MS = 250
const CLOSE_GRACE_MS = 200

/**
 * The status bar's "agent cpu 182% ram 1.2 GB" for the session in front: its
 * processes, not Caprock's. Hovering, focusing or clicking it opens the
 * resource popover (ResourcePopover.tsx): a click keeps it open until Escape,
 * the close button or a click outside.
 */
export function SessionLoad({ sessionId, sessions, onOpenSession }: {
  sessionId: string
  /** For the popover's names of the sessions using the most. */
  sessions?: SessionSummary[]
  /** Brings a session's tab forward: the popover's rows. */
  onOpenSession?: (id: string) => void
}) {
  const r = useSessionResources(sessionId)
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const refocus = useRef(false)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const show = (delay: number) => {
    window.clearTimeout(timer.current)
    if (delay) timer.current = window.setTimeout(() => setOpen(true), delay)
    else setOpen(true)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    if (!pinned) timer.current = window.setTimeout(() => setOpen(false), CLOSE_GRACE_MS)
  }
  const close = useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
    setPinned(false)
  }, [])
  // A pinned popover closes on a click anywhere but it and its figures.
  useEffect(() => {
    if (!pinned) return
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Element | null
      if (anchor.current?.contains(t) || t?.closest?.('[data-resource-popover]')) return
      close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pinned, close])
  if (!r) return null
  const title = open ? undefined : [
    `This session's own processes — the agent and everything it runs, not Caprock: ${r.procs} ${r.procs === 1 ? 'process' : 'processes'}, CPU summed (100% is one core), memory resident`,
    topLines(r),
    'Hover or click for the last hour.',
  ].filter(Boolean).join('\n')
  return (
    <>
      <button ref={anchor} type="button" data-session-load aria-haspopup="dialog" aria-expanded={open}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[4px] outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-accent"
        title={title}
        onMouseEnter={() => show(OPEN_DELAY_MS)} onMouseLeave={hide}
        onFocus={() => { if (!refocus.current) show(0) }}
        onBlur={(e) => { if (!pinned && !(e.relatedTarget as Element | null)?.closest?.('[data-resource-popover]')) hide() }}
        onClick={() => { if (pinned) close(); else { setPinned(true); show(0) } }}>
        {/* Said in words (owner, 2026-10-12: "is the second one memory, and is
          * it Caprock's or everything?"): it is the session's, and it is RAM. */}
        agent cpu <span className={`num ${r.hot ? 'text-warn' : 'text-fg'}`}>{fmtCPU(r.cpu_pct, r.warm)}</span>
        {' '}ram <span className="num text-fg">{fmtMem(r.mem_bytes)}</span>
      </button>
      {open && (
        <ResourcePopover sessionId={sessionId} sessions={sessions} anchor={anchor} onOpenSession={onOpenSession}
          onClose={(back) => {
            close()
            // Escape and the close button hand the focus back, which must not open it again.
            if (!back) return
            refocus.current = true
            anchor.current?.focus({ preventScroll: true })
            refocus.current = false
          }}
          onEnter={() => window.clearTimeout(timer.current)} onLeave={hide} />
      )}
    </>
  )
}

/**
 * A small mark on a session's row and tab while its processes have been busy
 * for a minute. Static, and drawn again only when what it says changes
 * (useSessionHot): a quiet row never redraws for a resources sample.
 */
export const HotMark = memo(function HotMark({ sessionId }: { sessionId: string | undefined }) {
  const why = useSessionHot(sessionId)
  if (!why) return null
  return (
    <span data-hot-mark role="img" aria-label={why} title={why} className="flex shrink-0 items-center text-warn opacity-80">
      <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true">
        <path d="M4.6 0.6c.3 1.6-.5 2.5-1.4 3.5C2.2 5.2 1 6.4 1 7.9 1 9.6 2.6 10.6 4.5 10.6S8 9.6 8 7.7c0-1.5-.8-2.4-1.5-3.2.1.9-.3 1.6-1 1.9.4-1.9-.2-4.3-.9-5.8z" fill="currentColor" />
      </svg>
    </span>
  )
})

/** The inspector's list of the session's busiest processes. */
export function Processes({ sessionId }: { sessionId: string }) {
  const r = useSessionResources(sessionId)
  if (!r || r.top.length === 0) return null
  return (
    <section aria-label="Processes" className="grid gap-2" data-processes>
      <SectionLabel right={<FitSummary className="num text-fg-muted" title="Summed over the session's processes; 100% is one core"
        variants={[<span key="both">{fmtCPU(r.cpu_pct, r.warm)} · {fmtMem(r.mem_bytes)}</span>, <span key="mem">{fmtMem(r.mem_bytes)}</span>]} />}>
        Processes{r.procs > 1 ? ` · ${r.procs}` : ''}
      </SectionLabel>
      <ul className="grid gap-1">
        {r.top.map((p) => (
          <li key={p.pid} className="flex items-baseline gap-2 text-[11.5px]" title={`pid ${p.pid}`}>
            <span className="mono min-w-0 flex-1 truncate text-fg">{p.name}</span>
            <span className="num w-[5ch] shrink-0 text-right text-fg-muted">{fmtCPU(p.cpu_pct, r.warm)}</span>
            <span className="num w-[7ch] shrink-0 text-right text-fg-muted">{fmtMem(p.mem_bytes)}</span>
          </li>
        ))}
      </ul>
      {r.hot && <p className="text-[11.5px] text-warn">{hotReasonShort(r)}</p>}
    </section>
  )
}

function hotReasonShort(r: SessionResources): string {
  const mins = r.over_since ? Math.max(1, Math.round((Date.now() - r.over_since) / 60_000)) : 1
  return `Hot for ${mins} min`
}

const BUTTON = 'h-[28px] shrink-0 rounded-[7px] border border-border-strong px-3 text-[12px] text-fg hover:bg-panel-2 disabled:opacity-50'

/**
 * Settings' "Caprock itself": the daemon, the app and the terminal holders,
 * and a button that stops the holders nothing can reach and nothing runs in.
 * `owner` is false on a paired device, which may read this but not reap.
 */
export function CaprockItself({ owner }: { owner: boolean }) {
  const rep = useResources()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string>()
  if (!rep) return null
  const c = rep.caprock
  const h = c.hosts
  const mem = c.daemon.mem_bytes + (c.app?.mem_bytes ?? 0) + h.mem_bytes
  const cpu = c.daemon.cpu_pct + (c.app?.cpu_pct ?? 0) + h.cpu_pct
  const kept = h.orphans - h.reapable
  const reap = async () => {
    setBusy(true)
    setDone(undefined)
    try {
      const r: ReapResult = await api.reapOrphans()
      const n = r.reaped.length
      const failed = r.failed?.length ?? 0
      setDone(`${n === 0 ? 'Nothing to stop' : `Stopped ${n}`}${failed ? `, ${failed} would not stop` : ''}${r.kept.length ? ` · ${r.kept.length} left running: something still runs in them` : ''}.`)
      await refreshResources()
    } catch (e) {
      setDone(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const parts = [
    `daemon ${fmtMem(c.daemon.mem_bytes)}`,
    c.app ? `app ${fmtMem(c.app.mem_bytes)}` : '',
    `${h.count} terminal ${h.count === 1 ? 'holder' : 'holders'}${h.count ? ` ${fmtMem(h.mem_bytes)}` : ''}`,
  ].filter(Boolean)
  return (
    <div data-caprock-itself className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 text-fg-muted">
          Caprock itself: <span className="num text-fg">{fmtMem(mem)}</span> · <span className="num text-fg">{fmtCPU(cpu)}</span> CPU
          <span className="text-fg-faint"> ({parts.join(' · ')})</span>
          {h.orphans > 0 && (
            <>
              {' · '}
              <span className="text-warn" title="Terminal holders no Caprock will attach to again: their install was deleted, or their session's entry is gone">
                {h.orphans} {h.orphans === 1 ? 'orphan' : 'orphans'}
              </span>
            </>
          )}
        </p>
        {owner && h.reapable > 0 && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void reap()} title="Stops holders whose program has exited, and holders nothing can reach that hold an idle shell. One running an agent or a command is never stopped.">
            {busy ? 'Stopping…' : `Stop ${h.reapable} ${h.reapable === 1 ? 'orphan' : 'orphans'}`}
          </button>
        )}
      </div>
      {kept > 0 && !done && (
        <p className="text-[11.5px] text-fg-faint">
          {kept} of them {kept === 1 ? 'runs' : 'run'} an agent or a command, so Caprock leaves {kept === 1 ? 'it' : 'them'} alone.
        </p>
      )}
      {done && <p role="status" className="text-[11.5px] text-fg-muted">{done}</p>}
    </div>
  )
}
