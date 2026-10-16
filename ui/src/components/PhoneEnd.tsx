/**
 * Ending a session from a phone, wherever it is listed (owner, 2026-10-16,
 * translated: "From the phone I can't end a session — e.g. I have some trial
 * chats and I can't end them if I want").
 *
 * One rule for every place that offers it — the session's bar, its chat's ⋯,
 * and a row's ⋯ (or a swipe left) on the home's Chats and Continue, All
 * sessions and the Chats screen: **End** for a live session Caprock started
 * and still holds, on a device allowed to control it; one confirm sheet; then
 * the polite stop, `end` (SIGTERM, a kill only after the grace), so the
 * conversation is saved and can be continued. Where End cannot be offered the
 * row says why in one line instead of going quiet. There is no way here to
 * signal a process Caprock did not start (CLAUDE.md rule 7): such a session
 * gets the reason and nothing else, and the daemon refuses it anyway
 * (`agents.Manager.End`: not owned).
 */
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { api, errText, type SessionSummary } from '@/lib/api'
import { MoreIcon } from './AppIcons'

/** Started somewhere else: rule 7, so Caprock never offers to stop it. */
export const WHY_NOT_OURS = 'Started in your own terminal — Caprock never stops it (rule 7).'
/** Caprock started it but no longer holds its terminal (a restart, a lost pty-host). */
export const WHY_DETACHED = 'Caprock no longer holds its terminal after a restart, so it cannot end it from here.'
/** A paired device holding the viewer role (ADR-034): the signal route is a controller's. */
export const WHY_WATCH = 'This phone can only watch — allow control on your computer: Settings → Use on your phone → Let it control sessions.'

/** Whether a session can be ended here: null when there is nothing to end. */
export type EndState = null | { can: true } | { can: false; why: string }

type Endable = Pick<SessionSummary, 'owned' | 'status'> & { detached?: boolean }

export function endState(s: Endable, canControl: boolean): EndState {
  if (s.status === 'ended') return null
  // The order matters: allowing control would not make a terminal's own
  // session stoppable, so that reason comes first.
  if (!s.owned) return { can: false, why: WHY_NOT_OURS }
  if (s.detached) return { can: false, why: WHY_DETACHED }
  if (!canControl) return { can: false, why: WHY_WATCH }
  return { can: true }
}

/**
 * The sessions ended from this screen, shown as ended at once: the list
 * learns it on its next read, a few seconds later, once the process is gone.
 */
export function useEndedHere() {
  const [ids, setIds] = useState<string[]>([])
  return {
    mark: (id: string) => setIds((v) => (v.includes(id) ? v : [...v, id])),
    view: <T extends { session_id: string; status: string }>(s: T): T => (ids.includes(s.session_id) && s.status !== 'ended' ? { ...s, status: 'ended' } : s),
  }
}

export type EndedHere = ReturnType<typeof useEndedHere>

/** A swipe to the left on a touch screen: at least 60px across, more across than down. */
export function useSwipeLeft(on: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return {
    onTouchStart: (e: TouchEvent) => { const t = e.touches[0]; start.current = t ? { x: t.clientX, y: t.clientY } : null },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current
      const t = e.changedTouches[0]
      start.current = null
      if (!s || !t) return
      const dx = t.clientX - s.x
      const dy = t.clientY - s.y
      if (dx <= -60 && Math.abs(dx) > Math.abs(dy) * 1.5) on()
    },
  }
}

/**
 * End's one confirmation, at the bottom where the thumb is. It sends `end`,
 * as closing a tab on the desktop does: SIGTERM, so Claude Code writes its
 * transcript out and `--resume` works, and a kill only if the process is
 * still running after the grace period. That is what makes "the
 * conversation is saved and can be continued" true; `kill` would not.
 */
export function EndSheet({ sessionId, title, onClose, onEnded }: { sessionId: string; title: string; onClose: () => void; onEnded?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const end = async () => {
    setBusy(true)
    setError('')
    try {
      await api.signal(sessionId, 'end')
      onEnded?.()
      onClose()
    } catch (e) {
      setBusy(false)
      setError(errText(e))
    }
  }
  return (
    <>
      <div aria-hidden className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div role="alertdialog" aria-modal="true" aria-label="End the session" data-phone-end-sheet
        className="fixed inset-x-0 bottom-0 z-50 grid gap-3 rounded-t-[16px] border-t border-border-strong bg-panel px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 shadow-lg">
        <p className="min-w-0 text-[16px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">End {title}?</p>
        <p className="text-[14px] text-fg-muted">The conversation is saved and can be continued.</p>
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-[10px] border border-border-strong text-[15px] text-fg">Keep it</button>
          <button type="button" autoFocus disabled={busy} onClick={() => void end()} className="min-h-11 rounded-[10px] bg-danger text-[15px] font-medium text-panel disabled:opacity-50">
            {busy ? 'Ending…' : 'End session'}
          </button>
        </div>
      </div>
    </>
  )
}

export const ROW_MENU_ITEM = 'flex min-h-11 w-full items-center px-4 text-left text-[15px] text-fg active:bg-panel-2 hover:bg-panel-2'

/** End in a row's menu: the item, or the one line that says why not. */
export function EndMenuItem({ state, onEnd }: { state: EndState; onEnd: () => void }) {
  if (!state) return null
  if (state.can) {
    return <button type="button" role="menuitem" data-row-end className={`${ROW_MENU_ITEM} font-medium text-danger`} onClick={onEnd}>End session…</button>
  }
  return <p data-row-end-why className="px-4 py-2 text-[13px] leading-snug text-fg-muted">{state.why}</p>
}


/**
 * A list row with a ⋯ on its right holding End (and whatever else the row
 * offers), a swipe left that opens the same End, and the confirm sheet. On a
 * phone the menu is a sheet at the bottom, where the thumb is and where no
 * list's rounded box can clip it; wider, it hangs under the ⋯. Nothing is
 * drawn beside the row when it has nothing to offer.
 */
export function EndableRow({ s, title, canControl, onEnded, items, onMenu, after, children, className = '' }: {
  s: Endable & { session_id: string }
  title: string
  canControl: boolean
  onEnded: () => void
  /** The row's other menu items, after End. */
  items?: (close: () => void) => ReactNode
  /** Told when the menu opens or closes. */
  onMenu?: (open: boolean) => void
  /** Under the row: an error, say. */
  after?: ReactNode
  /** The row's link. */
  children: ReactNode
  className?: string
}) {
  const state = endState(s, canControl)
  const [menu, setMenuState] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const box = useRef<HTMLLIElement>(null)
  const told = useRef(onMenu)
  told.current = onMenu
  const setMenu = (open: boolean) => { setMenuState(open); told.current?.(open) }
  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) { setMenuState(false); told.current?.(false) } }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menu])
  const close = () => setMenu(false)
  const extra = items?.(close)
  const hasMenu = !!state || !!extra
  const swipe = useSwipeLeft(() => { if (state?.can) setConfirm(true); else if (hasMenu) setMenu(true) })
  return (
    <li ref={box} className={`relative border-b border-border last:border-b-0 ${className}`} {...(hasMenu ? swipe : {})}>
      <div className="flex items-center">
        <div className="min-w-0 flex-1">{children}</div>
        {hasMenu && (
          <button type="button" aria-label={`More for ${title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg-faint hover:text-fg">
            <MoreIcon size={18} />
          </button>
        )}
      </div>
      {after}
      {menu && (
        <>
          <div aria-hidden className="fixed inset-0 z-40 bg-black/30 sm:hidden" onClick={close} />
          <div role="menu" aria-label={`More for ${title}`}
            className="fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-[16px] border-t border-border-strong bg-panel pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-lg sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-2 sm:top-[calc(100%-6px)] sm:z-20 sm:w-[260px] sm:rounded-[12px] sm:border sm:py-1 sm:shadow-[0_16px_40px_-16px_rgba(0,0,0,0.6)]">
            <p className="truncate px-4 pb-1 pt-2 text-[12px] text-fg-faint sm:hidden">{title}</p>
            <EndMenuItem state={state} onEnd={() => { setMenu(false); setConfirm(true) }} />
            {extra}
          </div>
        </>
      )}
      {confirm && <EndSheet sessionId={s.session_id} title={title} onClose={() => setConfirm(false)} onEnded={onEnded} />}
    </li>
  )
}
