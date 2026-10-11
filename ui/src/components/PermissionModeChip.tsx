/**
 * A session's permission mode, as a chip, and for a Claude Code session
 * Caprock started, the way to change it while it runs (ADR-054).
 *
 * What Claude Code allows decides the menu (read from 2.1.296):
 *
 *  - Shift+Tab cycles a live session through default → accept edits → plan
 *    → bypass (only in a process started able to reach it) → auto (only if
 *    the account has it). Those are "in this session": the daemon presses
 *    Shift+Tab one at a time and reads the footer after each, so the chip
 *    says what the session really is in, or why it did not get there.
 *  - Bypass in a process that was not started able to reach it, and
 *    "don't ask", need a new process: "Restart in …" resumes the same
 *    conversation under its own id with the new flag, in the same tab. It
 *    asks first, and only when the agent is at its prompt; bypass needs the
 *    one-time consent (ADR-041) like any bypass start.
 *
 * A session Caprock did not start shows its mode read-only: Caprock never
 * types into a process it did not start (rule 7), so it changes in that
 * terminal. Codex, OpenCode and the rest show nothing: their mode is not read.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errText, isPairedDevice, type PermissionModeView } from '@/lib/api'
import { live } from '@/lib/live'
import { useCanControl } from '@/lib/useCanControl'
import { BypassConsentNote } from './BypassConsent'
import { keys } from '@/lib/appkeys'

/** Each mode in the chip's words, and in the menu's. */
const CHIP: Record<string, string> = {
  default: 'asks first',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  bypassPermissions: 'bypass',
  auto: 'auto mode',
  dontAsk: "don't ask",
}

/** Each mode in the menu: its name, and what it does on a line of its own. */
const MODE: Record<string, { name: string; does: string }> = {
  default: { name: 'Manual', does: 'Asks before every edit and command' },
  acceptEdits: { name: 'Accept edits', does: 'Edits files freely; asks before commands' },
  plan: { name: 'Plan', does: 'Reads and plans; changes nothing' },
  bypassPermissions: { name: 'Bypass', does: 'Never asks: runs any command' },
  auto: { name: 'Auto', does: 'Decides when to ask, if your plan has it' },
  dontAsk: { name: "Don't ask", does: "Denies whatever isn't already allowed" },
}

/** The modes that take the guard off are drawn in the warning colour. */
function risky(m: string): boolean {
  return m === 'bypassPermissions' || m === 'dontAsk'
}

/** A small mark per mode, so the rows are told apart before they are read. */
function ModeIcon({ mode }: { mode: string }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (mode) {
    case 'default': // a hand raised: asks first
      return <svg {...common}><path d="M5.5 8V3.5a1 1 0 0 1 2 0V7m0-4.5a1 1 0 0 1 2 0V7m0-3.5a1 1 0 0 1 2 0V9.5c0 2.5-1.7 4.5-4 4.5S3.5 12.3 3 10.5L2.5 8.8a1 1 0 0 1 1.8-.8L5.5 9.5" /></svg>
    case 'acceptEdits': // a pencil with a check
      return <svg {...common}><path d="M9.5 3.5l3 3L6 13H3v-3z" /><path d="M10 14l1.5 1.2L14.5 12" /></svg>
    case 'plan': // a list
      return <svg {...common}><path d="M6 4h7M6 8h7M6 12h7" /><circle cx="3" cy="4" r=".6" fill="currentColor" /><circle cx="3" cy="8" r=".6" fill="currentColor" /><circle cx="3" cy="12" r=".6" fill="currentColor" /></svg>
    case 'bypassPermissions': // a lightning bolt
      return <svg {...common}><path d="M9 1.5L3.5 9h4l-1 5.5L12.5 7h-4z" /></svg>
    case 'auto': // a sparkle
      return <svg {...common}><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" /><path d="M13 11.5v3M11.5 13h3" /></svg>
    case 'dontAsk': // a shield struck through
      return <svg {...common}><path d="M8 1.5l5 2v4c0 3-2.2 5.6-5 7-2.8-1.4-5-4-5-7v-4z" /><path d="M3 3l10 10" /></svg>
    default:
      return <svg {...common}><circle cx="8" cy="8" r="5" /></svg>
  }
}

/**
 * One mode as a row of the menu: the name large with its mark, what it does
 * on the line under it, and when the row cannot be picked, why, on a line of
 * its own (owner, 2026-10-12: "great, but hard to read").
 */
function ModeRow({ mode, current, disabled, reason, restart, onPick, title }: {
  mode: string
  current?: boolean
  disabled: boolean
  reason?: string
  restart?: boolean
  onPick: () => void
  title?: string
}) {
  const v = MODE[mode] ?? { name: mode, does: '' }
  const off = disabled && !current
  return (
    <button type="button" role={restart ? 'menuitem' : 'menuitemradio'} aria-checked={restart ? undefined : !!current}
      disabled={disabled} onClick={onPick} title={title} data-mode-row={mode}
      aria-label={[`${restart ? 'Restart in ' : ''}${v.name}`, v.does, reason].filter(Boolean).join('. ')}
      className={`grid grid-cols-[18px_minmax(0,1fr)] items-start gap-x-2.5 rounded-[7px] border-l-[3px] py-2 pl-2 pr-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
        current ? 'border-accent bg-accent/10' : 'border-transparent'} ${off ? 'cursor-not-allowed' : current ? 'cursor-default' : 'hover:bg-panel-2'}`}>
      <span className={`mt-[2px] ${risky(mode) ? 'text-warn' : current ? 'text-accent' : off ? 'text-fg-muted' : 'text-fg'}`}><ModeIcon mode={mode} /></span>
      <span className="grid min-w-0 gap-0.5">
        <span data-mode-name className={`flex items-baseline gap-2 text-[15px] font-semibold leading-tight ${off ? 'text-fg-muted' : 'text-fg'}`}>
          {restart ? `Restart in ${v.name}` : v.name}
          {current && <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-accent">now</span>}
        </span>
        {v.does && <span data-mode-desc className="text-[13px] leading-snug text-fg-muted">{v.does}</span>}
        {reason && <span data-mode-reason className="text-[12px] leading-snug text-fg-muted">{reason}</span>}
      </span>
    </button>
  )
}

/** The chip's tone: bypass in the danger colour, as Claude Code draws it. */
function tone(mode: string): string {
  if (mode === 'bypassPermissions' || mode === 'dontAsk') return 'border-danger/60 text-danger'
  if (mode === 'plan') return 'border-accent/60 text-accent'
  return 'border-border text-fg-muted'
}

/** The menu's width: room for a mode's name and its one-line explanation. */
const MENU_W = 340

/** How long after a live event the mode is read again, at most once. */
const REFRESH_MS = 2_500

/**
 * The mode of a session, read on open and again shortly after its events
 * and prompts change (each hook carries the mode, and a switch in the
 * terminal shows on its footer). Undefined until the daemon has answered.
 */
export function usePermissionMode(sessionId: string, enabled = true): [PermissionModeView | undefined, (v: PermissionModeView) => void, () => void] {
  const [view, setView] = useState<PermissionModeView | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    api.permissionMode(sessionId)
      .then((v) => { if (alive && v && typeof v.mode === 'string') setView(v) })
      .catch(() => { /* an older daemon: no chip */ })
    return () => { alive = false }
  }, [sessionId, enabled, tick])
  useEffect(() => {
    if (!enabled) return
    const off = live.onFrame((f) => {
      const id = f.type === 'event' ? f.data.session_id : f.type === 'permission' || f.type === 'queue' ? f.data.session_id : ''
      if (id !== sessionId || pending.current) return
      pending.current = setTimeout(() => { pending.current = undefined; setTick((t) => t + 1) }, REFRESH_MS)
    })
    return () => {
      off()
      if (pending.current) { clearTimeout(pending.current); pending.current = undefined }
    }
  }, [sessionId, enabled])
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return [view, setView, refresh]
}

export function PermissionModeChip({ sessionId, agent, enabled = true }: { sessionId: string; agent?: string; enabled?: boolean }) {
  const claude = (agent ?? 'claude') === 'claude'
  const [view, setView, refresh] = usePermissionMode(sessionId, enabled && claude)
  const canControl = useCanControl()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState('')
  const ref = useRef<HTMLSpanElement>(null)
  // Where the menu opens: fixed under the chip, because the chip can sit in
  // a row that scrolls sideways (a phone's header), which would clip it.
  const [at, setAt] = useState<{ top: number; left: number } | undefined>(undefined)
  // Whether the bypass warning was accepted on this machine: asked only when
  // a bypass restart is about to be confirmed.
  const [accepted, setAccepted] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (confirm !== 'bypassPermissions') return
    let alive = true
    api.status()
      .then((st) => { if (alive) setAccepted((st as { claude_bypass_accepted?: boolean }).claude_bypass_accepted) })
      .catch(() => {})
    return () => { alive = false }
  }, [confirm])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) { setOpen(false); setConfirm('') } }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setConfirm('') } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  if (!claude || !view || (!view.mode && !view.switchable)) return null
  const mode = view.mode
  const label = CHIP[mode] ?? (mode || 'mode unknown')

  if (!view.switchable || !canControl) {
    return (
      <span
        data-permission-mode={mode}
        title={view.switchable
          ? 'The permission mode. A phone that only views cannot change it.'
          : "The permission mode, as this session's hooks last said. Caprock did not start it, so it changes only in its own terminal: Shift+Tab there."}
        className={`inline-flex items-center rounded-[6px] border px-1.5 text-[11px] ${tone(mode)}`}
      >
        {label}
      </span>
    )
  }

  const inSession = view.in_session ?? []
  const restart = view.restart ?? []
  const prompt = view.waiting === 'permission' || view.waiting === 'question'
  const working = view.waiting === 'turn'
  const needsConsent = confirm === 'bypassPermissions' && !isPairedDevice() && accepted === false

  async function run(target: string, viaRestart: boolean) {
    setBusy(true)
    setNote('')
    try {
      if (viaRestart && needsConsent) await api.acceptBypass()
      const v = await api.setPermissionMode(sessionId, target, viaRestart)
      setView(v)
      setOpen(false)
      setConfirm('')
      if (v.mode && v.mode !== target) setNote(`now ${CHIP[v.mode] ?? v.mode}`)
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string; mode?: string } | undefined) : undefined
      if (body?.mode) setView({ ...view!, mode: body.mode })
      setNote(errText(e))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <span ref={ref} className="relative inline-flex items-center gap-1.5">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission mode: ${label}. Change it`}
        data-permission-mode={mode}
        disabled={busy}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const width = Math.min(MENU_W, window.innerWidth - 32)
          setAt({ top: r.bottom + 4, left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) })
          setOpen((o) => !o)
          setConfirm('')
          setNote('')
        }}
        title="The permission mode this session runs in. Click to change it."
        className={`inline-flex items-center gap-1 rounded-[6px] border px-1.5 text-[11px] hover:text-fg disabled:opacity-50 ${tone(mode)}`}
      >
        {busy ? 'switching…' : label}
        <span aria-hidden className="text-[9px]">▾</span>
      </button>
      {note && <span role="status" className="max-w-[28ch] truncate text-[11px] text-fg-muted" title={note}>{note}</span>}
      {open && (
        <span role="menu" aria-label="Permission mode" style={at ? { top: at.top, left: at.left, maxHeight: `max(160px, calc(100vh - ${Math.round(at.top)}px - 16px))` } : undefined}
          className="fixed z-50 grid max-h-[calc(100vh-80px)] w-[min(340px,calc(100vw-32px))] content-start gap-1 overflow-y-auto whitespace-normal rounded-[10px] border border-border-strong bg-panel p-2 text-[13px] shadow-lg">
          {confirm ? (
            <span className="grid gap-2 p-1">
              {needsConsent && <BypassConsentNote button="Accept and restart" />}
              <span className="text-fg">
                Restart in {MODE[confirm]?.name ?? confirm}?
              </span>
              <span className="text-[11.5px] leading-relaxed text-fg-muted">
                This process stops and the same conversation is resumed in a new one, in this tab. Nothing is lost
                from the conversation; a command still running in it is stopped.
              </span>
              <span className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => run(confirm, true)}
                  className="rounded-sm border border-accent bg-accent/15 px-2 py-0.5 text-accent hover:bg-accent/25 disabled:opacity-50">
                  {needsConsent ? 'Accept and restart' : 'Restart'}
                </button>
                <button type="button" onClick={() => setConfirm('')} className="px-2 py-0.5 text-fg-muted hover:text-fg">Cancel</button>
              </span>
            </span>
          ) : (
            <>
              {prompt && <span className="rounded-[6px] bg-panel-2 px-2.5 py-2 text-[13px] text-fg">The session is asking something; answer it first.</span>}
              <span className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Switch now ({keys('Shift+Tab')})</span>
              {inSession.map((m) => (
                <ModeRow key={m} mode={m} current={m === mode} disabled={busy || prompt || m === mode} onPick={() => run(m, false)} />
              ))}
              {restart.length > 0 && (
                <>
                  <span className="mt-2 border-t border-border px-2 pb-0.5 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Needs a restart</span>
                  {restart.map((m) => (
                    <ModeRow key={m} mode={m} restart disabled={busy || prompt || working} onPick={() => setConfirm(m)}
                      reason={working ? 'The agent is working: restart when its turn ends.' : undefined}
                      title="Stops this process and resumes the same conversation in a new one" />
                  ))}
                </>
              )}
            </>
          )}
        </span>
      )}
    </span>
  )
}
