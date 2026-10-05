/**
 * The menu bar popover (macOS): a click on Caprock's menu bar icon shows this
 * page in a small borderless window under the icon (app/src-tauri/src/tray.rs).
 * What needs you first — a prompt to answer, a turn that ended — then what
 * is running, the plan windows and today's spend. A row opens its session in
 * the main window; Escape or a click elsewhere hides the popover.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, ApiError, errText, type PermissionChoice } from '@/lib/api'
import { isMacPlatform, isTauri } from '@/lib/appmode'
import { formatAccelerator } from '@/lib/accelerator'
import { fmtUSD } from '@/lib/format'
import { useLiveLink, live } from '@/lib/live'
import { shell } from '@/lib/shell'
import { buildPopover, usePopoverData, type ApprovalRow, type LimitRow, type SessionRow } from '@/lib/traydata'
import { useNow } from '@/lib/useNow'
import { AgentGlyph, CaprockMark } from '@/components/AppIcons'
import { ConnectionState } from '@/components/ConnectionState'
import { StatusDot, fmtCostShort } from '@/components/ProjectRow'
import { dotOf } from '@/lib/sidebar'

const DEFAULT_HOTKEY = 'control+alt+super+KeyC'
const HEADER_H = 40
const FOOTER_H = 42

function hide() {
  shell.trayHide().catch(() => { /* in a browser: nothing to hide */ })
}

function open(session?: string) {
  if (isTauri()) {
    shell.trayOpen(session).catch(() => { /* an older shell */ })
    return
  }
  // A browser preview of the page: the workspace in the same tab.
  location.hash = session ? `#/session/${encodeURIComponent(session)}` : '#/app'
}

/** Arrow keys move between the popover's rows and buttons, as in a menu. */
function onArrows(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tray-item]')]
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[at < 0 ? 0 : next]?.focus()
}

export default function TrayPanel() {
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-app', '')
    root.setAttribute('data-tray', '')
    if (isTauri()) root.setAttribute('data-tauri', '')
    // The window's theme follows the main window's choice as it changes.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'caprock-theme' && (e.newValue === 'dark' || e.newValue === 'light')) {
        root.setAttribute('data-theme', e.newValue)
        root.style.colorScheme = e.newValue
      }
    }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('storage', onStorage)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  return <PopoverView />
}

export function PopoverView() {
  const data = usePopoverData()
  const now = useNow(30_000)
  const model = useMemo(
    () => buildPopover({ sessions: data.sessions, permissions: data.permissions, summary: data.summary, now }),
    [data.sessions, data.permissions, data.summary, now],
  )
  const link = useLiveLink()
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY)
  const [hotkeyOff, setHotkeyOff] = useState(false)
  useEffect(() => {
    shell.hotkeyStatus()
      .then((s) => { setHotkey(s.accelerator ?? s.default); setHotkeyOff(s.accelerator === null) })
      .catch(() => { /* the default is shown */ })
  }, [])
  // The window is as tall as what it shows, up to the shell's maximum; past
  // that the middle scrolls.
  const content = useRef<HTMLDivElement>(null)
  const band = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = content.current
    if (!el || !isTauri()) return
    let last = 0
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(HEADER_H + FOOTER_H + el.offsetHeight + 8 + (band.current?.offsetHeight ?? 0))
      if (h !== last) { last = h; shell.trayFit(h).catch(() => { /* an older shell */ }) }
    })
    ro.observe(el)
    if (band.current) ro.observe(band.current)
    return () => ro.disconnect()
  }, [data.loaded])
  const working = model.live.filter((r) => dotOf(r.session, false) === 'working').length

  return (
    <div
      // Under the window's vibrancy in the shell a light tint is enough; a
      // browser preview gets the panel's own ground.
      className={`flex h-dvh min-h-0 flex-col text-fg ${isTauri() ? 'bg-[color-mix(in_srgb,var(--color-panel)_55%,transparent)]' : 'bg-panel'}`}
      onKeyDown={onArrows}
    >
      <header className="flex h-[40px] shrink-0 items-center gap-2 px-4">
        <CaprockMark size={15} />
        <span className="text-[13px] font-semibold tracking-[-0.01em]">Caprock</span>
        <ConnectionState link={link} heardAt={live.heardAt} className="ml-auto text-[11px] text-fg-muted" />
      </header>

      <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div ref={content}>
        {!data.loaded ? (
          <div className="h-[72px]" />
        ) : model.calm ? (
          <Calm working={working} />
        ) : (
          <Section title="Needs you" count={model.approvals.length + model.waiting.length}>
            {model.approvals.map((a) => <Approval key={a.session.session_id} row={a} onDone={data.refresh} />)}
            {model.waiting.map((r) => <SessionLine key={r.session.session_id} row={r} waiting />)}
          </Section>
        )}

        {model.live.length > 0 && (
          <Section title="Running" count={model.live.length + model.moreLive}>
            {model.live.map((r) => <SessionLine key={r.session.session_id} row={r} />)}
            {model.moreLive > 0 && (
              <button type="button" data-tray-item onClick={() => open()} className="app-row w-full rounded-[8px] px-2.5 py-1.5 text-left text-[12px] text-fg-muted">
                {model.moreLive} more in Caprock
              </button>
            )}
          </Section>
        )}

        </div>
      </div>

      {(model.limits.length > 0 || model.today !== undefined) && (
        <section ref={band} aria-label="Plan and spend" className="shrink-0 border-t border-[var(--app-hairline)] px-4 pb-3 pt-2.5">
          {model.today !== undefined && (
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[12px] text-fg-muted">Today, every agent</span>
              <span className="num text-[15px] font-semibold tracking-[-0.01em] text-fg">{fmtUSD(model.today)}</span>
            </div>
          )}
          {model.limits.length > 0 && (
            <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
              {model.limits.map((l) => <LimitBar key={`${l.agent}-${l.label}`} row={l} />)}
            </div>
          )}
        </section>
      )}

      <footer className="flex h-[42px] shrink-0 items-center gap-2 border-t border-[var(--app-hairline)] px-2">
        <button
          type="button"
          data-tray-item
          onClick={() => open()}
          className="app-row flex h-[30px] flex-1 items-center gap-2 rounded-[8px] px-2.5 text-left text-[12.5px] font-medium text-fg"
        >
          Open Caprock
          {!hotkeyOff && (
            <kbd className="mono ml-auto text-[11px] font-normal text-fg-faint">
              {formatAccelerator(hotkey, isMacPlatform() ? 'macos' : 'linux')}
            </kbd>
          )}
        </button>
      </footer>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mt-1.5 grid grid-cols-[minmax(0,1fr)] gap-1" aria-label={title}>
      <h2 className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-fg-faint">
        {title}
        {count !== undefined && count > 0 && <span className="num font-medium">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

function Calm({ working }: { working: number }) {
  return (
    <div className="mx-2 mt-2 flex items-center gap-3 rounded-[10px] border border-[var(--app-hairline)] px-3.5 py-3">
      <span aria-hidden className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-ok)_16%,transparent)] text-ok">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-fg">Nothing needs you</p>
        <p className="text-[11.5px] text-fg-muted">
          {working === 0 ? 'No agent is working right now.' : `${working} ${working === 1 ? 'agent is' : 'agents are'} working.`}
        </p>
      </div>
    </div>
  )
}

function SessionLine({ row, waiting = false }: { row: SessionRow; waiting?: boolean }) {
  const dot = waiting ? 'waiting' : dotOf(row.session, false)
  const what = waiting ? 'your turn' : row.phrase || row.title
  return (
    <button
      type="button"
      data-tray-item
      onClick={() => open(row.session.session_id)}
      title={`${row.project} · ${row.title} — open in Caprock`}
      className="app-row grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[8px] px-2.5 py-1.5 text-left"
    >
      <StatusDot dot={dot} />
      <AgentGlyph agent={row.session.agent} />
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-fg">
          <span className="font-medium">{row.project}</span>
          <span className="text-fg-muted"> · {row.title}</span>
        </span>
        <span className={`block truncate text-[11.5px] ${waiting ? 'text-accent' : 'text-fg-muted'}`}>{what}</span>
      </span>
      <span className="num flex flex-col items-end text-[11px] leading-[1.35] text-fg-muted">
        <span>{row.elapsed}</span>
        <span className="text-fg-faint">{fmtCostShort(row.cost) || ' '}</span>
      </span>
    </button>
  )
}

function Approval({ row, onDone }: { row: ApprovalRow; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const p = row.permission
  const answer = async (choice: PermissionChoice) => {
    setBusy(true)
    setNote('')
    try {
      await api.answerPermission(row.session.session_id, p.id, choice)
      onDone()
    } catch (e) {
      setNote(e instanceof ApiError && e.status === 409 ? 'Already answered.' : errText(e))
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mx-0.5 grid gap-2 rounded-[10px] border border-[var(--app-hairline-strong)] bg-[var(--app-row-hover)] px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot dot="waiting" />
        <AgentGlyph agent={row.session.agent} />
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          <span className="font-medium text-fg">{row.project}</span>
          <span className="text-fg-muted"> · {row.title}</span>
        </span>
      </div>
      <p className="text-[11.5px] text-fg-muted">
        Wants to use <span className="mono text-fg">{p.tool}</span>
      </p>
      <p
        className="mono break-all rounded-[6px] bg-[var(--app-hairline)] px-2 py-1.5 text-[11.5px] leading-snug text-fg"
        title={row.canApprove ? undefined : 'Shown in full in Caprock'}
      >
        <span className={row.canApprove ? '' : 'line-clamp-3'}>{p.detail || '—'}</span>
      </p>
      {note && <p role="status" className="text-[11.5px] text-fg-muted">{note}</p>}
      <div className="flex items-center gap-1.5">
        {row.canApprove && (
          <TrayButton primary disabled={busy} onClick={() => void answer('allow')}>Approve</TrayButton>
        )}
        <TrayButton disabled={busy} onClick={() => void answer('deny')}>Deny</TrayButton>
        <TrayButton onClick={() => open(row.session.session_id)}>{row.canApprove ? 'Open' : 'Review in Caprock'}</TrayButton>
      </div>
    </div>
  )
}

function TrayButton({ children, onClick, primary, disabled }: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      data-tray-item
      disabled={disabled}
      onClick={onClick}
      className={`h-[26px] rounded-[7px] px-2.5 text-[12px] font-medium transition-colors duration-100 disabled:opacity-50 motion-reduce:transition-none ${
        primary ? 'bg-accent text-panel hover:brightness-110' : 'border border-[var(--app-hairline-strong)] text-fg hover:bg-[var(--app-row-hover)]'
      }`}
    >
      {children}
    </button>
  )
}

function LimitBar({ row }: { row: LimitRow }) {
  const v = Math.max(0, Math.min(100, row.pct))
  const tone = row.stale ? 'bg-fg-faint' : v > 85 ? 'bg-danger' : v >= 60 ? 'bg-warn' : 'bg-ok'
  return (
    <div className="grid min-w-0 gap-1" title={row.stale ? 'Last reported a while ago: the agent has not refreshed this window' : undefined}>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="truncate text-fg-muted">{row.agent} {row.label}</span>
        <span className={`num font-medium ${row.stale ? 'text-fg-faint' : 'text-fg'}`}>{row.pct}%</span>
      </div>
      <span className="relative h-[4px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
        <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${v}%` }} />
      </span>
      <span className="truncate text-[11px] tabular-nums text-fg-faint">
        {row.stale ? 'reported a while ago' : row.resetIn ? `resets in ${row.resetIn}` : '\u00a0'}
      </span>
    </div>
  )
}
