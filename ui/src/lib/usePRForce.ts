/**
 * The force actions on a pull request (owner, 2026-10-12, translated: "if
 * needed I want to FORCE a fix or a check"), shared by the session deck's PR
 * rows and the PRs & CI tab's detail: who a fix goes to, why an action is
 * not offered, the sentence each asks to confirm, and doing it. Each asks
 * once, and then the row says what it is doing until GitHub shows it done
 * (lib/prforce progressStands). .ai/21-app.md § Session deck, The actions.
 */
import { useState } from 'react'
import { api, type CIJob, type CIRun, type SessionPRLive, type SessionSummary, type SpawnRequest } from './api'
import { ciTone, investigateMessage, keyStep } from './ci'
import { PROGRESS_MAX_MS, branchWorktree, fixCIMessage, fixConflictMessage, fixWorktreeName, forceErrText, prAgents, progressStands, rerunText, typeable, type DeckWorktree, type PRAgent, type PRProgress } from './prforce'
import { sessionTitle } from './sidebar'

export type ForceKind = 'conflict' | 'ci' | 'rerun' | 'update'
export const FORCE_LABEL: Record<ForceKind, string> = {
  conflict: 'Fix conflict with agent', ci: 'Fix CI with agent', rerun: 'Re-run checks', update: 'Update branch',
}
export const FORCE_TITLE: Record<ForceKind, string> = {
  conflict: 'An agent merges the base in, resolves the conflicts, runs the checks and pushes: the agent on this branch when Caprock started it, else a new one in the branch’s checkout',
  ci: 'An agent looks at this pull request’s CI — the failed job with its log, or the flaky checks — fixes it and pushes',
  rerun: 'Run the checks again on GitHub: the failed jobs, else every finished run. Needs the token’s Actions (write) permission',
  update: 'Merge the base into this branch on GitHub, as its Update branch button does. Needs the token’s Pull requests (write) permission',
}
/** Where a fix goes: typed into an agent Caprock started, or a new agent. */
export type FixPlan = { mode: 'queue'; to: SessionSummary } | { mode: 'spawn'; wt?: DeckWorktree; foreign: boolean }

/** What each PR is doing after a force action, per session, while the app runs: hiding the deck or closing the tab keeps it. */
const prProgress = new Map<string, PRProgress>()
function progressOf(sessionId: string): Record<number, PRProgress> {
  const out: Record<number, PRProgress> = {}
  for (const [k, g] of prProgress) {
    const i = k.lastIndexOf(':')
    if (k.slice(0, i) === sessionId) out[Number(k.slice(i + 1))] = g
  }
  return out
}
/** Forgets every progress line: for tests. */
export function forgetPRProgress() { prProgress.clear() }

export interface PRForceOptions {
  sessionId: string
  s: SessionSummary
  worktrees?: DeckWorktree[]
  onStartAgent?: (req: SpawnRequest, title: string) => Promise<void>
  onToast?: (text: string) => void
  /** This device may act (a paired device that may only watch may not). */
  canControl: boolean
  /** Whether GitHub is connected, as the last answer said; undefined before one. */
  connected: boolean | undefined
  /** Why nothing can be queued to the session itself ('' when it can): Investigate's reason. */
  why: string
  /** The runs read for a PR's head, when read: Fix CI sends the first failed job with its log. */
  runsOf: (p: SessionPRLive) => CIRun[] | undefined
  /** After an action went through: ask again sooner. */
  onDone: () => void
}

export function usePRForce(o: PRForceOptions) {
  const { sessionId, s, worktrees, onStartAgent, onToast, canControl, connected, why, runsOf, onDone } = o
  const [confirm, setConfirm] = useState<{ pr: number; kind: ForceKind }>()
  const [forcing, setForcing] = useState<number>()
  const [progress, setProgressState] = useState<Record<number, PRProgress>>(() => progressOf(sessionId))
  const setProgress = (n: number, g: PRProgress | undefined) => {
    const k = `${sessionId}:${n}`
    if (g) prProgress.set(k, g)
    else prProgress.delete(k)
    setProgressState(progressOf(sessionId))
  }
  // A progress line goes once GitHub shows it done, or after a while.
  const standing = (p: SessionPRLive, agents: PRAgent[], now: number): PRProgress | undefined => {
    const g = progress[p.number]
    return g && progressStands(g, p, agents, now) ? g : undefined
  }
  // While one stands, the PRs are asked sooner and the clock ticks, so it
  // goes as soon as it is done.
  const active = (now: number) => Object.values(progress).some((g) => now - g.at < PROGRESS_MAX_MS)

  const root = s.repo_root || s.cwd
  const agentsOf = (p: SessionPRLive) => prAgents(p.live?.branch, worktrees)
  // Who a fix goes to: a Caprock-started agent on the branch; for CI, else
  // the session in front as Investigate does; else a new agent in the
  // branch's checkout, or in a new worktree at the PR's head when there is
  // none or someone Caprock did not start works in it (rule 7).
  const fixPlan = (p: SessionPRLive, kind: 'conflict' | 'ci'): FixPlan => {
    const on = agentsOf(p)
    const mine = on.find((a) => typeable(a.session))
    if (mine) return { mode: 'queue', to: mine.session }
    if (kind === 'ci' && !why) return { mode: 'queue', to: s }
    const wt = branchWorktree(p.live?.branch, worktrees)
    const foreign = on.some((a) => !typeable(a.session))
    return { mode: 'spawn', wt: wt && !foreign ? wt : undefined, foreign }
  }
  const forceWhy = (p: SessionPRLive, kind: ForceKind): string => {
    if (!canControl) return 'This device may only watch: do it from the Mac, or make this device a controller in Settings.'
    const live = p.live
    if (!live || live.state !== 'open') return 'Only an open pull request.'
    if (kind === 'rerun' || kind === 'update') {
      if (connected === false) return 'Connect GitHub first.'
      if (kind === 'rerun' && live.checks.items.length === 0) return 'No checks to re-run.'
      if (kind === 'rerun' && live.checks.state === 'pending') return 'The checks are still running; GitHub re-runs a run once it has finished.'
      return ''
    }
    const plan = fixPlan(p, kind)
    if (plan.mode === 'spawn' && !onStartAgent) return 'An agent cannot be started from here.'
    if (plan.mode === 'spawn' && !root) return 'This session has no folder to start an agent in.'
    return ''
  }
  const confirmText = (p: SessionPRLive, kind: ForceKind): string => {
    const live = p.live!
    if (kind === 'rerun') return live.checks.failed > 0 ? `Re-run #${p.number}’s failed jobs on GitHub?` : `Re-run every check of #${p.number} on GitHub?`
    if (kind === 'update') return `Merge ${live.base} into ${live.branch} on GitHub (Update branch)?`
    const plan = fixPlan(p, kind)
    const what = kind === 'conflict' ? `merge origin/${live.base}, resolve the conflicts, run the checks and push` : 'fix #' + p.number + '’s CI and push'
    if (plan.mode === 'queue') return `Ask ${sessionTitle(plan.to)} to ${what}?`
    const where = plan.wt ? `in ${plan.wt.path.split(/[\\/]/).pop()}` : `in a new worktree at #${p.number}’s head`
    return `Start an agent ${where} to ${what}?${plan.foreign ? ' The agent on the branch was not started by Caprock, so nothing is typed into it.' : ''}`
  }
  // Fix CI's message: Investigate's for the first failed job, with its log;
  // else the flaky-check one.
  const ciMessage = async (p: SessionPRLive, fresh: boolean): Promise<string> => {
    const live = p.live!
    const runs = runsOf(p) ?? []
    const failed: CIJob | undefined = runs.flatMap((r) => r.jobs).find((j) => ciTone(j) === 'fail')
    if (!failed) return fixCIMessage(live, fresh)
    let lines: string[] = []
    try { lines = (await api.sessionCILog(sessionId, failed.id, 'pr', p.number)).lines } catch { /* the job's link has it */ }
    const run = runs.find((r) => r.id === failed.run_id)
    const text = investigateMessage({ pr: { number: p.number, title: live.title, url: live.url }, workflow: run?.name, job: failed, step: keyStep(failed)?.name, lines })
    return fresh && live.branch ? `${text}\nPush to the pull request's branch: git push origin HEAD:${live.branch}` : text
  }
  const force = async (p: SessionPRLive, kind: ForceKind) => {
    setConfirm(undefined)
    const live = p.live
    if (!live || forceWhy(p, kind)) return
    setForcing(p.number)
    const label = FORCE_LABEL[kind]
    try {
      if (kind === 'rerun') {
        const r = await api.sessionPRRerun(sessionId, p.number)
        setProgress(p.number, { kind: 'rerun', text: rerunText(r.jobs), at: Date.now(), head: live.head_sha })
      } else if (kind === 'update') {
        await api.sessionPRUpdateBranch(sessionId, p.number)
        setProgress(p.number, { kind: 'update', text: 'updating branch…', at: Date.now(), head: live.head_sha })
      } else {
        const plan = fixPlan(p, kind)
        const fresh = plan.mode === 'spawn' && !plan.wt
        const text = kind === 'conflict' ? fixConflictMessage(live, fresh) : await ciMessage(p, fresh)
        if (plan.mode === 'queue') {
          const res = await api.queueSend(plan.to.session_id, text)
          onToast?.(`${res.sent ? 'Sent to' : 'Queued for'} ${sessionTitle(plan.to)}`)
        } else {
          const req: SpawnRequest = plan.wt ? { cwd: plan.wt.path, prompt: text } : { cwd: root, worktree: fixWorktreeName(p.number), worktree_pr: p.number, prompt: text }
          await onStartAgent!(req, `#${p.number} ${kind === 'conflict' ? 'conflict' : 'CI'}`)
          onToast?.(`Started an agent on #${p.number}`)
        }
        setProgress(p.number, { kind: 'agent', text: 'agent fixing…', at: Date.now(), head: live.head_sha })
      }
      onDone()
    } catch (e) {
      onToast?.(`${label}: ${forceErrText(e)}`)
    } finally {
      setForcing(undefined)
    }
  }
  return { confirm, setConfirm, forcing, progress, standing, active, fixPlan, forceWhy, confirmText, force, agentsOf }
}
