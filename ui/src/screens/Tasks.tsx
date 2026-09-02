import { useState } from 'react'
import { api, ApiError, errText, type DiffResult, type Status, type Task, type TaskVerification, type TaskWork } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD, shortId } from '@/lib/format'
import { Copyable, Empty, Panel, Skeleton } from '@/components/ui'

const COLUMNS: { key: string; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'verifying', label: 'Verifying' },
  { key: 'needs_you', label: 'Needs you' },
  { key: 'done', label: 'Done' },
]

export function TasksScreen() {
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 30000 })
  const tasks = useApi(() => api.tasks(), [], { intervalMs: 4000 })
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  if (status.data && status.data.orchestration === false) {
    return <TaskRunnerOff status={status.data} onEnabled={() => { status.refresh(); tasks.refresh() }} />
  }
  const byCol = (col: string) => (tasks.data ?? []).filter((t) => t.status === col || (col === 'done' && t.status === 'failed'))
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setCreating(true)} className="border border-accent/50 text-accent bg-accent/10 px-2 py-1 rounded-sm text-[12px] hover:bg-accent/20">+ New task</button>
        <OrchestratorButton available={status.data?.claude_available ?? false} />
        {/* The graph is only meaningful while work is actually assigned, so it
         * is reachable from here rather than from a permanent nav slot. */}
        {(tasks.data ?? []).some((t) => t.assignee !== '' && t.status !== 'done' && t.status !== 'failed') && (
          <a href="#/graph" className="link text-[12px] border border-border px-2 py-1 rounded-sm hover:border-border-strong">view graph</a>
        )}
        <span className="ml-auto text-[11px] text-fg-faint">Tasks are files on disk (<span className="mono">tasks/&lt;id&gt;.md</span>); the orchestrator moves them. Nothing reaches Done until its <span className="mono">done_criteria</span> pass.</span>
      </div>
      {tasks.error && !tasks.data && <Empty title="Cannot reach the daemon">{tasks.error.message}</Empty>}
      {/* Six empty columns and two buttons say nothing about which button comes
       * first. The order matters — an orchestrator started over an empty board
       * has nothing to assign — so the empty board says it once, and disappears
       * the moment there is a task to look at. */}
      {tasks.data && tasks.data.length === 0 && (
        <div className="border border-border bg-panel-2/60 rounded-sm px-3 py-2 text-[12px] text-fg-muted">
          Start here: <span className="text-fg">+ New task</span> — a title and the commands that
          have to pass. Then <span className="text-fg">▶ Start orchestrator</span>, which assigns it
          to a worker and keeps going until the checks are green.
        </div>
      )}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {COLUMNS.map((c) => (
          <div key={c.key} className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-1.5 px-0.5 flex justify-between">
              <span>{c.label}</span><span className="num">{byCol(c.key).length}</span>
            </div>
            <div className="grid gap-1.5 content-start min-h-[60px]">
              {byCol(c.key).map((t) => <TaskCard key={t.id} t={t} onApprove={() => tasks.refresh()} onOpen={() => setOpen(t.id)} />)}
            </div>
          </div>
        ))}
      </div>
      {creating && <NewTask onClose={() => { setCreating(false); tasks.refresh() }} />}
      {open && <TaskDrawer id={open} onClose={() => { setOpen(null); tasks.refresh() }} />}
    </div>
  )
}

/**
 * TaskRunnerOff — the off state, which is the only thing most people ever see of
 * this feature.
 *
 * It was three paragraphs and a command to copy into a terminal. Prose is the
 * wrong shape for "what is this": nobody reads a wall of text to decide whether
 * to try a button, and a command to paste elsewhere is the opposite of a
 * control. The explanation is now three labelled steps — you write, Caprock
 * runs, Caprock checks — carrying the three facts that decide whether anyone
 * would run this at all:
 *
 *   1. the work happens in a separate git worktree, so their working tree is
 *      untouched;
 *   2. *Caprock* runs the checks, not the agent, which is the whole claim;
 *   3. the queue directory is created new, so their repository is untouched.
 *
 * "Phase 2" and "hive" are our vocabulary and appear nowhere here.
 */
function TaskRunnerOff({ status, onEnabled }: { status: Status; onEnabled: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const hive = status.suggested_hive ?? '~/caprock-tasks'
  const repo = status.suggested_repo ?? ''
  return (
    <div className="grid gap-3 max-w-[52rem] mx-auto">
      <Panel title="Task runner" right={<span className="text-[11px] text-fg-faint">off</span>}>
        <div className="grid gap-3 px-3 py-3">
          <ol className="grid gap-2 md:grid-cols-3">
            <Step n={1} title="You write a task">
              A title, a budget, and the commands that have to pass.
            </Step>
            <Step n={2} title="Caprock runs it">
              One Claude session per task, in its <span className="text-fg">own git worktree</span> —
              your working tree is untouched.
            </Step>
            <Step n={3} title="Caprock checks it">
              <span className="text-fg">Caprock</span> runs your commands, not the agent. Only green
              is done.
            </Step>
          </ol>
          <div className="text-[11px] text-fg-faint">
            Best for independent tasks — nothing here merges branches. The queue directory is
            created for you; your repository is not modified.
          </div>
        </div>
        <footer className="px-3 py-2 border-t border-border flex items-center gap-2">
          <button
            onClick={() => setConfirming(true)}
            className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm text-[12px] hover:bg-accent/25"
          >
            Turn on the task runner
          </button>
          <span className="text-[11px] text-fg-faint">
            No restart. Nothing runs until you start it.
          </span>
        </footer>
      </Panel>
      {confirming && (
        <EnableDialog hive={hive} repo={repo} onClose={() => setConfirming(false)} onDone={onEnabled} />
      )}
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="border border-border bg-panel-2/60 rounded-sm px-2.5 py-2 grid gap-1 content-start">
      <div className="flex items-baseline gap-1.5">
        <span className="num text-[11px] text-accent">{n}</span>
        <span className="text-[12px] font-medium">{title}</span>
      </div>
      <div className="text-[11px] text-fg-muted leading-[1.45]">{children}</div>
    </li>
  )
}

/**
 * EnableDialog — the confirmation before the runner is armed.
 *
 * Turning this on is what makes Caprock able to spawn Claude sessions with
 * permission prompts skipped, so it names the two paths it is about to use and
 * says so in words before anything happens. A one-click that silently arms an
 * unattended agent fleet is not something a local-first tool should ship, and a
 * dialog nobody can read is the same thing with an extra step — so the paths are
 * editable and the button says what it does.
 */
function EnableDialog({ hive, repo, onClose, onDone }: { hive: string; repo: string; onClose: () => void; onDone: () => void }) {
  const [dir, setDir] = useState(hive)
  const [repoDir, setRepoDir] = useState(repo)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setBusy(true); setError('')
    try {
      await api.enableHive(dir.trim(), repoDir.trim())
      onClose()
      onDone()
    } catch (e) {
      setError(errText(e))
    } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-24" onClick={onClose}>
      <div className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[560px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">Turn on the task runner</h2>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">✕</button>
        </header>
        <div className="px-4 py-3 grid gap-3 text-[13px]">
          <ul className="grid gap-1 text-[12px] text-fg-muted">
            <li>· Creates the queue directory below, with a README and an example task.</li>
            <li>· Lets Caprock spawn Claude sessions <span className="text-fg">with permission prompts skipped</span>, one git worktree each under the repo below.</li>
            <li>· Starts nothing yet — you start the orchestrator, and only then does work begin.</li>
          </ul>
          <label className="grid gap-1">
            <span className="text-[11px] text-fg-muted">Queue directory<span className="text-fg-faint"> · created if missing</span></span>
            <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] text-fg-muted">Repository<span className="text-fg-faint"> · workers branch from here</span></span>
            <input className="input mono" value={repoDir} onChange={(e) => setRepoDir(e.target.value)} />
          </label>
          {error && <div className="text-danger text-[12px]">{error}</div>}
        </div>
        <footer className="px-4 py-2 border-t border-border flex gap-2 justify-end">
          <button onClick={onClose} className="border border-border px-3 py-1 rounded-sm text-fg-muted hover:text-fg">Cancel</button>
          <button onClick={submit} disabled={busy} className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50">{busy ? 'turning on…' : 'Turn it on'}</button>
        </footer>
      </div>
    </div>
  )
}

function OrchestratorButton({ available }: { available: boolean }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const start = async () => {
    setBusy(true); setMsg('')
    try { const r = await api.startOrchestrator(); setMsg('orchestrator: ' + r.session_id.slice(0, 8)) }
    catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button disabled={busy || !available} onClick={start} title={available ? 'spawn the orchestrator session' : 'claude not found — cannot spawn'} className="border border-border text-fg-muted px-2 py-1 rounded-sm text-[12px] hover:text-fg disabled:opacity-50">{busy ? 'starting…' : '▶ Start orchestrator'}</button>
      {/* The reason this button is dead used to live only in a `title`
        * tooltip, while the visible copy told the user to press it. */}
      {!available && (
        <span className="text-[11px] text-fg-muted">
          <span className="mono">claude</span> was not found on this machine, so Caprock cannot spawn the
          orchestrator. It still observes every session you start yourself.
        </span>
      )}
      {msg && <span className="text-[11px] text-fg-faint mono">{msg}</span>}
    </span>
  )
}

function TaskCard({ t, onApprove, onOpen }: { t: Task; onApprove: () => void; onOpen: () => void }) {
  const over = t.budget_usd > 0 && t.cost_usd > t.budget_usd
  // A worker's output landed on a branch the board never named, and the session
  // diff endpoint existed but nothing linked to it — so the card was a title, an
  // id and a dollar figure, and the actual work was invisible. It opens now.
  const worked = t.assignee !== ''
  return (
    <div className="border border-border bg-panel rounded-[var(--radius-panel)] px-2 py-1.5">
      <button
        className="w-full text-left disabled:cursor-default"
        disabled={!worked}
        onClick={onOpen}
        title={worked ? 'show the diff, the checks that ran, and where the branch is' : 'nothing to show yet — no worker has picked this up'}
      >
        <div className={`text-[12px] font-medium truncate ${worked ? 'hover:text-accent' : ''}`} title={t.title}>{t.title || t.id}</div>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-fg-faint">
          <span className="mono">{shortId(t.id)}</span>
          {t.assignee && <span className="mono text-fg-muted">→ {t.assignee}</span>}
          <span className={`num ml-auto ${over ? 'text-danger' : 'text-fg-muted'}`}>{fmtUSD(t.cost_usd)}{t.budget_usd > 0 ? ` / ${fmtUSD(t.budget_usd)}` : ''}</span>
        </div>
      </button>
      {worked && <div className="mt-1 text-[10px] text-fg-faint mono truncate">caprock/{t.assignee}</div>}
      {t.status === 'needs_you' && (
        <div className="flex gap-1 mt-1.5">
          <button onClick={() => api.approve(t.id, true).then(onApprove)} className="flex-1 text-[11px] border border-ok/40 text-ok rounded-sm hover:bg-ok/10">approve</button>
          <button onClick={() => api.approve(t.id, false).then(onApprove)} className="flex-1 text-[11px] border border-danger/40 text-danger rounded-sm hover:bg-danger/10">reject</button>
        </div>
      )}
    </div>
  )
}

/**
 * TaskDrawer — what the worker actually did.
 *
 * Four questions, in the order someone asks them after a task goes green: what
 * changed, what proved it, where is it, and how do I take it. The first three
 * were all recorded and none were shown; the fourth was not offered at all, so
 * the only way to land a worker's branch was to already know it existed.
 *
 * The merge command is text, not a button. It writes to the user's repository,
 * and a dashboard that runs git on your default branch without you reading the
 * command first is not something a local-first tool should ship.
 */
function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useApi(() => api.task(id), [id], { intervalMs: 6000 })
  const d = detail.data
  const work = d?.work
  // A task can be worked by more than one session (a reassignment, or a worker
  // respawned after a crash). The newest window is the one holding the work.
  const session = work?.sessions?.[0]
  return (
    <div className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-16" onClick={onClose}>
      <div className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[820px] max-w-[94vw] max-h-[82vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center gap-2 sticky top-0 bg-panel z-10">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">Task</h2>
          {d && <span className="text-[12px] truncate">{d.task.title || d.task.id}</span>}
          {d && <span className="mono text-[10px] text-fg-faint">{d.task.status}</span>}
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">✕</button>
        </header>
        {!d && !detail.error && <Skeleton rows={5} />}
        {detail.error && !d && <Empty title="Cannot load the task">{detail.error.message}</Empty>}
        {d && (
          <div className="px-3 py-3 grid gap-3">
            <WhereItIs work={work} assignee={d.task.assignee} />
            <Checks criteria={d.done_criteria} runs={work?.verifications} status={d.task.status} />
            <TaskDiff sessionID={session?.session_id} assignee={d.task.assignee} />
            {d.body && (
              <Panel title="Brief">
                <pre className="mono text-[11px] leading-[1.45] px-3 py-2 whitespace-pre-wrap">{d.body}</pre>
              </Panel>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** WhereItIs — the branch, the worktree, and the command that lands it. */
function WhereItIs({ work, assignee }: { work?: TaskWork; assignee: string }) {
  if (!work?.branch) {
    return (
      <Panel title="Where the work is">
        <div className="px-3 py-2 text-[12px] text-fg-faint">
          No worker has been assigned yet, so there is no branch. One is created the moment the
          orchestrator assigns this task.
        </div>
      </Panel>
    )
  }
  return (
    <Panel title="Where the work is">
      <div className="overflow-x-auto">
        {/* Scrolls inside itself on a narrow screen: the table is wide, and a
        * body that scrolls sideways takes every other panel with it. */}
        <table className="w-full text-[12px]">
          <tbody>
            <tr className="border-b border-border/60">
              <td className="px-3 py-1 text-fg-muted w-32">branch</td>
              <td className="px-3 py-1 mono break-all">{work.branch}</td>
            </tr>
            {work.worktree && (
              <tr className="border-b border-border/60">
                <td className="px-3 py-1 text-fg-muted w-32">worktree</td>
                <td className="px-3 py-1 mono break-all">{work.worktree}</td>
              </tr>
            )}
            <tr className="border-b border-border/60 last:border-0">
              <td className="px-3 py-1 text-fg-muted w-32 align-top">take it</td>
              <td className="px-3 py-1 grid gap-1 justify-items-start">
                <Copyable command={`git merge --no-ff ${work.branch}`} />
                <span className="text-[11px] text-fg-faint">
                  Run it from {work.repo ? <span className="mono">{work.repo}</span> : 'your repo'}, on the branch you want the work
                  on. Prefer <span className="mono">git cherry-pick</span> if you only want some of it. Worker{' '}
                  <span className="mono">{assignee}</span> may still be running — check the diff below first.
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/** Checks — which done_criteria ran, and whether they passed. */
function Checks({ criteria, runs, status }: { criteria?: string[]; runs?: TaskVerification[]; status: string }) {
  // Rows come back newest round first, so the head of the list is the round
  // that decided the task's current state. Showing every round would bury it.
  const head = runs?.[0]
  const latest = head ? runs!.filter((r) => r.round === head.round) : []
  const right = head ? `round ${head.round}` : undefined
  return (
    <Panel title="What has to pass" right={right}>
      {latest.length === 0 && (
        <div className="px-3 py-2 grid gap-1">
          <div className="text-[12px] text-fg-faint">
            {status === 'done'
              ? 'This task was marked done without a recorded check.'
              : 'Not run yet. Caprock runs these itself, in the worker’s worktree, when the worker reports it has finished.'}
          </div>
          <ul className="grid gap-0.5">
            {(criteria ?? []).map((c) => <li key={c} className="mono text-[11px] text-fg-muted">$ {c}</li>)}
          </ul>
          {(criteria ?? []).length === 0 && <div className="mono text-[11px] text-danger">no done_criteria — Caprock cannot verify this task</div>}
        </div>
      )}
      {latest.length > 0 && (
        <ul>
          {latest.map((r) => (
            <li key={r.command} className="border-b border-border/60 last:border-0 px-3 py-1.5 flex items-center gap-3">
              <span className={`text-[10px] w-14 shrink-0 mono ${r.exit_code === 0 ? 'text-ok' : 'text-danger'}`}>
                {r.exit_code === 0 ? 'passed' : `exit ${r.exit_code}`}
              </span>
              <span className="mono text-[12px] truncate" title={r.command}>{r.command}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** TaskDiff — the same working-tree diff the Session screen shows, reached from
 *  the task instead of from the session that happens to hold it. */
function TaskDiff({ sessionID, assignee }: { sessionID?: string; assignee: string }) {
  const diff = useApi(() => (sessionID ? api.diff(sessionID) : Promise.resolve(undefined)), [sessionID], { intervalMs: 8000 })
  const [open, setOpen] = useState<string | null>(null)
  if (!sessionID) {
    return (
      <Panel title="What changed">
        <div className="px-3 py-2 text-[12px] text-fg-faint">
          No session has been attributed to this task yet{assignee ? ` (worker ${assignee})` : ''}, so there is nothing to diff.
        </div>
      </Panel>
    )
  }
  if (diff.error && !diff.data) {
    const e = diff.error
    if (e instanceof ApiError && e.status === 409) {
      const body = e.body as { error?: string; cwd?: string } | undefined
      return <Panel title="What changed"><div className="px-3 py-2 text-[12px] text-fg-faint">{body?.error}{body?.cwd ? <> · <span className="mono">{body.cwd}</span></> : null}</div></Panel>
    }
    return <Panel title="What changed"><div className="px-3 py-2 text-[12px] text-fg-faint">{e.message}</div></Panel>
  }
  const d: DiffResult | undefined = diff.data
  if (!d) return <Panel title="What changed"><Skeleton rows={3} /></Panel>
  return (
    <Panel title="What changed" right={<span className="num">{d.files.length} files</span>}>
      {d.files.length === 0 && (
        <div className="px-3 py-2 text-[12px] text-fg-faint">
          Nothing uncommitted in <span className="mono">{d.branch || 'the worktree'}</span>. If the worker committed its
          work, the branch above holds it.
        </div>
      )}
      <ul>
        {d.files.map((f) => (
          <li key={f.path} className="border-b border-border/60 last:border-0">
            <button className="w-full text-left px-3 py-1.5 flex items-center gap-3 hover:bg-panel-2" onClick={() => setOpen(open === f.path ? null : f.path)}>
              <span className={`mono text-[10px] w-16 shrink-0 ${f.status === 'added' || f.status === 'untracked' ? 'text-ok' : f.status === 'deleted' ? 'text-danger' : 'text-fg-muted'}`}>{f.status}</span>
              <span className="mono text-[12px] truncate">{f.path}</span>
              <span className="ml-auto num text-[11px] shrink-0"><span className="text-ok">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span></span>
            </button>
            {open === f.path && f.patch && (
              <pre className="mono text-[11px] leading-[1.35] px-3 pb-2 overflow-auto max-h-[40vh]">
                {f.patch.split('\n').map((line, i) => {
                  const cls = line.startsWith('+') && !line.startsWith('+++') ? 'text-ok' : line.startsWith('-') && !line.startsWith('---') ? 'text-danger' : line.startsWith('@@') ? 'text-info' : 'text-fg-muted'
                  return <div key={i} className={cls}>{line || ' '}</div>
                })}
              </pre>
            )}
            {open === f.path && !f.patch && <div className="px-3 pb-2 text-[11px] text-fg-faint">{f.binary ? 'binary file' : 'no patch'}</div>}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// Exported for its test: the empty-criteria guard is a safety rule (an
// unverifiable task can never reach Done), not a cosmetic form check.
export function NewTask({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [budget, setBudget] = useState('3')
  const [criteria, setCriteria] = useState('go test ./...\ngo vet ./...')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const criteriaList = criteria.split('\n').map((s) => s.trim()).filter(Boolean)
  const submit = async () => {
    if (!title.trim()) { setError('Title is required.'); return }
    // A task with no done_criteria cannot be verified, and Caprock will not mark
    // an unverifiable task done. Say so here rather than letting the user create
    // one and discover it parked in Needs you.
    if (criteriaList.length === 0) { setError('At least one done criterion is required — it is what decides when the task is done.'); return }
    setBusy(true); setError('')
    try {
      await api.createTask({ title: title.trim(), budget_usd: parseFloat(budget) || 0, done_criteria: criteriaList, body })
      onClose()
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-24" onClick={onClose}>
      <div className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[560px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center"><h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">New task</h2><button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">✕</button></header>
        <div className="px-4 py-3 grid gap-3 text-[13px]">
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Title</span><input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add /healthz endpoint" /></label>
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Budget (USD)</span><input className="input" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Done criteria · one command per line</span><textarea className="input" rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label>
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Description</span><textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          {error && <div className="text-danger text-[12px]">{error}</div>}
        </div>
        <footer className="px-4 py-2 border-t border-border flex gap-2 justify-end">
          <button onClick={onClose} className="border border-border px-3 py-1 rounded-sm text-fg-muted hover:text-fg">Cancel</button>
          <button onClick={submit} disabled={busy} className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50">{busy ? 'creating…' : 'Create task'}</button>
        </footer>
      </div>
    </div>
  )
}
