/**
 * Jarvis — every agent on the machine on one screen, and acting on them
 * from it (.ai/04-ui.md § Jarvis; owner, 2026-11-15, translated from
 * Russian: "an orchestrator of the other agents — not switching between
 * projects, everything in one place, and from there you can conveniently
 * control it").
 *
 * Top to bottom: one compact line (the name, the project chips with their
 * mute ×, the day's figures), Needs you (each row with its action right
 * there), Agents (one dense row each), and the command line pinned at the
 * bottom (`@project text`). V1 has no model: it draws the daemon's
 * deterministic digest (GET /v1/jarvis, lib/useJarvis.ts).
 *
 * Every action goes through a path the app already uses: the permission
 * card (components/PermissionPrompt), the agent queue (api.queueSend), the
 * task approvals (api.approve, as Tasks does), the stop signal
 * (api.signal kill, as StopConfirm does) and the start request SpawnDialog
 * builds (api.spawn). A session Caprock did not start offers Open only:
 * Caprock never types into a process it did not start (rule 7).
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, errText, type JarvisAgent, type JarvisDigest, type JarvisNeed } from '@/lib/api'
import { fmtAgo, fmtUSD } from '@/lib/format'
import { href, navigate } from '@/lib/router'
import { useNow } from '@/lib/useNow'
import { useJarvis } from '@/lib/useJarvis'
import { useCanControl } from '@/lib/useCanControl'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { byProject, headlineParts, isStopped, loadMuted, needKey, needWord, NOT_OURS_TITLE, OLD_NEED_MS, parseCommand, routeCommand, saveMuted, shownOf, suggest, summaryLine } from '@/lib/jarvis'
import { projectsApi } from '@/lib/projects'
import { PermissionPrompt } from '@/components/PermissionPrompt'
import { AgentGlyph } from '@/components/AgentMarks'
import { useAgentChoice, useSpawnableAgents } from '@/components/AgentPicker'
import { useBypassConsent } from '@/components/BypassConsent'
import { useInitialMode } from '@/lib/permissionMode'
import { DEFAULT_MODE } from '@/components/SpawnDialog'
import { Empty, Skeleton } from '@/components/ui'

export interface JarvisScreenProps {
  /** The app brings a session's tab forward (PipelineHost); absent, the session's terminal page opens. */
  onOpenSession?: (id: string) => void
}

export function JarvisScreen(props: JarvisScreenProps) {
  const host = useContext(PipelineHostContext)
  const read = useJarvis()
  const now = useNow(15_000)
  if (!read.data) {
    return read.error ? <Empty title="Cannot reach the daemon">{read.error.message}</Empty>
      : <Skeleton rows={4} className="rounded-[var(--radius-panel)] border border-border bg-panel" />
  }
  return <JarvisView digest={read.data} now={now} onOpenSession={props.onOpenSession ?? host.onOpenSession} onChanged={read.refresh} />
}

/** The screen from one digest: what the tests and the preview mount. */
export function JarvisView({ digest, now, onOpenSession, onChanged }: {
  digest: JarvisDigest
  now: number
  onOpenSession?: (id: string) => void
  /** Ask again at once, after an action moved something. */
  onChanged?: () => void
}) {
  const [muted, setMuted] = useState<Set<string>>(loadMuted)
  const [only, setOnly] = useState<string>('')
  const toggleMute = (p: string) => {
    setMuted((cur) => {
      const next = new Set(cur)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      saveMuted(next)
      return next
    })
    if (only === p) setOnly('')
  }
  const open = useCallback((id: string) => {
    if (onOpenSession) onOpenSession(id)
    else navigate({ name: 'session', id, tab: 'terminal' })
  }, [onOpenSession])
  const canControl = useCanControl()
  const { needs, agents } = shownOf(digest, muted, only || undefined)
  // Agents done and untouched for half an hour fold into one line, as Work
  // folds them: on the owner's machine they were 13 of 16 live rows.
  const [showIdle, setShowIdle] = useState(false)
  const active = agents.filter((a) => a.state !== 'idle')
  const idle = agents.filter((a) => a.state === 'idle')
  const done = idle.filter((a) => !dozingAgent(a, now))
  const dozing = idle.length - done.length
  // The first answer's time: rows waiting since before it were already there.
  const [firstAt] = useState(() => digest.generated_at || Date.now())
  const leaving = useLeaving(needs, needKey, needSince, firstAt)
  const nothing = (digest.agents ?? []).length === 0 && (digest.needs_you ?? []).length === 0
  const changed = onChanged ?? noop

  return (
    <div data-jarvis className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <JarvisHead digest={digest} muted={muted} only={only} onOnly={setOnly} onToggleMute={toggleMute} />

      {nothing ? (
        <p data-jarvis-empty className="px-1 py-6 text-[13px] text-fg-muted">Nothing running. Start something: <span className="mono text-fg">@project what to do</span></p>
      ) : (
        <>
          <p data-jarvis-summary className="px-1 text-[14px] leading-snug text-fg">{summaryLine(needs.length, active, dozing + done.length)}</p>
          <section aria-label="Needs you" data-jarvis-needs className="grid grid-cols-[minmax(0,1fr)] gap-1">
            <h2 className="px-1 text-[12px] font-medium text-fg-muted">Needs you <span className="num text-fg-faint">· {needs.length}</span></h2>
            {leaving.length === 0 ? (
              <p data-jarvis-needs-none className="rounded-[var(--radius-panel)] border border-border bg-panel px-2.5 py-2 text-[13px] text-fg-muted">
                <span className="text-ok">✓</span> Nothing needs you right now. A permission, a question or a stuck agent shows up here first.
              </p>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
                {leaving.map(({ item, gone, fresh }) => (
                  <NeedRow key={needKey(item)} need={item} gone={gone} fresh={fresh} now={now} canControl={canControl} onOpen={open} onChanged={changed} />
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Working now" data-jarvis-agents className="grid grid-cols-[minmax(0,1fr)] gap-1">
            <h2 className="px-1 text-[12px] font-medium text-fg-muted">Working now <span className="num text-fg-faint">· {active.length}</span></h2>
            {active.length === 0 ? (
              <p className="rounded-[var(--radius-panel)] border border-border bg-panel px-2.5 py-2 text-[13px] text-fg-muted">
                {muted.size > 0 || only ? 'No agent is working in the projects shown.' : 'No agent is working. Give one a task below.'}
              </p>
            ) : (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                {byProject(active).map(([project, list]) => (
                  <div key={project} data-jarvis-project={project} className="overflow-hidden rounded-[var(--radius-panel)] border border-border bg-panel">
                    <h3 className="flex items-baseline gap-2 border-b border-border px-2.5 py-1 text-[12.5px]">
                      <span className="font-semibold text-fg">{project}</span>
                      <span className="num text-fg-faint">{list.length} {list.length === 1 ? 'agent' : 'agents'}</span>
                    </h3>
                    <ul className="grid grid-cols-[minmax(0,1fr)]">
                      {list.map((a) => <AgentRow key={a.session_id} agent={a} now={now} canControl={canControl} onOpen={open} onChanged={changed} grouped />)}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
          {(done.length > 0 || dozing > 0) && (
            <section aria-label="Finished" data-jarvis-done className="grid grid-cols-[minmax(0,1fr)] gap-1">
              <h2 className="px-1 text-[12px] font-medium text-fg-muted">Finished, waiting for a next task <span className="num text-fg-faint">· {done.length + dozing}</span></h2>
              <ul className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-[var(--radius-panel)] border border-border bg-panel">
                {(showIdle ? idle : done).map((a) => <AgentRow key={a.session_id} agent={a} now={now} canControl={canControl} onOpen={open} onChanged={changed} />)}
                {dozing > 0 && (
                  <li className="px-2.5 py-1.5">
                    <button type="button" data-jarvis-idle-toggle onClick={() => setShowIdle((v) => !v)} aria-expanded={showIdle}
                      className="text-[12.5px] text-fg-muted hover:text-fg">
                      {showIdle ? 'Hide' : 'Show'} <span className="num">{dozing}</span> finished over 30 minutes ago
                    </button>
                  </li>
                )}
              </ul>
            </section>
          )}
        </>
      )}

      <CommandLine digest={digest} canControl={canControl} onOpen={open} onChanged={changed} />
    </div>
  )
}

function noop() {}

/** Idle at its prompt for over 30 minutes. */
const DOZE_MS = 30 * 60_000
export function dozingAgent(a: JarvisAgent, now: number): boolean {
  return a.state === 'idle' && now - a.last_activity_at > DOZE_MS
}
const needSince = (n: JarvisNeed) => n.since

/** The one compact line: the name, the chips, the day's figures. */
function JarvisHead({ digest, muted, only, onOnly, onToggleMute }: {
  digest: JarvisDigest
  muted: ReadonlySet<string>
  only: string
  onOnly: (p: string) => void
  onToggleMute: (p: string) => void
}) {
  const chip = 'inline-flex h-[24px] max-w-[14rem] items-center gap-1 rounded-full border px-2 text-[12px] transition-colors motion-reduce:transition-none'
  return (
    <header data-jarvis-head className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <h1 className="text-[15px] font-semibold text-fg">Jarvis</h1>
      <div role="group" aria-label="Projects" className="flex min-w-0 flex-wrap items-center gap-1">
        <button type="button" aria-pressed={!only} onClick={() => onOnly('')}
          className={`${chip} ${!only ? 'border-accent/70 bg-accent/10 text-fg' : 'border-border text-fg-muted hover:text-fg'}`}>All</button>
        {(digest.projects ?? []).map((p) => {
          const isMuted = muted.has(p.name)
          if (isMuted) {
            return (
              <button key={p.name} type="button" data-jarvis-chip={p.name} data-muted onClick={() => onToggleMute(p.name)}
                title={`${p.name} is muted: hidden everywhere on this screen. Click to bring it back.`}
                className={`${chip} border-dashed border-border text-fg-faint line-through hover:text-fg-muted`}>
                <span className="truncate">{p.name}</span>
              </button>
            )
          }
          const picked = only === p.name
          return (
            <span key={p.name} data-jarvis-chip={p.name} className={`${chip} pr-0.5 ${picked ? 'border-accent/70 bg-accent/10 text-fg' : 'border-border text-fg-muted'}`}>
              <button type="button" aria-pressed={picked} onClick={() => onOnly(picked ? '' : p.name)} title={picked ? 'Show every project' : `Show ${p.name} only`}
                className="flex min-w-0 items-center gap-1 hover:text-fg">
                {p.waiting > 0 && <span aria-label={`${p.waiting} waiting for you`} className="h-[6px] w-[6px] shrink-0 rounded-full bg-warn" />}
                <span className="truncate">{p.name}</span>
                {p.live > 0 && <span className="num text-fg-faint">{p.live}</span>}
              </button>
              <button type="button" aria-label={`Mute ${p.name}`} title={`Mute ${p.name}: hide it everywhere on this screen`} onClick={() => onToggleMute(p.name)}
                className="grid h-[18px] w-[18px] place-items-center rounded-full text-fg-faint hover:bg-panel-2 hover:text-fg">×</button>
            </span>
          )
        })}
      </div>
      <p data-jarvis-headline className="num ml-auto text-[12.5px] text-fg-muted">
        {headlineParts(digest.headline).map((p, i) => (
          <span key={p.text}>{i > 0 && <span className="text-fg-faint"> · </span>}<span className={p.tone === 'warn' ? 'text-warn' : p.tone === 'danger' ? 'text-danger' : undefined}>{p.text}</span></span>
        ))}
        <span className="text-fg-faint"> · </span><span className="text-fg" title="Today's agent spend at API list price, not a bill">{fmtUSD(digest.headline.cost_today_usd)}</span>
      </p>
    </header>
  )
}

/**
 * The rows, with those just gone kept LEAVE_MS so they collapse away rather
 * than vanish. A row is fresh — it slides in once — when it began waiting
 * after the screen's first answer, so opening the screen animates nothing.
 */
export const LEAVE_MS = 240
function useLeaving<T>(items: readonly T[], key: (t: T) => string, since: (t: T) => number, firstAt: number): { item: T; gone: boolean; fresh: boolean }[] {
  const [gone, setGone] = useState<Map<string, T>>(() => new Map())
  const prev = useRef<Map<string, T>>(new Map())
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const keys = items.map(key).join('\n')
  const current = useMemo(() => new Map(items.map((t) => [key(t), t])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys])
  useEffect(() => {
    const left = [...prev.current].filter(([k]) => !current.has(k))
    prev.current = current
    if (left.length === 0) return
    setGone((g) => { const n = new Map(g); left.forEach(([k, v]) => n.set(k, v)); return n })
    timers.current.push(setTimeout(() => setGone((g) => { const n = new Map(g); left.forEach(([k]) => n.delete(k)); return n }), LEAVE_MS))
  }, [current])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  const out = items.map((item) => ({ item, gone: false, fresh: since(item) > firstAt }))
  for (const [k, item] of gone) if (!current.has(k)) out.push({ item, gone: true, fresh: false })
  return out
}

/** A session's title as a link that opens it. */
function OpenTitle({ project, title, id, onOpen }: { project: string; title: string; id: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(id)} title={`Open ${title || project}`} className="flex min-w-0 max-w-full items-baseline gap-1.5 overflow-hidden text-left hover:underline">
      <span className="max-w-[14rem] shrink-0 truncate font-medium text-fg">{project}</span>
      <span className="min-w-0 truncate text-fg-muted">{title}</span>
    </button>
  )
}

const smallBtn = 'h-[26px] shrink-0 rounded-[7px] border border-border px-2.5 text-[12px] text-fg hover:bg-panel-2 disabled:opacity-50'

function NeedRow({ need, gone, fresh, now, canControl, onOpen, onChanged }: {
  need: JarvisNeed
  gone: boolean
  fresh: boolean
  now: number
  canControl: boolean
  onOpen: (id: string) => void
  onChanged: () => void
}) {
  const ours = need.controllable && canControl
  // A task runner's approval names no session: it opens Tasks.
  const task = need.kind === 'approval' && !need.session_id
  // A turn stopped on an error ("Stopped: rate limit") arrives as a question;
  // what it wants is to carry on.
  const stopped = isStopped(need)
  const old = now - need.since > OLD_NEED_MS
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn(); onChanged() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  let actions: ReactNode
  if (!ours && !task) {
    actions = <button type="button" title={NOT_OURS_TITLE} onClick={() => onOpen(need.session_id)} className={smallBtn}>Open terminal</button>
  } else if (need.kind === 'approval' && need.approval_id) {
    const id = need.approval_id
    actions = (
      <>
        <button type="button" disabled={busy} onClick={() => void act(() => api.approve(id, true))} title="Send it back to the worker to carry on" className={`${smallBtn} border-ok/50 text-ok hover:bg-ok/10`}>Approve</button>
        <button type="button" disabled={busy} onClick={() => void act(() => api.approve(id, false))} title="Stop it and mark it failed" className={`${smallBtn} border-danger/50 text-danger hover:bg-danger/10`}>Deny</button>
      </>
    )
  } else if (task) {
    actions = null
  } else if (need.kind === 'loop') {
    actions = (
      <>
        <button type="button" onClick={() => onOpen(need.session_id)} className={smallBtn}>Open</button>
        <StopButton sessionId={need.session_id} onStopped={onChanged} />
      </>
    )
  } else {
    actions = <button type="button" onClick={() => onOpen(need.session_id)} className={smallBtn}>Open</button>
  }
  return (
    <li data-jarvis-need={need.kind} data-session={need.session_id} data-controllable={ours ? 'true' : 'false'}
      data-old={old ? 'true' : undefined} title={old ? 'Waiting for over 12 hours' : undefined}
      className={`jarvis-row-wrap ${gone ? 'jarvis-gone' : ''} ${fresh ? 'jarvis-in' : ''} ${old ? 'opacity-60 hover:opacity-100 focus-within:opacity-100' : ''}`} aria-hidden={gone || undefined}>
      <div className="min-h-0 overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-[var(--radius-panel)] border border-border border-l-[3px] border-l-warn bg-panel px-2.5 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span className={`shrink-0 text-[12px] font-medium ${need.kind === 'loop' ? 'text-danger' : 'text-warn'}`}>{needWord(need.kind)}</span>
            <span className="min-w-0 flex-[1_1_12rem]">
              {task ? (
                <a href={href({ name: 'tasks' })} title="Open Tasks" className="block min-w-0 truncate text-fg hover:underline">{need.title}</a>
              ) : <OpenTitle project={need.project} title={need.title} id={need.session_id} onOpen={onOpen} />}
            </span>
            <span className="num shrink-0 text-[11.5px] text-fg-faint" title="Waiting since">{fmtAgo(need.since, now)}</span>
            <span className="flex shrink-0 items-center gap-1">{actions}</span>
          </div>
          {need.detail && need.detail !== need.title && <p className="line-clamp-2 min-w-0 whitespace-pre-line text-[12px] text-fg-muted [overflow-wrap:anywhere]" title={need.detail}>{need.detail}</p>}
          {!ours && <p className="text-[11.5px] text-fg-faint">Started outside Caprock: answer it in its own terminal.</p>}
          {ours && need.kind === 'permission' && <PermissionPrompt sessionId={need.session_id} keys={false} pageKeys={false} />}
          {ours && need.kind === 'question' && (
            <ReplyBox sessionId={need.session_id} placeholder={stopped ? 'Message — or press Continue' : 'Reply — sent when it is ready'} onSent={onChanged}
              quick={stopped ? 'continue' : undefined} />
          )}
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        </div>
      </div>
    </li>
  )
}

/** An inline message to an agent, through its queue: sent when it is idle (api.queueSend). */
function ReplyBox({ sessionId, placeholder, onSent, onClose, autoFocus, quick }: { sessionId: string; placeholder: string; onSent?: () => void; onClose?: () => void; autoFocus?: boolean
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

/** Stop, confirmed by a second press within a few seconds; ends the process as StopConfirm does (api.signal kill). */
export const STOP_ARM_MS = 4000
function StopButton({ sessionId, onStopped }: { sessionId: string; onStopped: () => void }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), STOP_ARM_MS)
    return () => clearTimeout(t)
  }, [armed])
  const press = async () => {
    if (!armed) { setArmed(true); return }
    setBusy(true); setError('')
    try { await api.signal(sessionId, 'kill'); setArmed(false); onStopped() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return (
    <button type="button" data-jarvis-stop disabled={busy} onClick={() => void press()}
      title={error || (armed ? 'Press again to stop: the process ends, the conversation is kept' : 'Stop the session (asks once more)')}
      className={`${smallBtn} ${armed ? 'border-danger bg-danger text-on-danger hover:brightness-110' : 'hover:border-danger hover:text-danger'}`}>
      {busy ? 'Stopping…' : armed ? 'Stop?' : 'Stop'}
    </button>
  )
}

const DOT: Record<JarvisAgent['state'], string> = {
  working: 'bg-ok jarvis-dot-working',
  waiting: 'bg-warn',
  idle: 'bg-fg-faint',
  stuck: 'bg-danger',
}

function AgentRow({ agent, now, canControl, onOpen, onChanged, grouped }: {
  agent: JarvisAgent
  /** Under its project's heading: the row leads with the title alone. */
  grouped?: boolean
  now: number
  canControl: boolean
  onOpen: (id: string) => void
  onChanged: () => void
}) {
  const ours = agent.controllable && canControl
  const [messaging, setMessaging] = useState(false)
  return (
    <li data-jarvis-agent={agent.session_id} data-state={agent.state} data-controllable={ours ? 'true' : 'false'}
      className="jarvis-row border-b border-border px-2.5 py-1.5 last:border-b-0 hover:bg-panel-2/60 focus-within:bg-panel-2/60">
      {/* One grid per row with fixed tracks from 900px, so every column lines
        * up down the list whether or not a row has a plan; below, it wraps. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] min-[900px]:grid min-[900px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_12rem_4rem_4.5rem_15rem]">
        <span className="flex min-w-0 flex-[1_1_16rem] items-center gap-2">
          <AgentGlyph agent={agent.agent} size={13} />
          <span aria-label={agent.state} title={agent.state} className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT[agent.state]}`} />
          {grouped ? (
            <button type="button" onClick={() => onOpen(agent.session_id)} title={`Open ${agent.title || agent.project}`}
              className="min-w-0 truncate text-left font-medium text-fg hover:underline">{agent.title || agent.project}</button>
          ) : <OpenTitle project={agent.project} title={agent.title} id={agent.session_id} onOpen={onOpen} />}
        </span>
        <span className="min-w-0 flex-[2_1_12rem] truncate text-[12.5px] text-fg-muted">
          <span key={agent.now} className="jarvis-swap" title={agent.now}>{agent.now || '—'}</span>
        </span>
        {agent.plan && agent.plan.total > 0 ? <PlanBar plan={agent.plan} /> : <span aria-hidden className="hidden min-[900px]:block" />}
        <span className="num shrink-0 text-right text-[12px] text-fg-muted" title="Today, at API list price, not a bill">{fmtUSD(agent.cost_today_usd)}</span>
        <span className="num w-[4.5rem] shrink-0 text-right text-[11.5px] text-fg-faint" title="Last activity">{fmtAgo(agent.last_activity_at, now)}</span>
        <span className="jarvis-actions flex shrink-0 items-center justify-end gap-1">
          {ours ? (
            <>
              <button type="button" aria-expanded={messaging} onClick={() => setMessaging((m) => !m)} className={smallBtn}>Message</button>
              <button type="button" onClick={() => onOpen(agent.session_id)} className={smallBtn}>Open terminal</button>
              <StopButton sessionId={agent.session_id} onStopped={onChanged} />
            </>
          ) : (
            <button type="button" title={NOT_OURS_TITLE} onClick={() => onOpen(agent.session_id)} className={smallBtn}>Open</button>
          )}
        </span>
      </div>
      {ours && messaging && (
        <div className="mt-1.5">
          <ReplyBox sessionId={agent.session_id} autoFocus placeholder={`Message ${agent.project} — sent when the agent is ready`} onSent={onChanged} onClose={() => setMessaging(false)} />
        </div>
      )}
    </li>
  )
}

/** Segments that fill as steps complete; one continuous bar past PLAN_SEGMENTS. */
export const PLAN_SEGMENTS = 12
function PlanBar({ plan }: { plan: NonNullable<JarvisAgent['plan']> }) {
  const done = Math.min(plan.done, plan.total)
  const label = `${done}/${plan.total}${plan.current ? ` · ${plan.current}` : ''}`
  return (
    <span data-jarvis-plan className="flex min-w-0 flex-[1_1_10rem] items-center gap-1.5" title={label}>
      <span aria-hidden className="flex h-[6px] w-[64px] shrink-0 gap-[2px]">
        {plan.total <= PLAN_SEGMENTS ? Array.from({ length: plan.total }, (_, i) => (
          <span key={i} className="relative flex-1 overflow-hidden rounded-[2px] bg-border-strong/60">
            <span data-filled={i < done ? 'true' : undefined} className="jarvis-seg absolute inset-0 bg-ok" />
          </span>
        )) : (
          <span className="relative flex-1 overflow-hidden rounded-[2px] bg-border-strong/60">
            <span className="jarvis-seg-run absolute inset-y-0 left-0 bg-ok" style={{ width: `${(done / plan.total) * 100}%` }} />
          </span>
        )}
      </span>
      <span className="num min-w-0 truncate text-[11.5px] text-fg-muted">{label}</span>
    </span>
  )
}

/** Where the command line's toast says it went. */
interface Sent { text: string; open?: string; error?: boolean }

/**
 * `@project text`: to the project's live agent Caprock started, through its
 * queue (the most recently active one when several, named in the toast);
 * with none, a new session in the project's folder with the text as its
 * task, started as the New agent sheet starts one (its agent and mode).
 */
function CommandLine({ digest, canControl, onOpen, onChanged }: { digest: JarvisDigest; canControl: boolean; onOpen: (id: string) => void; onChanged: () => void }) {
  const [line, setLine] = useState('')
  const [pick, setPick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)
  const [known, setKnown] = useState<{ name: string; root: string }[]>([])
  useEffect(() => {
    let alive = true
    projectsApi.list().then((ps) => { if (alive) setKnown(ps.map((p) => ({ name: p.name, root: p.root }))) }, () => {})
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!sent || sent.error) return
    const t = setTimeout(() => setSent(null), 8000)
    return () => clearTimeout(t)
  }, [sent])
  const names = useMemo(() => {
    const s = new Set<string>((digest.projects ?? []).map((p) => p.name))
    for (const a of digest.agents ?? []) s.add(a.project)
    for (const k of known) s.add(k.name)
    return [...s]
  }, [digest, known])
  const agents = useSpawnableAgents()
  const [agent] = useAgentChoice(agents)
  const [mode] = useInitialMode(DEFAULT_MODE)
  const consent = useBypassConsent(agent, mode)
  const options = suggest(line, names)
  const cmd = parseCommand(line, names)

  const complete = (name: string) => { setLine(`@${name} `); setPick(0) }
  const submit = async () => {
    if (busy) return
    if (cmd.kind === 'hint') { setSent({ text: cmd.text, error: true }); return }
    if (!canControl) { setSent({ text: 'This device only watches: it cannot send to agents.', error: true }); return }
    const route = routeCommand(digest, cmd.project)
    setBusy(true); setSent(null)
    try {
      if (route.kind === 'queue') {
        await api.queueSend(route.agent.session_id, cmd.text)
        const which = route.of > 1 ? ` — the most recently active of ${route.of}: ${route.agent.title || route.agent.session_id.slice(0, 8)}` : ''
        setSent({ text: `Sent to ${cmd.project}${which}. It goes in when the agent is ready.`, open: route.agent.session_id })
      } else {
        const dir = route.dir ?? known.find((k) => k.name === cmd.project)?.root
        if (!dir) { setSent({ text: `Caprock does not know ${cmd.project}'s folder yet: add it as a project first.`, error: true }); return }
        if (consent.needed) { setSent({ text: 'Your new sessions start in bypass, which needs a one-time consent on this computer: start this one from New agent.', error: true }); return }
        const req: Parameters<typeof api.spawn>[0] = { cwd: dir, prompt: cmd.text }
        if (agent !== 'claude') req.agent = agent
        if (mode) req.permission_mode = mode
        const { session_id } = await api.spawn(req)
        const why = route.skipped > 0 ? ' (the agent running there was not started by Caprock, so it was left alone)' : ''
        setSent({ text: `Started a new session in ${cmd.project}${why}.`, open: session_id })
      }
      setLine('')
      onChanged()
    } catch (e) {
      if (!consent.noteRefusal(e)) setSent({ text: errText(e), error: true })
      else setSent({ text: 'Bypass needs a one-time consent on this computer: start this one from New agent.', error: true })
    } finally { setBusy(false) }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (options.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
      return
    }
    if (options.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      complete(options[Math.min(pick, options.length - 1)]!)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() }
    if (e.key === 'Escape') { setLine(''); setSent(null) }
  }
  return (
    <div data-jarvis-command className="sticky bottom-0 z-10 -mx-1 grid grid-cols-[minmax(0,1fr)] gap-1 bg-bg px-1 pb-2 pt-1">
      {sent && (
        <p role="status" data-jarvis-toast className={`jarvis-in flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] ${sent.error ? 'text-warn' : 'text-fg-muted'}`}>
          <span className="min-w-0">{sent.text}</span>
          {sent.open && <button type="button" onClick={() => onOpen(sent.open!)} className="text-accent hover:underline">Open</button>}
        </p>
      )}
      <div className="relative">
        {options.length > 0 && (
          <ul role="listbox" aria-label="Projects" className="absolute bottom-full left-0 z-20 mb-1 max-h-[12rem] w-[16rem] max-w-full overflow-y-auto rounded-[8px] border border-border-strong bg-panel py-1 shadow-lg">
            {options.map((o, i) => (
              <li key={o} role="option" aria-selected={i === pick}>
                <button type="button" onMouseDown={(e) => { e.preventDefault(); complete(o) }}
                  className={`block w-full truncate px-2.5 py-1 text-left text-[12.5px] ${i === pick ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-panel-2'}`}>@{o}</button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex min-w-0 items-center gap-1.5 rounded-[8px] border border-border-strong bg-panel px-2 focus-within:border-accent">
          <span aria-hidden className="mono text-[13px] text-fg-faint">›</span>
          <input value={line} onChange={(e) => { setLine(e.target.value); setPick(0) }} onKeyDown={onKey} disabled={busy}
            aria-label="Command: @project, then what to do" placeholder="Give a task: @project what to do — it goes to that project's agent, or starts one"
            className="h-[34px] min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-fg-faint focus:outline-none" />
          <span className="hidden shrink-0 text-[11px] text-fg-faint sm:inline">{options.length > 0 ? '⇥ pick' : line.trim() && cmd.kind === 'hint' ? cmd.text : '↵ send'}</span>
        </div>
      </div>
    </div>
  )
}
