/**
 * Caprock's own cost on the status strip — *caprock 1.0 GB · 2.2 GB*, memory
 * then disk — and the panel a click opens: what that memory and disk are spent
 * on, the daemon's disk reads and writes, the warnings with the duplicates
 * behind them, what Caprock did about it on its own, and the buttons. The
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
import { fmtCPU, fmtMem, refreshResources, useResources, type ReapResult } from '@/lib/resources'
import { age, fmtBytes, footprintText, footprintTitle, ORPHAN_KIND, strayCount, useFootprint, useFootprintWithOrphans, verdictSummary, warnings, windowUsage, type Footprint, type FootprintVerdict, type Orphan, type OrphanStopResult } from '@/lib/footprint'
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
  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" data-caprock-load data-warn={warn || undefined} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)} title={footprintTitle(f)}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap ${warn ? 'text-warn' : 'text-fg-muted hover:text-fg'}`}>
        {warn && <span aria-hidden data-warn-dot className="h-[6px] w-[6px] rounded-full bg-warn" />}
        caprock <span className="num">{fmtMem(f.memory.total_mem_bytes)}</span>
        {!narrow && (
          <>
            <span aria-hidden className="opacity-60">·</span>
            <span data-disk-figure className="num">{fmtBytes(f.disk.total_bytes)}</span>
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

/** The panel above the strip: `caprock doctor` in the window. */
export function FootprintPanel({ f: strip, owner, onCheck: onStripCheck, onClose, className = 'absolute bottom-[25px] right-0 z-40' }: {
  f: Footprint
  owner: boolean
  /** Ask the daemon again now: *Check now*, and after a reap. */
  onCheck?: () => void
  onClose?: () => void
  className?: string
}) {
  // While open, the panel asks for the footprint with the orphan list taken
  // now; the strip's answer (counts only) stands in until it lands.
  const full = useFootprintWithOrphans()
  const f = full.data && full.data.at >= strip.at - FRESH_MS ? full.data : strip
  const onCheck = () => {
    onStripCheck?.()
    full.refresh()
  }
  const now = useNow(5_000)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  // *Check now*: "checking…" until an answer newer than the one shown lands.
  const [checking, setChecking] = useState<number>()
  useEffect(() => {
    if (checking === undefined) return
    if (f.at > checking) { setChecking(undefined); return }
    const t = window.setTimeout(() => setChecking(undefined), 5_000)
    return () => window.clearTimeout(t)
  }, [checking, f.at])
  const check = () => {
    setChecking(f.at)
    onCheck()
  }
  const sinceCheck = now - f.at
  const checked = checking !== undefined ? 'checking…' : sinceCheck < 10_000 ? 'checked just now' : `checked ${fmtAgo(f.at, now)}`
  const warns = warnings(f).length
  const h = f.memory.hosts
  const reap = async () => {
    setBusy(true)
    setNote(undefined)
    try {
      const r: ReapResult = await api.reapOrphans()
      const n = r.reaped.length
      const failed = r.failed?.length ?? 0
      setNote(`${n === 0 ? 'Nothing to stop' : `Stopped ${n}`}${failed ? `, ${failed} would not stop` : ''}${r.kept.length ? ` · ${r.kept.length} left running: something still runs in them` : ''}.`)
      await refreshResources()
      onCheck()
    } catch (e) {
      setNote(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const copy = () => {
    void navigator.clipboard?.writeText(footprintText(f)).then(() => setNote('Report copied.'), () => setNote('Could not reach the clipboard.'))
  }
  const body = (
    <ClosePanel.Provider value={onClose}>
      <Body f={f} now={now} owner={owner} onStopped={onCheck} />
    </ClosePanel.Provider>
  )
  return (
    <div role="dialog" aria-label="Caprock on this computer" data-footprint-panel
      className={`app-fade-in flex flex-col max-h-[calc(100vh-48px)] w-[340px] max-w-[calc(100vw-24px)] gap-2.5 overflow-y-auto rounded-[12px] border border-[var(--app-hairline-strong)] bg-panel p-3 text-[12.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)] ${className}`}>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-semibold">Caprock on this computer</span>
          {onClose && (
            <button type="button" aria-label="Close" onClick={onClose} className="text-fg-faint hover:text-fg">×</button>
          )}
        </div>
        {/* The command's name, so the panel and `caprock doctor` read as one thing. */}
        <div className="flex items-baseline justify-between gap-2 text-[11.5px] text-fg-faint">
          <span><span className="mono">doctor</span> · <span data-checked>{checked}</span></span>
          <button type="button" data-check-now onClick={check} disabled={checking !== undefined} className="text-fg-muted hover:text-accent disabled:opacity-50">Check now</button>
        </div>
      </div>
      <p data-verdict-summary className={`flex items-center gap-1.5 font-medium ${warns ? 'text-warn' : 'text-ok'}`}>
        {warns ? <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-warn" /> : <span aria-hidden>✓</span>}
        {verdictSummary(f)}
      </p>
      {body}
      {note && <p role="status" className="text-[11.5px] text-fg-muted">{note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {owner && h.reapable > 0 && (
          <button type="button" data-reap className={BUTTON} disabled={busy} onClick={() => void reap()}
            title="Stops holders whose program has exited, and holders nothing can reach that hold an idle shell. One running an agent or a command is never stopped.">
            {busy ? 'Stopping…' : `Stop ${h.reapable} ${h.reapable === 1 ? 'orphan' : 'orphans'}`}
          </button>
        )}
        <button type="button" data-copy-report className={BUTTON} onClick={copy} title="The same report `caprock doctor` prints, as text">Copy report</button>
      </div>
    </div>
  )
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

/** A path that wraps at its slashes, never inside a name. */
function Path({ children }: { children: string }) {
  const parts = shortExe(children).split(/(?<=[/\\])/)
  return <span className="mono" title={children}>{parts.map((x, i) => <span key={i}>{x}{i < parts.length - 1 && <wbr />}</span>)}</span>
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

/**
 * Each warning as one short line a person reads at a glance, the processes
 * behind it under it, and the daemon's own sentence one click down. A code
 * this build does not know shows the daemon's sentence as it is.
 */
function warningHead(f: Footprint, v: FootprintVerdict): { head: string; detail?: ReactNode } {
  const d = f.duplicates
  switch (v.code) {
    case 'duplicate_daemon': {
      const ds = d.daemons ?? []
      return {
        head: `${plural(ds.length, 'other Caprock daemon')} running`,
        detail: ds.map((p) => <li key={p.pid}><span className="num">pid {p.pid} · {fmtMem(p.mem_bytes)}</span> · <Path>{p.exe ?? 'unknown'}</Path></li>),
      }
    }
    case 'duplicate_app': {
      const as = d.apps ?? []
      return {
        head: `${as.length} copies of the desktop app`,
        detail: as.map((p) => <li key={p.pid}><span className="num">pid {p.pid}</span> · <Path>{p.exe ?? 'unknown'}</Path></li>),
      }
    }
    case 'orphans': {
      const h = f.memory.hosts
      return {
        head: `${plural(h.orphans, 'orphaned terminal holder')} of ${h.count}`,
        detail: (d.other_install_holders.exes ?? []).map((e) => <li key={e.exe}><span className="num">{e.count}</span> from <Path>{e.exe}</Path></li>),
      }
    }
    case 'disk_reads_high': {
      const hr = f.disk_io?.last_hour
      return { head: hr ? `Read ${fmtBytes(hr.read_bytes)} from disk in the last ${ioSpan(f)}` : v.text }
    }
    case 'stray_processes': {
      const n = strayCount(f.orphans) + (f.orphans?.by_kind?.claude_child ?? 0)
      return { head: n > 0 ? `${plural(n, 'process', 'processes')} ${n === 1 ? 'looks' : 'look'} abandoned` : v.text }
    }
    case 'database_large': return { head: `The database is ${fmtBytes(f.disk.database_bytes)}` }
    case 'wal_large': return { head: `The write-ahead log is ${fmtBytes(f.disk.wal_bytes)}` }
  }
  return { head: v.text }
}

function Warnings({ f }: { f: Footprint }) {
  const warns = warnings(f)
  if (!warns.length) return null
  return (
    <ul data-warnings className="flex flex-col gap-1 rounded-[8px] border border-warn/40 bg-warn/10 px-2.5 py-1.5">
      {warns.map((v) => {
        const { head, detail } = warningHead(f, v)
        return (
          <li key={v.code} data-verdict={v.code}>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-baseline gap-1.5 text-fg [&::-webkit-details-marker]:hidden" title={v.text}>
                <span aria-hidden className="h-[5px] w-[5px] shrink-0 -translate-y-[2px] rounded-full bg-warn" />
                <span className="min-w-0 flex-1">{head}</span>
                {head !== v.text && <span aria-hidden className="shrink-0 text-[10px] text-fg-faint transition-transform group-open:rotate-90">›</span>}
              </summary>
              {head !== v.text && <p className="mt-0.5 pl-[11px] text-[11.5px] text-fg-muted">{v.text}</p>}
            </details>
            {detail && Array.isArray(detail) && detail.length > 0 && <ul data-duplicates className="flex flex-col pl-[11px] text-[11px] text-fg-muted">{detail}</ul>}
          </li>
        )
      })}
    </ul>
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

// --- the body: sections stacked under headers (owner's pick, 2026-10-13) ---

function Body({ f, now, owner, onStopped }: { f: Footprint; now: number; owner: boolean; onStopped: () => void }) {
  const io = ioLines(f)
  return (
    <>
      <Warnings f={f} />
      <Orphans f={f} owner={owner} onStopped={onStopped} />
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
    </>
  )
}

// --- orphans: what looks abandoned, and the Advanced stop (ADR-059) --------

/**
 * Processes on this machine that look abandoned, each with why. Read-only
 * until *Advanced* is switched on (off by default, on the computer itself
 * only): then each gets a checkbox and a Stop, and nothing is stopped
 * without a second click on the confirmation. The daemon scans again and
 * signals only what that scan lists with the start time shown here.
 */
export function Orphans({ f, owner, onStopped }: { f: Footprint; owner: boolean; onStopped?: () => void }) {
  const o = f.orphans
  const [advanced, setAdvanced] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(() => new Set())
  const [confirm, setConfirm] = useState<number[]>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  if (!o) return null
  const list = o.list ?? []
  const byPid = new Map(list.map((x) => [x.pid, x]))
  const chosen = [...picked].filter((p) => byPid.has(p))
  const toggle = (pid: number) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(pid)) n.delete(pid)
    else n.add(pid)
    return n
  })
  const stop = async (pids: number[]) => {
    const targets = pids.flatMap((p) => {
      const x = byPid.get(p)
      return x ? [{ pid: p, started_at: x.started_at }] : []
    })
    if (!targets.length) { setConfirm(undefined); return }
    setBusy(true)
    setNote(undefined)
    try {
      const r: OrphanStopResult = await api.stopOrphans(targets)
      const ok = r.stopped ?? []
      const bad = r.failed ?? []
      setNote([ok.length ? `Stopped ${ok.map((x) => `${x.label} (pid ${x.pid})`).join(', ')}.` : '', ...bad.map((x) => `pid ${x.pid} not stopped: ${x.error}.`)].filter(Boolean).join(' '))
      setPicked(new Set())
      onStopped?.()
    } catch (e) {
      setNote(errText(e))
    } finally {
      setBusy(false)
      setConfirm(undefined)
    }
  }
  const count = o.scanned ? list.length : o.count
  const canStop = advanced && owner
  return (
    <section data-orphans className="flex flex-col gap-1">
      <Header title="Orphans" right={
        <span className="flex items-baseline gap-2">
          {owner && list.length > 0 && (
            <label className="flex cursor-pointer items-center gap-1 text-[11px] font-normal normal-case tracking-normal text-fg-muted" title="Show a Stop for each process. Off by default; nothing is stopped without your click.">
              <input type="checkbox" data-advanced checked={advanced} onChange={(e) => { setAdvanced(e.target.checked); setConfirm(undefined) }} className="h-3 w-3 accent-accent" />
              Advanced
            </label>
          )}
          <span className={`num font-semibold ${strayCount(o) ? 'text-warn' : ''}`}>{count}</span>
        </span>
      } />
      {!o.scanned && <p className="text-[11.5px] text-fg-muted">{o.count ? `${plural(o.count, 'process', 'processes')} at the last check; looking now…` : 'Looking…'}</p>}
      {o.scanned && list.length === 0 && <p data-orphans-none className="text-[11.5px] text-fg-muted">Nothing looks abandoned.</p>}
      {list.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {list.map((x) => (
            <OrphanRow key={x.pid} o={x} at={f.at} advanced={canStop} picked={picked.has(x.pid)} busy={busy}
              onPick={() => toggle(x.pid)} onStop={() => setConfirm([x.pid])} />
          ))}
        </ul>
      )}
      {canStop && list.length > 0 && !confirm && (
        <div className="flex items-center gap-2">
          <button type="button" data-stop-selected className={BUTTON} disabled={busy || chosen.length === 0} onClick={() => setConfirm(chosen)}>
            Stop selected{chosen.length ? ` (${chosen.length})` : ''}
          </button>
          <span className="text-[11px] text-fg-faint">SIGTERM, then SIGKILL after 5 s</span>
        </div>
      )}
      {confirm && (
        <div role="alertdialog" aria-label="Stop processes" data-stop-confirm className="flex flex-col gap-1.5 rounded-[8px] border border-warn/40 bg-warn/10 px-2.5 py-1.5">
          <p className="text-[12px] text-fg">
            Stop {confirm.length === 1 ? `${byPid.get(confirm[0]!)?.label ?? 'it'} (pid ${confirm[0]})` : plural(confirm.length, 'process', 'processes')}?
            <span className="text-fg-muted"> Caprock may not have started {confirm.length === 1 ? 'it' : 'them'}; anything unsaved in {confirm.length === 1 ? 'it' : 'them'} is lost.</span>
          </p>
          <div className="flex gap-2">
            <button type="button" data-stop-confirm-yes className={`${BUTTON} text-warn`} disabled={busy} onClick={() => void stop(confirm)}>{busy ? 'Stopping…' : 'Stop'}</button>
            <button type="button" data-stop-confirm-no className={BUTTON} disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button>
          </div>
        </div>
      )}
      {note && <p role="status" data-orphans-note className="text-[11.5px] text-fg-muted">{note}</p>}
      {o.note && o.scanned && <p className="text-[11px] text-fg-faint">{o.note}</p>}
    </section>
  )
}

function OrphanRow({ o, at, advanced, picked, busy, onPick, onStop }: {
  o: Orphan
  at: number
  advanced: boolean
  picked: boolean
  busy: boolean
  onPick: () => void
  onStop: () => void
}) {
  const where = [o.exe, o.data_dir ? `data ${o.data_dir}${o.data_dir_gone ? ' (gone)' : ''}` : ''].filter(Boolean).join(' · ')
  return (
    <li data-orphan={o.pid} data-kind={o.kind} className="flex items-start gap-1.5">
      {advanced && (
        <input type="checkbox" aria-label={`Select pid ${o.pid}`} data-orphan-pick checked={picked} onChange={onPick} disabled={busy} className="mt-[3px] h-3 w-3 shrink-0 accent-accent" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate" title={`${ORPHAN_KIND[o.kind] ?? o.kind}${where ? ` · ${where}` : ''}`}>
            <span className="mono text-fg">{o.label}</span>
            <span className="num text-fg-faint"> · pid {o.pid}</span>
          </span>
          <span className="num shrink-0 text-[11px] text-fg-faint" title="how long it has run">{age(at - o.started_at)}</span>
          <span className="num w-[6ch] shrink-0 text-right text-fg">{fmtMem(o.mem_bytes)}</span>
        </div>
        <p className="text-[11px] leading-[15px] text-fg-muted">{o.why}</p>
        {where && <p className="truncate text-[10.5px] text-fg-faint" title={where}>{where}</p>}
      </div>
      {advanced && (
        <button type="button" data-orphan-stop disabled={busy} onClick={onStop}
          className="h-[20px] shrink-0 rounded-[6px] border border-[var(--app-hairline-strong)] px-1.5 text-[11px] text-fg-muted hover:border-warn hover:text-warn disabled:opacity-50"
          title={o.auto ? 'The daemon stops this one on its own; this stops it now.' : 'Stop this process: SIGTERM, then SIGKILL after 5 s.'}>
          Stop
        </button>
      )}
    </li>
  )
}
