import { useEffect, useState } from 'react'
import { api, ApiError, type SessionSummary } from '@/lib/api'
import { dotOf, sessionTitle } from '@/lib/sidebar'
import { fmtAgo } from '@/lib/format'
import { useCanControl } from '@/lib/useCanControl'
import { StatusDot, fmtCostShort } from './ProjectRow'

/** How many rows the empty workspace lists: a week of work, not the archive. */
export const RECENT_LIMIT = 6

/**
 * What was being done in this project, on the screen you land on when no tab
 * is open. The sidebar lists only what is running, so before this a session
 * that ended last night — the one you most likely came back for — was not on
 * the app's first screen at all, and carrying it on took the dashboard, the
 * session page and its Continue button. Here it is one click.
 *
 * A row opens the session (its terminal when Caprock holds one, its details
 * otherwise); the button beside an ended one carries the conversation on in a
 * new tab, in the permission mode it was last running in.
 */
export function RecentInProject({
  root,
  permissions,
  onOpen,
  onContinued,
}: {
  root: string
  permissions: ReadonlySet<string>
  onOpen: (s: SessionSummary) => void
  /** A continued session's new id and its title, for the tab. */
  onContinued: (id: string, title: string) => void
}) {
  const [list, setList] = useState<SessionSummary[] | null>(null)
  const canControl = useCanControl()

  useEffect(() => {
    let live = true
    setList(null)
    api.sessionsInDir(root).then(
      (all) => { if (live) setList(recentOf(all)) },
      () => { if (live) setList([]) },
    )
    return () => { live = false }
  }, [root])

  if (!list || list.length === 0) return null
  return (
    <section aria-label="Recent sessions" className="flex min-w-0 flex-col gap-1">
      <h2 className="px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-faint">Recent</h2>
      {list.map((s) => (
        <RecentRow
          key={s.session_id}
          s={s}
          hasPermission={permissions.has(s.session_id)}
          canControl={canControl}
          onOpen={() => onOpen(s)}
          onContinued={onContinued}
        />
      ))}
    </section>
  )
}

/** Agents only, the most recently worked first. An ended session nobody
 *  wrote a word in is an agent opened and closed: nothing to come back to. */
export function recentOf(all: SessionSummary[], limit = RECENT_LIMIT): SessionSummary[] {
  return all
    .filter((s) => s && s.kind !== 'shell')
    .filter((s) => s.status !== 'ended' || (s.stats?.turns ?? 0) > 0 || !!(s.title || s.description))
    .sort((a, b) => lastWorked(b) - lastWorked(a))
    .slice(0, limit)
}

function lastWorked(s: SessionSummary): number {
  return s.worked_at || s.last_event_at || 0
}

function RecentRow({
  s,
  hasPermission,
  canControl,
  onOpen,
  onContinued,
}: {
  s: SessionSummary
  hasPermission: boolean
  canControl: boolean
  onOpen: () => void
  onContinued: (id: string, title: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const title = sessionTitle(s)
  const ended = s.status === 'ended'
  const cost = fmtCostShort(s.stats?.cost_usd ?? 0)
  const resumable = canControl && ended && !!s.resume?.ok

  async function carryOn() {
    setBusy(true)
    setError('')
    try {
      const res = await api.spawn({
        cwd: s.cwd,
        resume: s.session_id,
        fork: false,
        ...(s.resume?.permission_mode ? { permission_mode: s.resume.permission_mode } : {}),
      })
      onContinued(res.session_id, title)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-row group flex h-[38px] items-center gap-3 rounded-[8px] px-3">
      <StatusDot dot={dotOf(s, hasPermission)} />
      <button type="button" onClick={onOpen} title={title} className="min-w-0 flex-1 truncate text-left text-[13.5px] text-fg">
        {title}
      </button>
      <span className="mono shrink-0 text-[11.5px] text-fg-faint">
        {[cost, ended ? fmtAgo(lastWorked(s)) : 'running'].filter(Boolean).join(' · ')}
      </span>
      <span className="flex w-[84px] shrink-0 justify-end">
        {error ? (
          <span className="shrink-0 text-[11.5px] text-danger" title={error}>failed</span>
        ) : resumable ? (
          <button
            type="button"
            onClick={carryOn}
            disabled={busy}
            title="Carry this conversation on in a new tab"
            className="shrink-0 rounded-[6px] border border-[var(--app-hairline-strong)] px-2 py-0.5 text-[12px] text-fg hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'Continue'}
          </button>
        ) : !ended ? (
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 rounded-[6px] border border-[var(--app-hairline-strong)] px-2 py-0.5 text-[12px] text-fg hover:border-accent hover:text-accent"
          >
            Open
          </button>
        ) : null}
      </span>
    </div>
  )
}
