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

/** Each mode in the chip's words, and in the menu's. */
const CHIP: Record<string, string> = {
  default: 'asks first',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  bypassPermissions: 'bypass',
  auto: 'auto mode',
  dontAsk: "don't ask",
}

const MENU: Record<string, string> = {
  default: 'Manual · asks first',
  acceptEdits: 'Accept edits · asks before commands',
  plan: 'Plan · changes nothing',
  bypassPermissions: 'Bypass · never asks',
  auto: 'Auto · if your plan has it',
  dontAsk: "Don't ask · denies what isn't allowed",
}

/** The chip's tone: bypass in the danger colour, as Claude Code draws it. */
function tone(mode: string): string {
  if (mode === 'bypassPermissions' || mode === 'dontAsk') return 'border-danger/60 text-danger'
  if (mode === 'plan') return 'border-accent/60 text-accent'
  return 'border-border text-fg-muted'
}

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
          const width = Math.min(300, window.innerWidth - 32)
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
        <span role="menu" aria-label="Permission mode" style={at ? { top: at.top, left: at.left } : undefined}
          className="fixed z-50 grid max-h-[calc(100vh-80px)] w-[min(300px,calc(100vw-32px))] gap-1 overflow-y-auto whitespace-normal rounded-[8px] border border-border-strong bg-panel p-2 text-[12px] shadow-lg">
          {confirm ? (
            <span className="grid gap-2 p-1">
              {needsConsent && <BypassConsentNote button="Accept and restart" />}
              <span className="text-fg">
                Restart in {MENU[confirm] ?? confirm}?
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
              {prompt && <span className="px-1 pb-1 text-[11.5px] text-fg-muted">The session is asking something; answer it first.</span>}
              <span className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">In this session · Shift+Tab</span>
              {inSession.map((m) => (
                <button key={m} type="button" role="menuitemradio" aria-checked={m === mode} disabled={busy || prompt || m === mode}
                  onClick={() => run(m, false)}
                  className="flex items-center gap-2 rounded-[5px] px-1.5 py-1 text-left hover:bg-panel-2 disabled:cursor-default disabled:hover:bg-transparent aria-checked:text-fg disabled:[&:not([aria-checked=true])]:opacity-50">
                  <span aria-hidden className="w-3 text-accent">{m === mode ? '✓' : ''}</span>
                  {MENU[m] ?? m}
                </button>
              ))}
              {restart.length > 0 && (
                <>
                  <span className="mt-1 px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Needs a restart</span>
                  {restart.map((m) => (
                    <button key={m} type="button" role="menuitem" disabled={busy || prompt || working}
                      onClick={() => setConfirm(m)}
                      title={working ? 'The agent is working; restart it when the turn has ended.' : 'Stops this process and resumes the same conversation in a new one'}
                      className="flex items-center gap-2 rounded-[5px] px-1.5 py-1 text-left hover:bg-panel-2 disabled:opacity-50 disabled:hover:bg-transparent">
                      <span aria-hidden className="w-3" />
                      Restart in {MENU[m] ?? m}
                    </button>
                  ))}
                  {working && <span className="px-1 text-[11px] text-fg-faint">The agent is working: restart when its turn ends.</span>}
                </>
              )}
            </>
          )}
        </span>
      )}
    </span>
  )
}
