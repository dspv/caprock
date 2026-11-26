/**
 * *Set up this computer* on a linked computer's page (issue #1088; the
 * owner's pick of 2026-11-26, variant A of the mockup): every step it still
 * needs, each run there on a click (lib/remotesetup.ts).
 *
 * - A line *N of M done · each step runs there when you click it* and a thin
 *   bar, then a row per step: ✓ done, ○ to do, ◐ running (with the last line
 *   it printed), its name, a muted detail, and its action at the right.
 * - **Install / Add to PATH / Sign in** run that computer's own command in a
 *   shell there. **Show output** opens that shell as a tab here (a remote tab,
 *   #1085), where anything it asks is answered. An agent's sign-in opens it
 *   at once: it asks in its terminal.
 * - **Sign in to GitHub** is the GitHub CLI's device flow: its one-time code
 *   is shown here in a dashed box with **Copy and open**, which copies it and
 *   opens github.com/login/device on this computer, on that click only; the
 *   row ticks by itself once the CLI there is signed in.
 * - **Read and accept** shows Claude Code's bypass warning (BypassConsentNote)
 *   and records the consent there (#1091).
 * - **Needs <name>'s own screen**: the Chrome extension and site sign-ins,
 *   which no command can do, each with **Done there**, kept on this computer.
 *
 * Shown while something is left; then one quiet line, *Set up · all done*,
 * that opens the list again. A computer running a Caprock from before the
 * checklist shows nothing.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { machineBase, machinesApi, type Machine } from '@/lib/machines'
import { fetchSetup, notThere, type SetupReport } from '@/lib/setup'
import { useAppActions } from '@/lib/setup'
import { useApi } from '@/lib/useApi'
import { navigate } from '@/lib/router'
import { openExternal } from '@/lib/nudges'
import { extProps } from '@/lib/externalLinks'
import {
  GITHUB_DEVICE_URL,
  acceptBypassThere,
  chromeDefaultOn,
  fetchRuns,
  remoteSteps,
  runError,
  runStep,
  stepCounts,
  type RemoteStep,
  type SetupRun,
} from '@/lib/remotesetup'
import { BypassConsentNote } from './BypassConsent'

/** How often the list reads again while a step runs there, and otherwise. */
export const RUNNING_POLL_MS = 2500
export const IDLE_POLL_MS = 15_000

const BUTTON = 'shrink-0 rounded-[6px] bg-accent px-3 py-1 text-[12.5px] font-semibold text-panel hover:brightness-110 disabled:opacity-50'
const QUIET = 'shrink-0 rounded-[6px] border border-border-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-panel-2 disabled:opacity-50'

export function RemoteSetup({ m }: { m: Pick<Machine, 'id' | 'name' | 'setup_done'> }) {
  const actions = useAppActions()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [open, setOpen] = useState(false)
  // A setting's answer, shown at once until a read newer than it.
  const [fresh, setFresh] = useState<{ rep: SetupReport; at: number } | undefined>(undefined)
  // Read often while a step runs there, else now and then.
  const [every, setEvery] = useState(IDLE_POLL_MS)
  const setup = useApi(() => fetchSetup(machineBase(m.id)), [m.id], { live: false, intervalMs: every })
  const runs = useApi(() => fetchRuns(m.id), [m.id], { live: false, intervalMs: every })
  const want = pending || (runs.data ?? []).some((r) => r.state === 'running') ? RUNNING_POLL_MS : IDLE_POLL_MS
  useEffect(() => { setEvery(want) }, [want])
  const rep = fresh && (!setup.data || setup.loadedAt < fresh.at) ? fresh.rep : setup.data
  const steps = remoteSteps(rep, m.setup_done ?? [], runs.data ?? [])
  // A Caprock there from before the checklist, or nothing to set up there.
  if (setup.error && notThere(setup.error)) return null
  if (!rep || steps.length === 0) return null
  const { done, total, left } = stepCounts(steps)
  // An older Caprock there lists no tools: nothing new to say once it is ready.
  if (left === 0 && !rep.tools) return null

  const refresh = () => { setup.refresh(); runs.refresh() }
  const act = async (s: RemoteStep, fn: () => Promise<unknown>) => {
    setPending(s.key)
    setError('')
    try { await fn() } catch (e) { setError(runError(e, m.name)) } finally { setPending(null); refresh() }
  }
  const showOutput = (run: SetupRun, label: string) => {
    if (actions.openRemote) actions.openRemote(m.id, run.shell, `${label} on ${m.name}`)
    else navigate({ name: 'machine', id: m.id, session: run.shell })
  }
  const onAction = (s: RemoteStep) => {
    const a = s.action
    if (!a) return
    switch (a.kind) {
      case 'run':
        void act(s, async () => {
          const run = await runStep(m.id, a.step, a.agent)
          // An agent's sign-in asks in its terminal: open it at once.
          if (a.signin) showOutput(run, s.label)
        })
        return
      case 'bypass':
        setReading(true)
        return
      case 'chrome':
        void act(s, async () => { const r = await chromeDefaultOn(m.id); setFresh({ rep: r, at: Date.now() }) })
        return
      case 'mark':
        void act(s, () => machinesApi.setSetupDone(m.id, [...(m.setup_done ?? []), a.step]))
        return
    }
  }
  const unmark = (s: RemoteStep) => {
    if (s.action?.kind !== 'mark') return
    const step = s.action.step
    void act(s, () => machinesApi.setSetupDone(m.id, (m.setup_done ?? []).filter((k) => k !== step)))
  }

  if (left === 0 && !open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-remote-setup="done" className="flex items-center gap-2 justify-self-start text-[13px] text-fg-muted hover:text-fg">
        <span aria-hidden className="font-bold text-ok">✓</span>Set up · all done
      </button>
    )
  }
  const own = steps.filter((s) => !s.screen)
  const screen = steps.filter((s) => s.screen)
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <section aria-label="Set up this computer" data-remote-setup={left === 0 ? 'done' : 'left'} className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-panel px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold text-fg">Set up this computer</h2>
        <span className="tabular-nums text-[12.5px] text-fg-muted" data-remote-setup-count>{done} of {total} done · each step runs there when you click it</span>
        {left === 0 && <button type="button" onClick={() => setOpen(false)} className="ml-auto text-[12.5px] text-fg-muted hover:text-fg">Hide</button>}
      </div>
      <div role="progressbar" aria-label="Set up" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-[3px] w-full overflow-hidden rounded-full bg-panel-2">
        <div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <ol className="grid min-w-0 gap-0.5">
        {own.map((s) => (
          <StepRow key={s.key} s={s} name={m.name} pending={pending === s.key} onAction={() => onAction(s)} onOutput={s.run ? () => showOutput(s.run!, s.label) : undefined}>
            {s.key === 'bypass' && reading && s.mark !== 'done' ? (
              <div className="grid gap-2">
                <BypassConsentNote button="Accept" on={m.name} />
                <div className="flex gap-2">
                  <button type="button" className={BUTTON} disabled={pending === s.key} onClick={() => void act(s, async () => { await acceptBypassThere(m.id); setReading(false) })}>Accept</button>
                  <button type="button" className={QUIET} onClick={() => setReading(false)}>Not now</button>
                </div>
              </div>
            ) : null}
          </StepRow>
        ))}
      </ol>
      {screen.length > 0 && (
        <div className="grid min-w-0 gap-0.5 border-t border-border pt-3">
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-warn" data-remote-setup-screen>Needs {m.name}&apos;s own screen</div>
          <ol className="grid min-w-0 gap-0.5">
            {screen.map((s) => <StepRow key={s.key} s={s} name={m.name} pending={pending === s.key} onAction={() => onAction(s)} onUndo={() => unmark(s)} />)}
          </ol>
        </div>
      )}
      {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
    </section>
  )
}

function StepRow({ s, name, pending, onAction, onOutput, onUndo, children }: {
  s: RemoteStep
  name: string
  pending: boolean
  onAction: () => void
  onOutput?: () => void
  onUndo?: () => void
  children?: ReactNode
}) {
  const run = s.run
  const failed = s.mark === 'todo' && run?.state === 'finished'
  const word = s.action?.kind === 'run' ? s.action.word : s.action?.kind === 'bypass' ? 'Read and accept' : s.action?.kind === 'chrome' ? 'Turn on' : 'Done there'
  const quiet = s.action?.kind === 'mark'
  const detail = s.mark === 'running'
    ? (run?.code ? 'Enter the code below on GitHub, from this computer.' : run?.line || `Running on ${name}…`)
    : failed ? `Finished, but not done yet${run?.line ? `: ${run.line}` : '.'}` : s.detail
  return (
    <li data-remote-step={s.key} data-mark={s.mark} className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 py-1.5">
      <span aria-label={s.mark === 'done' ? 'done' : s.mark === 'running' ? 'running' : 'to do'} className={`pt-[1px] text-center text-[14px] leading-[20px] ${s.mark === 'done' ? 'font-bold text-ok' : s.mark === 'running' ? 'animate-pulse text-accent' : 'text-fg-faint'}`}>
        {s.mark === 'done' ? '✓' : s.mark === 'running' ? '◐' : '○'}
      </span>
      <div className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 basis-56">
            <span className={`text-[13.5px] ${s.mark === 'done' ? 'text-fg-muted' : 'font-medium text-fg'}`}>{s.label}</span>
            <span className={`block truncate text-[12.5px] ${s.mark === 'running' && !run?.code ? 'mono text-fg-muted' : failed ? 'text-warn' : s.mark === 'running' ? 'text-fg-muted' : 'text-fg-faint'}`} title={detail} data-remote-step-detail>{detail}</span>
          </span>
          {onOutput && (s.mark === 'running' || failed) && <button type="button" className="shrink-0 text-[12.5px] text-accent hover:underline" onClick={onOutput}>Show output</button>}
          {s.mark === 'todo' && s.action && !children && (
            <button type="button" className={quiet ? QUIET : BUTTON} disabled={pending} onClick={onAction}>{pending ? '…' : failed && s.action.kind === 'run' ? 'Try again' : word}</button>
          )}
          {s.mark === 'done' && onUndo && <button type="button" className="shrink-0 text-[12px] text-fg-faint hover:text-fg" onClick={onUndo}>Not yet</button>}
        </div>
        {s.key === 'gh_auth' && run?.code && s.mark === 'running' && <DeviceCode code={run.code} />}
        {children}
      </div>
    </li>
  )
}

/** The GitHub CLI's one-time code, to enter on GitHub from this computer. */
function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState('')
  return (
    <div data-device-code className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-[8px] border border-dashed border-accent/60 px-4 py-3">
      <span className="grid gap-0.5">
        <span className="text-[12px] text-fg-muted">Enter this code on GitHub</span>
        <span className="mono select-all text-[22px] font-semibold tracking-[0.12em] text-fg" data-device-code-value>{code}</span>
      </span>
      <button
        type="button"
        className={BUTTON}
        {...extProps('github.com/login/device')}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => setCopied('Copied.'), () => setCopied(''))
          openExternal(GITHUB_DEVICE_URL)
        }}
      >
        Copy and open
      </button>
      <span className="text-[12px] text-fg-faint">{copied ? `${copied} ` : ''}Opens github.com/login/device here. The row ticks when GitHub says yes.</span>
    </div>
  )
}
