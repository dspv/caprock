import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CloseButton, DialogBackdrop } from '@/components/Dialog'
import { api, ApiError, errText, isPairedDevice, type DiffResult, type Status, type Task, type TaskStarter, type TaskVerification, type TaskWork } from '@/lib/api'
import { useCanControl } from '@/lib/useCanControl'
import { useApi } from '@/lib/useApi'
import { fmtUSD } from '@/lib/format'
import { checksFor, TASK_TEMPLATES, unfilled, type TaskTemplate } from '@/lib/taskTemplates'
import { Copyable, Empty, Panel, Skeleton } from '@/components/ui'

/**
 * Tasks — hand a job to an agent and get it back verified.
 *
 * Owner review, 2026-10-11 (translated): "completely unclear what this is, how
 * it works and what to do with it; nothing ready-made to start from; the
 * interface is done badly." Three answers, one per complaint:
 *
 *   - what it is: one sentence, then a worked example walked through the four
 *     things that happen — you write it, a worker does it on its own branch,
 *     Caprock runs your checks, you merge — instead of abstract steps;
 *   - something ready-made: a gallery of templates (lib/taskTemplates.ts) whose
 *     checks are filled from what the repository declares, never guessed;
 *   - the board: six narrow kanban columns, five of them usually empty, became
 *     one list grouped by what each task needs from you, each row saying what
 *     it is doing now, what it cost, how its checks went and the one thing to
 *     do with it.
 */

/** The groups the board shows, in the order a person needs them. */
const GROUPS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'needs_you', label: 'Needs you', statuses: ['needs_you'] },
  { key: 'working', label: 'Working', statuses: ['assigned', 'in_progress', 'verifying'] },
  { key: 'waiting', label: 'Waiting to start', statuses: ['inbox'] },
  { key: 'finished', label: 'Finished', statuses: ['done', 'failed'] },
]

export function TasksScreen() {
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 30000 })
  const tasks = useApi(() => api.tasks(), [], { intervalMs: 4000 })
  // The templates' prefill. A paired device never writes tasks (ADR-029), and
  // the endpoint is not on its allowlist, so it is not asked.
  const starter = useApi(() => (isPairedDevice() ? Promise.resolve(undefined) : api.taskStarter()), [], { live: false })
  // undefined: closed; null: a blank form; a template: that template's form.
  const [creating, setCreating] = useState<TaskTemplate | null | undefined>(undefined)
  const [open, setOpen] = useState<string | null>(null)
  if (status.data && status.data.orchestration === false) {
    return (
      <TaskRunnerOff
        status={status.data}
        starter={starter.data}
        onEnabled={(picked) => {
          status.refresh(); tasks.refresh(); starter.refresh()
          // A template picked before the runner was on opens the moment it is.
          if (picked !== undefined) setCreating(picked)
        }}
      />
    )
  }
  const list = tasks.data ?? []
  const waiting = list.filter((t) => t.status === 'inbox').length
  const moving = list.some((t) => t.status === 'assigned' || t.status === 'in_progress' || t.status === 'verifying')
  const paired = isPairedDevice()
  return (
    <div className="grid gap-5">
      <header className="grid gap-1.5 min-w-0">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-fg">Tasks</h1>
          {/* A paired device reads the board; it does not run it (ADR-029). */}
          {!paired && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {(list.some((t) => t.assignee !== '' && t.status !== 'done' && t.status !== 'failed')) && (
                // The graph is only meaningful while work is actually assigned.
                <a href="#/graph" className="link text-[13px] px-2 py-1.5">view graph</a>
              )}
              {/* Over an empty board the orchestrator has nothing to assign, so
                * the button waits until there is a task. */}
              {list.length > 0 && <OrchestratorButton available={status.data?.claude_available ?? false} />}
              <button onClick={() => setCreating(null)} className="rounded-[8px] bg-accent px-4 py-1.5 text-[13px] font-semibold text-panel hover:opacity-90">+ New task</button>
            </div>
          )}
        </div>
        <p className="max-w-[48rem] text-[14px] leading-relaxed text-fg-muted">
          Give an agent a job and the commands that prove it is done. It works on its own branch; Caprock runs the
          commands itself, and only green counts as done.
        </p>
        {status.data?.repo && (
          <p className="truncate text-[12px] text-fg-faint" title={`${status.data.repo}${status.data.hive ? ` · ${status.data.hive}/tasks` : ''}`}>
            Workers branch from <span className="mono text-fg-muted">{status.data.repo}</span>
            {status.data.hive && <> · tasks are files in <span className="mono text-fg-muted">{status.data.hive}/tasks</span></>}
          </p>
        )}
      </header>

      {tasks.error && !tasks.data && <Empty title="Cannot reach the daemon">{tasks.error.message}</Empty>}
      {!tasks.data && !tasks.error && <Skeleton rows={4} />}

      {/* The one thing that most often stalls a first run: a task sits in the
       * queue and nothing happens, because nothing assigns it until the
       * orchestrator runs. Say so where the task is, with the button. */}
      {waiting > 0 && !moving && !paired && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-warn/40 bg-warn/10 px-4 py-3 text-[14px]">
          <span className="text-fg">
            {waiting === 1 ? '1 task is' : `${waiting} tasks are`} waiting. The orchestrator hands tasks to workers — start it if it is not running.
          </span>
          <span className="ml-auto"><OrchestratorButton available={status.data?.claude_available ?? false} primary /></span>
        </div>
      )}

      {tasks.data && list.length === 0 && (
        <div className="grid gap-5">
          {!paired && <TemplateGallery starter={starter.data} onPick={setCreating} />}
          <section className="grid gap-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-fg-faint">How a task runs</h2>
            <HowItRuns starter={starter.data} />
          </section>
        </div>
      )}

      {list.length > 0 && (
        <>
          {!paired && <TemplateStrip onPick={setCreating} />}
          <div className="grid gap-5">
            {GROUPS.map((g) => {
              const rows = list.filter((t) => g.statuses.includes(t.status))
              if (rows.length === 0) return null
              return (
                <section key={g.key} className="grid gap-2" aria-label={g.label}>
                  <h2 className="flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-fg-faint">
                    {g.label}<span className="num text-fg-muted">{rows.length}</span>
                  </h2>
                  <ul className="grid overflow-hidden rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
                    {rows.map((t) => <TaskRow key={t.id} t={t} onChanged={() => tasks.refresh()} onOpen={() => setOpen(t.id)} />)}
                  </ul>
                </section>
              )
            })}
          </div>
          <p className="text-[12px] text-fg-faint">
            Tasks are files on disk (<span className="mono">tasks/&lt;id&gt;.md</span>); the orchestrator moves them. Nothing is
            merged for you: a finished task is a branch you review and take.
          </p>
        </>
      )}
      {creating !== undefined && (
        <NewTask template={creating ?? undefined} starter={starter.data} onClose={() => { setCreating(undefined); tasks.refresh() }} />
      )}
      {open && <TaskDrawer id={open} onClose={() => { setOpen(null); tasks.refresh() }} />}
    </div>
  )
}

/** The example's check: the repo's own first test command when it has one. */
function exampleCheck(starter?: TaskStarter): string {
  return checksFor(TASK_TEMPLATES[0], starter?.checks ?? [])[0] ?? 'your test command'
}

/**
 * HowItRuns — the four things that happen to a task, told as one worked
 * example rather than as abstract steps: a reader can picture "fix the failing
 * tests in billing/, checked by make test" in a way "you write a task" never
 * let them. The check named is the repository's own when one was detected.
 */
function HowItRuns({ starter, large = false }: { starter?: TaskStarter; large?: boolean }) {
  const check = exampleCheck(starter)
  const steps: { title: string; body: ReactNode }[] = [
    {
      title: 'You write the task',
      body: <>“Fix the failing tests in <span className="mono text-fg">billing/</span>” — and the check that must pass: <span className="mono text-fg">{check}</span>.</>,
    },
    {
      title: 'A worker does it',
      body: <>A Claude session takes it on its own branch, <span className="mono text-fg">caprock/worker-1</span>, in its <span className="text-fg">own git worktree</span>. Your checkout is untouched.</>,
    },
    {
      title: 'Caprock checks it',
      body: <><span className="text-fg">Caprock</span> runs <span className="mono text-fg">{check}</span> itself — it runs your commands, not the agent. Red goes back to the worker; only green is done.</>,
    },
    {
      title: 'You take it',
      body: <>Read the diff and merge the branch. Nothing is merged for you.</>,
    },
  ]
  return (
    <ol className={`grid gap-3 ${large ? 'md:grid-cols-2 xl:grid-cols-4' : 'sm:grid-cols-2 xl:grid-cols-4'}`} aria-label="How a task runs">
      {steps.map((s, i) => (
        <li key={s.title} className="grid content-start gap-2 rounded-[12px] border border-border bg-panel-2/60 p-4">
          <span className="flex items-baseline gap-2">
            <span className={`num font-semibold leading-none text-accent ${large ? 'text-[28px]' : 'text-[20px]'}`}>{i + 1}</span>
            <span className={`font-semibold leading-snug text-fg ${large ? 'text-[17px]' : 'text-[15px]'}`}>{s.title}</span>
          </span>
          <span className="text-[13px] leading-relaxed text-fg-muted">{s.body}</span>
        </li>
      ))}
    </ol>
  )
}

/**
 * TemplateGallery — ready-made starting points. Each card says what its checks
 * will be in *this* repository, so the user sees before picking that the
 * template knows about their project — or, when nothing was detected, that
 * they will write the checks themselves.
 */
function TemplateGallery({ starter, onPick }: { starter?: TaskStarter; onPick: (t: TaskTemplate | null) => void }) {
  return (
    <section className="grid gap-3" aria-label="Start from a template">
      <div className="grid gap-0.5">
        <h2 className="text-[17px] font-semibold text-fg">Start from a template</h2>
        <p className="text-[13px] text-fg-muted">Pick one and adapt it — every field stays editable before anything runs.</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TASK_TEMPLATES.map((t) => {
          const checks = checksFor(t, starter?.checks ?? [])
          return (
            <li key={t.id}>
              <button
                onClick={() => onPick(t)}
                className="group grid h-full w-full content-start gap-1.5 rounded-[12px] border border-border bg-panel p-4 text-left shadow-[var(--shadow-panel)] hover:border-accent/60"
              >
                <span className="text-[15px] font-semibold text-fg group-hover:text-accent">{t.name}</span>
                <span className="text-[13px] leading-snug text-fg-muted">{t.blurb}</span>
                <span className="mt-1 truncate text-[12px] text-fg-faint">
                  {starter === undefined ? ' ' : checks.length > 0
                    ? <>checks: <span className="mono text-fg-muted">{checks.join(' · ')}</span></>
                    : 'checks: you write them'}
                </span>
              </button>
            </li>
          )
        })}
        <li className="sm:col-span-2 lg:col-span-3">
          <button
            onClick={() => onPick(null)}
            className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-[12px] border border-dashed border-border-strong px-4 py-3 text-left hover:border-accent/60"
          >
            <span className="text-[15px] font-semibold text-fg">Blank task</span>
            <span className="text-[13px] text-fg-muted">Write your own from scratch.</span>
          </button>
        </li>
      </ul>
      {starter && <DetectedLine starter={starter} />}
    </section>
  )
}

/** Where the templates' checks came from, so a prefilled command is never a mystery. */
function DetectedLine({ starter }: { starter: TaskStarter }) {
  if (starter.checks.length === 0) {
    return (
      <p className="text-[12px] text-fg-faint">
        No test, lint or build commands found in <span className="mono">{starter.repo}</span> (Makefile, package.json, go.mod,
        Cargo.toml, pyproject.toml), so the templates leave the checks for you to write.
      </p>
    )
  }
  const sources = [...new Set(starter.checks.map((c) => c.source))]
  return (
    <p className="text-[12px] text-fg-faint">
      Checks found in <span className="mono">{starter.repo}</span> from {sources.join(', ')}.
    </p>
  )
}

/** The gallery folded to one line once the board has tasks to show. */
function TemplateStrip({ onPick }: { onPick: (t: TaskTemplate | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-fg-faint">Start from:</span>
      {TASK_TEMPLATES.map((t) => (
        <button key={t.id} onClick={() => onPick(t)} className="rounded-full border border-border px-3 py-1 text-fg-muted hover:border-accent/60 hover:text-fg">
          {t.name}
        </button>
      ))}
    </div>
  )
}

/**
 * TaskRunnerOff — the off state, which is the only thing most people ever see of
 * this feature.
 *
 * What it is (one sentence), how it runs (one worked example in four steps),
 * what you could hand it (the templates), and the button. The facts that decide
 * whether anyone would run it are in the example: the work happens in a
 * separate git worktree, *Caprock* runs the checks, nothing is merged for you —
 * and the queue directory is created new, so their repository is untouched.
 * Picking a template here asks to turn the runner on, then opens that template.
 *
 * "Phase 2" and "hive" are our vocabulary and appear nowhere here.
 */
function TaskRunnerOff({ status, starter, onEnabled }: { status: Status; starter?: TaskStarter; onEnabled: (picked?: TaskTemplate | null) => void }) {
  // undefined: no dialog; otherwise the dialog is open and remembers what was
  // picked (null: the plain button, or a blank task).
  const [confirming, setConfirming] = useState<{ picked?: TaskTemplate | null } | null>(null)
  const hive = status.suggested_hive ?? '~/caprock-tasks'
  const repo = status.suggested_repo ?? ''
  const paired = isPairedDevice()
  return (
    // Big on purpose (owner, 2026-10-11: "make it large and beautiful"): this
    // is the whole feature for anyone who has not turned it on.
    <div className="mx-auto grid max-w-[68rem] gap-8 px-2 py-6 md:py-10">
      <header className="grid gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Task runner · off</span>
        <h1 className="text-[32px] font-semibold leading-[1.1] tracking-[-0.02em] text-fg md:text-[40px]">
          Hand off a task. <span className="text-accent">Get it back green.</span>
        </h1>
        <p className="max-w-[46rem] text-[17px] leading-relaxed text-fg-muted">
          Give an agent a job and the commands that prove it is done. It works on its own branch, Caprock runs the
          commands itself, and the task is done only when they pass.
        </p>
      </header>
      <section className="grid gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-fg-faint">For example</h2>
        <HowItRuns starter={starter} large />
      </section>
      {!paired && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <button
            onClick={() => setConfirming({})}
            className="rounded-[10px] bg-accent px-6 py-3 text-[16px] font-semibold text-panel shadow-[0_10px_30px_-12px_var(--color-accent)] hover:opacity-90"
          >
            Turn on the task runner
          </button>
          <span className="text-[14px] text-fg-muted">No restart. Nothing runs until you start it.</span>
        </div>
      )}
      {!paired && <TemplateGallery starter={starter} onPick={(t) => setConfirming({ picked: t })} />}
      <p className="text-[13px] text-fg-faint">
        Best for independent tasks: nothing here merges branches. The queue directory is created for you; your repository is not modified.
      </p>
      {confirming && (
        <EnableDialog hive={hive} repo={repo} onClose={() => setConfirming(null)} onDone={() => onEnabled(confirming.picked)} />
      )}
    </div>
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
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-24">
      <div role="dialog" aria-modal="true" aria-label="Turn on the task runner" className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[560px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">Turn on the task runner</h2>
          <CloseButton onClick={onClose} className="-my-1 ml-auto" />
        </header>
        <div className="px-4 py-3 grid gap-3 text-[13px]">
          <ul className="grid gap-1 text-[12px] text-fg-muted">
            <li>· Creates the queue directory below, with a README. The queue starts empty.</li>
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
    </DialogBackdrop>
  )
}

function OrchestratorButton({ available, primary = false }: { available: boolean; primary?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const start = async () => {
    setBusy(true); setMsg('')
    try { const r = await api.startOrchestrator(); setMsg('orchestrator: ' + r.session_id.slice(0, 8)) }
    catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
  }
  const cls = primary
    ? 'rounded-[8px] border border-warn/60 bg-warn/15 px-3 py-1.5 text-[13px] font-semibold text-fg hover:bg-warn/25 disabled:opacity-50'
    : 'rounded-[8px] border border-border px-3 py-1.5 text-[13px] text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50'
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {/* Starting it twice is safe: a running orchestrator is nudged to re-read
        * its queue rather than duplicated (orchestrator.Start). */}
      <button disabled={busy || !available} onClick={start} title={available ? 'start the session that hands tasks to workers; if it is already running, it re-reads the queue' : 'claude not found — cannot spawn'} className={cls}>{busy ? 'starting…' : '▶ Start orchestrator'}</button>
      {/* The reason this button is dead used to live only in a `title`
        * tooltip, while the visible copy told the user to press it. */}
      {!available && (
        <span className="text-[12px] text-fg-muted">
          <span className="mono">claude</span> was not found on this machine, so Caprock cannot spawn the
          orchestrator. It still observes every session you start yourself.
        </span>
      )}
      {msg && <span className="text-[12px] text-fg-faint mono">{msg}</span>}
    </span>
  )
}

type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'faint'

/** What a task's state is called on the board, and its colour. */
export function stateOf(t: Task): { label: string; tone: Tone } {
  switch (t.status) {
    case 'inbox': return { label: 'Waiting', tone: 'faint' }
    case 'assigned': return { label: 'Starting', tone: 'accent' }
    case 'in_progress': return { label: 'Working', tone: 'ok' }
    case 'verifying': return { label: 'Checking', tone: 'accent' }
    case 'needs_you': return { label: 'Needs you', tone: 'warn' }
    case 'done': return { label: 'Done', tone: 'ok' }
    case 'failed': return { label: 'Failed', tone: 'danger' }
  }
  return { label: t.status, tone: 'faint' }
}

/** One line of what the task is doing right now, in words. */
export function nowLine(t: Task): string {
  const w = t.assignee
  switch (t.status) {
    case 'inbox': return 'In the queue. The orchestrator gives it to a worker.'
    case 'assigned': return `Given to ${w}; the session is starting.`
    case 'in_progress':
      return t.verify_rounds > 0
        ? `Checks failed in round ${t.verify_rounds}; ${w} is fixing it.`
        : `${w} is working on branch caprock/${w}.`
    case 'verifying': return `Caprock is running the checks in ${w}'s worktree.`
    case 'needs_you':
      if (t.budget_usd > 0 && t.cost_usd > t.budget_usd) return 'Over its budget. Approve to let it carry on, or reject to stop it.'
      if (t.verify_rounds >= 3) return `Checks failed ${t.verify_rounds} rounds in a row. Open it to see why, then decide.`
      return 'Waiting for your decision: a check needs approval before it runs, or there is nothing to check.'
    case 'done': return `Checks passed. The work is on branch caprock/${w}.`
    case 'failed': return w ? `Stopped. Nothing was merged; branch caprock/${w} is still there.` : 'Stopped before any work.'
  }
  return ''
}

/** How the checks went, from what the board row knows. */
export function checksLine(t: Task): { text: string; tone: Tone } {
  switch (t.status) {
    case 'done': return { text: t.verify_rounds > 1 ? `passed in round ${t.verify_rounds}` : 'passed', tone: 'ok' }
    case 'verifying': return { text: `running, round ${t.verify_rounds + 1}`, tone: 'accent' }
  }
  if (t.verify_rounds > 0) return { text: `failed ${t.verify_rounds}×`, tone: 'danger' }
  return { text: 'not run yet', tone: 'faint' }
}

const toneText: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', accent: 'text-accent', faint: 'text-fg-faint' }
const tonePill: Record<Tone, string> = {
  ok: 'text-ok border-ok/40 bg-ok/10',
  warn: 'text-warn border-warn/50 bg-warn/10',
  danger: 'text-danger border-danger/40 bg-danger/10',
  accent: 'text-accent border-accent/40 bg-accent/10',
  faint: 'text-fg-muted border-border bg-panel-2',
}

/**
 * TaskRow — one task, readable at a glance: its state, what it is doing now,
 * how the checks went, what it cost against its budget, and the one thing to do
 * with it. Approve/reject are the only actions taken from the row; everything
 * else opens the drawer, which is where the diff and the merge command live.
 */
function TaskRow({ t, onChanged, onOpen }: { t: Task; onChanged: () => void; onOpen: () => void }) {
  // Answering an approval is a controller's to do as well (ADR-034).
  const canControl = useCanControl()
  const st = stateOf(t)
  const ck = checksLine(t)
  const over = t.budget_usd > 0 && t.cost_usd > t.budget_usd
  const pct = t.budget_usd > 0 ? Math.min(100, (t.cost_usd / t.budget_usd) * 100) : 0
  const worked = t.assignee !== ''
  return (
    <li className="grid items-center gap-x-5 gap-y-2 border-b border-border/70 px-4 py-3 last:border-0 md:grid-cols-[6.5rem_minmax(0,1fr)_8.5rem_9.5rem_15rem]">
      <span className={`inline-flex w-fit items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[12px] font-medium ${tonePill[st.tone]}`}>
        <span className={`h-1.5 w-1.5 rounded-full bg-current ${t.status === 'in_progress' || t.status === 'verifying' ? 'animate-pulse' : ''}`} />
        {st.label}
      </span>
      <button
        className="grid min-w-0 gap-0.5 text-left disabled:cursor-default"
        disabled={!worked}
        onClick={onOpen}
        title={worked ? 'show the diff, the checks that ran, and where the branch is' : 'nothing to show yet — no worker has picked this up'}
      >
        <span className={`truncate text-[15px] font-medium text-fg ${worked ? 'hover:text-accent' : ''}`} title={`${t.title} · ${t.id}`}>{t.title || t.id}</span>
        <span className="text-[13px] leading-snug text-fg-muted">{nowLine(t)}</span>
        {worked && <span className="text-[11px] text-fg-faint mono">caprock/{t.assignee}</span>}
      </button>
      <span className="grid gap-0.5 text-[13px]">
        <span className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">checks</span>
        <span className={toneText[ck.tone]}>{ck.text}</span>
      </span>
      <span className="grid gap-1 text-[13px]" title={t.budget_usd > 0 ? `spent ${fmtUSD(t.cost_usd)} of a ${fmtUSD(t.budget_usd)} budget` : undefined}>
        <span className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">cost</span>
        <span className={`num ${over ? 'text-danger' : 'text-fg'}`}>
          {fmtUSD(t.cost_usd)}{t.budget_usd > 0 && <span className="text-fg-faint"> of {fmtUSD(t.budget_usd)}</span>}
        </span>
        {t.budget_usd > 0 && (
          <span className="h-1 w-full overflow-hidden rounded-full bg-panel-2" aria-hidden>
            <span className={`block h-full ${over ? 'bg-danger' : 'bg-accent/70'}`} style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      <span className="flex justify-start gap-2 md:justify-end">
        {t.status === 'needs_you' && canControl ? (
          <>
            <button onClick={() => api.approve(t.id, true).then(onChanged)} title="send it back to the worker to carry on" className="rounded-[8px] border border-ok/50 px-3 py-1.5 text-[13px] text-ok hover:bg-ok/10">Approve</button>
            <button onClick={() => api.approve(t.id, false).then(onChanged)} title="stop it and mark it failed" className="rounded-[8px] border border-danger/50 px-3 py-1.5 text-[13px] text-danger hover:bg-danger/10">Reject</button>
            {worked && <button onClick={onOpen} className="rounded-[8px] border border-border px-3 py-1.5 text-[13px] text-fg-muted hover:text-fg">Open</button>}
          </>
        ) : t.status === 'done' ? (
          <button onClick={onOpen} className="rounded-[8px] border border-accent/60 bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-accent/20">Review &amp; merge</button>
        ) : worked ? (
          <button onClick={onOpen} className="rounded-[8px] border border-border px-3 py-1.5 text-[13px] text-fg-muted hover:border-border-strong hover:text-fg">Open</button>
        ) : null}
      </span>
    </li>
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
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-16">
      <div role="dialog" aria-modal="true" aria-label="Task" className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[820px] max-w-[94vw] max-h-[82vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center gap-2 sticky top-0 bg-panel z-10">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">Task</h2>
          {d && <span className="text-[12px] truncate">{d.task.title || d.task.id}</span>}
          {d && <span className="mono text-[10px] text-fg-faint">{d.task.status}</span>}
          <CloseButton onClick={onClose} className="-my-1 ml-auto" />
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
    </DialogBackdrop>
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


/**
 * NewTask — the form, blank or prefilled from a template.
 *
 * Three fields decide whether a task can ever go green, and each now says
 * where its value came from: the checks are the repository's own (detected,
 * listed under the field to add with a click), the budget is empty with the
 * daemon's ceiling as its placeholder — never a figure invented here — and a
 * template's `<…>` parts must be filled in before it can be created.
 *
 * Exported for its test: the empty-criteria guard is a safety rule (an
 * unverifiable task can never reach Done), not a cosmetic form check.
 */
export function NewTask({ onClose, template, starter }: { onClose: () => void; template?: TaskTemplate; starter?: TaskStarter }) {
  const detected = starter?.checks ?? []
  const [title, setTitle] = useState(template?.title ?? '')
  const [budget, setBudget] = useState('')
  const [criteria, setCriteria] = useState(() => checksFor(template, detected).join('\n'))
  const [body, setBody] = useState(template?.prompt ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const criteriaList = criteria.split('\n').map((s) => s.trim()).filter(Boolean)
  const left = unfilled(template, title, body)
  const fallback = starter?.default_budget_usd
  // A template opens with its first `<…>` in the title selected, so typing
  // replaces it: the part to fill in is where the cursor already is.
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = titleRef.current
    const first = template?.placeholders.find((p) => el?.value.includes(p))
    if (el && first) {
      const at = el.value.indexOf(first)
      el.setSelectionRange(at, at + first.length)
    }
  }, [template])
  const submit = async () => {
    if (!title.trim()) { setError('Title is required.'); return }
    if (left.length > 0) { setError(`Fill in ${left.join(', ')} first.`); return }
    // A task with no done_criteria cannot be verified, and Caprock will not mark
    // an unverifiable task done. Say so here rather than letting the user create
    // one and discover it parked in Needs you.
    if (criteriaList.length === 0) { setError('At least one check is required — it is what decides when the task is done.'); return }
    const b = budget.trim() === '' ? 0 : Number(budget)
    if (!Number.isFinite(b) || b < 0) { setError('Budget is a number of dollars, or empty.'); return }
    setBusy(true); setError('')
    try {
      await api.createTask({ title: title.trim(), budget_usd: b, done_criteria: criteriaList, body })
      onClose()
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  const addCheck = (cmd: string) => setCriteria((c) => (c.trim() ? c.replace(/\s*$/, '') + '\n' + cmd : cmd))
  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center overflow-auto pt-16 pb-8">
      <div role="dialog" aria-modal="true" aria-label="New task" className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[680px] max-w-[94vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-4 py-3 border-b border-border flex items-center gap-3">
          <h2 className="text-[15px] font-semibold text-fg">{template ? template.name : 'New task'}</h2>
          {template && <span className="text-[12px] text-fg-faint">template · edit anything</span>}
          <CloseButton onClick={onClose} className="-my-1 ml-auto" />
        </header>
        <div className="px-4 py-4 grid gap-4 text-[14px]">
          <label className="grid gap-1">
            <span className="text-[13px] font-medium text-fg">Title</span>
            <input ref={titleRef} autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a /healthz endpoint" />
          </label>
          <label className="grid gap-1">
            <span className="text-[13px] font-medium text-fg">What the agent should do</span>
            <textarea className="input" rows={template ? 5 : 4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What to change, where, and what to leave alone. The worker reads this." />
          </label>
          {left.length > 0 && (
            <p className="-mt-2 text-[12px] text-warn">Replace <span className="mono">{left.join(' ')}</span> with your own.</p>
          )}
          <div className="grid gap-1">
            <label htmlFor="new-task-checks" className="text-[13px] font-medium text-fg">Checks that must pass <span className="font-normal text-fg-faint">· one command per line, run in the worker’s worktree</span></label>
            <textarea id="new-task-checks" className="input mono text-[13px]" rows={Math.min(8, Math.max(3, criteriaList.length + 1))} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="make test" />
            {detected.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="text-fg-faint">Found in this repo:</span>
                {detected.map((c) => {
                  const on = criteriaList.includes(c.command)
                  return (
                    <button
                      key={c.command}
                      type="button"
                      disabled={on}
                      onClick={() => addCheck(c.command)}
                      title={`from ${c.source}`}
                      className="mono rounded-sm border border-border px-1.5 py-0.5 text-fg-muted hover:border-accent/60 hover:text-fg disabled:opacity-40"
                    >
                      {on ? '✓ ' : '+ '}{c.command}
                    </button>
                  )
                })}
              </div>
            ) : (
              <span className="text-[12px] text-fg-faint">
                {starter ? 'No check commands were found in this repo. ' : ''}Write the commands you would run before pushing — the task is done only when every one exits 0.
              </span>
            )}
          </div>
          <label className="grid gap-1 max-w-[16rem]">
            <span className="text-[13px] font-medium text-fg">Budget (USD)</span>
            <input className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={fallback !== undefined ? `default ${fallback}` : ''} />
            <span className="text-[12px] text-fg-faint">
              {fallback !== undefined ? `Empty means Caprock's ceiling of ${fmtUSD(fallback)}. ` : ''}Past it, the task stops and waits for you.
            </span>
          </label>
          {error && <div className="text-danger text-[13px]">{error}</div>}
        </div>
        <footer className="px-4 py-3 border-t border-border flex items-center gap-2 justify-end">
          <span className="mr-auto text-[12px] text-fg-faint">It waits in the queue until the orchestrator hands it to a worker.</span>
          <button onClick={onClose} className="rounded-[8px] border border-border px-3 py-1.5 text-fg-muted hover:text-fg">Cancel</button>
          <button onClick={submit} disabled={busy} className="rounded-[8px] bg-accent px-4 py-1.5 font-semibold text-panel hover:opacity-90 disabled:opacity-50">{busy ? 'creating…' : 'Create task'}</button>
        </footer>
      </div>
    </DialogBackdrop>
  )
}
