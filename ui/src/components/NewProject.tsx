/**
 * Start work from the phone (WP-15, .ai/21-app.md § Phone v2): clone a
 * repository, make a new project or a worktree, then start an agent there and
 * land in its chat — without walking to the computer.
 *
 * Built for a thumb at 320–390 px: one column, 44 px targets, 16 px fields (so
 * iOS does not zoom), no autofocus (the keyboard would cover the picker), and
 * nothing that scrolls the page by itself — each step replaces the card it
 * came from in place.
 *
 * A clone outlives the phone's connection: it runs on the computer, and this
 * screen follows it through lib/startwork.ts, which keeps the request in
 * localStorage and resumes on reconnect without cloning twice. The daemon
 * enforces every rule shown here (ADR-034): a controller only, folders under
 * home, https:// or git@ addresses only.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, errText, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useCanControl } from '@/lib/useCanControl'
import { live, useLiveLink } from '@/lib/live'
import { navigate, type StartMode } from '@/lib/router'
import { newOpId, projectsApi, type OpFrame, type Project } from '@/lib/projects'
import {
  CloneTracker, clearPendingClone, isPhoneCloneURL, loadPendingClone, repoName, savePendingClone,
  type CloneView, type PendingClone,
} from '@/lib/startwork'
import { ConnectionState } from './ConnectionState'
import { DirPicker } from './DirPicker'
import { SpawnDialog } from './SpawnDialog'
import { spawnableAgents } from './AgentPicker'

const MODES: { key: StartMode; label: string }[] = [
  { key: 'clone', label: 'Clone' },
  { key: 'new', label: 'New project' },
  { key: 'worktree', label: 'Worktree' },
]

/** A place work can start: a folder, and the project it is in when known. */
interface Ready {
  path: string
  projectId?: string
  what: string
}

const FIELD = 'input h-11 !text-[16px]'
const PRIMARY = 'flex h-12 w-full items-center justify-center rounded-[var(--radius-panel)] bg-accent px-4 text-[16px] font-medium text-accent-fg disabled:opacity-50'
const SECONDARY = 'flex h-11 w-full items-center justify-center rounded-[var(--radius-panel)] border border-border-strong px-4 text-[15px] text-fg disabled:opacity-50'

export function NewProjectScreen({ mode: asked }: { mode?: StartMode }) {
  const canControl = useCanControl()
  // A clone left running when the page was closed or discarded comes back here.
  const [pending, setPending] = useState<PendingClone | null>(() => loadPendingClone())
  const mode: StartMode = asked ?? 'clone'
  const [ready, setReady] = useState<Ready | null>(null)
  const [worktreeOf, setWorktreeOf] = useState<string>('')
  const [spawning, setSpawning] = useState('')
  const status = useApi(() => api.status(), [], { live: false })
  // Where a phone may put things: the daemon's browse root, inside home.
  const root = useApi(() => api.browse(''), [], { live: false })
  const home = root.data?.root ?? ''

  const pick = (m: StartMode) => {
    setReady(null)
    navigate({ name: 'start', mode: m })
  }

  if (!canControl) {
    return (
      <Frame>
        <div className="grid gap-2 rounded-[var(--radius-panel)] border border-border bg-panel p-4 text-[15px] leading-relaxed text-fg">
          <p>This phone can read Caprock, not start work.</p>
          <p className="text-fg-muted">On the computer: Settings → Open Caprock on your phone → <span className="text-fg">Let it control sessions</span>.</p>
        </div>
      </Frame>
    )
  }

  return (
    <Frame>
      <div role="tablist" aria-label="How to start" className="grid grid-cols-3 gap-1 rounded-[10px] bg-panel-2 p-1">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={mode === m.key}
            onClick={() => pick(m.key)}
            className={`h-11 min-w-0 rounded-[8px] px-1 text-[14px] ${mode === m.key ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-muted'}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {ready ? (
        <ReadyCard
          ready={ready}
          onStart={() => setSpawning(ready.path)}
          onWorktree={ready.projectId && mode !== 'worktree' ? () => { setWorktreeOf(ready.projectId!); pick('worktree') } : undefined}
          onAnother={() => setReady(null)}
        />
      ) : mode === 'clone' ? (
        <CloneForm
          home={home}
          pending={pending}
          onPending={setPending}
          onDone={(op) => setReady({ path: op.dest ?? '', projectId: op.project_id ? String(op.project_id) : undefined, what: 'Cloned' })}
        />
      ) : mode === 'new' ? (
        <CreateForm home={home} onDone={setReady} />
      ) : (
        <WorktreeForm initial={worktreeOf} onDone={setReady} />
      )}

      {spawning && (
        <SpawnDialog
          available={status.data?.claude_available ?? false}
          geminiAvailable={status.data?.gemini_available ?? false}
          agents={status.data ? spawnableAgents(status.data) : undefined}
          initialCwd={spawning}
          landOn="chat"
          onClose={() => setSpawning('')}
        />
      )}
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-[560px] min-w-0 gap-4 pb-8">
      <div className="flex items-center gap-3">
        <a href="#/" className="flex h-11 items-center pr-2 text-[15px] text-accent">← Now</a>
        <h1 className="text-[18px] font-semibold text-fg">Start work</h1>
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-[13px] text-fg-muted">{label}{hint && <span className="text-fg-faint"> · {hint}</span>}</span>
      {children}
    </label>
  )
}

/** A folder field with the picker folded under it: the default is usually right. */
function FolderField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-[13px] text-fg-muted">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <input className={`${FIELD} min-w-0 flex-1`} value={value} onChange={(e) => onChange(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label={label} />
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="h-11 shrink-0 rounded-[var(--radius-panel)] border border-border-strong px-3 text-[14px] text-fg">
          {open ? 'Done' : 'Change'}
        </button>
      </div>
      {open && <div className="min-w-0"><DirPicker value={value} onPick={onChange} /></div>}
    </div>
  )
}

function Problem({ text }: { text: string }) {
  return text ? <p role="alert" className="text-[14px] leading-snug text-danger break-words">{text}</p> : null
}

function CloneForm({
  home,
  pending,
  onPending,
  onDone,
}: {
  home: string
  pending: PendingClone | null
  onPending: (p: PendingClone | null) => void
  onDone: (op: OpFrame) => void
}) {
  // Prefilled from a clone that failed or is being followed, so "Try again" is one tap.
  const [url, setUrl] = useState(pending?.url ?? '')
  const [parent, setParent] = useState(pending?.parent ?? '')
  const [error, setError] = useState('')
  const [view, setView] = useState<CloneView | null>(null)
  const into = parent || home
  const u = url.trim()

  useEffect(() => {
    if (!pending) return
    const t = new CloneTracker(pending, setView)
    t.start()
    return () => t.stop()
  }, [pending])

  useEffect(() => {
    if (view?.phase === 'done') {
      onPending(null)
      onDone(view.op)
    }
  }, [view, onDone, onPending])

  const submit = () => {
    setError('')
    if (!isPhoneCloneURL(u)) { setError('Paste an https:// address, or git@host:owner/repo.'); return }
    if (!into) { setError('Choose a folder to clone into.'); return }
    const p: PendingClone = { op_id: newOpId(), url: u, parent: into, started_at: Date.now() }
    savePendingClone(p)
    setView({ phase: 'sending' })
    onPending(p)
  }

  const unfollow = () => { clearPendingClone(); onPending(null); setView(null) }
  if (pending && view?.phase !== 'failed') return <CloneProgress pending={pending} view={view ?? { phase: 'sending' }} onUnfollow={unfollow} />

  const failed = view?.phase === 'failed' ? view.error : ''
  return (
    <form className="grid min-w-0 gap-4" onSubmit={(e) => { e.preventDefault(); if (failed) { onPending(null); setView(null) } submit() }}>
      <Field label="Repository" hint="https:// or git@">
        <input
          className={FIELD}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://github.com/you/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <FolderField label="Clone into" value={into} onChange={setParent} />
      {u && isPhoneCloneURL(u) && into && (
        <p className="mono text-[12px] text-fg-faint break-all">→ {into.replace(/\/+$/, '')}/{repoName(u)}</p>
      )}
      <Problem text={error || (failed ? `Clone failed: ${failed}` : '')} />
      <button type="submit" className={PRIMARY}>{failed ? 'Try again' : 'Clone'}</button>
    </form>
  )
}

/** Where the clone is, said so a phone that just came back knows at a glance. */
function CloneProgress({ pending, view, onUnfollow }: { pending: PendingClone; view: CloneView; onUnfollow: () => void }) {
  const link = useLiveLink()
  const op = view.op
  const pct = Math.max(0, Math.min(100, op?.progress ?? 0))
  const label = view.phase === 'offline'
    ? 'Waiting for the connection…'
    : view.phase === 'sending' ? 'Starting the clone…' : op?.phase ? `${op.phase}` : 'Cloning…'
  return (
    <div className="grid min-w-0 gap-3 rounded-[var(--radius-panel)] border border-border bg-panel p-4" aria-busy="true">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="text-[16px] font-medium text-fg">{label}</span>
        <span className="num text-[16px] text-fg-muted">{view.phase === 'running' ? `${pct}%` : ''}</span>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Clone progress" className="h-2 overflow-hidden rounded-full bg-panel-2">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${view.phase === 'running' ? pct : 4}%` }} />
      </div>
      <p className="mono text-[12px] text-fg-faint break-all">{pending.url}</p>
      <p className="text-[13px] leading-snug text-fg-muted">
        The clone runs on the computer. Lock the phone or lose signal — it keeps going, and this page catches up when you are back.
      </p>
      <ConnectionState link={link} heardAt={live.heardAt} className="text-[12px] text-fg-muted" />
      <button type="button" onClick={onUnfollow} className="justify-self-start py-2 text-[13px] text-fg-faint underline">
        Stop following (the clone goes on)
      </button>
    </div>
  )
}

function CreateForm({ home, onDone }: { home: string; onDone: (r: Ready) => void }) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [gitInit, setGitInit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const into = parent || home
  const submit = async () => {
    setError('')
    const n = name.trim()
    if (!n || /[/\\]/.test(n) || n === '.' || n === '..') { setError('Name the folder — one name, no slashes.'); return }
    if (!into) { setError('Choose where it goes.'); return }
    setBusy(true)
    try {
      const r = await projectsApi.add({ create: { parent: into, name: n, git_init: gitInit } })
      if ('project' in r) onDone({ path: r.project.root, projectId: r.project.id, what: 'Created' })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="grid min-w-0 gap-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <Field label="Name">
        <input className={FIELD} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="my-new-project" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <FolderField label="In" value={into} onChange={setParent} />
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] text-fg">
        <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={gitInit} onChange={(e) => setGitInit(e.target.checked)} />
        Make it a git repository
      </label>
      <Problem text={error} />
      <button type="submit" disabled={busy} className={PRIMARY}>{busy ? 'Creating…' : 'Create'}</button>
    </form>
  )
}

function WorktreeForm({ initial, onDone }: { initial: string; onDone: (r: Ready) => void }) {
  const list = useApi(() => projectsApi.list(), [], { live: false })
  const repos = useMemo(() => (list.data ?? []).filter((p) => p.kind === 'repo'), [list.data])
  const [projectId, setProjectId] = useState(initial)
  const [branch, setBranch] = useState('')
  const [create, setCreate] = useState(true)
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const project: Project | undefined = repos.find((p) => p.id === projectId) ?? (projectId ? undefined : repos[0])

  const submit = async () => {
    setError('')
    if (!project) { setError('Choose a project.'); return }
    const b = branch.trim()
    if (!b) { setError('Name the branch.'); return }
    setBusy(true)
    try {
      const wt = await projectsApi.createWorktree(project.id, { branch: b, create, base: create && base.trim() ? base.trim() : undefined })
      onDone({ path: wt.path, projectId: project.id, what: `Worktree on ${wt.branch}` })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  if (list.error && !list.data) return <Problem text={errText(list.error)} />
  if (!list.data) return <p className="text-[14px] text-fg-muted">Reading your projects…</p>
  if (repos.length === 0) {
    return <p className="text-[15px] leading-relaxed text-fg-muted">No git project yet. Clone one, or make a new project, first.</p>
  }
  return (
    <form className="grid min-w-0 gap-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <Field label="Project">
        <select className={FIELD} value={project?.id ?? ''} onChange={(e) => setProjectId(e.target.value)}>
          {repos.map((p) => <option key={p.id} value={p.id}>{p.name}{p.branch ? ` · ${p.branch}` : ''}</option>)}
        </select>
      </Field>
      {project && <p className="mono -mt-2 text-[12px] text-fg-faint break-all">{project.root}</p>}
      <Field label="Branch">
        <input className={FIELD} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="feature-x" value={branch} onChange={(e) => setBranch(e.target.value)} />
      </Field>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] text-fg">
        <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={create} onChange={(e) => setCreate(e.target.checked)} />
        New branch
      </label>
      {create && (
        <Field label="From" hint={project?.default_branch ? `${project.default_branch} if empty` : 'the current branch if empty'}>
          <input className={FIELD} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={project?.default_branch ?? 'main'} value={base} onChange={(e) => setBase(e.target.value)} />
        </Field>
      )}
      <Problem text={error} />
      <button type="submit" disabled={busy} className={PRIMARY}>{busy ? 'Making the worktree…' : 'Make the worktree'}</button>
    </form>
  )
}

function ReadyCard({ ready, onStart, onWorktree, onAnother }: { ready: Ready; onStart: () => void; onWorktree?: () => void; onAnother: () => void }) {
  return (
    <div className="grid min-w-0 gap-3 rounded-[var(--radius-panel)] border border-ok/40 bg-ok/10 p-4">
      <p className="text-[16px] font-medium text-fg"><span className="text-ok">✓</span> {ready.what}</p>
      <p className="mono text-[12px] text-fg-muted break-all">{ready.path}</p>
      <button type="button" onClick={onStart} className={PRIMARY} disabled={!ready.path}>Start an agent here</button>
      {onWorktree && <button type="button" onClick={onWorktree} className={SECONDARY}>Make a worktree in it</button>}
      <button type="button" onClick={onAnother} className="justify-self-start py-2 text-[14px] text-fg-muted underline">Start something else</button>
      {isPairedDevice() && <p className="text-[12px] text-fg-faint">The session opens on its chat.</p>}
    </div>
  )
}
