import { useEffect, useRef, useState } from 'react'
import { api, ApiError, isPairedDevice, type SessionSummary } from '@/lib/api'
import { navigate } from '@/lib/router'
import { fmtAgo, shortId } from '@/lib/format'

/**
 * A terminal into a project, from its row on the Projects panel.
 *
 * Owner request (2026-10-02): one click on a project and you are typing in
 * it. The row knows the directory it is keyed on (`dir`); the sessions in it
 * come from `GET /v1/sessions?dir=`, each with whether it can be picked up.
 *
 * What one click does depends on what is there:
 *
 *  - **One terminal Caprock holds in this project** — it opens. That is the
 *    common case for someone who works from the dashboard, and the reason the
 *    button exists: no menu between the click and the prompt.
 *  - **Anything else** — a short menu: Caprock's own live sessions to open,
 *    other sessions to continue (ended) or branch (still running elsewhere),
 *    and a new session in the folder.
 *
 * Rule 7 holds throughout: a session Caprock did not start is never typed
 * into. Continuing or branching starts a *second* process on the same history
 * (`claude --resume`, with `--fork-session` while the original runs), which is
 * Caprock's and so can be typed into — the same path as ContinueSession.
 *
 * A paired device may not start processes, so on a tablet only Caprock's own
 * live sessions are offered.
 */

const MAX_ROWS = 6

/** A session Caprock started and still holds the terminal of. */
function isOpenable(s: SessionSummary): boolean {
  return s.owned && s.status !== 'ended' && !s.detached && !s.resume
}

function describe(s: SessionSummary): string {
  return s.description || s.title || shortId(s.session_id)
}

export function ProjectTerminal({ dir, label }: { dir: string; label: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [open, setOpen] = useState(false)
  // Open upward when the row is near the bottom of the window: the dashboard
  // does not scroll as a page, so a menu hanging below the last row is cut off.
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const paired = isPairedDevice()

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

  async function click() {
    if (open) {
      setOpen(false)
      return
    }
    setBusy(true)
    setError('')
    try {
      const list = await api.sessionsInDir(dir)
      const openable = list.filter(isOpenable)
      const only = openable.length === 1 ? openable[0] : undefined
      if (only) {
        navigate({ name: 'session', id: only.session_id, tab: 'terminal' })
        return
      }
      const r = ref.current?.getBoundingClientRect()
      if (r) {
        const below = window.innerHeight - r.bottom
        setUp(below < 320 && r.top > below)
      }
      setSessions(list)
      setOpen(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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

  const openable = (sessions ?? []).filter(isOpenable)
  // Sessions that can be carried on here. Ones that cannot (another agent, a
  // transcript gone) are left out of the menu: their reason is on the
  // session's own card, and a menu of things you cannot click is not a menu.
  const pickable = paired ? [] : (sessions ?? []).filter((s) => !isOpenable(s) && s.resume?.ok)
  const rows = [...openable, ...pickable].slice(0, MAX_ROWS)

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={click}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Open a terminal in ${label}`}
        className="mono text-[11px] text-fg-faint hover:text-accent border border-transparent hover:border-border rounded-sm px-1.5 py-0.5 disabled:opacity-50"
      >
        {busy ? '…' : '>_'}
      </button>
      {error && !open && (
        <span className="absolute right-0 top-full mt-1 z-20 whitespace-nowrap text-[11px] text-danger bg-panel border border-border rounded-sm px-2 py-1">
          {error}
        </span>
      )}
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-20 w-[22rem] max-w-[90vw] max-h-[60vh] overflow-y-auto bg-panel border border-border rounded-sm shadow-lg py-1 text-left ${
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
              <button
                key={s.session_id}
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
                className="w-full grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-2 px-3 py-1.5 hover:bg-panel-2 disabled:opacity-50"
              >
                <span className={`text-[11px] ${mine ? 'text-accent' : 'text-fg-muted'}`}>
                  {live && <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok mr-1.5 align-middle" />}
                  {verb}
                </span>
                <span className="truncate text-[12px] text-fg text-left">{describe(s)}</span>
                <span className="num text-[11px] text-fg-faint">{fmtAgo(s.worked_at || s.last_event_at)}</span>
              </button>
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
