/**
 * The inspector beside the terminal in front (WP-04). Beside an agent it is
 * the agent cockpit (components/Cockpit.tsx): who is working and in what
 * state, what the session has cost and what each call costs now, its
 * context, what it is doing this second, its recent tool calls, the plan
 * windows and a loop warning when there is one. Beside a shell it is the
 * plain inspector: the folder and what has changed. Open by default, closed
 * and opened with ⌘I.
 *
 * The figures come from the sessions list the sidebar already holds and the
 * day's summary — no extra polling for them. The diff is fetched while the
 * panel is open, every 20 s; an agent's events once, then from the live
 * socket.
 */
import { useEffect, useState } from 'react'
import { api, errText, type DiffResult, type EditorList, type SessionSummary, type Summary } from '@/lib/api'
import { firstChangedLine, joinPath, preferredName } from '@/lib/editors'
import { sessionPlace, type Project } from '@/lib/projects'
import { agentName } from './Projects'
import { PermissionPrompt } from './PermissionPrompt'
import { StatusDot } from './ProjectRow'
import { branchLabel } from '@/lib/sessionLabels'
import { dotOf, sessionTitle } from '@/lib/sidebar'
import { href } from '@/lib/router'
import { CloseIcon, ExternalIcon, StopIcon } from './AppIcons'
import { everyWhileVisible } from '@/lib/visible'
import { Cockpit, SectionLabel } from './Cockpit'
import { StopConfirm, stopLabel, type StopWhat } from './StopConfirm'

const DIFF_REFRESH_MS = 20_000
const DIFF_FILES_SHOWN = 5

export function Inspector({
  session,
  sessionId,
  hasPermission,
  showPrompt = true,
  onClose,
  onDetach,
  editors = null,
  onOpenInEditor,
  onReviewChanges,
  onOpenFile,
  summary,
  project,
}: {
  session?: SessionSummary
  /** The sidebar's project the session belongs to: its name heads the place line. */
  project?: Pick<Project, 'name' | 'default_branch'>
  sessionId?: string
  hasPermission: boolean
  /** Draw the permission card: false while the session's terminal is in front and answers it. */
  showPrompt?: boolean
  onClose: () => void
  onDetach: () => void
  /** The editors found on this machine (F18); null hides the actions. */
  editors?: EditorList | null
  onOpenInEditor?: OpenInEditor
  /** Opens the Changes view of the worktree the session runs in. */
  onReviewChanges?: () => void
  /** Opens a changed file in a file tab; without it a click opens the editor. */
  onOpenFile?: (path: string) => void
  /** The day's summary: the plan windows the cockpit shows. */
  summary?: Summary
}) {
  const isAgent = !!sessionId && !!session && session.kind !== 'shell'
  return (
    <aside aria-label="Inspector" className="app-scroll flex h-full min-h-0 flex-col overflow-y-auto border-l border-[var(--app-hairline)] bg-[var(--app-chrome-bg)]">
      <div className="flex h-[40px] shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] pl-4 pr-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">{isAgent ? 'Agent' : 'Inspector'}</h2>
        <button type="button" onClick={onClose} aria-label="Close the inspector (⌘I)" title="Close (⌘I)" className="ml-auto flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          <CloseIcon size={13} />
        </button>
      </div>
      {!sessionId ? (
        <p className="px-4 py-5 text-[12.5px] leading-relaxed text-fg-muted">Open a session to see what it costs, how full its context is, and what it changed.</p>
      ) : (
        <Body key={sessionId} session={session} project={project} sessionId={sessionId} hasPermission={hasPermission} showPrompt={showPrompt} onDetach={onDetach} editor={editors && onOpenInEditor ? { name: preferredName(editors), open: onOpenInEditor } : undefined} onReviewChanges={onReviewChanges} onOpenFile={onOpenFile} summary={summary} />
      )}
    </aside>
  )
}

type OpenInEditor = (path: string, label: string, editor?: string, line?: number) => void
interface EditorAction { name: string; open: OpenInEditor }

function Body({ session: s, project, sessionId, hasPermission, showPrompt, onDetach, editor, onReviewChanges, onOpenFile, summary }: { session?: SessionSummary; project?: Pick<Project, 'name' | 'default_branch'>; sessionId: string; hasPermission: boolean; showPrompt: boolean; onDetach: () => void; editor?: EditorAction; onReviewChanges?: () => void; onOpenFile?: (path: string) => void; summary?: Summary }) {
  const isShell = s?.kind === 'shell'
  const ended = s?.status === 'ended'
  if (s && !isShell) {
    return (
      <div className="grid gap-[18px] px-4 pb-4 pt-3.5">
        <header className="grid gap-1">
          <h3 className="line-clamp-2 text-[14.5px] font-semibold leading-snug tracking-[-0.01em] text-fg" title={sessionTitle(s)}>{sessionTitle(s)}</h3>
          {s.cwd && <Place place={sessionPlace(s, project)} />}
        </header>
        {showPrompt && <PermissionPrompt sessionId={sessionId} />}
        <Cockpit
          s={s}
          sessionId={sessionId}
          hasPermission={hasPermission}
          summary={summary}
          changes={<Changes sessionId={sessionId} editor={editor} onReview={onReviewChanges} onOpenFile={onOpenFile} />}
        />
        <Actions s={s} sessionId={sessionId} isShell={false} ended={ended} editor={editor} onDetach={onDetach} />
      </div>
    )
  }
  return (
    <div className="grid gap-5 px-4 py-4">
      <header className="grid gap-1">
        <div className="flex items-center gap-2">
          {s && <StatusDot dot={dotOf(s, hasPermission)} />}
          <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-fg">{s ? sessionTitle(s) : 'Loading…'}</h3>
        </div>
        {s && (
          <p className="text-[12px] text-fg-muted">
            {isShell ? 'Login shell' : agentName(s.agent)}
            {!isShell && (s.model_display || s.model) ? ` · ${s.model_display || s.model}` : ''}
            {branchLabel(s.git_branch) ? <> · <span className="mono">{branchLabel(s.git_branch)}</span></> : null}
          </p>
        )}
        {/* Cut from the left: the end of a path is the part that tells two
          * worktrees apart, and it was the part cut off. */}
        {s?.cwd && <p dir="rtl" className="mono truncate text-left text-[11px] text-fg-faint" title={s.cwd}><bdi dir="ltr">{s.cwd}</bdi></p>}
      </header>

      {!isShell && showPrompt && <PermissionPrompt sessionId={sessionId} />}

      {s && <Changes sessionId={sessionId} editor={editor} onReview={onReviewChanges} onOpenFile={onOpenFile} />}

      <Actions s={s} sessionId={sessionId} isShell={isShell} ended={ended} editor={editor} onDetach={onDetach} />
    </div>
  )
}

/** "caprock · feat/x": the project first, a branch only when it is not the default, the path on hover. */
function Place({ place }: { place: { project: string; branch: string; path: string } }) {
  return (
    <p className="flex min-w-0 items-baseline gap-1.5 text-[12px]" title={place.path} aria-label={`Project ${place.project}${place.branch ? `, branch ${place.branch}` : ''}`}>
      <span className="min-w-0 truncate font-medium text-fg">{place.project}</span>
      {place.branch && <span className="mono min-w-0 truncate text-[11px] text-fg-faint">· {place.branch}</span>}
    </p>
  )
}

function Actions({ s, sessionId, isShell, ended, editor, onDetach }: { s?: SessionSummary; sessionId: string; isShell: boolean; ended: boolean; editor?: EditorAction; onDetach: () => void }) {
  return (
      <div className="grid gap-1.5 border-t border-[var(--app-hairline)] pt-4">
        {!isShell && (
          <a href={href({ name: 'session', id: sessionId })} className="app-row flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-[12.5px] text-fg no-underline">
            <ExternalIcon size={14} className="text-fg-muted" /> Open in the dashboard
          </a>
        )}
        {editor && s?.cwd && (
          <button type="button" onClick={() => editor.open(s.cwd!, 'the folder')} className="app-row flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] text-fg" title={s.cwd}>
            <ExternalIcon size={14} className="text-fg-muted" /> Open in {editor.name}
          </button>
        )}
        <button type="button" onClick={onDetach} className="app-row flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] text-fg">
          <CloseIcon size={14} className="text-fg-muted" />
          <span className="flex-1">Close the tab</span>
          <kbd className="mono text-[10.5px] text-fg-faint">⌘W</kbd>
        </button>
        {s?.owned && !ended && <StopButton sessionId={sessionId} what={isShell ? 'shell' : 'session'} />}
      </div>
  )
}

function Changes({ sessionId, editor, onReview, onOpenFile }: { sessionId: string; editor?: EditorAction; onReview?: () => void; onOpenFile?: (path: string) => void }) {
  const [diff, setDiff] = useState<DiffResult | undefined>(undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => api.diff(sessionId)
      .then((d) => { if (alive) { setDiff(d); setError('') } })
      .catch((e: unknown) => { if (alive) setError(errText(e)) })
    void load()
    const stop = everyWhileVisible(() => { void load() }, DIFF_REFRESH_MS)
    return () => { alive = false; stop() }
  }, [sessionId])
  const files = diff?.files ?? []
  const add = files.reduce((n, f) => n + (f.additions ?? 0), 0)
  const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0)
  return (
    <section aria-label="Changes" className="grid gap-2">
      <SectionLabel right={onReview ? (
        <button type="button" onClick={onReview} className="text-[11.5px] text-accent underline-offset-2 hover:underline">Review and commit</button>
      ) : undefined}>Changes</SectionLabel>
      {error ? (
        <p className="text-[11.5px] text-fg-faint">{error}</p>
      ) : !diff ? (
        <p className="text-[11.5px] text-fg-faint">Reading the working tree…</p>
      ) : files.length === 0 ? (
        <p className="text-[11.5px] text-fg-faint">No uncommitted changes{diff.branch ? ` on ${diff.branch}` : ''}.</p>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <span className="num text-[13px] font-medium text-fg">{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            <span className="num text-[12px] text-ok">+{add}</span>
            <span className="num text-[12px] text-danger">−{del}</span>
            {add + del > 0 && (
              <span className="ml-auto flex h-[5px] w-[72px] overflow-hidden rounded-full bg-[var(--app-hairline)]" aria-hidden>
                <span className="h-full bg-ok" style={{ width: `${(add / (add + del)) * 100}%` }} />
                <span className="h-full bg-danger" style={{ width: `${(del / (add + del)) * 100}%` }} />
              </span>
            )}
          </div>
          <ul className="grid gap-px">
            {files.slice(0, DIFF_FILES_SHOWN).map((f) => (
              <li key={f.path} className="flex items-center gap-2 text-[11.5px]" title={f.path}>
                <span className={`mono w-3 text-center ${f.status === 'deleted' ? 'text-danger' : f.status === 'added' || f.status === 'untracked' ? 'text-ok' : 'text-fg-faint'}`}>{STATUS[f.status] ?? '·'}</span>
                {onOpenFile && f.status !== 'deleted' ? (
                  <button type="button" onClick={() => onOpenFile(f.path)} className="mono min-w-0 flex-1 truncate text-left text-fg hover:text-accent hover:underline" title={`Open ${f.path}`}>
                    {tail(f.path)}
                  </button>
                ) : editor && diff.root && f.status !== 'deleted' ? (
                  <button
                    type="button"
                    onClick={() => editor.open(joinPath(diff.root, f.path), f.path, undefined, firstChangedLine(f.patch))}
                    className="mono min-w-0 flex-1 truncate text-left text-fg hover:text-accent hover:underline"
                    title={`Open ${f.path} in ${editor.name}`}
                  >
                    {tail(f.path)}
                  </button>
                ) : (
                  <span className="mono min-w-0 flex-1 truncate text-fg">{tail(f.path)}</span>
                )}
                {!f.binary && <span className="num text-ok">+{f.additions}</span>}
                {!f.binary && <span className="num text-danger">−{f.deletions}</span>}
              </li>
            ))}
            {files.length > DIFF_FILES_SHOWN && (
              <li>
                {onReview ? (
                  <button type="button" onClick={onReview} className="text-[11.5px] text-fg-muted hover:text-fg">{files.length - DIFF_FILES_SHOWN} more — review them</button>
                ) : (
                  <a href={href({ name: 'session', id: sessionId, tab: 'changes' })} className="text-[11.5px] text-fg-muted no-underline hover:text-fg">
                    {files.length - DIFF_FILES_SHOWN} more — open the diff
                  </a>
                )}
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  )
}

const STATUS: Record<string, string> = { added: 'A', untracked: 'U', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C' }

/** The last two segments of a path: the file and the folder it is in. */
function tail(path: string): string {
  const parts = path.split('/')
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

/** Stopping is separate from closing a tab, and asks first (components/StopConfirm.tsx). */
function StopButton({ sessionId, what }: { sessionId: string; what: StopWhat }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="app-row flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] text-danger">
        <StopIcon size={14} /> {stopLabel(what)}
      </button>
    )
  }
  return <StopConfirm sessionId={sessionId} what={what} onDone={() => setConfirming(false)} />
}
