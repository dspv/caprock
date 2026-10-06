/**
 * The inspector beside the terminal in front (WP-04): what the session has
 * cost, how full its context is, its tokens, the permission prompt it waits
 * on, and what it has changed. Opened and closed with ⌘I.
 *
 * The figures come from the sessions list the sidebar already holds — no
 * extra polling for them. Only the diff is fetched, when the inspector is
 * open, and refreshed every 20 s while it stays open.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api, errText, type DiffResult, type EditorList, type SessionSummary } from '@/lib/api'
import { firstChangedLine, joinPath, preferredName } from '@/lib/editors'
import { fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { agentName } from './Projects'
import { PermissionPrompt } from './PermissionPrompt'
import { StatusDot } from './ProjectRow'
import { branchLabel } from '@/lib/sessionLabels'
import { dotOf, sessionTitle } from '@/lib/sidebar'
import { href } from '@/lib/router'
import { CloseIcon, ExternalIcon, StopIcon } from './AppIcons'

const DIFF_REFRESH_MS = 20_000
const DIFF_FILES_SHOWN = 8

export function Inspector({
  session,
  sessionId,
  hasPermission,
  onClose,
  onDetach,
  editors = null,
  onOpenInEditor,
  onReviewChanges,
}: {
  session?: SessionSummary
  sessionId?: string
  hasPermission: boolean
  onClose: () => void
  onDetach: () => void
  /** The editors found on this machine (F18); null hides the actions. */
  editors?: EditorList | null
  onOpenInEditor?: OpenInEditor
  /** Opens the Changes view of the worktree the session runs in. */
  onReviewChanges?: () => void
}) {
  return (
    <aside aria-label="Inspector" className="app-scroll flex h-full min-h-0 flex-col overflow-y-auto border-l border-[var(--app-hairline)] bg-[var(--app-chrome-bg)]">
      <div className="flex h-[40px] shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] pl-4 pr-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">Inspector</h2>
        <button type="button" onClick={onClose} aria-label="Close the inspector (⌘I)" title="Close (⌘I)" className="ml-auto flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          <CloseIcon size={13} />
        </button>
      </div>
      {!sessionId ? (
        <p className="px-4 py-5 text-[12.5px] leading-relaxed text-fg-muted">Open a session to see what it costs, how full its context is, and what it changed.</p>
      ) : (
        <Body key={sessionId} session={session} sessionId={sessionId} hasPermission={hasPermission} onDetach={onDetach} editor={editors && onOpenInEditor ? { name: preferredName(editors), open: onOpenInEditor } : undefined} onReviewChanges={onReviewChanges} />
      )}
    </aside>
  )
}

type OpenInEditor = (path: string, label: string, editor?: string, line?: number) => void
interface EditorAction { name: string; open: OpenInEditor }

function Body({ session: s, sessionId, hasPermission, onDetach, editor, onReviewChanges }: { session?: SessionSummary; sessionId: string; hasPermission: boolean; onDetach: () => void; editor?: EditorAction; onReviewChanges?: () => void }) {
  const isShell = s?.kind === 'shell'
  const ended = s?.status === 'ended'
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
        {s?.cwd && <p className="mono truncate text-[11px] text-fg-faint" title={s.cwd}>{s.cwd}</p>}
      </header>

      {!isShell && <PermissionPrompt sessionId={sessionId} />}

      {s && !isShell && <Figures s={s} />}
      {s && <Changes sessionId={sessionId} editor={editor} onReview={onReviewChanges} />}

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
    </div>
  )
}

function Figures({ s }: { s: SessionSummary }) {
  const st = s.stats
  const ctx = s.context
  return (
    <section aria-label="Figures" className="grid gap-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Figure label="Cost" value={fmtUSD(st?.cost_usd ?? 0)} />
        <Figure label="Turns" value={String(st?.turns ?? 0)} sub={`${st?.tool_calls ?? 0} tool calls`} />
        <Figure label="Tokens in" value={fmtTokens((st?.tokens_in ?? 0) + (st?.cache_read ?? 0) + (st?.cache_write ?? 0))} sub={`${fmtTokens(st?.cache_read ?? 0)} from cache`} />
        <Figure label="Tokens out" value={fmtTokens(st?.tokens_out ?? 0)} />
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11.5px] text-fg-muted">Context</span>
          <span className="num text-[11.5px] text-fg">{ctx ? `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}` : '—'}</span>
        </div>
        <div className="h-[5px] overflow-hidden rounded-full bg-[var(--app-hairline)]" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ctx ? Math.round(ctx.pct) : 0}>
          <div
            className={`h-full rounded-full ${ctx && ctx.pct >= 85 ? 'bg-danger' : ctx && ctx.pct >= 60 ? 'bg-warn' : 'bg-ok'}`}
            style={{ width: `${Math.max(0, Math.min(100, ctx?.pct ?? 0))}%` }}
          />
        </div>
        <p className="text-[11px] text-fg-faint">
          {ctx ? `${fmtPct(ctx.pct)} full · next call ${fmtUSD(ctx.next_call_usd)} before it does anything` : s.context_note ?? 'not measured yet'}
        </p>
      </div>
    </section>
  )
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <span className="text-[11.5px] text-fg-muted">{label}</span>
      <span className="num truncate text-[17px] font-medium leading-tight tracking-[-0.01em] text-fg">{value}</span>
      {sub && <span className="num truncate text-[11px] text-fg-faint">{sub}</span>}
    </div>
  )
}

function Changes({ sessionId, editor, onReview }: { sessionId: string; editor?: EditorAction; onReview?: () => void }) {
  const [diff, setDiff] = useState<DiffResult | undefined>(undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => api.diff(sessionId)
      .then((d) => { if (alive) { setDiff(d); setError('') } })
      .catch((e: unknown) => { if (alive) setError(errText(e)) })
    void load()
    const id = window.setInterval(load, DIFF_REFRESH_MS)
    return () => { alive = false; window.clearInterval(id) }
  }, [sessionId])
  const files = diff?.files ?? []
  const add = files.reduce((n, f) => n + (f.additions ?? 0), 0)
  const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0)
  return (
    <section aria-label="Changes" className="grid gap-2">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[11.5px] text-fg-muted">Changes</h4>
        {onReview && (
          <button type="button" onClick={onReview} className="text-[11.5px] text-accent underline-offset-2 hover:underline">Review and commit</button>
        )}
        {diff && files.length > 0 && (
          <span className="num ml-auto text-[11.5px]">
            <span className="text-fg">{files.length} {files.length === 1 ? 'file' : 'files'}</span>{' '}
            <span className="text-ok">+{add}</span> <span className="text-danger">−{del}</span>
          </span>
        )}
      </div>
      {error ? (
        <p className="text-[11.5px] text-fg-faint">{error}</p>
      ) : !diff ? (
        <p className="text-[11.5px] text-fg-faint">Reading the working tree…</p>
      ) : files.length === 0 ? (
        <p className="text-[11.5px] text-fg-faint">No uncommitted changes{diff.branch ? ` on ${diff.branch}` : ''}.</p>
      ) : (
        <ul className="grid gap-px">
          {files.slice(0, DIFF_FILES_SHOWN).map((f) => (
            <li key={f.path} className="flex items-center gap-2 text-[11.5px]" title={f.path}>
              <span className="mono w-3 text-center text-fg-faint">{STATUS[f.status] ?? '·'}</span>
              {editor && diff.root && f.status !== 'deleted' ? (
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
              <a href={href({ name: 'session', id: sessionId, tab: 'changes' })} className="text-[11.5px] text-fg-muted no-underline hover:text-fg">
                {files.length - DIFF_FILES_SHOWN} more — open the diff
              </a>
            </li>
          )}
        </ul>
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

/** Stopping is separate from closing a tab, and asks first. */
function StopButton({ sessionId, what }: { sessionId: string; what: 'session' | 'shell' }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      await api.signal(sessionId, 'kill')
      setConfirming(false)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="app-row flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] text-danger">
        <StopIcon size={14} /> Stop the {what}…
      </button>
    )
  }
  return (
    <Confirm>
      <p className="text-[12.5px] text-fg">Stop this {what}? Its process ends; the {what === 'shell' ? 'shell' : 'conversation'} is kept{what === 'session' ? ' and can be continued' : ''}.</p>
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setConfirming(false)} className="h-[28px] rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[12.5px] text-fg hover:bg-[var(--app-row-hover)]">Keep it</button>
        <button type="button" autoFocus disabled={busy} onClick={() => void stop()} className="h-[28px] rounded-[7px] bg-danger px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50">
          {busy ? 'Stopping…' : `Stop ${what}`}
        </button>
      </div>
    </Confirm>
  )
}

function Confirm({ children }: { children: ReactNode }) {
  return <div role="alertdialog" aria-label="Confirm stop" className="grid gap-2 rounded-[9px] border border-danger/40 bg-danger/[0.06] p-3">{children}</div>
}
