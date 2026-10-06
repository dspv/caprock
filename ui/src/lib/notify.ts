/**
 * OS notifications in the desktop app (WP-09, .ai/21-app.md § Notifications).
 *
 * The daemon decides when and what (the `notify` frame, under the same rules,
 * cooldown and hourly cap as Telegram); this decides whether this window
 * should speak at all, and asks the shell to show it (`notify`, an allowlisted
 * Tauri command). A browser tab never does: there, the notification is only
 * what the existing screens already show.
 *
 * - **Quiet when watched.** Nothing for the session in front, in a focused
 *   window: whoever would read it is already looking at it.
 * - **Never stale.** An approval whose prompt is no longer waiting — answered
 *   in the terminal, or replayed after the laptop slept — is not shown.
 * - **Buttons on macOS.** The shell gets the frame's session, prompt and
 *   actions; on macOS it shows Approve and Deny itself and answers them with
 *   the prompt id, and a click on the body opens the session through
 *   `caprock:shown` and `caprock:open-session` (app/README.md).
 * - **Withdrawn when answered elsewhere.** When a session's prompt goes away
 *   (a `permission` frame with none), the approval notifications shown for it
 *   are withdrawn by id (`withdraw_notifications`; macOS), so Notification
 *   Center keeps no stale Approve button.
 * - **Elsewhere the click opens the prompt.** The official plugin reports no
 *   clicks or actions there, so Approve and Deny live in the app: a click
 *   brings the app forward, and the app coming forward soon after a
 *   notification it showed while in the background opens that session, its
 *   prompt card in view. The card answers with the prompt's id (ADR-035), so a stale one is
 *   refused. A show from the menu bar, tray or hotkey is the user's own
 *   (`caprock:shown`, sent before the window comes up) and opens nothing:
 *   the open waits a moment for that word and drops the notification.
 * - **Waiting is asked of the daemon, by prompt id.** The workspace's set of
 *   waiting sessions (WP-10) is per session, and during a replay it still
 *   holds a prompt whose answer is a few frames later; the GET is not.
 */
import { useEffect, useRef } from 'react'
import { api } from './api'
import { isTauri } from './appmode'
import { live, type NotifyFrame } from './live'
import { href } from './router'
import { SHOWN_EVENT } from './shell'

/** How long after a notification the app coming forward counts as its click. */
export const CLICK_WINDOW_MS = 2 * 60_000

/** How long a focus waits for the shell to say the show was the user's own. */
export const SHOWN_GRACE_MS = 300

/** What this window shows right now. */
export interface Viewing {
  /** Whether the window has focus. */
  focused: boolean
  /** The session in front: the focused tab, or the session screen. */
  sessionId?: string
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

interface NotifierDeps {
  invoke: Invoke
  viewing: () => Viewing
  /** Whether an approval's prompt still waits; true when it cannot be told. */
  stillWaiting: (n: NotifyFrame) => Promise<boolean>
  open: (n: NotifyFrame) => void
  now?: () => number
  /** Runs fn after ms; a test runs it at once. */
  later?: (fn: () => void, ms: number) => void
}

/** Whether a notification would interrupt someone already looking at its session. */
export function isWatched(n: NotifyFrame, v: Viewing): boolean {
  return v.focused && v.sessionId === n.session_id
}

/** The route that shows a notification's session with its prompt in view. */
export function promptRoute(n: NotifyFrame): string {
  return href({ name: 'session', id: n.session_id, tab: 'terminal' })
}

/** Decides, shows and remembers one window's OS notifications. */
export class Notifier {
  private seen = new Set<string>()
  private pending: { n: NotifyFrame; at: number } | null = null
  /** Approval notifications shown, by session, until their prompt goes away. */
  private shownFor = new Map<string, string[]>()

  constructor(private deps: NotifierDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** A notify frame arrived. Resolves to whether it was shown. */
  async receive(n: NotifyFrame): Promise<boolean> {
    if (this.seen.has(n.id)) return false
    this.seen.add(n.id)
    if (isWatched(n, this.deps.viewing())) return false
    if (n.prompt_id && !(await this.deps.stillWaiting(n))) return false
    if (isWatched(n, this.deps.viewing())) return false
    if (!this.deps.viewing().focused) this.pending = { n, at: this.now() }
    try {
      await this.deps.invoke('notify', {
        title: n.title, body: n.body, id: n.id, sessionId: n.session_id, promptId: n.prompt_id, actions: n.actions,
      })
      if (n.prompt_id) this.shownFor.set(n.session_id, [...(this.shownFor.get(n.session_id) ?? []), n.id])
      return true
    } catch {
      return false
    }
  }

  /**
   * The window came forward: open what the newest notification was about,
   * unless the shell says in the next moment that the user brought it up.
   */
  focused(): void {
    const p = this.pending
    if (!p || this.now() - p.at > CLICK_WINDOW_MS) {
      this.pending = null
      return
    }
    const later = this.deps.later ?? ((fn, ms) => { window.setTimeout(fn, ms) })
    later(() => {
      if (this.pending !== p) return
      this.pending = null
      // A GitHub notification is about a pull request, not a session: the
      // app coming forward is all its click does.
      if (!p.n.session_id) return
      if (this.deps.viewing().sessionId === p.n.session_id) return
      this.deps.open(p.n)
    }, SHOWN_GRACE_MS)
  }

  /** The menu bar, tray or hotkey brought the window up: not a notification's click. */
  shown(): void {
    this.pending = null
  }

  /**
   * A session's prompt went away — answered in the terminal, on the card, from
   * a phone or the notification itself: coming forward no longer opens it, and
   * its notifications are withdrawn so none keeps a stale Approve button.
   */
  answered(sessionId: string): void {
    if (this.pending?.n.kind === 'approval' && this.pending.n.session_id === sessionId) this.pending = null
    const ids = this.shownFor.get(sessionId)
    if (!ids) return
    this.shownFor.delete(sessionId)
    this.deps.invoke('withdraw_notifications', { ids }).catch(() => {}) // an older shell has no such command
  }
}

function tauriInvoke(): Invoke | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__
  const invoke = internals?.invoke
  return invoke ? (cmd, args) => invoke(cmd, args) : null
}

async function promptStillWaits(n: NotifyFrame): Promise<boolean> {
  try {
    const r = await api.permission(n.session_id)
    return r.permission?.id === n.prompt_id
  } catch {
    return true // cannot tell: say it rather than stay silent
  }
}

/**
 * Shows the app's OS notifications while mounted; does nothing outside the
 * Tauri shell. `sessionId` is the session in front of the reader, if any.
 */
export function useOsNotifications(sessionId: string | undefined): void {
  const front = useRef(sessionId)
  front.current = sessionId
  useEffect(() => {
    const invoke = isTauri() ? tauriInvoke() : null
    if (!invoke) return
    const notifier = new Notifier({
      invoke,
      viewing: () => ({ focused: document.hasFocus(), sessionId: front.current }),
      stillWaiting: promptStillWaits,
      open: (n) => { location.hash = promptRoute(n) },
    })
    const off = live.onFrame((f) => {
      if (f.type === 'notify') void notifier.receive(f.data)
      else if (f.type === 'permission' && !f.data.permission) notifier.answered(f.data.session_id)
    })
    const onFocus = () => notifier.focused()
    const onShown = () => notifier.shown()
    window.addEventListener('focus', onFocus)
    window.addEventListener(SHOWN_EVENT, onShown)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(SHOWN_EVENT, onShown)
    }
  }, [])
}
