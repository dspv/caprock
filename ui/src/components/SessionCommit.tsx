/**
 * Commit and push from a session's Changes tab — the phone's compact Changes
 * view (21-app.md F13/F14 groundwork). It finds the project and worktree the
 * session runs in, lists what is uncommitted there (tap a file to stage or
 * unstage it), and offers Commit, Commit & Push, Push and Pull. A viewer sees
 * the counts and is told where committing happens.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionSummary } from '@/lib/api'
import { changesApi, changedCount, entriesOf, failureOf, type ChangeEntry, type WorktreeRef } from '@/lib/changes'
import { inProject, NotSupportedError, projectsApi, worktreeKeyOf, type Project } from '@/lib/projects'
import { useCanControl } from '@/lib/useCanControl'
import { useChanges } from '@/lib/useChanges'
import { CommitBox, OutcomeLine, RemoteActions, type Outcome } from './CommitBox'

/** Files listed before "show all". */
const SHOWN = 8

type Resolved =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'unlisted' }
  | { kind: 'unknown-worktree'; name: string }
  | { kind: 'ok'; ref: WorktreeRef; project: Project }

/**
 * The listed project a session belongs to (the longest root that holds it),
 * and git's name for its worktree — '' for the main checkout. A worktree the
 * project does not list is not guessed at: committing in the wrong checkout
 * is worse than not offering to.
 */
export function resolveWorktree(s: Pick<SessionSummary, 'cwd' | 'repo_root' | 'worktree'>, list: Project[]): Resolved {
  const p = list
    .filter((x) => x.kind === 'repo' && x.root && inProject(s, x))
    .sort((a, b) => b.root.length - a.root.length)[0]
  if (!p) return { kind: 'unlisted' }
  const key = worktreeKeyOf(s, p)
  if (key === 'main') return { kind: 'ok', ref: { projectId: p.id, worktree: '' }, project: p }
  if ((p.worktrees ?? []).some((w) => w.name === key)) return { kind: 'ok', ref: { projectId: p.id, worktree: key }, project: p }
  return { kind: 'unknown-worktree', name: key }
}

export function SessionCommit({ session }: { session: Pick<SessionSummary, 'cwd' | 'repo_root' | 'worktree' | 'session_id' | 'git_branch'> }) {
  const [resolved, setResolved] = useState<Resolved>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)
  const canControl = useCanControl()
  const { cwd, repo_root: repoRoot, worktree } = session

  useEffect(() => {
    let alive = true
    projectsApi.list()
      .then((list) => { if (alive) setResolved(resolveWorktree({ cwd, repo_root: repoRoot, worktree }, list)) })
      .catch((e: unknown) => { if (alive) setResolved(e instanceof NotSupportedError ? { kind: 'unsupported' } : { kind: 'unlisted' }) })
    return () => { alive = false }
  }, [cwd, repoRoot, worktree, nonce])

  if (resolved.kind === 'loading' || resolved.kind === 'unsupported') return null
  if (resolved.kind === 'unknown-worktree') {
    return <Note>This session runs in the worktree “{resolved.name}”, which its project does not list; commit it on the machine.</Note>
  }
  if (resolved.kind === 'unlisted') {
    return <AddProject root={repoRoot || cwd} canControl={canControl} onAdded={() => setNonce((n) => n + 1)} />
  }
  return <Panel target={resolved.ref} canControl={canControl} sessionId={session.session_id} />
}

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2 text-[12.5px] leading-snug text-fg-muted">{children}</p>
}

function AddProject({ root, canControl, onAdded }: { root: string; canControl: boolean; onAdded: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!root) return null
  if (!canControl) return null
  const add = async () => {
    setBusy(true)
    setError('')
    try {
      await projectsApi.add({ path: root })
      onAdded()
    } catch (e) {
      setError(failureOf(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-2 rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2.5">
      <p className="text-[12.5px] leading-snug text-fg-muted">To commit and push from here, add <span className="mono text-fg">{root}</span> as a project.</p>
      <button type="button" disabled={busy} onClick={() => void add()} className="min-h-11 justify-self-start rounded-[7px] border border-border-strong px-3 text-[13px] text-fg disabled:opacity-50">
        {busy ? 'Adding…' : 'Add as a project'}
      </button>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

function Panel({ target, canControl, sessionId }: { target: WorktreeRef; canControl: boolean; sessionId: string }) {
  const ref = useMemo(() => target, [target.projectId, target.worktree]) // eslint-disable-line react-hooks/exhaustive-deps
  const { changes, error, accept } = useChanges(ref)
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState('')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const entries = entriesOf(changes)
  const total = changedCount(changes)
  const toggle = async (e: ChangeEntry) => {
    if (e.area === 'conflicted') return
    setBusy(e.key)
    setOutcome(null)
    try {
      const req = { paths: [e.file.path] }
      accept(e.area === 'staged' ? await changesApi.unstage(ref, req) : await changesApi.stage(ref, req))
    } catch (err) {
      setOutcome({ ok: false, failure: failureOf(err) })
    } finally {
      setBusy('')
    }
  }
  if (error && !changes) return <Note>{error.message}</Note>
  if (!changes) return null
  const shown = all ? entries : entries.slice(0, SHOWN)
  const branch = changes.branch || 'detached HEAD'
  return (
    <section aria-label="Commit" className="grid gap-2.5 rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-[13px] font-medium text-fg">Uncommitted</h3>
        <span className="mono min-w-0 truncate text-[12px] text-fg-muted">{branch}</span>
        <span className="num ml-auto text-[12px] text-fg-muted">
          {total === 0 ? 'clean' : `${total} file${total === 1 ? '' : 's'}${changes.staged.length ? ` · ${changes.staged.length} staged` : ''}`}
          {changes.ahead > 0 && ` · ↑${changes.ahead}`}
          {changes.behind > 0 && ` · ↓${changes.behind}`}
        </span>
      </div>
      {entries.length > 0 && (
        <ul className="grid">
          {shown.map((e) => (
            <li key={e.key}>
              <button
                type="button"
                disabled={!canControl || !!busy || e.area === 'conflicted'}
                onClick={() => void toggle(e)}
                aria-pressed={e.area === 'staged'}
                className="flex min-h-11 w-full min-w-0 items-center gap-2.5 border-b border-border/60 text-left last:border-0 disabled:opacity-100"
              >
                <span
                  aria-hidden
                  className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border text-[12px] leading-none ${e.area === 'staged' ? 'border-accent bg-accent text-bg' : e.area === 'conflicted' ? 'border-danger text-danger' : 'border-border-strong text-transparent'}`}
                >
                  {e.area === 'conflicted' ? '!' : '✓'}
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-fg">{e.file.path}</span>
                <span className="num shrink-0 text-[11px]">
                  {e.file.status === 'untracked' ? <span className="text-ok">new</span> : e.file.binary ? <span className="text-fg-faint">bin</span> : (
                    <><span className="text-ok">+{e.file.additions}</span> <span className="text-danger">−{e.file.deletions}</span></>
                  )}
                </span>
              </button>
            </li>
          ))}
          {entries.length > SHOWN && (
            <li>
              <button type="button" onClick={() => setAll((v) => !v)} className="min-h-11 text-[12.5px] text-fg-muted">
                {all ? 'Show fewer' : `Show all ${entries.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
      {canControl && entries.length > 0 && (
        <p className="text-[11.5px] text-fg-faint">{changes.staged.length > 0 ? 'Checked files are committed.' : 'Nothing checked: every file is committed. Tap files to commit only those.'}</p>
      )}
      {outcome && <OutcomeLine outcome={outcome} onDismiss={() => setOutcome(null)} compact />}
      {canControl ? (
        <>
          {total > 0 && <CommitBox target={ref} changes={changes} onChanges={accept} sessionId={sessionId} compact />}
          <RemoteActions target={ref} changes={changes} onChanges={accept} compact />
        </>
      ) : (
        <p className="text-[12px] text-fg-muted">This device can read, not commit. Commit on the machine, or make this device a controller there.</p>
      )}
    </section>
  )
}
