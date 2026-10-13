/**
 * A session Caprock cannot type into, in an app tab of its own (owner,
 * 2026-10-13, translated: "why when I click one of these on the left am I
 * taken to something like the web version of the dashboard instead of into
 * the session?"). Two kinds land here: a session started in another
 * terminal, and one that has ended — or whose terminal closed when Caprock
 * restarted (`detached`).
 *
 * The body is the session's conversation, read-only and live (the session
 * page's ChatView); the inspector beside it is the one an owned session has.
 * Where the terminal would be, a plain line says why there is none, with
 * **Continue here** — `--resume` in a NEW process Caprock starts, a copy
 * under a new id while the original still runs (ContinueSession's rules) —
 * and **Open in dashboard**. Nothing is ever sent to the other process
 * (rule 7): not a key, not a signal. The header's ⋯ hides the row from the
 * sidebar or closes the tab.
 */
import { useState } from 'react'
import { api, ApiError, type SessionSummary } from '@/lib/api'
import { dotOf, sessionTitle } from '@/lib/sidebar'
import { modeWords } from '@/lib/permissionMode'
import { useCanControl } from '@/lib/useCanControl'
import { useApi } from '@/lib/useApi'
import { agentName } from './Projects'
import { ChatView } from './ChatView'
import { AgentGlyph } from './AgentMarks'
import { StatusDot } from './ProjectRow'
import { CloseIcon, ExternalIcon, EyeOffIcon, MoreIcon } from './AppIcons'
import { MenuBox, MenuItem, type MenuAt } from './RowMenu'

/** Why a session is watched rather than typed into. */
export type ObserveWhy = 'other' | 'ended' | 'detached'

export function observeWhy(s: Pick<SessionSummary, 'status' | 'detached' | 'owned'>): ObserveWhy {
  if (s.status === 'ended') return 'ended'
  if (s.owned && s.detached) return 'detached'
  return 'other'
}

/** Whether Caprock holds a terminal it may type into: what a session tab needs (rule 7). */
export function attachable(s: Pick<SessionSummary, 'status' | 'detached' | 'owned'>): boolean {
  return s.owned && s.status !== 'ended' && !s.detached
}

const HEADLINE: Record<ObserveWhy, string> = {
  other: 'Started in another terminal — Caprock watches it, it can’t type into it.',
  ended: 'This session has ended — what it said is below, read-only.',
  detached: 'Its terminal closed when Caprock restarted — Caprock can’t type into it.',
}

const WHAT_CONTINUE_DOES: Record<ObserveWhy, string> = {
  other: 'Continue here opens a copy of the conversation in a new tab; the original keeps running there, untouched.',
  ended: 'Continue here carries the conversation on, in this tab.',
  detached: 'Continue here carries it on, in this tab.',
}

const STATE: Record<ObserveWhy, string> = {
  other: 'in another terminal',
  ended: 'ended',
  detached: 'no terminal',
}

export function ObservePane({ sessionId, session: listed, title: fallbackTitle, hasPermission = false, onContinued, onOpenDashboard, onHide, onClose }: {
  sessionId: string
  /** The list's summary, absent until it answers. */
  session?: SessionSummary
  /** The tab's own title, for before the list answers. */
  title: string
  hasPermission?: boolean
  /** A process Caprock started now carries the conversation: its id, and whether it kept this one's. */
  onContinued: (id: string, title: string, sameId: boolean) => void
  onOpenDashboard: () => void
  /** Closes the tab and hides the session's row from the sidebar; nothing is sent to it. */
  onHide: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<(MenuAt & { from: HTMLElement | null }) | null>(null)
  const canControl = useCanControl()
  // The list says whether a live session can be picked up only on its own
  // page's answer: read it once, when the tab is shown. It also stands in for
  // an old session the list no longer carries.
  const detail = useApi(() => api.session(sessionId), [sessionId], { live: false })
  const s: SessionSummary | undefined = listed ?? detail.data
  const resume = listed?.resume ?? detail.data?.resume
  const title = s ? sessionTitle(s) : fallbackTitle || 'session'
  const why = s ? observeWhy(s) : 'other'
  const mode = resume?.permission_mode ?? ''

  async function carryOn() {
    if (!s) return
    setBusy(true)
    setError('')
    // Still running elsewhere: a copy under a new id, so two processes never
    // write one transcript. Ended or detached: the same conversation, carried
    // on (the daemon stops a detached process of its own first).
    const fork = why === 'other'
    try {
      const res = await api.spawn({ cwd: s.cwd, resume: s.session_id, fork, ...(mode ? { permission_mode: mode } : {}) })
      onContinued(res.session_id, title, res.session_id === s.session_id)
      setBusy(false)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setBusy(false)
    }
  }

  const closeMenu = () => {
    const from = menu?.from
    setMenu(null)
    from?.focus()
  }

  return (
    <div data-observe-pane={sessionId} data-observe-why={why} className="flex h-full w-full flex-col bg-bg">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] pl-4 pr-2 text-[12.5px]">
        <StatusDot dot={s ? dotOf(s, hasPermission) : 'idle'} />
        <AgentGlyph agent={s?.agent} />
        <span data-observe-title className="min-w-0 truncate font-medium text-fg">{title}</span>
        <span className="shrink-0 text-fg-faint">· {s ? `${agentName(s.agent)} · ` : ''}{STATE[why]}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={`More for ${title}`}
          aria-haspopup="menu"
          title="Hide from the list, open in the dashboard, close the tab"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.right - 220, y: r.bottom + 4, from: e.currentTarget })
          }}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          <MoreIcon size={15} />
        </button>
      </div>
      <ChatView key={sessionId} sessionId={sessionId} canType={false} ended={why === 'ended'} className="min-h-0 flex-1" />
      <div data-observe-terminal className="shrink-0 border-t border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] px-4 py-3">
        <p className="text-[13px] leading-snug text-fg">{HEADLINE[why]}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {canControl && resume?.ok && (
            <button
              type="button"
              data-observe-continue
              onClick={carryOn}
              disabled={busy}
              title={WHAT_CONTINUE_DOES[why]}
              className="rounded-[6px] bg-accent px-3 py-1 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50"
            >
              {busy ? 'Opening…' : 'Continue here'}
            </button>
          )}
          <button type="button" data-observe-dashboard onClick={onOpenDashboard} className="inline-flex items-center gap-1 text-[12.5px] text-fg-muted underline-offset-2 hover:text-fg hover:underline">
            Open in dashboard <ExternalIcon size={12} />
          </button>
          {canControl && resume && !resume.ok && resume.reason && (
            <span className="text-[12px] text-fg-faint">Can’t continue here: {resume.reason}</span>
          )}
        </div>
        {canControl && resume?.ok && (
          <p className="mt-1.5 text-[12px] leading-snug text-fg-faint">
            {WHAT_CONTINUE_DOES[why]}{mode ? ` It starts in ${modeWords(mode)}.` : ''}
          </p>
        )}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
      </div>
      {menu && (
        <MenuBox at={menu} label={`${title} actions`} width={220} onClose={closeMenu}>
          <MenuItem icon={<EyeOffIcon size={14} />} label="Hide from the list" onClick={() => { setMenu(null); onHide() }} />
          <MenuItem icon={<ExternalIcon size={14} />} label="Open in dashboard" onClick={() => { setMenu(null); onOpenDashboard() }} />
          <MenuItem icon={<CloseIcon size={14} />} label="Close tab" onClick={() => { setMenu(null); onClose() }} />
        </MenuBox>
      )}
    </div>
  )
}
