/**
 * Jarvis's decision cards (.ai/04-ui.md § Jarvis, *Needs you*): what an
 * agent waits on, answered with one tap where Caprock may type into it
 * (rule 7: sessions it started, on a device that controls).
 *
 * - A question with its options: one button each, the agent's recommended
 *   one first with a star; *Something else…* types a free answer. Pressed
 *   through POST /v1/jarvis/answer, which presses that option in the
 *   agent's own dialog.
 * - A permission or a plan: the session's permission prompt (usePermission,
 *   the path every other screen answers it by), as one-tap buttons. A plan
 *   to approve is Claude Code's ExitPlanMode prompt.
 * - A question that cannot be pressed — several questions in one dialog,
 *   several answers to pick, no options read — keeps the reply box through
 *   the agent's queue.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, errText, type JarvisNeed, type PermissionChoice } from '@/lib/api'
import { commandGist } from '@/lib/cockpit'
import { shownOptions } from '@/lib/jarvis'
import { PermissionPrompt, usePermission } from './PermissionPrompt'

export const smallBtn = 'h-[26px] shrink-0 rounded-[7px] border border-border px-2.5 text-[12px] text-fg hover:bg-panel-2 disabled:opacity-50'
const optBtn = 'grid min-h-[34px] min-w-0 max-w-full content-center gap-0.5 rounded-[8px] border px-3 py-1.5 text-left text-[13px] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'

/** What the card says once answered: "✓ Answered “R2 bucket”. Sent to the agent; it carries on." */
export function answeredText(what: string): string {
  return `✓ ${what}. Sent to the agent; it carries on.`
}

/** The reason an answer did not go, in plain words. */
function answerError(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return 'That question is no longer on the agent’s screen — answered in the terminal, or it moved on.'
  if (e instanceof ApiError && e.status === 403) return 'Caprock did not start this session, so it will not type into it. Answer it in its own terminal.'
  return errText(e)
}

/** A question's options as one-tap buttons, and a free answer. */
export function OptionButtons({ need, onAnswered, onChanged }: { need: JarvisNeed; onAnswered: (text: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const press = async (answer: { option: number } | { text: string }, said: string) => {
    setBusy(true); setError('')
    try {
      await api.jarvisAnswer(need.session_id, answer)
      onAnswered(answeredText(`Answered “${said}”`))
      onChanged()
    } catch (e) {
      setError(answerError(e))
      if (e instanceof ApiError && e.status === 409) onChanged()
    } finally { setBusy(false) }
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <div role="group" aria-label="Answers" className="flex min-w-0 flex-wrap gap-1.5">
        {shownOptions(need.options).map((o) => (
          <button key={o.index} type="button" disabled={busy} data-jarvis-option={o.index} data-recommended={o.recommended ? 'true' : undefined}
            onClick={() => void press({ option: o.index }, o.label)}
            title={o.recommended ? 'The agent recommends this one' : undefined}
            className={`${optBtn} ${o.recommended ? 'border-accent bg-accent/10 text-fg hover:bg-accent/20' : 'border-border bg-panel text-fg hover:bg-panel-2'}`}>
            <span className="font-medium">{o.recommended && <span aria-label="Recommended" className="mr-1 text-accent">★</span>}{o.label}</span>
            {o.description && <span className="text-[12px] text-fg-muted">{o.description}</span>}
          </button>
        ))}
        {!typing && (
          <button type="button" disabled={busy} onClick={() => setTyping(true)} className={`${optBtn} border-dashed border-border bg-panel text-fg-muted hover:text-fg`}>
            <span className="font-medium">Something else…</span>
            <span className="text-[12px]">Type your answer</span>
          </button>
        )}
      </div>
      {typing && (
        <form className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t) void press({ text: t }, t) }}>
          <input value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Your answer" placeholder="Your answer"
            onKeyDown={(e) => { if (e.key === 'Escape') { setTyping(false); setText('') } }}
            className="h-[30px] min-w-0 rounded-[7px] border border-border bg-bg px-2 text-[13px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none" />
          <button type="submit" disabled={busy || !text.trim()} className={`${smallBtn} h-[30px] border-accent/60 text-accent hover:bg-accent/10`}>Answer</button>
        </form>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

/**
 * A permission prompt, or a plan to approve, as one-tap buttons. Several
 * prompts at once keep the permission card's own list, answered in the
 * terminal (ADR-035): which one is in front is unknown.
 */
export function PermissionButtons({ sessionId, onAnswered, onChanged, onOpen, fallback, onPlan }: {
  sessionId: string
  /** Told whether the prompt on screen is a plan to approve, so the card can say so. */
  onPlan?: (plan: boolean) => void
  onAnswered: (text: string) => void
  onChanged: () => void
  onOpen: () => void
  /** What to draw while no prompt is read (none yet, or none any more). */
  fallback?: ReactNode
}) {
  const [prompt, setPrompt] = usePermission(sessionId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [whole, setWhole] = useState(false)
  const isPlan = prompt?.tool === 'ExitPlanMode'
  useEffect(() => { onPlan?.(isPlan) }, [isPlan, onPlan])
  if (!prompt) return <>{fallback ?? null}</>
  if ((prompt.waiting?.length ?? 0) > 1) return <PermissionPrompt sessionId={sessionId} keys={false} pageKeys={false} onOpenTerminal={onOpen} />
  const plan = prompt.tool === 'ExitPlanMode'
  const answer = async (choice: PermissionChoice, said: string) => {
    setBusy(true); setError('')
    try {
      await api.answerPermission(sessionId, prompt.id, choice)
      setPrompt(null)
      onAnswered(answeredText(said))
      onChanged()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setPrompt(null); onChanged() }
      setError(answerError(e))
    } finally { setBusy(false) }
  }
  const { gist } = commandGist(prompt.detail)
  const long = prompt.detail.length > 240 || prompt.detail.split('\n').length > 4
  return (
    <div data-jarvis-permission={plan ? 'plan' : 'tool'} className="grid grid-cols-[minmax(0,1fr)] gap-1.5 [overflow-wrap:anywhere]">
      {plan ? (
        <p className={`whitespace-pre-line text-[13px] text-fg ${whole ? '' : 'line-clamp-3'}`}>{prompt.detail}</p>
      ) : (
        <p className="text-[13px] text-fg">
          {prompt.agent_id ? 'A subagent wants' : 'Wants'} to {/^(Bash|PowerShell)$/.test(prompt.tool) ? 'run' : `use ${prompt.tool}`}:{' '}
          <code className="mono rounded-[4px] bg-panel-2 px-1 py-px text-[12px]" title={prompt.detail}>{gist || prompt.detail}</code>
        </p>
      )}
      <div role="group" aria-label={plan ? 'Plan' : 'Permission'} className="flex min-w-0 flex-wrap gap-1.5">
        {plan ? (
          <>
            <button type="button" disabled={busy} onClick={() => void answer('allow', 'Approved the plan')} className={`${optBtn} border-accent bg-accent/10 font-medium text-fg hover:bg-accent/20`}>
              <span><span aria-hidden className="mr-1 text-accent">★</span>Approve and start</span>
            </button>
            <button type="button" disabled={busy} onClick={() => void answer('deny', 'Asked it to keep planning')} className={`${optBtn} border-border bg-panel text-fg hover:bg-panel-2`}>Keep planning</button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void answer('allow', 'Allowed')} className={`${optBtn} border-transparent bg-ok font-medium text-bg hover:brightness-110`}>Allow</button>
            {prompt.always && (
              <button type="button" disabled={busy} onClick={() => void answer('always', `Allowed: ${prompt.always}`)} className={`${optBtn} border-border bg-panel text-fg hover:bg-panel-2`}>{prompt.always}</button>
            )}
            <button type="button" disabled={busy} onClick={() => void answer('deny', 'Denied')} className={`${optBtn} border-border bg-panel text-fg hover:border-danger hover:text-danger`}>Deny</button>
          </>
        )}
      </div>
      {(plan || long) && (
        <button type="button" onClick={() => (plan ? setWhole((v) => !v) : onOpen())} className="justify-self-start text-[12px] text-fg-muted hover:text-fg hover:underline">
          {plan ? (whole ? 'Show less' : 'Read the whole plan') : 'See the whole command in the terminal'}
        </button>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

/** An inline message to an agent, through its queue: sent when it is idle (api.queueSend). */
export function ReplyBox({ sessionId, placeholder, onSent, onClose, autoFocus, quick }: { sessionId: string; placeholder: string; onSent?: () => void; onClose?: () => void; autoFocus?: boolean
  /** A one-press message beside Send ("continue" after an error stop). */
  quick?: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const send = async (said?: string) => {
    const t = (said ?? text).trim()
    if (!t || busy) return
    setBusy(true); setNote('')
    try {
      await api.queueSend(sessionId, t)
      setText('')
      setNote('Sent: it goes in when the agent is ready.')
      onSent?.()
    } catch (e) {
      setNote(errText(e))
    } finally { setBusy(false) }
  }
  return (
    <form data-jarvis-reply className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5" onSubmit={(e) => { e.preventDefault(); void send() }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="Message" autoFocus={autoFocus}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose?.() }}
        className="h-[28px] min-w-0 rounded-[7px] border border-border bg-bg px-2 text-[13px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none" />
      <span className="flex gap-1.5">
        <button type="submit" disabled={busy || !text.trim()} className={`${smallBtn} border-accent/60 text-accent hover:bg-accent/10`}>Send</button>
        {quick && <button type="button" disabled={busy} onClick={() => void send(quick)} title={`Send “${quick}”`} className={smallBtn}>{quick[0]!.toUpperCase() + quick.slice(1)}</button>}
      </span>
      {note && <p className="col-span-2 text-[11.5px] text-fg-muted">{note}</p>}
    </form>
  )
}
