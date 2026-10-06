import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { api, ApiError, errText, type Permission, type PermissionChoice } from '@/lib/api'
import { live, useLive } from '@/lib/live'
import { useCanControl } from '@/lib/useCanControl'

/**
 * The permission prompt a session waits on: from GET on mount and on every
 * reconnect of the live socket, then from its "permission" frames.
 */
export function usePermission(sessionId: string): [Permission | null, (p: Permission | null) => void] {
  const [prompt, setPrompt] = useState<Permission | null>(null)
  const { conn } = useLive()
  useEffect(() => {
    if (conn !== 'open') return
    let alive = true
    api.permission(sessionId)
      .then((r) => { if (alive) setPrompt(r.permission) })
      .catch(() => { /* an older daemon, or the session is gone: no buttons */ })
    return () => { alive = false }
  }, [sessionId, conn])
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'permission' && f.data.session_id === sessionId) setPrompt(f.data.permission)
  }), [sessionId])
  return [prompt, setPrompt]
}

/**
 * Buttons for a Claude Code permission prompt (ADR-035).
 *
 * The terminal draws the same menu, answered with arrows and Enter — fine at a
 * desk, a guessing game on a phone. Here it is the command or file being asked
 * about, in full, and one button per answer. A viewer sees what is being asked
 * and no buttons.
 */
export function PermissionPrompt({ sessionId }: { sessionId: string }) {
  const [prompt, setPrompt] = usePermission(sessionId)
  const canControl = useCanControl()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => { setError('') }, [prompt?.id])

  const answer = useCallback(async (choice: PermissionChoice) => {
    if (!prompt) return
    setBusy(true)
    setError('')
    try {
      await api.answerPermission(sessionId, prompt.id, choice)
      setPrompt(null)
    } catch (err) {
      // 409: answered in the terminal, or it is not the dialog on screen. The
      // live frame brings the one that is; this one is gone either way. 422:
      // the menu on the screen has no such option — the daemon typed nothing,
      // the prompt still waits, and the reason is shown.
      if (err instanceof ApiError && err.status === 409) setPrompt(null)
      else setError(errText(err))
    } finally {
      setBusy(false)
    }
  }, [prompt, sessionId, setPrompt])

  usePromptKeys(card, !!prompt && canControl && !busy, !!prompt?.always, answer)
  if (!prompt) return null

  const button = 'min-h-[48px] rounded-sm px-4 py-2 text-[15px] font-medium disabled:opacity-50'
  return (
    <div ref={card} role="alertdialog" aria-label="Permission prompt" className="grid gap-2 border border-accent/60 bg-accent/10 rounded-sm px-3 py-3 mt-2">
      <p className="text-[13px] text-fg">
        Claude wants to use <span className="mono font-medium">{prompt.tool}</span>
        {!!prompt.queued && <span className="text-fg-muted"> · {prompt.queued} more waiting</span>}
      </p>
      {prompt.detail && (
        <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-panel-2 px-2 py-1.5 text-[12px] text-fg">
          {prompt.detail}
        </pre>
      )}
      {canControl ? (
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <button type="button" disabled={busy} onClick={() => void answer('allow')} aria-keyshortcuts="Y Enter" className={`${button} bg-accent text-bg hover:brightness-110`}>
            Yes <Key>↵</Key>
          </button>
          {prompt.always && (
            <button type="button" disabled={busy} onClick={() => void answer('always')} aria-keyshortcuts="A" className={`${button} border border-accent text-fg hover:bg-accent/15`}>
              {prompt.always} <Key>A</Key>
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void answer('deny')} aria-keyshortcuts="N Escape" className={`${button} border border-border-strong text-fg hover:border-danger hover:text-danger`}>
            No <Key>Esc</Key>
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-fg-muted">Waiting for an answer on a device that controls sessions.</p>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

/** The key that presses a button, drawn on it; not part of its name. */
function Key({ children }: { children: string }) {
  return (
    <kbd aria-hidden className="ml-1.5 rounded-[3px] border border-current/40 px-1 font-sans text-[11px] font-normal opacity-70">
      {children}
    </kbd>
  )
}

/**
 * The cards that want the keyboard, newest last: only the newest answers a
 * key, so two cards on one page never both take the same Y.
 */
const keyed: symbol[] = []

/** Focus is somewhere a key means typing: a field, an editor, a terminal. */
function typingInto(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el.closest('.xterm, [data-term-host]')) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Keys for the card (owner, 2026-10-06): Y or Enter is Yes, A the always
 * option when there is one, N or Esc is No.
 *
 * Never from a focused terminal, field or editor — a key meant for the
 * terminal must reach the terminal, and the web Session page draws the card
 * under one. Enter and Esc only when focus is on nothing in particular (the
 * page) or inside the card: on another button Enter presses that button, and
 * Esc closes whatever else is open. Not while a dialog of the page's own is
 * open, nor from a card that is hidden (a background tab), and only the
 * newest card on the page listens.
 */
function usePromptKeys(
  card: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  hasAlways: boolean,
  answer: (c: PermissionChoice) => void,
) {
  useEffect(() => {
    if (!enabled) return
    const me = Symbol('permission-card')
    keyed.push(me)
    const onKey = (e: KeyboardEvent) => {
      if (keyed[keyed.length - 1] !== me) return
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      const el = card.current
      if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]')) return
      const active = document.activeElement
      if (typingInto(active)) return
      const modal = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some((d) => !d.closest('[hidden]'))
      if (modal) return
      const onPage = !active || active === document.body || el.contains(active)
      let choice: PermissionChoice | null = null
      switch (e.key) {
        case 'y': case 'Y': choice = 'allow'; break
        case 'a': case 'A': choice = hasAlways ? 'always' : null; break
        case 'n': case 'N': choice = 'deny'; break
        case 'Enter':
          // A button of the card that has focus presses itself.
          if (onPage && !(active instanceof HTMLButtonElement)) choice = 'allow'
          break
        case 'Escape': if (onPage) choice = 'deny'; break
      }
      if (!choice) return
      e.preventDefault()
      answer(choice)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = keyed.indexOf(me)
      if (i >= 0) keyed.splice(i, 1)
    }
  }, [card, enabled, hasAlways, answer])
}
