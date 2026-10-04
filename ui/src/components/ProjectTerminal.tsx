import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type SessionSummary } from '@/lib/api'
import { useCanControl } from '@/lib/useCanControl'
import { navigate } from '@/lib/router'
import { fmtAgo, shortId } from '@/lib/format'
import { OpenInTerminal } from './OpenInTerminal'

/**
 * A terminal into a project, from its row on the Projects panel.
 *
 * Owner request, made several times (2026-10-02, again 2026-10-04): one click
 * on a project and you are typing in it. The first version was a faint 11px
 * `>_` at the row's right edge that opened a menu; it was there and nobody
 * could see it, which is the same as not being there. Now the row carries a
 * real button whose label says what it will do, decided from the project's
 * live sessions before the click:
 *
 *  - **Terminal** — a live session Caprock started is running here. Opens the
 *    most recently active one's terminal. The only label that promises typing.
 *  - **Pick up in a terminal** — the newest live session was started somewhere
 *    else. Caprock never types into it (rule 7); this starts a second process
 *    on its history (`claude --resume <id> --fork-session`) and opens that.
 *    When it cannot be resumed here, the session's page opens instead, where
 *    the reason is stated.
 *  - **New session here** — nothing is running. Starts `claude` in the
 *    project's directory.
 *
 * The `⋯` beside it keeps the full list: Caprock's own live sessions to open,
 * other sessions to continue (ended) or branch (still running elsewhere), and
 * a new session in the folder — from `GET /v1/sessions?dir=`.
 *
 * A paired device may not start processes, so on a tablet only opening one of
 * Caprock's own live sessions is offered, and a session started elsewhere
 * opens its page.
 */

const MAX_ROWS = 6

/** A session Caprock started and still holds the terminal of. */
export function isOpenable(s: SessionSummary): boolean {
  return s.owned && s.status !== 'ended' && !s.detached
}

function lastWork(s: SessionSummary): number {
  return s.worked_at || s.last_event_at || 0
}

function describe(s: SessionSummary): string {
  return s.description || s.title || shortId(s.session_id)
}

export type ProjectAction =
  | { kind: 'open'; session: SessionSummary }
  | { kind: 'pickup'; session: SessionSummary }
  | { kind: 'new' }
  | { kind: 'none' }

/**
 * What the row's button does, from the project's sessions. Pure, so the rule
 * is tested on its own: Caprock's own live session first, then picking up the
 * newest live one, then a new session.
 */
export function projectAction(sessions: SessionSummary[], paired: boolean): ProjectAction {
  const live = sessions.filter((s) => s.status !== 'ended').sort((a, b) => lastWork(b) - lastWork(a))
  const mine = live.find(isOpenable)
  if (mine) return { kind: 'open', session: mine }
  if (live[0]) return { kind: 'pickup', session: live[0] }
  return paired ? { kind: 'none' } : { kind: 'new' }
}

const BIG = 'inline-flex items-center gap-1.5 rounded-sm px-3.5 py-2 min-h-[36px] text-[13px] font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
/** The one style that says "you will be typing": filled. */
export const PRIMARY = `${BIG} bg-accent text-bg hover:brightness-110`
/** Big and obvious, but not a promise to type into anything that exists. */
export const SECONDARY = `${BIG} border border-accent text-accent hover:bg-accent/10`

export function ProjectTerminal({ dir, label, sessions = [] }: { dir: string; label: string; sessions?: SessionSummary[] }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<SessionSummary[] | null>(null)
  const [open, setOpen] = useState(false)
  // Open upward when the row is near the bottom of the window: the dashboard
  // does not scroll as a page, so a menu hanging below the last row is cut off.
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // "Paired" here means "may not start a session": a controller may (ADR-034).
  const paired = !useCanControl()
  const action = projectAction(sessions, paired)

  // Close on a click elsewhere or Escape: a menu that stays open after the
  // pointer has moved on covers the rows beneath it.
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

  async function spawn(req: { cwd: string; resume?: string; fork?: boolean }) {
    setBusy(true)
    setError('')
    try {
      const res = await api.spawn(req)
      navigate({ name: 'session', id: res.session_id, tab: 'terminal' })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setBusy(false)
    }
  }

  async function primary() {
    switch (action.kind) {
      case 'open':
        navigate({ name: 'session', id: action.session.session_id, tab: 'terminal' })
        return
      case 'new':
        await spawn({ cwd: dir })
        return
      case 'pickup': {
        const s = action.session
        if (paired) {
          navigate({ name: 'session', id: s.session_id })
          return
        }
        // Whether it can be resumed is decided on disk (the transcript, the
        // folder), and Now's list does not carry it for a live session.
        setBusy(true)
        setError('')
        try {
          const list = await api.sessionsInDir(dir)
          const fresh = list.find((x) => x.session_id === s.session_id)
          if (fresh?.resume?.ok) {
            await spawn({ cwd: fresh.cwd || s.cwd, resume: s.session_id, fork: true })
            return
          }
          // It cannot be picked up here: its page says why.
          navigate({ name: 'session', id: s.session_id })
        } catch (e) {
          setError(e instanceof ApiError ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }
    }
  }

  async function toggleMenu() {
    if (open) {
      setOpen(false)
      return
    }
    setBusy(true)
    setError('')
    try {
      const list = await api.sessionsInDir(dir)
      const r = ref.current?.getBoundingClientRect()
      if (r) {
        const below = window.innerHeight - r.bottom
        setUp(below < 320 && r.top > below)
      }
      setMenu(list)
      setOpen(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openable = (menu ?? []).filter(isOpenable)
  // Sessions that can be carried on here. Ones that cannot (another agent, a
  // transcript gone) are left out of the menu: their reason is on the
  // session's own card, and a menu of things you cannot click is not a menu.
  const pickable = paired ? [] : (menu ?? []).filter((s) => !isOpenable(s) && s.resume?.ok)
  const rows = [...openable, ...pickable].slice(0, MAX_ROWS)

  const label1 =
    action.kind === 'open' ? 'Terminal' : action.kind === 'pickup' ? (paired ? 'Open session' : 'Pick up in a terminal') : 'New session here'
  const title =
    action.kind === 'open'
      ? `Open the terminal of “${describe(action.session)}”, which Caprock started`
      : action.kind === 'pickup'
        ? paired
          ? `“${describe(action.session)}” was started outside Caprock; open its page`
          : `“${describe(action.session)}” is running in another terminal. Caprock will not type into it: this opens a second claude on its history, and the original keeps running.`
        : `Start claude in ${dir}`

  return (
    <div ref={ref} className="relative flex items-center gap-1.5">
      {action.kind !== 'none' && (
        <button
          type="button"
          onClick={primary}
          disabled={busy}
          title={title}
          aria-label={`${label1} — ${label}`}
          className={action.kind === 'open' ? PRIMARY : SECONDARY}
        >
          <span aria-hidden className="mono text-[12px]">{'>_'}</span>
          {busy ? 'Opening…' : label1}
        </button>
      )}
      <button
        type="button"
        onClick={toggleMenu}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Every way into ${label}`}
        aria-label={`Every way into ${label}`}
        className="min-h-[36px] min-w-[32px] rounded-sm border border-border text-fg-muted hover:text-fg hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
      >
        ⋯
      </button>
      {error && !open && (
        <span role="alert" className="absolute left-0 top-full mt-1 z-20 max-w-[90vw] text-[11px] text-danger bg-panel border border-border rounded-sm px-2 py-1">
          {error}
        </span>
      )}
      {open && (
        <div
          role="menu"
          className={`absolute left-0 z-20 w-[22rem] max-w-[90vw] max-h-[60vh] overflow-y-auto bg-panel border border-border rounded-sm shadow-lg py-1 text-left ${
            up ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-[0.08em] text-fg-faint truncate">
            terminal · {label}
          </div>
          {rows.length === 0 && (
            <div className="px-3 py-1.5 text-[12px] text-fg-muted">
              {paired ? 'No session Caprock started is running here.' : 'Nothing to pick up here yet.'}
            </div>
          )}
          {rows.map((s) => {
            const mine = isOpenable(s)
            const live = s.status !== 'ended'
            const verb = mine ? 'open' : live ? 'branch' : 'continue'
            return (
              <div key={s.session_id} className="flex items-center hover:bg-panel-2">
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() =>
                  mine
                    ? navigate({ name: 'session', id: s.session_id, tab: 'terminal' })
                    : spawn({ cwd: s.cwd, resume: s.session_id, fork: live })
                }
                title={
                  mine
                    ? 'Caprock started this session; its terminal is here'
                    : live
                      ? 'Still running in another terminal: opens a branch, the original keeps running'
                      : 'Carry this conversation on, here'
                }
                className="flex-1 min-w-0 grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-2 pl-3 pr-1 py-1.5 disabled:opacity-50"
              >
                <span className={`text-[11px] ${mine ? 'text-accent' : 'text-fg-muted'}`}>
                  {live && <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok mr-1.5 align-middle" />}
                  {verb}
                </span>
                <span className="truncate text-[12px] text-fg text-left">{describe(s)}</span>
                <span className="num text-[11px] text-fg-faint">{fmtAgo(s.worked_at || s.last_event_at)}</span>
              </button>
              {/* The same session in the user's own terminal app. */}
              <span className="pr-2">
                <OpenInTerminal sessionID={s.session_id} info={s.open_terminal} compact />
              </span>
              </div>
            )
          })}
          {!paired && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => spawn({ cwd: dir })}
              className="w-full text-left border-t border-border mt-1 px-3 pt-2 pb-1.5 text-[12px] text-accent hover:bg-panel-2 disabled:opacity-50"
            >
              + new session here
            </button>
          )}
          {error && <div className="px-3 py-1 text-[11px] text-danger">{error}</div>}
        </div>
      )}
    </div>
  )
}
