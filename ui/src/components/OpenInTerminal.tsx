import { useEffect, useRef, useState } from 'react'
import { api, errText, isPairedDevice, type NativeTerminal, type OpenTerminalInfo, type OpenTerminalMode, type Settings, type TerminalList } from '@/lib/api'

/**
 * Open a session in the user's own terminal application.
 *
 * The web terminal is a fine place to glance at a session and an awkward one
 * to live in (owner request, 2026-10-04). This hands the conversation to
 * Ghostty, iTerm2, Terminal or whatever is installed, running the agent's own
 * resume command in the session's folder; Caprock keeps watching it through
 * hooks and the transcript, as it does any session started by hand.
 *
 * The server decides what is allowed (rule 7 — nothing is stopped or typed
 * into unless Caprock started it), so this only renders its answer:
 *
 *  - **resume** an ended session;
 *  - **move** one Caprock is running: its process here is stopped, then the
 *    same conversation is resumed there. It stops something, so it is never
 *    what a single click does — the click opens the menu and the choice is
 *    made there;
 *  - **fork** a live one: a branch under a new id, the original runs on.
 */

let cached: Promise<TerminalList> | null = null

/** Forget the detected terminals (tests, and after the preference changes). */
export function resetTerminals() {
  cached = null
}

function useTerminals(): [TerminalList | null, (t: TerminalList) => void] {
  const [list, setList] = useState<TerminalList | null>(null)
  useEffect(() => {
    let live = true
    if (!cached) cached = api.terminals()
    cached.then((l) => live && setList(l)).catch(() => {
      cached = null
    })
    return () => {
      live = false
    }
  }, [])
  return [list, setList]
}

const verb: Record<OpenTerminalMode, (name: string) => string> = {
  resume: (n) => `Open in ${n}`,
  move: (n) => `Move to ${n}`,
  fork: (n) => `Fork into ${n}`,
}

const explain: Record<OpenTerminalMode, string> = {
  resume: 'Carries the conversation on in that window.',
  move: 'Stops it here, then carries the same conversation on there.',
  fork: 'A branch under a new id; this one keeps running.',
}

export function OpenInTerminal({
  sessionID,
  info,
  compact = false,
}: {
  sessionID: string
  info?: OpenTerminalInfo
  /** On a menu row: one small button, the choice confirmed in place. */
  compact?: boolean
}) {
  const [list, setList] = useTerminals()
  const [chosen, setChosen] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A tablet reads; opening a window on the laptop is not its to do (ADR-029).
  if (isPairedDevice() || !info || !list || list.terminals.length === 0) return null

  const termID = chosen || list.preferred
  const term: NativeTerminal = list.terminals.find((t) => t.id === termID) ?? list.terminals[0]!
  const modes = info.modes
  const primary = modes[0]
  const needsChoice = modes.includes('move')

  async function run(mode: OpenTerminalMode) {
    setBusy(true)
    setError('')
    setDone('')
    setOpen(false)
    setConfirm(false)
    try {
      const res = await api.openTerminal(sessionID, { terminal: term.id, mode })
      setDone(`opened in ${res.terminal.name || term.name}`)
      window.setTimeout(() => setDone(''), 4000)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function prefer(id: string) {
    setChosen(id)
    const next = { ...list!, preferred: id }
    setList(next)
    cached = Promise.resolve(next)
    try {
      await api.saveSettings({ terminal: id } as Settings)
    } catch {
      /* the choice still holds for this page */
    }
  }

  if (compact) {
    if (!primary) {
      return <span className="text-[11px] text-fg-faint" title={info.reason}>↗</span>
    }
    const label = confirm ? `${primary === 'move' ? 'move' : 'open'}?` : '↗'
    return (
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            if (needsChoice && !confirm) {
              setConfirm(true)
              return
            }
            void run(primary)
          }}
          title={`${verb[primary](term.name)} — ${explain[primary]}`}
          aria-label={verb[primary](term.name)}
          className="text-[11px] text-fg-muted hover:text-accent border border-transparent hover:border-border rounded-sm px-1 disabled:opacity-50"
        >
          {busy ? '…' : label}
        </button>
        {error && <span className="text-[11px] text-danger truncate max-w-[10rem]" title={error}>failed</span>}
      </span>
    )
  }

  const button = 'text-[11px] border px-1.5 rounded-sm disabled:opacity-50'
  return (
    <span ref={ref} className="relative inline-flex items-center gap-2">
      <span className="inline-flex items-stretch">
        <button
          type="button"
          disabled={busy || !primary}
          onClick={() => (needsChoice ? setOpen((o) => !o) : primary && run(primary))}
          title={primary ? `${verb[primary](term.name)} — ${explain[primary]}` : info.reason}
          className={`${button} border-accent text-accent hover:bg-accent/10 rounded-r-none`}
        >
          {busy ? 'opening…' : `Open in ${term.name} ↗`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Other terminals and ways to open"
          className={`${button} border-accent text-accent hover:bg-accent/10 border-l-0 rounded-l-none`}
        >
          ▾
        </button>
      </span>
      {!primary && info.reason && <span className="text-[11px] text-fg-faint truncate max-w-[24rem]" title={info.reason}>{info.reason}</span>}
      {done && <span className="text-[11px] text-ok">{done}</span>}
      {error && <span className="text-[11px] text-danger">{error}</span>}
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-[19rem] max-w-[90vw] bg-panel border border-border rounded-sm shadow-lg py-1 text-left">
          {modes.length > 0 && (
            <>
              <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-[0.08em] text-fg-faint">open</div>
              {modes.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="menuitem"
                  onClick={() => run(m)}
                  className="w-full text-left px-3 py-1.5 hover:bg-panel-2"
                >
                  <div className="text-[12px] text-fg">{verb[m](term.name)} ↗</div>
                  <div className="text-[11px] text-fg-faint">{explain[m]}</div>
                </button>
              ))}
            </>
          )}
          {modes.length === 0 && info.reason && <div className="px-3 py-1.5 text-[11px] text-fg-muted">{info.reason}</div>}
          {list.terminals.length > 1 && (
            <>
              <div className="px-3 pt-2 pb-1 mt-1 border-t border-border text-[10px] uppercase tracking-[0.08em] text-fg-faint">terminal</div>
              {list.terminals.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={t.id === term.id}
                  onClick={() => prefer(t.id)}
                  className="w-full flex items-center gap-2 px-3 py-1 text-[12px] hover:bg-panel-2"
                >
                  <span className="w-3 text-accent">{t.id === term.id ? '✓' : ''}</span>
                  <span className={t.id === term.id ? 'text-fg' : 'text-fg-muted'}>{t.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </span>
  )
}
