/**
 * Caprock's own cost on the status strip — *caprock 1.0 GB · 2.2 GB*, memory
 * then disk — and the doctor a click opens: one verdict line, Clean up, a row
 * per kind of problem in plain words, and what the memory and disk are spent
 * on behind the breakdown. The
 * owner asked (2026-10-13, translated): show the memory Caprock takes and
 * what it is spent on, so a user can tell at a glance whether a slowdown is
 * Caprock or not; and disk.
 *
 * One source for every figure: GET /v1/footprint (lib/footprint.ts), asked
 * every 10 s while the page is visible. Before its first answer, and from a
 * daemon without it, the strip falls back to the resource meter's memory.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errText } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { fmtCPU, fmtMem, useResources } from '@/lib/resources'
import { age, cleanupList, doctorHeadline, doctorRows, fmtBytes, footprintText, footprintTitle, orphanFigure, plainName, safeToStop, startedFrom, useFootprint, useFootprintWithOrphans, warnings, windowUsage, type DoctorRow, type DoctorRowKey, type Footprint, type Orphan, type OrphanStopResult } from '@/lib/footprint'
import { useNow } from '@/lib/useNow'
import { useMenuDismiss } from './Cockpit'

/**
 * Below this window width the strip says memory alone, "caprock 1.1 GB", and
 * the disk figure moves to the tooltip and the panel. Measured 2026-10-13: an
 * agent tab in front with the sidebar closed needs about 1,250 px for the
 * session's figures and "caprock 1.1 GB · 2.2 GB" side by side; narrower,
 * the session's figures were the part cut off.
 */
export const NARROW_STRIP_PX = 1250

function useNarrow(): boolean {
  const query = `(max-width: ${NARROW_STRIP_PX - 1}px)`
  const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined
  const [narrow, setNarrow] = useState(() => mq?.matches ?? false)
  useEffect(() => {
    if (!mq) return
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  return narrow
}

/** The palette's *Caprock doctor* opens the panel (AppShell); no chord of its own. */
export const DOCTOR_EVENT = 'caprock:doctor'
export function openCaprockDoctor() {
  window.dispatchEvent(new Event(DOCTOR_EVENT))
}

/** Settings' Storage section, scrolled into view once the screen has drawn it. */
export function openStorageSettings() {
  location.hash = '#/settings'
  let tries = 0
  const look = () => {
    const el = document.getElementById('settings-storage')
    if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return }
    if (++tries < 40) window.setTimeout(look, 50)
  }
  window.setTimeout(look, 0)
}

/**
 * The strip's figure. `owner` is false on a paired device, which may read the
 * footprint but not stop orphans.
 */
export function CaprockFootprint({ owner }: { owner: boolean }) {
  const fp = useFootprint()
  const rep = useResources()
  const narrow = useNarrow()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useMenuDismiss(open, box, () => setOpen(false))
  const f = fp.data
  const has = Boolean(f)
  useEffect(() => {
    if (!has) return
    const show = () => setOpen(true)
    window.addEventListener(DOCTOR_EVENT, show)
    return () => window.removeEventListener(DOCTOR_EVENT, show)
  }, [has])
  if (!f) {
    // A daemon without /v1/footprint: memory alone, from the meter.
    if (!rep) return null
    const c = rep.caprock
    const mem = c.daemon.mem_bytes + (c.app?.mem_bytes ?? 0) + (c.webview?.mem_bytes ?? 0) + c.hosts.mem_bytes
    return (
      <span data-caprock-load className="inline-flex items-center gap-1.5 whitespace-nowrap text-fg-muted" title={`Caprock itself: ${fmtMem(mem)} memory`}>
        caprock <span className="num">{fmtMem(mem)}</span>
      </span>
    )
  }
  const warn = warnings(f).length > 0
  const orphans = orphanFigure(f.orphans, true)
  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" data-caprock-load data-warn={warn || undefined} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)} title={open ? undefined : footprintTitle(f)}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap ${warn ? 'text-warn' : 'text-fg-muted hover:text-fg'}`}>
        {warn && <span aria-hidden data-warn-dot className="h-[6px] w-[6px] rounded-full bg-warn" />}
        caprock <span className="num">{fmtMem(f.memory.total_mem_bytes)}</span>
        {!narrow && (
          <>
            <span aria-hidden className="opacity-60">·</span>
            <span data-disk-figure className="num">{fmtBytes(f.disk.total_bytes)}</span>
            {orphans && (
              <>
                <span aria-hidden className="opacity-60">·</span>
                <span data-orphan-figure className="num">{orphans}</span>
              </>
            )}
          </>
        )}
      </button>
      {open && <FootprintPanel f={f} owner={owner} onCheck={fp.refresh} onClose={() => setOpen(false)} />}
    </span>
  )
}

/** How much older than the strip's answer the panel's own may be and still be shown. */
const FRESH_MS = 30_000

const BUTTON = 'h-[26px] shrink-0 rounded-[7px] border border-[var(--app-hairline-strong)] px-2.5 text-[12px] text-fg hover:border-accent disabled:opacity-50'
const PRIMARY = 'h-[28px] shrink-0 rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-bg hover:brightness-110 disabled:opacity-50'
const SMALL = 'h-[22px] shrink-0 rounded-[6px] border border-[var(--app-hairline-strong)] px-2 text-[11.5px] text-fg-muted hover:border-accent hover:text-fg disabled:opacity-50'

/** Where a confirmation is open: under the verdict for Clean up, under a row for its Stop. */
type Confirming = { at: 'all' | DoctorRowKey; items: Orphan[] }

/**
 * The panel above the strip: `caprock doctor` in the window, in plain words
 * (owner, 2026-10-15: "nothing is understandable"). One verdict line; when
 * something can be stopped, one Clean up; a row per kind of problem with a
 * line of why, its size and a small Stop; pids, paths and the daemon's own
 * sentences under each row's Details; the memory and disk breakdown behind
 * *Show breakdown*. Nothing is stopped without the confirmation, which lists
 * every process with its own checkbox (ADR-059).
 */
export function FootprintPanel({ f: strip, owner, onCheck: onStripCheck, onClose, className = 'absolute bottom-[25px] right-0 z-40' }: {
  f: Footprint
  owner: boolean
  /** Ask the daemon again now: *Check now*, and after a stop. */
  onCheck?: () => void
  onClose?: () => void
  className?: string
}) {
  // While open, the panel asks for the footprint with the orphan list taken
  // now; the strip's answer (counts only) stands in until it lands.
  const full = useFootprintWithOrphans()
  const f = full.data && full.data.at >= strip.at - FRESH_MS ? full.data : strip
  const onCheck = (fresh = false) => {
    onStripCheck?.()
    if (fresh) full.checkNow()
    else full.refresh()
  }
  const now = useNow(5_000)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const [confirm, setConfirm] = useState<Confirming>()
  // What outlived SIGTERM: offered a Force stop, the second click (ADR-059, amended 2026-10-18).
  const [stubborn, setStubborn] = useState<Orphan[]>([])
  const [breakdown, setBreakdown] = useState(false)
  // *Check now*: "Checking…" until an answer newer than the one shown lands.
  const [checking, setChecking] = useState<number>()
  useEffect(() => {
    if (checking === undefined) return
    if (f.at > checking) { setChecking(undefined); return }
    const t = window.setTimeout(() => setChecking(undefined), 5_000)
    return () => window.clearTimeout(t)
  }, [checking, f.at])
  const check = () => {
    setChecking(f.at)
    onCheck(true)
  }
  const sinceCheck = now - f.at
  const checked = checking !== undefined ? 'Checking…' : sinceCheck < 10_000 ? 'Checked just now' : `Checked ${fmtAgo(f.at, now)}`
  const rows = doctorRows(f)
  const all = owner ? cleanupList(rows) : []
  const safe = all.filter(safeToStop)
  const head = doctorHeadline(f)
  const stop = async (items: Orphan[], force = false) => {
    if (!items.length) { setConfirm(undefined); return }
    setBusy(true)
    setNote(undefined)
    try {
      const r: OrphanStopResult = await api.stopOrphans(items.map((x) => ({ pid: x.pid, started_at: x.started_at })), force)
      const ok = r.stopped ?? []
      const still = r.running ?? []
      const bad = r.failed ?? []
      const freed = ok.reduce((s, x) => s + x.mem_bytes, 0)
      setStubborn(force ? [] : still)
      setNote([
        ok.length ? `Stopped ${ok.length}${freed ? `, about ${fmtBytes(freed)} freed` : ''}.` : '',
        force && still.length ? `${still.length} still running after a force stop.` : '',
        bad.length ? `${bad.length} could not be stopped${bad.length === 1 ? `: ${bad[0]!.error}` : ''}.` : '',
      ].filter(Boolean).join(' '))
      onCheck()
    } catch (e) {
      setNote(errText(e))
    } finally {
      setBusy(false)
      setConfirm(undefined)
    }
  }
  const copy = () => {
    void navigator.clipboard?.writeText(footprintText(f)).then(() => setNote('Report copied.'), () => setNote('Could not reach the clipboard.'))
  }
  const confirmBox = (at: Confirming['at']) => confirm?.at === at && (
    <StopConfirm items={confirm.items} at={f.at} busy={busy} onStop={(xs) => void stop(xs)} onCancel={() => setConfirm(undefined)} />
  )
  const looking = owner && !head.ok && f.orphans && !f.orphans.scanned && f.orphans.count > 0
  return (
    <ClosePanel.Provider value={onClose}>
      <div role="dialog" aria-label="Caprock on this computer" data-footprint-panel
        className={`app-fade-in flex flex-col max-h-[calc(100vh-48px)] w-[360px] max-w-[calc(100vw-24px)] gap-3 overflow-y-auto rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel p-3.5 text-[12.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)] ${className}`}>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[14px] font-semibold">Caprock on this computer</span>
            {onClose && (
              <button type="button" aria-label="Close" onClick={onClose} className="text-fg-faint hover:text-fg">×</button>
            )}
          </div>
          <div className="flex items-baseline justify-between gap-2 text-[11.5px] text-fg-faint">
            <span data-checked title="caprock doctor, in the window">{checked}</span>
            <button type="button" data-check-now onClick={check} disabled={checking !== undefined} className="text-fg-muted hover:text-accent disabled:opacity-50">Check now</button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p data-verdict-summary data-ok={head.ok || undefined} className={`flex items-center gap-2 text-[14px] font-medium leading-[18px] ${head.ok ? 'text-ok' : 'text-fg'}`}>
            {head.ok ? <span aria-hidden>✓</span> : <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-warn" />}
            {head.text}
          </p>
          {safe.length > 0 && !confirm && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" data-cleanup className={PRIMARY} disabled={busy} onClick={() => { setNote(undefined); setConfirm({ at: 'all', items: all }) }}>
                {busy ? 'Stopping…' : `Clean up (frees ~${fmtBytes(safe.reduce((s, x) => s + x.mem_bytes, 0))})`}
              </button>
              <span className="text-[11.5px] text-fg-muted">You see the list first.</span>
            </div>
          )}
          {looking && <p className="text-[11.5px] text-fg-muted">Looking for what can be stopped…</p>}
          {orphanFigure(f.orphans) && (
            <p data-orphan-summary className="num text-[12px] text-fg-muted" title="Processes that look abandoned: Caprock's own, claude and codex sessions that ended, MCP servers whose agent is gone">
              {orphanFigure(f.orphans)}
            </p>
          )}
          {confirmBox('all')}
        </div>

        {owner && stubborn.length > 0 && (
          <ForceStop items={stubborn} busy={busy} onForce={(xs) => void stop(xs, true)} onDismiss={() => setStubborn([])} />
        )}

        {rows.length > 0 && (
          <ul data-doctor-rows className="flex flex-col divide-y divide-[var(--app-hairline)] border-y border-[var(--app-hairline)]">
            {rows.map((r) => (
              <DoctorRowView key={r.key} r={r} at={f.at} canStop={owner && r.stoppable.length > 0} busy={busy}
                onStop={() => { setNote(undefined); setConfirm({ at: r.key, items: r.stoppable }) }}>
                {confirmBox(r.key)}
              </DoctorRowView>
            ))}
          </ul>
        )}

        {note && <p role="status" data-doctor-note className="text-[11.5px] text-fg-muted">{note}</p>}

        {breakdown && <Breakdown f={f} now={now} />}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" data-breakdown aria-expanded={breakdown} onClick={() => setBreakdown((b) => !b)}
            className="flex items-center gap-1 text-[12px] text-fg-muted hover:text-accent">
            <span aria-hidden className={`inline-block text-[10px] transition-transform ${breakdown ? 'rotate-90' : ''}`}>›</span>
            {breakdown ? 'Hide breakdown' : `What the ${fmtMem(f.memory.total_mem_bytes)} is spent on`}
          </button>
          <button type="button" data-copy-report className={BUTTON} onClick={copy} title="The same report `caprock doctor` prints, as text">Copy report</button>
        </div>
      </div>
    </ClosePanel.Provider>
  )
}

/** One row: what, one line of why, the size, a small Stop; the technical part under Details. */
function DoctorRowView({ r, at, canStop, busy, onStop, children }: {
  r: DoctorRow
  at: number
  canStop: boolean
  busy: boolean
  onStop: () => void
  children?: ReactNode
}) {
  const hasDetails = r.procs.length > 0 || Boolean(r.said)
  return (
    <li data-doctor-row={r.key} data-warn={r.warn || undefined} className="flex flex-col gap-0.5 py-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`h-[6px] w-[6px] shrink-0 rounded-full ${r.warn ? 'bg-warn' : 'bg-[var(--app-hairline-strong)]'}`} />
        <span className="min-w-0 flex-1 text-fg">
          {r.title}{r.count !== undefined && <span className="num text-fg-faint"> ({r.count})</span>}
        </span>
        {r.value && <span className={`num shrink-0 text-right ${r.key === 'reads' && r.warn ? 'text-warn' : 'text-fg-muted'}`}>{r.value}</span>}
        {canStop && (
          <button type="button" data-row-stop disabled={busy} onClick={onStop} aria-label={`Stop: ${r.title}`} className={SMALL}>Stop</button>
        )}
      </div>
      {r.reason && <p className="pl-[14px] text-[11.5px] leading-[15px] text-fg-muted">{r.reason}</p>}
      {hasDetails && (
        <details data-row-details className="group pl-[14px]">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="inline-block text-[9px] transition-transform group-open:rotate-90">›</span>Details
          </summary>
          <div className="mt-1 flex flex-col gap-1.5 rounded-[6px] bg-[var(--app-hairline)] px-2 py-1.5 font-mono text-[10.5px] leading-[14px] text-fg-muted">
            {r.procs.map((p) => {
              const from = startedFrom(p.data_dir, p.exe)
              return (
                <div key={p.pid} data-orphan={p.pid} className="flex flex-col">
                  <span className="text-fg">{p.label ? `${p.label} · ` : ''}pid {p.pid} · {fmtMem(p.mem_bytes)}{p.cpu_pct !== undefined && p.cpu_pct !== null ? ` · ${fmtCPU(p.cpu_pct)} CPU` : ''}{p.started_at ? ` · ${age(at - p.started_at)}` : ''}</span>
                  {from && <span>started by: {from}</span>}
                  {p.cmd && <span data-orphan-cmd className="break-all" title={p.cmd}>$ {p.cmd}</span>}
                  {p.exe && <span className="break-all">{p.exe}</span>}
                  {p.data_dir && <span className="break-all">data {p.data_dir}{p.data_dir_gone ? ' (gone)' : ''}</span>}
                  {p.why && <span className="font-sans text-[11px]">{p.why}</span>}
                </div>
              )
            })}
            {r.said && <p className="font-sans text-[11px]">{r.said}</p>}
          </div>
        </details>
      )}
      {children}
    </li>
  )
}

/**
 * The one confirmation every stop goes through (ADR-059): each process on
 * its own line with its own checkbox, the safe ones ticked, so the person
 * sees and can untick each before the one click that stops them.
 */
function StopConfirm({ items, at, busy, onStop, onCancel }: { items: Orphan[]; at: number; busy: boolean; onStop: (xs: Orphan[]) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(items.filter(safeToStop).map((x) => x.pid)))
  const chosen = items.filter((x) => picked.has(x.pid))
  const freed = chosen.reduce((s, x) => s + x.mem_bytes, 0)
  const toggle = (pid: number) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(pid)) n.delete(pid)
    else n.add(pid)
    return n
  })
  return (
    <div role="alertdialog" aria-label="Stop these processes" data-stop-confirm
      onKeyDown={(e) => { if (e.code === 'Escape') { e.stopPropagation(); onCancel() } }}
      className="mt-1 flex flex-col gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] bg-[var(--app-hairline)] px-2.5 py-2">
      <p className="text-[12px] text-fg">Stop these? <span className="text-fg-muted">Untick any you want to keep. Anything unsaved in them is lost.</span></p>
      <ul className="flex flex-col gap-1">
        {items.map((x) => {
          const from = startedFrom(x.data_dir, x.exe)
          const careful = !safeToStop(x)
          return (
            <li key={x.pid}>
              <label className="flex cursor-pointer items-start gap-2 text-[12px]">
                <input type="checkbox" data-stop-pick={x.pid} checked={picked.has(x.pid)} onChange={() => toggle(x.pid)} disabled={busy} className="mt-[2px] h-3.5 w-3.5 shrink-0 accent-accent" />
                <span className="min-w-0 flex-1">
                  <span className="text-fg">{plainName(x)}</span>
                  <span className="text-fg-faint"> · {from ?? `running ${age(at - x.started_at)}`}</span>
                  {careful && <span className="block text-[11px] text-fg-muted">{carefulWhy(x)}</span>}
                </span>
                <span className="num shrink-0 text-fg-muted">{fmtMem(x.mem_bytes)}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-2">
        <button type="button" data-stop-confirm-yes autoFocus className={PRIMARY} disabled={busy || chosen.length === 0} onClick={() => onStop(chosen)}>
          {busy ? 'Stopping…' : chosen.length ? `Stop ${chosen.length}${freed ? ` · frees ~${fmtBytes(freed)}` : ''}` : 'Stop'}
        </button>
        <button type="button" data-stop-confirm-no className={BUTTON} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * What outlived SIGTERM. Nothing more was sent; **Force stop** is the second
 * click, which sends SIGKILL to each one named here (ADR-059, amended
 * 2026-10-18).
 */
function ForceStop({ items, busy, onForce, onDismiss }: { items: Orphan[]; busy: boolean; onForce: (xs: Orphan[]) => void; onDismiss: () => void }) {
  return (
    <div role="alertdialog" aria-label="Still running" data-force-stop-box
      className="flex flex-col gap-2 rounded-[8px] border border-[var(--app-hairline-strong)] bg-[var(--app-hairline)] px-2.5 py-2">
      <p className="text-[12px] text-fg">Still running after a polite stop. <span className="text-fg-muted">Force stop ends {items.length === 1 ? 'it' : 'them'} at once; nothing in {items.length === 1 ? 'it' : 'them'} gets to save.</span></p>
      <ul className="flex flex-col gap-0.5 text-[12px]">
        {items.map((x) => (
          <li key={x.pid} data-still-running={x.pid} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 text-fg">{plainName(x)} <span className="text-fg-faint">· pid {x.pid}</span></span>
            <span className="num shrink-0 text-fg-muted">{fmtMem(x.mem_bytes)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <button type="button" data-force-stop className={PRIMARY} disabled={busy} onClick={() => onForce(items)}>
          {busy ? 'Stopping…' : `Force stop ${items.length}`}
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onDismiss}>Leave running</button>
      </div>
    </div>
  )
}

/** Why a listed process is not ticked for you. */
function carefulWhy(o: Orphan): string {
  switch (o.kind) {
    case 'caprock_daemon': return 'Not a test folder: it may be a Caprock you use.'
    case 'caprock_holder': return 'Something still runs in it; stopping closes that terminal.'
    case 'caprock_old_holder': return 'A session still runs in it; stopping ends that session.'
    case 'caprock_other': return 'Part of an app; it may still be in use.'
    default: return 'Check it before stopping.'
  }
}

// --- the pieces ------------------------------------------------------------
type Line = { key: string; label: ReactNode; value: string; aside?: string; tone?: 'warn' }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function memoryLines(f: Footprint): Line[] {
  const m = f.memory
  const lines: Line[] = []
  if (m.daemon) lines.push({ key: 'daemon', label: 'daemon', value: fmtMem(m.daemon.mem_bytes), aside: fmtCPU(m.daemon.cpu_pct)})
  const w = windowUsage(f)
  if (w) {
    const what = m.webview ? `${m.app ? 'app + ' : ''}${plural(m.webview.count, 'web view')}` : 'app'
    lines.push({ key: 'window', label: <>window <Faint>· {what}</Faint></>, value: fmtMem(w.mem_bytes), aside: fmtCPU(w.cpu_pct)})
  }
  const h = m.hosts
  lines.push({ key: 'hosts', label: <>terminal holders <Faint>· {h.count}</Faint></>, value: fmtMem(h.mem_bytes), aside: fmtCPU(h.cpu_pct)})
  if (h.orphans > 0) lines.push({ key: 'orphans', label: <span className="pl-3">of them orphaned</span>, value: String(h.orphans), tone: 'warn' })
  const others = f.duplicates.daemons ?? []
  if (others.length) lines.push({ key: 'others', label: <>other daemons <Faint>· {others.length}</Faint></>, value: fmtMem(m.other_daemons_mem_bytes), tone: 'warn' })
  return lines
}

function diskLines(f: Footprint): Line[] {
  const d = f.disk
  // The WAL is worth naming only when it has grown; the daemon folds it back at 256 MB.
  const rows: [string, ReactNode, number][] = [
    ['db', <>history database {d.wal_bytes >= 64 * 2 ** 20 && <Faint>· WAL {fmtBytes(d.wal_bytes)}</Faint>}</>, d.database_bytes],
    ['pastes', 'pastes', d.pastes_bytes],
    ['logs', 'logs', d.logs_bytes],
    ['bin', 'programs', d.binaries_bytes],
    ['other', 'other', d.other_bytes],
  ]
  return rows.map(([key, label, b]) => ({ key, label, value: fmtBytes(b)}))
}

/** Read and written in the last hour; the last minute beside each, small. */
function ioLines(f: Footprint): Line[] | undefined {
  const io = f.disk_io
  const hr = io?.last_hour
  if (!io || !hr) return undefined
  const reads = warnings(f).some((v) => v.code === 'disk_reads_high')
  const min = io.last_minute
  return [
    { key: 'read', label: 'read', value: fmtBytes(hr.read_bytes), aside: min ? fmtBytes(min.read_bytes) : '', tone: reads ? 'warn' : undefined },
    { key: 'write', label: 'written', value: fmtBytes(hr.write_bytes), aside: min ? fmtBytes(min.write_bytes) : ''},
  ]
}

/** The window the hour figures cover while the daemon is younger than an hour. */
function ioSpan(f: Footprint): string {
  const s = f.disk_io?.last_hour?.seconds ?? 3600
  return s >= 3540 ? 'hour' : `${Math.max(1, Math.round(s / 60))} min`
}

function Faint({ children }: { children: ReactNode }) {
  return <span className="text-fg-faint">{children}</span>
}

function Header({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[var(--app-hairline)] pb-0.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint">{title}</span>
      {right}
    </div>
  )
}

function Row({ l }: { l: Line }) {
  return (
    <li data-row={l.key} className="flex h-[19px] items-baseline gap-2 leading-[19px]">
      <span className={`min-w-0 flex-1 truncate ${l.tone === 'warn' ? 'text-warn' : 'text-fg-muted'}`}>{l.label}</span>
      <span className="num w-[7ch] shrink-0 text-right text-[11px] text-fg-faint">{l.aside ?? ''}</span>
      <span className={`num w-[7ch] shrink-0 text-right ${l.tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{l.value}</span>
    </li>
  )
}

/**
 * An executable as a person names the install: the app bundle
 * ("Caprock 0.104.app") when it is in one, else the path. The whole path is
 * in the tooltip and in the copied report.
 */
export function shortExe(p: string): string {
  const m = /([^/\\]+\.app)[/\\]/.exec(p)
  return m ? m[1]! : p
}

const ClosePanel = createContext<(() => void) | undefined>(undefined)

/** To Settings' Storage section: what fills the database, and the retention that trims it. */
function StorageLink() {
  const close = useContext(ClosePanel)
  return (
    <button type="button" data-storage-link onClick={() => { close?.(); openStorageSettings() }} className="text-[11px] font-normal normal-case tracking-normal text-fg-muted hover:text-accent">
      Storage settings →
    </button>
  )
}

function Actions({ f, now, limit = 2 }: { f: Footprint; now: number; limit?: number }) {
  const acts = (f.actions ?? []).slice(-limit).reverse()
  if (!acts.length) return null
  return (
    <ul data-actions className="flex flex-col gap-0.5">
      {acts.map((a) => (
        <li key={`${a.at}-${a.what}`} className="flex gap-2 text-[11.5px]">
          <span className="num w-[7ch] shrink-0 whitespace-nowrap text-fg-faint">{fmtAgo(a.at, now)}</span>
          <span className="min-w-0 text-fg-muted">{a.what}</span>
        </li>
      ))}
    </ul>
  )
}


// --- the breakdown: sections stacked under headers (owner's pick, 2026-10-13) ---

function Breakdown({ f, now }: { f: Footprint; now: number }) {
  const io = ioLines(f)
  return (
    <div data-breakdown-body className="flex flex-col gap-2.5">
      <section data-memory className="flex flex-col gap-1">
        <Header title="Memory" right={<span className="flex items-baseline gap-2"><span className="num text-[11px] text-fg-faint">{fmtCPU(f.memory.total_cpu_pct)} CPU</span><span className="num font-semibold">{fmtMem(f.memory.total_mem_bytes)}</span></span>} />
        <ul className="flex flex-col">{memoryLines(f).map((l) => <Row key={l.key} l={l} />)}</ul>
      </section>
      <section data-disk className="flex flex-col gap-1">
        <Header title="Disk" right={<span className="flex items-baseline gap-2"><StorageLink /><span className="num font-semibold">{fmtBytes(f.disk.total_bytes)}</span></span>} />
        <ul className="flex flex-col">{diskLines(f).map((l) => <Row key={l.key} l={l} />)}</ul>
      </section>
      {io && (
        <section data-disk-io className="flex flex-col gap-1">
          <Header title="Disk activity" right={<span className="flex gap-2 whitespace-nowrap text-[10.5px] text-fg-faint"><span className="w-[7ch] text-right">minute</span><span className="w-[7ch] text-right">{ioSpan(f)}</span></span>} />
          <ul className="flex flex-col">{io.map((l) => <Row key={l.key} l={l} />)}</ul>
        </section>
      )}
      {(f.actions ?? []).length > 0 && (
        <section className="flex flex-col gap-1">
          <Header title="Done on its own" />
          <Actions f={f} now={now} />
        </section>
      )}
    </div>
  )
}
