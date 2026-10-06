/**
 * A worktree's pull request (WP-19): its checks, reviews and whether it can
 * be merged, kept current by the daemon's `github` frames; and opening one —
 * title and body drafted from the commits (or the agent's summary), the
 * default branch as base, draft or not — which pushes the branch first when
 * GitHub does not have it yet, then links the result. In the app's Changes
 * view as a strip under the header, on the phone in the Changes tab. Every
 * failure is shown with what was being done and what GitHub said.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, isPairedDevice } from '@/lib/api'
import type { WorktreeRef } from '@/lib/changes'
import { messageFromSummary } from '@/lib/changes'
import {
  agoText, checksText, existingPR, githubApi, githubErrorText, mergeText, prKey, prTone, reviewText, usePR,
  type PRTone, type PullRequest, type WorktreeGitHub,
} from '@/lib/github'
import { live } from '@/lib/live'
import { PullRequestIcon } from './AppIcons'
import { CreateRepoSheet } from './CreateRepoSheet'
import { Sheet } from './Sheet'

const TONE_DOT: Record<PRTone, string> = {
  ok: 'bg-ok',
  fail: 'bg-danger',
  pending: 'bg-warn',
  merged: 'bg-fg-muted',
  closed: 'bg-fg-faint',
  none: 'bg-fg-faint/70',
}

const TONE_TEXT: Record<PRTone, string> = {
  ok: 'text-ok',
  fail: 'text-danger',
  pending: 'text-warn',
  merged: 'text-fg-muted',
  closed: 'text-fg-faint',
  none: 'text-fg-muted',
}

/** What GitHub knows of a worktree, read once and again when its pull request moves. */
export function useWorktreeGitHub(target: WorktreeRef): { info?: WorktreeGitHub; error?: string; reload: () => void; refresh: () => Promise<void>; set: (i: WorktreeGitHub) => void } {
  const [info, setInfo] = useState<WorktreeGitHub | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [n, setN] = useState(0)
  const { projectId, worktree } = target
  const live$ = usePR(projectId, worktree)

  useEffect(() => {
    let alive = true
    githubApi.worktree(projectId, worktree)
      .then((i) => { if (alive) { setInfo(i); setError(undefined) } })
      .catch((e: unknown) => { if (alive) setError(githubErrorText(e)) })
    return () => { alive = false }
  }, [projectId, worktree, n])

  // A push or a commit changes what can be offered (published, ahead).
  useEffect(() => {
    let timer = 0
    live.start()
    const off = live.onFrame((f) => {
      if (f.type !== 'project' || String(f.data.id) !== projectId) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setN((x) => x + 1), 1500)
    })
    return () => { off(); window.clearTimeout(timer) }
  }, [projectId])

  const refresh = useCallback(async () => {
    try {
      setInfo(await githubApi.refresh(projectId, worktree))
      setError(undefined)
    } catch (e) {
      setError(githubErrorText(e))
    }
  }, [projectId, worktree])

  // The live frame is newer than the read.
  const merged = info && live$ && live$.at >= (info.pr?.at ?? 0) ? { ...info, pr: live$, draft: live$.state === 'open' ? undefined : info.draft } : info
  return { info: merged, error, reload: () => setN((x) => x + 1), refresh, set: setInfo }
}

/** The small mark the sidebar shows beside a worktree with a pull request. */
export function PRDot({ projectId, worktree }: { projectId: string; worktree: string }) {
  const pr = usePR(projectId, worktree)
  if (!pr) return null
  const tone = prTone(pr)
  return (
    <span
      role="img"
      data-pr={prKey(projectId, worktree)}
      aria-label={`pull request #${pr.number}: ${toneWord(tone)}`}
      title={summaryLine(pr)}
      className={`relative inline-flex shrink-0 items-center ${TONE_TEXT[tone]}`}
    >
      <PullRequestIcon size={12} />
      {tone !== 'none' && tone !== 'closed' && <span aria-hidden className={`absolute -right-[2px] -top-[1px] h-[5px] w-[5px] rounded-full ${TONE_DOT[tone]}`} />}
    </span>
  )
}

function toneWord(t: PRTone): string {
  switch (t) {
    case 'ok': return 'checks passed'
    case 'fail': return 'needs attention'
    case 'pending': return 'checks running'
    case 'merged': return 'merged'
    case 'closed': return 'closed'
    default: return 'open'
  }
}

function summaryLine(pr: PullRequest): string {
  const parts = [`#${pr.number} ${pr.title}`]
  if (pr.state !== 'open') parts.push(pr.state)
  else {
    parts.push(checksText(pr.checks))
    const r = reviewText(pr.review)
    if (r) parts.push(r)
    parts.push(mergeText(pr))
  }
  return parts.join(' · ')
}

/** The pull request's state: link, checks, reviews, mergeability, and its checks one by one. */
export function PRStatus({ pr, compact = false, onRefresh }: { pr: PullRequest; compact?: boolean; onRefresh?: () => Promise<void> }) {
  const [open, setOpen] = useState(pr.checks.state === 'fail')
  const [busy, setBusy] = useState(false)
  const tone = prTone(pr)
  const review = reviewText(pr.review)
  const failing = pr.checks.items.filter((c) => c.state === 'fail')
  const shown = open ? pr.checks.items : failing.slice(0, 3)
  const target = compact ? 'min-h-11' : ''
  return (
    <div className="grid min-w-0 gap-1.5" aria-label={`Pull request #${pr.number}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className={`flex min-w-0 items-center gap-1.5 font-medium text-fg hover:text-accent ${target}`} title="Open on GitHub">
          <span className={TONE_TEXT[tone]}><PullRequestIcon size={13} /></span>
          <span className="num shrink-0">#{pr.number}</span>
          <span className="min-w-0 truncate">{pr.title}</span>
          {pr.draft && <span className="shrink-0 rounded-[4px] border border-border px-1 text-[10.5px] font-normal text-fg-muted">draft</span>}
        </a>
        {pr.state === 'open' ? (
          <>
            <span className={`flex items-center gap-1 ${TONE_TEXT[pr.checks.state === 'fail' ? 'fail' : pr.checks.state === 'pending' ? 'pending' : pr.checks.state === 'pass' ? 'ok' : 'none']}`}>
              <span aria-hidden className={`inline-block h-[7px] w-[7px] rounded-full ${TONE_DOT[pr.checks.state === 'fail' ? 'fail' : pr.checks.state === 'pending' ? 'pending' : pr.checks.state === 'pass' ? 'ok' : 'none']}`} />
              {checksText(pr.checks)}
            </span>
            {review && <span className={pr.review === 'approved' ? 'text-ok' : pr.review === 'changes_requested' ? 'text-danger' : 'text-fg-muted'}>{review}{pr.reviews.length > 0 && pr.review !== 'review_required' ? ` by ${pr.reviews.filter((r) => r.state === pr.review).map((r) => `@${r.user}`).join(', ')}` : ''}</span>}
            <span className={pr.mergeable === false ? 'text-danger' : 'text-fg-muted'}>{mergeText(pr)}</span>
          </>
        ) : (
          <span className={TONE_TEXT[tone]}>{pr.state} into {pr.base}</span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-fg-faint">
          <span>read {agoText(pr.at)}</span>
          {onRefresh && (
            <button type="button" disabled={busy} onClick={() => { setBusy(true); void onRefresh().finally(() => setBusy(false)) }} className={`rounded-[5px] px-1.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:opacity-50 ${target}`}>
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          {pr.checks.items.length > 0 && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={`rounded-[5px] px-1.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg ${target}`}>
              {open ? 'Hide checks' : `Checks (${pr.checks.items.length})`}
            </button>
          )}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="grid gap-0.5" aria-label="Checks">
          {shown.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex min-w-0 items-center gap-2 text-[11.5px]">
              <span aria-label={c.state} className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${c.state === 'pass' ? 'bg-ok' : c.state === 'fail' ? 'bg-danger' : c.state === 'skipped' ? 'bg-fg-faint' : 'bg-warn'}`} />
              {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-fg hover:text-accent">{c.name}</a> : <span className="min-w-0 truncate text-fg">{c.name}</span>}
              <span className="shrink-0 text-fg-faint">{c.state === 'pass' ? 'passed' : c.state === 'fail' ? 'failed' : c.state === 'skipped' ? 'skipped' : 'running'}</span>
            </li>
          ))}
        </ul>
      )}
      {pr.error && <p role="alert" className="text-[11.5px] leading-snug text-danger [overflow-wrap:anywhere]">Could not read it again: {pr.error.doing}: {pr.error.message}</p>}
    </div>
  )
}

/** The pull request form: title, body, base, draft. Pushes first when it must. */
export function CreatePRForm({ target, info, sessionId, compact = false, onCreated, onCancel }: {
  target: WorktreeRef
  info: WorktreeGitHub
  sessionId?: string
  compact?: boolean
  onCreated: (pr: PullRequest, pushed: boolean) => void
  onCancel?: () => void
}) {
  const [title, setTitle] = useState(info.draft?.title ?? info.branch)
  const [body, setBody] = useState(info.draft?.body ?? '')
  const [base, setBase] = useState(info.base)
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState<'' | 'send' | 'summary'>('')
  const [error, setError] = useState('')
  const [existing, setExisting] = useState<PullRequest | undefined>(undefined)
  const pushFirst = !info.published || info.ahead > 0

  const summarize = async () => {
    if (!sessionId) return
    setBusy('summary')
    setError('')
    try {
      const notes = await api.notes(sessionId, 12)
      const note = notes.find((n) => !n.fragment) ?? notes[0]
      if (!note) { setError('The agent has not said anything yet in this worktree.'); return }
      const msg = messageFromSummary(note.text)
      const [subject, ...rest] = msg.split('\n')
      setTitle(subject ?? title)
      const commits = info.draft?.commits ?? []
      const tail = commits.length > 1 ? `\n\n${[...commits].reverse().map((c) => `- ${c}`).join('\n')}` : ''
      setBody(`${rest.join('\n').trim()}${tail}`.trim())
    } catch (e) {
      setError(githubErrorText(e))
    } finally {
      setBusy('')
    }
  }

  const submit = async () => {
    if (!title.trim()) { setError('A pull request needs a title.'); return }
    setBusy('send')
    setError('')
    setExisting(undefined)
    try {
      const r = await githubApi.createPR(target.projectId, target.worktree, { title: title.trim(), body, base: base.trim() || undefined, draft })
      onCreated(r.pr, r.pushed)
    } catch (e) {
      setError(githubErrorText(e))
      setExisting(existingPR(e))
    } finally {
      setBusy('')
    }
  }

  const field = compact ? 'input h-11 !text-[16px]' : 'input'
  const btn = compact ? 'min-h-11 px-4 text-[15px]' : 'h-[30px] px-3.5 text-[13px]'
  return (
    <form className="grid min-w-0 gap-3" onSubmit={(e) => { e.preventDefault(); void submit() }} aria-label="Open a pull request">
      <label className="grid gap-1">
        <span className="text-[12px] text-fg-muted">Title</span>
        <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      </label>
      <label className="grid gap-1">
        <span className="text-[12px] text-fg-muted">Description</span>
        <textarea className={`input min-h-[110px] resize-y ${compact ? '!text-[16px]' : ''}`} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Description" />
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <span className="text-fg-muted">Into</span>
          <input className={`${field} w-[140px]`} value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch" />
        </label>
        <span className="mono min-w-0 truncate text-[12px] text-fg-faint">← {info.branch}</span>
        <label className={`flex items-center gap-2 text-[12.5px] text-fg ${compact ? 'min-h-11' : ''}`}>
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          Draft
        </label>
        {sessionId && (
          <button type="button" disabled={!!busy} onClick={() => void summarize()} className={`rounded-[6px] text-[12px] text-accent hover:underline disabled:opacity-50 ${compact ? 'min-h-11' : ''}`}>
            {busy === 'summary' ? 'Reading…' : "Use the agent's summary"}
          </button>
        )}
      </div>
      {pushFirst && <p className="text-[12px] text-fg-muted">{info.published ? `${info.ahead} commit${info.ahead === 1 ? '' : 's'} not on GitHub yet: they are pushed first.` : `${info.branch} is not on GitHub yet: it is pushed first, with your git credentials.`}</p>}
      {error && (
        <div role="alert" className="grid gap-1 rounded-[8px] border border-danger/40 bg-danger/[0.06] px-2.5 py-2 text-[12.5px] leading-snug text-fg [overflow-wrap:anywhere]">
          <span>{error}</span>
          {existing && <a href={existing.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Open #{existing.number} on GitHub</a>}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && <button type="button" onClick={onCancel} className={`rounded-[7px] border border-[var(--app-hairline-strong)] text-fg hover:bg-[var(--app-row-hover)] ${btn}`}>Cancel</button>}
        <button type="submit" disabled={!!busy} className={`rounded-[7px] bg-accent font-medium text-panel hover:brightness-110 disabled:opacity-50 ${btn}`}>
          {busy === 'send' ? (pushFirst ? 'Pushing, then opening…' : 'Opening…') : draft ? 'Open draft pull request' : 'Open pull request'}
        </button>
      </div>
    </form>
  )
}

/** Why a worktree offers no pull request, when that is worth saying. */
function reasonText(i: WorktreeGitHub): string | null {
  return i.reason === 'detached' ? 'HEAD is detached: check out a branch to open a pull request.' : null
}

/**
 * The strip in the app's Changes view: the pull request's state, or the
 * button that opens one, or the one that puts the project on GitHub.
 */
export function GitHubStrip({ target, title, sessionId }: { target: WorktreeRef; title: string; sessionId?: string }) {
  const { info, error, refresh, reload } = useWorktreeGitHub(target)
  const [creating, setCreating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [opened, setOpened] = useState<{ pr: PullRequest; pushed: boolean } | null>(null)
  if (error) return <Strip><p role="alert" className="text-[12px] text-danger [overflow-wrap:anywhere]">{error}</p></Strip>
  if (!info) return null
  if (info.reason === 'no_remote') {
    if (isPairedDevice()) return null
    return (
      <Strip>
        <span className="text-[12px] text-fg-muted">Not on GitHub yet.</span>
        {info.connected
          ? <button type="button" onClick={() => setPublishing(true)} className="rounded-[6px] px-1.5 text-[12px] text-accent hover:bg-[var(--app-row-hover)]">Create a GitHub repository…</button>
          : <a href="#/settings" className="text-[12px] text-accent hover:underline">Connect GitHub to publish it</a>}
        {publishing && <CreateRepoSheet projectId={target.projectId} defaultName={title.split(' · ')[0] ?? ''} onClose={() => setPublishing(false)} onDone={() => { setPublishing(false); reload() }} />}
      </Strip>
    )
  }
  if (!info.repo) return null
  const why = reasonText(info)
  if (info.pr) {
    return (
      <Strip>
        <div className="min-w-0 flex-1">
          {opened && <p role="status" className="mb-1 text-[12px] text-ok">{opened.pushed ? `Pushed ${info.branch} and opened` : 'Opened'} #{opened.pr.number}.</p>}
          <PRStatus pr={info.pr} onRefresh={info.connected ? refresh : undefined} />
        </div>
        {info.pr.state !== 'open' && info.draft && (
          <button type="button" onClick={() => setCreating(true)} className="shrink-0 rounded-[6px] px-1.5 text-[12px] text-accent hover:bg-[var(--app-row-hover)]">New pull request…</button>
        )}
        {creating && <CreateSheet target={target} info={info} sessionId={sessionId} onClose={() => setCreating(false)} onCreated={(pr, pushed) => { setOpened({ pr, pushed }); setCreating(false); reload() }} />}
      </Strip>
    )
  }
  if (why) return <Strip><span className="text-[12px] text-fg-muted">{why}</span></Strip>
  if (info.reason) return null
  return (
    <Strip>
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
        <PullRequestIcon size={13} className="text-fg-faint" />
        {info.connected ? `No pull request from ${info.branch} into ${info.base} yet.` : 'Connect GitHub in Settings to open a pull request from here.'}
      </span>
      {info.connected && (
        <button type="button" onClick={() => setCreating(true)} className="ml-auto h-[26px] shrink-0 rounded-[7px] bg-accent px-2.5 text-[12px] font-medium text-panel hover:brightness-110">
          Open pull request…
        </button>
      )}
      {creating && <CreateSheet target={target} info={info} sessionId={sessionId} onClose={() => setCreating(false)} onCreated={(pr, pushed) => { setOpened({ pr, pushed }); setCreating(false); reload() }} />}
    </Strip>
  )
}

function Strip({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[36px] shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-[var(--app-hairline)] px-4 py-1.5" aria-label="GitHub">{children}</div>
}

function CreateSheet({ target, info, sessionId, onClose, onCreated }: { target: WorktreeRef; info: WorktreeGitHub; sessionId?: string; onClose: () => void; onCreated: (pr: PullRequest, pushed: boolean) => void }) {
  return (
    <Sheet label="Open a pull request" title={`Open a pull request · ${info.repo?.full_name ?? ''}`} onClose={onClose} width={600}>
      <div className="px-5 py-4">
        <CreatePRForm target={target} info={info} sessionId={sessionId} onCreated={onCreated} onCancel={onClose} />
      </div>
    </Sheet>
  )
}

/** The phone's pull request card, in a session's Changes tab. */
export function PullRequestCard({ target, canControl, sessionId }: { target: WorktreeRef; canControl: boolean; sessionId?: string }) {
  const { info, error, refresh, reload } = useWorktreeGitHub(target)
  const [creating, setCreating] = useState(false)
  const [opened, setOpened] = useState<PullRequest | null>(null)
  if (error) return <p role="alert" className="text-[12.5px] text-danger [overflow-wrap:anywhere]">{error}</p>
  if (!info || !info.repo || (info.reason && !info.pr)) return null
  return (
    <div className="grid gap-2 border-t border-border/60 pt-2.5" aria-label="Pull request">
      {info.pr ? (
        <>
          {opened && <p role="status" className="text-[12.5px] text-ok">Opened #{opened.number}.</p>}
          <PRStatus pr={info.pr} compact onRefresh={canControl && info.connected ? refresh : undefined} />
        </>
      ) : !info.connected ? (
        <p className="text-[12px] text-fg-muted">GitHub is not connected; connect it in Settings on the computer to open a pull request.</p>
      ) : creating ? (
        <CreatePRForm target={target} info={info} sessionId={sessionId} compact onCancel={() => setCreating(false)} onCreated={(pr) => { setOpened(pr); setCreating(false); reload() }} />
      ) : canControl ? (
        <button type="button" onClick={() => setCreating(true)} className="flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-panel)] border border-border-strong px-3 text-[14px] text-fg">
          <PullRequestIcon size={15} /> Open a pull request
        </button>
      ) : (
        <p className="text-[12px] text-fg-muted">No pull request from {info.branch} yet.</p>
      )}
    </div>
  )
}
