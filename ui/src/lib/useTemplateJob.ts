/**
 * New project from a template (ADR-065): the job outlives its sheet. Esc
 * hides components/TemplateProjectSheet.tsx; the operation's frames still
 * arrive at the app (`ops`, from /v1/live), a missed one is read back from
 * `GET /v1/projects/ops`, and when the operation is done the agent starts
 * with the template's prompt — `POST /v1/agents`, the one way a session
 * starts — and its tab opens. The template the person ticked is saved only
 * then: one that made nothing is not kept.
 */
import { useEffect, useRef, useState } from 'react'
import { api, errText } from './api'
import { keys } from './appkeys'
import { projectsApi, type OpFrame } from './projects'
import { isTemplateOp, readyLine, type TemplateJob, type TemplateOp } from './templates'

export interface TemplateJobHooks {
  /** The agent started: open its tab on the new project. */
  onStarted: (sessionId: string, projectId: string, job: TemplateJob) => void
  /** The project was made: list it and select it. */
  onMade: (projectId: string) => void
  toast: (text: string) => void
  /** Whether the sheet is showing (a failure then speaks there, not in a toast). */
  sheetOpen: () => boolean
  closeSheet: () => void
}

export function useTemplateJob(ops: readonly OpFrame[], hooks: TemplateJobHooks) {
  const [job, setJob] = useState<TemplateJob | null>(null)
  const [op, setOp] = useState<TemplateOp | undefined>(undefined)
  const handled = useRef('')
  const h = useRef(hooks)
  h.current = hooks
  const id = job?.op_id

  useEffect(() => {
    if (!id) return
    const hit = ops.find((o) => o.op_id === id)
    if (isTemplateOp(hit)) setOp(hit)
  }, [ops, id])

  // A frame missed (a socket that reconnected) is read back from the list.
  const running = !!id && (!op || op.state === 'running')
  useEffect(() => {
    if (!running || !id) return
    const t = window.setInterval(() => {
      projectsApi.ops().then((list) => {
        const hit = list.find((o) => o.op_id === id)
        if (isTemplateOp(hit)) setOp((cur) => (cur && cur.updated_at && hit.updated_at && hit.updated_at < cur.updated_at ? cur : hit))
      }).catch(() => { /* the frames carry on */ })
    }, 2000)
    return () => window.clearInterval(t)
  }, [running, id])

  useEffect(() => {
    if (!job || !op || op.op_id !== job.op_id) return
    if (op.state === 'failed') {
      const key = `${op.op_id}:failed:${op.updated_at ?? ''}`
      if (handled.current === key) return
      handled.current = key
      if (!h.current.sheetOpen()) h.current.toast(`${job.name} was not made: ${(op.error ?? '').trim() || 'it failed'} — ${keys('⌘K')} → New project from a template… to see why or try again.`)
      return
    }
    if (op.state !== 'done' || job.starting || job.agentError || handled.current === `${op.op_id}:done`) return
    handled.current = `${op.op_id}:done`
    const projectId = op.project_id ? String(op.project_id) : ''
    const cwd = op.dest ?? ''
    setJob({ ...job, starting: true, projectId, cwd })
    if (projectId) h.current.onMade(projectId)
    const saving = job.save ? api.addTemplate(job.save).then(() => '', (e) => ` The template was not saved: ${errText(e)}`) : Promise.resolve('')
    api.spawn({ cwd, agent: job.agent, prompt: job.prompt })
      .then(async ({ session_id }) => {
        h.current.onStarted(session_id, projectId, job)
        setJob(null)
        setOp(undefined)
        h.current.closeSheet()
        h.current.toast(readyLine(job.name, op) + (await saving))
      })
      .catch(async (e) => {
        setJob({ ...job, starting: false, projectId, cwd, agentError: errText(e) })
        h.current.toast(`${job.name} is made, but ${job.agentLabel} did not start: ${errText(e)}${await saving}`)
      })
  }, [job, op])

  return {
    job,
    op,
    /** Create was accepted. */
    submit: (j: TemplateJob, o: TemplateOp) => { handled.current = ''; setJob(j); setOp(o) },
    /** A newer frame than the list has (Retry's answer). */
    setOp: (o: TemplateOp) => setOp(o),
    /** Forget the job: a failed one started over, or one handed to New agent. */
    reset: () => { setJob(null); setOp(undefined) },
  }
}
