/**
 * One row of the Work board (.ai/04-ui.md § Work): its title, a bar along
 * agent → PR → CI → merged filled to the stage it is in (red at CI when a
 * check failed, it conflicts or changes were asked for; full on a merge), the
 * stage in a word — *in v0.140.0* once released, a muted *not released* after
 * *merged* while it waits for one — who works on it, how long since it started, its agent cost, and an
 * estimate only where a measured basis exists — each saying its basis on
 * hover (lib/work.ts).
 *
 * A pull request's title opens the Pipeline's detail for it; a session's (or
 * a session named on a row) opens the session — in the app, its tab comes
 * forward (`onOpenSession`); a task's opens Tasks.
 */
import type { ReactNode } from 'react'
import { href } from '@/lib/router'
import type { BoardFlow } from '@/lib/prboard'
import { AGENT_COST_NOTE } from '@/lib/prboard'
import { fmtUSD } from '@/lib/format'
import { spanText } from '@/lib/prstats'
import { ciVsUsual, origin, pipelineHref, releaseLag, STEPS, titleIsNumber, todoSteps, turnLeft, type WorkItem } from '@/lib/work'
import type { WorkSession } from '@/lib/api'
import { agentName } from './Characters'

export interface WorkRowProps {
  it: WorkItem
  now: number
  /** Time since the board was read: turn ranges count down from it. */
  passed: number
  /** The repository's Pipeline flow figures, when read. */
  flow?: BoardFlow
  /** The app brings a session's tab forward; absent, the session's page opens. */
  onOpenSession?: (id: string) => void
  /** Show the repository's name (more than one repository on the board). */
  showRepo?: boolean
}

/** The stage bar: four steps, filled to the stage; a merge fills it, in the merged colour. */
export function StageBar({ it, compact = false }: { it: Pick<WorkItem, 'fill' | 'red' | 'running' | 'word'> & Partial<Pick<WorkItem, 'stage'>>; compact?: boolean }) {
  const label = it.fill === 0 ? `Not started: ${it.word}` : `Step ${it.fill} of ${STEPS.length} (${STEPS[it.fill - 1]}): ${it.word}`
  const merged = it.stage === 'merged' || it.stage === 'released'
  return (
    <span role="img" aria-label={label} title={`${STEPS.join(' → ')}\n${label}`} data-work-bar={it.fill} className="inline-flex shrink-0 items-center gap-[3px]">
      {STEPS.map((s, i) => {
        const filled = i < it.fill
        const at = i === it.fill - 1
        const tone = !filled ? 'bg-fg-faint/30'
          : at && it.red ? 'bg-danger'
          : at && it.running ? 'bg-warn motion-safe:animate-pulse'
          : merged ? 'bg-merged' : 'bg-accent'
        return <span key={s} data-work-step={s} data-on={filled || undefined} className={`block ${compact ? 'h-[5px] w-[12px]' : 'h-[6px] w-[16px]'} rounded-[2px] ${tone}`} />
      })}
    </span>
  )
}

/** The stage word's colour. */
function wordTone(it: WorkItem): string {
  if (it.red) return 'text-danger'
  if (it.running) return 'text-warn'
  if (it.stage === 'merged') return 'text-merged'
  // Released: the bar is full; the release it shipped in is a quiet word.
  if (it.stage === 'released') return 'text-fg-muted'
  if (it.stage === 'planned') return 'text-fg-muted'
  return 'text-fg'
}

/** The quiet word after the stage word: *not released* on a merge waiting for a release. */
export function NoteWord({ it, className = '' }: { it: Pick<WorkItem, 'note'>; className?: string }) {
  if (!it.note) return null
  return <span data-work-release-note title={it.note.title} className={`whitespace-nowrap font-normal text-fg-muted ${className}`}>· {it.note.text}</span>
}

/** A session's name as a link. */
export function SessionLink({ s, onOpenSession, children }: { s: WorkSession; onOpenSession?: (id: string) => void; children: ReactNode }) {
  if (onOpenSession) {
    return <button type="button" data-work-session={s.session_id} onClick={() => onOpenSession(s.session_id)} className="min-w-0 text-left text-fg [overflow-wrap:anywhere] hover:text-accent hover:underline">{children}</button>
  }
  return <a href={href({ name: 'session', id: s.session_id })} data-work-session={s.session_id} className="min-w-0 text-fg no-underline [overflow-wrap:anywhere] hover:text-accent hover:underline">{children}</a>
}

/** Who: the agent and its model, and who started it. */
export function whoText(s: WorkSession): string {
  const model = s.model_display || ''
  return `${agentName(s.agent)}${model ? ` ${model}` : ''}`
}

/** The row's title, as the link it is. */
export function TitleLink({ it, onOpenSession, className = '' }: { it: WorkItem; onOpenSession?: (id: string) => void; className?: string }) {
  const cls = `min-w-0 text-left font-medium leading-[1.35] text-fg no-underline [overflow-wrap:anywhere] hover:text-accent ${className}`
  const s = it.sessions[0]
  if (it.pr && it.repo) return <a href={pipelineHref(it.repo.root, it.pr.number)} data-work-open="pr" className={cls} title="Open it in the Pipeline">{it.title}</a>
  if (it.kind === 'task') return <a href={href({ name: 'tasks' })} data-work-open="task" className={cls} title="Open Tasks">{it.title}</a>
  if (s && onOpenSession) return <button type="button" data-work-open="session" onClick={() => onOpenSession(s.session_id)} className={cls}>{it.title}</button>
  if (s) return <a href={href({ name: 'session', id: s.session_id })} data-work-open="session" className={cls}>{it.title}</a>
  return <span className={cls}>{it.title}</span>
}

/** The cost as the row says it; the list price note on hover. */
export function CostCell({ it }: { it: WorkItem }) {
  if (it.costUsd === undefined) return <span className="text-fg-faint" title="No Caprock session was recorded on it">–</span>
  return <span title={`${fmtUSD(it.costUsd)} at API list price, not a bill.\n${AGENT_COST_NOTE}`}>{fmtUSD(it.costUsd)}</span>
}

/** What the row says it is waiting on or doing, with its estimates. */
export function rowNotes(it: WorkItem, flow: BoardFlow | undefined, now: number, passed: number): { text: string; title: string; tone?: string; todo?: { done: number; total: number } }[] {
  const out: { text: string; title: string; tone?: string; todo?: { done: number; total: number } }[] = []
  // A queued message is not its session's turn: the session's own row says that.
  for (const s of it.kind === 'queued' ? [] : it.sessions) {
    if (s.state === 'permission') out.push({ text: 'waiting for your approval', title: 'A permission prompt is on its screen', tone: 'text-warn' })
    else if (s.state === 'question') out.push({ text: 'asked you a question', title: 'It asked a question and waits for the answer', tone: 'text-warn' })
    const t = turnLeft(s, passed)
    if (t) out.push(t)
    const todo = todoSteps(s)
    if (todo) out.push({ text: todo.text, title: todo.title, todo })
  }
  const ci = ciVsUsual(it.card, flow, now)
  if (ci) out.push(ci)
  const lag = releaseLag(it.stage, flow)
  if (lag) out.push(lag)
  if (it.queued) {
    const s = it.sessions[0]
    out.push({ text: it.queued.position === 1 ? 'next, after the current turn' : `${it.queued.position} in line`, title: s ? `Queued for ${s.name || s.project}` : 'Queued' })
  }
  return out
}

/** A todo's steps as a small bar beside its words. */
export function TodoMeter({ done, total }: { done: number; total: number }) {
  const n = Math.min(total, 10)
  const on = Math.round((done / total) * n)
  return (
    <span aria-hidden className="inline-flex items-center gap-[2px] align-middle">
      {Array.from({ length: n }, (_, i) => <span key={i} className={`block h-[4px] w-[5px] rounded-[1px] ${i < on ? 'bg-fg-muted' : 'bg-fg-faint/30'}`} />)}
    </span>
  )
}

const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto_64px_72px] items-start gap-x-4 gap-y-1.5 @max-[720px]/work:grid-cols-[minmax(0,1fr)_auto_auto]'

export function WorkRow({ it, now, passed, flow, onOpenSession, showRepo = true }: WorkRowProps) {
  const notes = rowNotes(it, flow, now, passed)
  const elapsed = it.startedAt ? spanText(Math.max(0, now - it.startedAt)) : ''
  return (
    <li data-work-row={it.key} data-work-kind={it.kind} data-work-stage={it.stage} data-needs-you={it.needsYou || undefined}
      className={`border-b border-border px-3 py-2.5 last:border-b-0 ${it.needsYou ? 'shadow-[inset_3px_0_0_var(--color-warn)]' : ''}`}>
      <div className={ROW_GRID}>
        <div className="min-w-0 @max-[720px]/work:col-span-3">
          <div className="flex min-w-0 items-baseline gap-2">
            {it.pr && !titleIsNumber(it.pr.number, it.title) && <span className="num shrink-0 text-[13px] text-fg-muted">#{it.pr.number}</span>}
            <TitleLink it={it} onOpenSession={onOpenSession} className="text-[14px]" />
          </div>
          <Meta it={it} showRepo={showRepo} onOpenSession={onOpenSession} />
          {notes.length > 0 && (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-fg-muted">
              {notes.map((n, i) => (
                <span key={i} data-work-note title={n.title} className={`inline-flex min-w-0 items-center gap-1.5 ${n.tone ?? ''}`}>
                  {n.todo && <TodoMeter done={n.todo.done} total={n.todo.total} />}
                  <span className="[overflow-wrap:anywhere]">{n.text}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 pt-[3px] @max-[720px]/work:col-span-1">
          <StageBar it={it} />
          <span data-work-word className={`whitespace-nowrap text-[12.5px] font-medium ${wordTone(it)}`}>{it.word}</span>
          <NoteWord it={it} className="text-[12px]" />
        </div>
        <span className="num pt-[1px] text-right text-[12.5px] text-fg-muted" title={it.startedAt ? `Started ${new Date(it.startedAt).toLocaleString()}` : undefined}>{elapsed || '–'}</span>
        <span className="num pt-[1px] text-right text-[13px] font-medium text-fg"><CostCell it={it} /></span>
      </div>
    </li>
  )
}

/** Repository, branch, who works on it. */
export function Meta({ it, showRepo, onOpenSession }: { it: WorkItem; showRepo: boolean; onOpenSession?: (id: string) => void }) {
  const parts: ReactNode[] = []
  if (showRepo && it.repo) parts.push(<span key="repo" className="truncate" title={it.repo.root}>{it.repo.name}</span>)
  if (it.branch) parts.push(<span key="branch" className="mono truncate" title={`Branch ${it.branch}`}>{it.branch}</span>)
  if (it.task && it.kind !== 'task') parts.push(<a key="task" href={href({ name: 'tasks' })} className="truncate text-fg-muted no-underline hover:text-accent" title="Open Tasks">task: {it.task.title}</a>)
  for (const s of it.kind === 'queued' ? [] : it.sessions) {
    parts.push(
      <span key={s.session_id} className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1">
        <SessionLink s={s} onOpenSession={onOpenSession}>{whoText(s)}</SessionLink>
        <span className="shrink-0 text-fg-faint" title={s.owned ? 'Caprock started it' : 'Started in your own terminal: watched, never typed into'}>· {origin(s)}</span>
      </span>,
    )
  }
  if (it.kind === 'queued' && it.sessions[0]) {
    const s = it.sessions[0]
    parts.push(<span key="for" className="inline-flex min-w-0 gap-1">for <SessionLink s={s} onOpenSession={onOpenSession}>{s.name || s.project || s.session_id.slice(0, 8)}</SessionLink></span>)
  }
  if (parts.length === 0) return null
  return (
    <div data-work-meta className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[12px] text-fg-muted">
      {parts}
    </div>
  )
}
