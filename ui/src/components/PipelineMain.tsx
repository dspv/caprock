/**
 * The Pipeline page's *Default branch* panel (.ai/04-ui.md § Pipeline): the
 * newest run of each workflow on the repository's default branch, each with
 * its jobs as a mini pipeline, its wall-clock time and its runner cost, and
 * what GitHub billed for Actions this month. A failed job opens the end of
 * its log, with Investigate. It was the session deck's *Main* view until the
 * deck was removed (owner, 2026-10-20).
 *
 * Asked while the page is in front and the window shown, through the deck's
 * route and its kept answer (`main:<repository>`, lib/deckCache); the usage
 * only while there is a connected repository, kept by the daemon 30 minutes.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, errText, type CIJob, type CILog, type SessionRepoCI, type SessionSummary } from '@/lib/api'
import { ciActive, ciTone, fmtRun, investigateMessage, jobNodes, keyStep, runSpan, type PipeNode } from '@/lib/ci'
import { sumCostLabel, usageLine } from '@/lib/runnercost'
import { openExternal } from '@/lib/nudges'
import { sessionTitle } from '@/lib/sidebar'
import { extTitle } from '@/lib/externalLinks'
import { CI_RUNNING_MS, usePoll } from '@/lib/usePoll'
import { MiniPipeline } from './MiniPipeline'
import { CIMark } from './CIParts'
import { Panel } from './ui'

/** A failed read kept over the answer it would replace. */
const keepMain = (prev: SessionRepoCI, next: SessionRepoCI) => !!next.error && !!prev.ci && !next.ci

export function PipelineMain({ sessionId, s, visible, now, why, onToast }: { sessionId: string; s: SessionSummary; visible: boolean; now: number; why: string; onToast?: (t: string) => void }) {
  const scope = s.repo_root || s.cwd || sessionId
  const [main] = usePoll<SessionRepoCI>(visible, `pipeline-main:${sessionId}`, () => api.sessionCIMain(sessionId), (d) => ciActive(d.ci), CI_RUNNING_MS, `main:${scope}`, keepMain)
  const owner = main?.repo?.split('/')[0] ?? ''
  const [usage] = usePoll(visible && !!main?.connected && !!owner, `pipeline-usage:${owner}`, () => api.actionsUsage(owner), () => false)
  const ci = main?.ci
  const runs = useMemo(() => ci?.runs ?? [], [ci?.runs])
  const failed = runs.flatMap((r) => r.jobs).find((j) => ciTone(j) === 'fail' && j.status === 'completed')
  const [picked, setPicked] = useState<number>()
  const job = runs.flatMap((r) => r.jobs).find((j) => j.id === picked) ?? failed
  if (!main || main.reason || !main.connected) return null
  const line = usageLine(usage)
  const branch = main.branch ?? ci?.branch ?? 'the default branch'
  const pick = (n: PipeNode) => {
    if (n.jobId) setPicked(n.jobId)
    else if (n.url) openExternal(n.url)
  }
  return (
    <Panel title={<>Default branch · <span className="mono normal-case tracking-normal text-fg">{branch}</span></>}
      right={line && (
        <span data-pipeline-usage={line.kind} title={line.title} className="flex min-w-0 items-center gap-2">
          <span className={`num truncate ${line.kind === 'available' ? 'text-fg-muted' : 'text-fg-faint'}`}>{line.text}</span>
          {line.kind === 'permission' && <button type="button" onClick={() => openExternal(line.url)} className="shrink-0 text-accent hover:underline" title={extTitle()}>token settings ↗</button>}
        </span>
      )}>
      <section data-pipeline-main aria-label={`${branch}: its CI`} className="grid gap-1 px-3 py-2">
        {!ci ? <p className="text-[12.5px] text-fg-muted">{main.error ? `CI not read: ${main.error.message}` : 'CI not read.'}</p>
          : runs.length === 0 ? <p className="text-[12.5px] text-fg-muted">No GitHub Actions runs on {branch}.</p>
            : runs.map((run) => {
              const ms = runSpan(run, now)
              const cost = sumCostLabel(run.cost)
              return (
                <div key={run.id} data-pipeline-main-run={run.id} className="flex min-w-0 items-center gap-2 text-[12.5px]">
                  <CIMark tone={ciTone(run)} />
                  <button type="button" onClick={() => run.html_url && openExternal(run.html_url)} title={extTitle(`Open the ${run.name} run on GitHub`)}
                    className="min-w-0 truncate text-left text-fg hover:underline">{run.name}</button>
                  <MiniPipeline nodes={jobNodes([run], now)} label={`${run.name}: its jobs`} onPick={pick} />
                  <span className="ml-auto flex shrink-0 items-baseline gap-2 text-[11.5px] text-fg-muted">
                    {ms !== undefined && <span className={`num ${run.status === 'completed' ? '' : 'text-warn'}`}>{fmtRun(ms)}</span>}
                    {cost && <span className="num" title={cost.title}>{cost.text}</span>}
                  </span>
                </div>
              )
            })}
        {ci?.error && <p className="truncate text-[11.5px] text-warn" title={ci.error.message}>The last read failed; this is the one before.</p>}
      </section>
      {job && ciTone(job) === 'fail' && job.status === 'completed' && (
        <MainFailure key={job.id} job={job} sessionId={sessionId} s={s} why={why} onToast={onToast}
          where={{ text: `${branch} of ${main.repo ?? 'the repository'}`, url: runs.find((r) => r.id === job.run_id)?.html_url }}
          workflow={runs.find((r) => r.id === job.run_id)?.name} />
      )}
    </Panel>
  )
}

/** A failed job on the default branch: its step, the end of its log, Investigate. */
function MainFailure({ job, sessionId, s, why, onToast, where, workflow }: { job: CIJob; sessionId: string; s: SessionSummary; why: string; onToast?: (t: string) => void; where: { text: string; url?: string }; workflow?: string }) {
  const step = keyStep(job)
  const [log, setLog] = useState<CILog | { error: string }>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let on = true
    api.sessionCILog(sessionId, job.id, 'main').then((l) => { if (on) setLog(l) }, (e) => { if (on) setLog({ error: errText(e) }) })
    return () => { on = false }
  }, [sessionId, job.id])
  const investigate = async () => {
    if (why) return
    setBusy(true)
    const lines = log && 'lines' in log ? log.lines : []
    const text = investigateMessage({ where, workflow, job, step: step?.name, lines })
    try {
      const res = await api.queueSend(sessionId, text)
      onToast?.(`${res.sent ? 'Sent to' : 'Queued for'} ${sessionTitle(s)}`)
    } catch (e) {
      onToast?.(`Not queued: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-pipeline-main-failure={job.id} className="flex flex-col gap-2 border-t border-border px-3 py-2">
      <span className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
        <CIMark tone="fail" />
        <span className="min-w-0 truncate font-medium text-danger">{job.name}{step ? ` › ${step.name}` : ''}</span>
        {job.html_url && <button type="button" onClick={() => openExternal(job.html_url!)} className="ml-auto shrink-0 text-[11.5px] text-fg-muted hover:underline" title={extTitle()}>open on GitHub ↗</button>}
      </span>
      {!log ? <p className="text-[11.5px] text-fg-muted">Reading the end of the log…</p> : 'error' in log ? <p className="text-[11.5px] text-warn">Log not read: {log.error}</p> : (
        <pre data-pipeline-main-log className="app-scroll max-h-[200px] overflow-auto rounded-[6px] border border-[var(--app-hairline)] bg-[var(--color-term-bg)] px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-[#c9c5be]">
          {log.lines.map((l, i) => <div key={i} className={i === log.error_line ? 'ci-error-line text-[#ff8080]' : ''}>{l || ' '}</div>)}
          {log.lines.length === 0 && <div>The log is empty.</div>}
        </pre>
      )}
      <span>
        <button type="button" data-pipeline-main-investigate disabled={!!why || busy} onClick={() => void investigate()}
          title={why || 'Queue this failure — the job, its step, its link and the end of its log — into this agent, to investigate and fix'}
          className="rounded-[6px] border border-accent/50 px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:border-[var(--app-hairline)] disabled:text-fg-faint">
          {busy ? 'Queueing…' : 'Investigate'}
        </button>
      </span>
    </div>
  )
}
