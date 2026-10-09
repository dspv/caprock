import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { api, ApiError, errText, type Permission, type PermissionChoice } from '@/lib/api'
import { commandGist, requester, toolKind } from '@/lib/cockpit'
import { navigate } from '@/lib/router'
import { live, useLiveConn } from '@/lib/live'
import { useCanControl } from '@/lib/useCanControl'

/**
 * The permission prompt a session waits on: from GET on mount and on every
 * reconnect of the live socket, then from its "permission" frames.
 */
export function usePermission(sessionId: string): [Permission | null, (p: Permission | null) => void] {
  const [prompt, setPrompt] = useState<Permission | null>(null)
  const conn = useLiveConn()
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
 *
 * In the desktop app the card shows under the session's terminal too (owner,
 * 2026-10-07: it was hidden in 0.78.2 and he wanted it back). It is worded
 * better than the terminal's menu, and its keys work from that terminal while
 * the question waits — the owner lives in the terminal, and the mouse is the
 * wrong instrument there. It never takes focus.
 */
/**
 * `keys` is false where no terminal of this session is on the page — the
 * session screen a phone answers from — so the card names no keys it could
 * not take.
 */
export function PermissionPrompt({ sessionId, keys = true }: { sessionId: string; keys?: boolean }) {
  const [prompt, setPrompt] = usePermission(sessionId)
  const canControl = useCanControl()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => { setError('') }, [prompt?.id])

  const answer = useCallback(async (choice: PermissionChoice, id?: string) => {
    if (!prompt) return
    setBusy(true)
    setError('')
    try {
      await api.answerPermission(sessionId, id ?? prompt.id, choice)
      // Dismissing one of several leaves the rest: the live frame says which.
      if (!id || id === prompt.id) setPrompt(null)
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

  // With more than one outstanding, which dialog the terminal shows is
  // unknown, so no key and no button answers any of them (ADR-035, amended
  // 2026-10-09): the card lists them and sends the reader to the terminal.
  const several = (prompt?.waiting?.length ?? 0) > 1
  usePromptKeys(card, sessionId, !!prompt && !several && canControl && !busy, !!prompt?.always, answer)
  if (!prompt) return null
  if (several) {
    return (
      <SeveralPrompts card={card} sessionId={sessionId} prompts={prompt.waiting!} canControl={canControl} busy={busy}
        onDismiss={(id) => void answer('dismiss', id)} error={error} />
    )
  }

  const button = 'min-h-[48px] rounded-sm px-4 py-2 text-[15px] font-medium disabled:opacity-50'
  return (
    <div ref={card} role="alertdialog" aria-label="Permission prompt" className="grid gap-2 border border-accent/60 bg-accent/10 rounded-sm px-3 py-3 mt-2">
      <div className="flex items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="text-[13px] text-fg">
            <Asker p={prompt} /> wants to {toolKind(prompt.tool) === 'run' ? 'run' : 'use'} <span className="mono font-medium">{prompt.tool}</span>
          </p>
          {prompt.agent_id && (
            <p className="text-[11.5px] text-fg-muted">Not the main thread: a subagent of this session asks, in the same terminal.</p>
          )}
        </div>
        {/* For a prompt settled where no hook saw it — it timed out, or a
            check denied it — the card would otherwise stay until the turn
            ends. Hiding it types nothing. */}
        {canControl && (
          <button type="button" disabled={busy} onClick={() => void answer('dismiss')} aria-label="Hide this prompt" title="Hide — types nothing"
            className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-panel-2 hover:text-fg">
            ×
          </button>
        )}
      </div>
      {prompt.detail && <Request detail={prompt.detail} />}
      {canControl ? (
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <button type="button" disabled={busy} onClick={() => void answer('allow')} aria-keyshortcuts={keys ? "Y Enter" : undefined} className={`${button} bg-accent text-bg hover:brightness-110`}>
            Yes {keys && <Key>Y</Key>}
          </button>
          {prompt.always && (
            <button type="button" disabled={busy} onClick={() => void answer('always')} aria-keyshortcuts={keys ? "A" : undefined} className={`${button} border border-accent text-fg hover:bg-accent/15`}>
              {prompt.always} {keys && <Key>A</Key>}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void answer('deny')} aria-keyshortcuts={keys ? "N Escape" : undefined} className={`${button} border border-border-strong text-fg hover:border-danger hover:text-danger`}>
            No {keys && <Key>N</Key>}
          </button>
          {/* One question: the terminal's menu and the card answer the same
              dialog, so Enter and Esc there mean Yes and No here. */}
          {keys && (
            <p className="self-center text-[11.5px] text-fg-muted sm:ml-auto">
              Keys work from the terminal · <span className="mono" aria-hidden>↵</span> Yes · <span className="mono" aria-hidden>Esc</span> No
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-fg-muted">Waiting for an answer on a device that controls sessions.</p>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

/** Who asks, "Claude" or "Subagent (general-purpose)", the latter marked. */
function Asker({ p }: { p: Permission }) {
  const who = requester(p)
  return p.agent_id ? <span className="font-medium text-accent">{who}</span> : <>{who}</>
}

/**
 * What is being asked about: the part of a command that says what it does,
 * then the whole of it, wrapped. A long one is folded to a few lines with the
 * rest one click away — never cut to one line, as the Now line used to.
 */
function Request({ detail }: { detail: string }) {
  const { gist, more } = commandGist(detail)
  const long = detail.length > 240 || detail.split('\n').length > 4
  const [open, setOpen] = useState(!long)
  return (
    <div className="grid gap-1">
      {more && gist && (
        <p className="mono break-words text-[12.5px] font-medium text-fg" title={detail}>{gist}</p>
      )}
      <pre className={`mono overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-panel-2 px-2 py-1.5 text-[12px] text-fg ${open ? 'max-h-60' : 'max-h-[5.4em] overflow-hidden'}`} title={open ? undefined : detail}>
        {detail}
      </pre>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="justify-self-start text-[11.5px] text-fg-muted underline-offset-2 hover:text-fg hover:underline">
          {open ? 'Show less' : 'Show the whole command'}
        </button>
      )}
    </div>
  )
}

/** Brings the session's terminal forward: the one on this page, else the session's Terminal tab. */
export function openTerminal(sessionId: string) {
  const host = [...document.querySelectorAll<HTMLElement>('[data-term-session]')].find((el) => el.getAttribute('data-term-session') === sessionId)
  if (host && !host.closest('[hidden]')) {
    host.scrollIntoView({ block: 'nearest' })
    host.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    return
  }
  navigate({ name: 'session', id: sessionId, tab: 'terminal' })
}

/**
 * Two or more prompts outstanding at once — subagents asking in parallel.
 * Claude Code shows them one at a time in the terminal, and nothing says
 * which is in front, so a Yes here could approve one the reader did not read.
 * Each is listed with who asks; the answer is given in the terminal. Hiding
 * one types nothing.
 */
function SeveralPrompts({ card, sessionId, prompts, canControl, busy, onDismiss, error }: {
  card: RefObject<HTMLDivElement | null>
  sessionId: string
  prompts: Permission[]
  canControl: boolean
  busy: boolean
  onDismiss: (id: string) => void
  error: string
}) {
  return (
    <div ref={card} role="alertdialog" aria-label="Permission prompts" className="grid gap-2 border border-accent/60 bg-accent/10 rounded-sm px-3 py-3 mt-2">
      <div className="grid gap-0.5">
        <p className="text-[13px] font-medium text-fg">{prompts.length} approvals waiting</p>
        <p className="text-[11.5px] text-fg-muted">
          The terminal shows them one at a time, and Caprock cannot tell which one is in front — answer there.
        </p>
      </div>
      <ol className="grid gap-1.5">
        {prompts.map((p) => {
          const { gist } = commandGist(p.detail)
          return (
            <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-sm border border-border bg-panel-2 px-2 py-1.5">
              <div className="grid min-w-0 gap-0.5">
                <p className="text-[12.5px] text-fg"><Asker p={p} />: <span className="mono">{p.tool}</span></p>
                {gist && <p className="mono line-clamp-2 break-all text-[11.5px] text-fg-muted" title={p.detail}>{gist}</p>}
              </div>
              {canControl && (
                <button type="button" disabled={busy} onClick={() => onDismiss(p.id)} aria-label={`Hide ${requester(p)}’s ${p.tool} prompt`} title="Hide — types nothing"
                  className="-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-panel hover:text-fg">
                  ×
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {canControl && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => openTerminal(sessionId)} className="min-h-[40px] rounded-sm bg-accent px-4 py-2 text-[14px] font-medium text-bg hover:brightness-110">
            Open terminal
          </button>
        </div>
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
 * From the terminal of the session asking (owner, 2026-10-07), Y, A and N
 * answer the card and never reach the terminal. That is safe only while the
 * question waits: Claude Code's prompt is replaced by its permission menu, so
 * no keystroke there is typing. Enter and Esc are left to that menu, which
 * already means Yes and No by them. Any other terminal, field or editor keeps
 * every key — a key meant for it must reach it. Enter and Esc from elsewhere
 * only when focus is on nothing in particular (the page) or inside the card:
 * on another button Enter presses that button, and Esc closes whatever else
 * is open. Not while a dialog of the page's own is open, nor from a card that
 * is hidden (a background tab), and only the newest card on the page listens.
 *
 * The listener is on the capture phase so a key taken from the terminal is
 * stopped before xterm sees it.
 */
function usePromptKeys(
  card: RefObject<HTMLDivElement | null>,
  sessionId: string,
  enabled: boolean,
  hasAlways: boolean,
  answer: (c: PermissionChoice) => void,
) {
  // A layout effect: the keys listen from the commit that paints the card, so
  // a key pressed the moment it appears is not lost (the race #250 fixed in
  // AppShell).
  useLayoutEffect(() => {
    if (!enabled) return
    const me = Symbol('permission-card')
    keyed.push(me)
    const onKey = (e: KeyboardEvent) => {
      if (keyed[keyed.length - 1] !== me) return
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      const el = card.current
      if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]')) return
      const active = document.activeElement
      const inOwnTerminal = active instanceof HTMLElement && active.closest('[data-term-session]')?.getAttribute('data-term-session') === sessionId
      if (typingInto(active) && !inOwnTerminal) return
      const modal = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some((d) => !d.closest('[hidden]'))
      if (modal) return
      const onPage = !active || active === document.body || el.contains(active)
      let choice: PermissionChoice | null = null
      switch (inOwnTerminal && (e.key === 'Enter' || e.key === 'Escape') ? '' : e.key) {
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
      e.stopPropagation()
      answer(choice)
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const i = keyed.indexOf(me)
      if (i >= 0) keyed.splice(i, 1)
    }
  }, [card, sessionId, enabled, hasAlways, answer])
}
