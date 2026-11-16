/**
 * Jarvis — every agent on the machine on one screen, and acting on them
 * from it (.ai/04-ui.md § Jarvis; owner, 2026-11-15, translated from
 * Russian: "an orchestrator of the other agents — not switching between
 * projects, everything in one place, and from there you can conveniently
 * control it").
 *
 * Top to bottom: one compact line (the name, the project chips with their
 * mute ×, the brain's state, the day's figures), the brain's first-use card
 * until one is chosen, the summary, Needs you as decision cards (one tap
 * where Caprock may answer), Handled for you (what Caprock did on its own
 * today), Working now, Finished, the chat with Jarvis, and its field pinned
 * at the bottom with hold to talk (V2; the digest is GET /v1/jarvis,
 * lib/useJarvis.ts).
 *
 * Every action goes through a path the app already uses: the permission
 * prompt (usePermission, api.answerPermission), the agent queue
 * (api.queueSend), the task approvals (api.approve, as Tasks does), the stop
 * signal (api.signal kill, as StopConfirm does), continue-on for Undo — or
 * the contract's own (POST /v1/jarvis/answer, /say). A session Caprock did
 * not start offers Open only: Caprock never types into a process it did not
 * start (rule 7).
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errText, type JarvisAgent, type JarvisDigest, type JarvisNeed } from '@/lib/api'
import { fmtAgo, fmtUSD } from '@/lib/format'
import { href, navigate } from '@/lib/router'
import { useNow } from '@/lib/useNow'
import { useJarvis } from '@/lib/useJarvis'
import { useCanControl } from '@/lib/useCanControl'
import { PipelineHostContext } from '@/lib/pipelineHost'
import {
  brainCardHidden, byProject, handledLine, headlineParts, hideBrainCard, isHidden, isStopped, LATER_MS, loadDismissed, loadLater, loadMuted,
  needKey, needPrint, needWord, NOT_OURS_TITLE, OLD_NEED_MS, pruneHidden, saveDismissed, saveLater, saveMuted, shownOf, summaryLine, tapAnswerable,
  type DismissedMap, type LaterMap,
} from '@/lib/jarvis'
import { AgentGlyph } from '@/components/AgentMarks'
import { OptionButtons, PermissionButtons, ReplyBox, smallBtn } from '@/components/JarvisCards'
import { JarvisHandled } from '@/components/JarvisHandled'
import { JarvisChat } from '@/components/JarvisChat'
import { BrainChooser, BrainFirstUse, BrainStatus, settingOf } from '@/components/JarvisBrain'
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

/** How long an answered card says so in place. */
export const ANSWERED_MS = 5000

/** A line under Needs you after Later, with its Undo, for a few seconds. */
interface Notice { key: string; text: string }
export const NOTICE_MS = 6000

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
  const { needs: allNeeds, agents } = shownOf(digest, muted, only || undefined)

  // Later (an hour) and Dismiss (until the need changes), per browser.
  const [later, setLater] = useState<LaterMap>(loadLater)
  const [dismissed, setDismissed] = useState<DismissedMap>(loadDismissed)
  const [showHidden, setShowHidden] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const clock = Math.max(now, Date.now())
  // What no longer applies is forgotten: a need answered, a Later run out.
  useEffect(() => {
    const p = pruneHidden(digest.needs_you ?? [], later, dismissed, clock)
    if (Object.keys(p.later).length !== Object.keys(later).length) { setLater(p.later); saveLater(p.later) }
    if (Object.keys(p.dismissed).length !== Object.keys(dismissed).length) { setDismissed(p.dismissed); saveDismissed(p.dismissed) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digest])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])
  const hide = (n: JarvisNeed, how: 'later' | 'dismiss') => {
    const k = needKey(n)
    if (how === 'later') {
      const next = { ...later, [k]: clock + LATER_MS }
      setLater(next); saveLater(next)
      setNotice({ key: k, text: 'Hidden for an hour. It comes back if it is still waiting.' })
    } else {
      const next = { ...dismissed, [k]: needPrint(n) }
      setDismissed(next); saveDismissed(next)
      setNotice({ key: k, text: 'Dismissed. It comes back if the agent asks something new.' })
    }
  }
  const unhide = (k: string) => {
    const l = { ...later }; delete l[k]
    const d = { ...dismissed }; delete d[k]
    setLater(l); saveLater(l); setDismissed(d); saveDismissed(d)
    setNotice(null)
  }
  const hiddenNeeds = allNeeds.filter((n) => isHidden(n, later, dismissed, clock))
  const needs = allNeeds.filter((n) => !isHidden(n, later, dismissed, clock))
  const listed = showHidden ? allNeeds : needs

  // An answered card says so in its place for ANSWERED_MS, even once the
  // digest has dropped it (the agent moved on at once): otherwise the
  // answer's confirmation would vanish with the row.
  const [answered, setAnswered] = useState<Map<string, { need: JarvisNeed; text: string; at: number }>>(() => new Map())
  const markAnswered = useCallback((n: JarvisNeed, text: string) => {
    setAnswered((m) => new Map(m).set(needKey(n), { need: n, text, at: Date.now() }))
  }, [])
  useEffect(() => {
    if (answered.size === 0) return
    const next = Math.min(...[...answered.values()].map((a) => a.at)) + ANSWERED_MS - Date.now()
    const t = setTimeout(() => setAnswered((m) => {
      const n = new Map(m)
      for (const [k, a] of n) if (Date.now() - a.at >= ANSWERED_MS) n.delete(k)
      return n
    }), Math.max(0, next))
    return () => clearTimeout(t)
  }, [answered])
  const order = useRef<string[]>([])
  const rows = listed.slice()
  for (const a of answered.values()) {
    const k = needKey(a.need)
    if (rows.some((r) => needKey(r) === k)) continue
    const i = order.current.indexOf(k)
    rows.splice(i < 0 ? rows.length : Math.min(i, rows.length), 0, a.need)
  }
  useEffect(() => { order.current = rows.map(needKey) })

  // Agents done and untouched for half an hour fold into one line, as Work
  // folds them: on the owner's machine they were 13 of 16 live rows.
  const [showIdle, setShowIdle] = useState(false)
  const active = agents.filter((a) => a.state !== 'idle')
  const idle = agents.filter((a) => a.state === 'idle')
  const done = idle.filter((a) => !dozingAgent(a, now))
  const dozing = idle.length - done.length
  // The first answer's time: rows waiting since before it were already there.
  const [firstAt] = useState(() => digest.generated_at || Date.now())
  const leaving = useLeaving(rows, needKey, needSince, firstAt)
  const nothing = (digest.agents ?? []).length === 0 && (digest.needs_you ?? []).length === 0
  const changed = onChanged ?? noop

  // The brain: its first-use card until chosen (Not now hides it a week), the chooser on demand.
  const [chooser, setChooser] = useState(false)
  const [brainLater, setBrainLater] = useState(() => brainCardHidden(Date.now()))
  const brain = digest.brain
  const firstUse = brain?.state === 'unchosen' && !brainLater && !chooser && canControl

  return (
    <div data-jarvis className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <JarvisHead digest={digest} muted={muted} only={only} onOnly={setOnly} onToggleMute={toggleMute}
        brain={canControl ? <BrainStatus brain={brain} onOpen={() => setChooser((v) => !v)} /> : null} />

      {chooser && (
        <section aria-label="Jarvis’s brain" className="rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2.5">
          <h2 className="mb-1.5 text-[13px] font-semibold text-fg">Jarvis runs on</h2>
          <BrainChooser current={settingOf(brain)} onSaved={() => { changed() }} onClose={() => setChooser(false)} />
        </section>
      )}
      {firstUse && (
        <BrainFirstUse onChoose={() => setChooser(true)} onSaved={changed}
          onNotNow={() => { hideBrainCard(Date.now()); setBrainLater(true) }} />
      )}

      {nothing ? (
        <p data-jarvis-empty className="px-1 py-6 text-[13px] text-fg-muted">Nothing running. Say what to start below, or <span className="mono text-fg">@project what to do</span>.</p>
      ) : (
        <>
          <p data-jarvis-summary className="px-1 text-[14px] leading-snug text-fg">{summaryLine(needs.length, active, dozing + done.length)}{handledLine(digest.handled_today)}</p>
          <section aria-label="Needs you" data-jarvis-needs className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
            <h2 className="flex items-baseline gap-2 px-1 text-[12px] font-medium text-fg-muted">
              <span>Needs you <span className="num text-fg-faint">· {needs.length}</span></span>
              {hiddenNeeds.length > 0 && (
                <button type="button" data-jarvis-hidden-toggle aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)} className="font-normal text-fg-faint hover:text-fg">
                  {showHidden ? 'Hide' : 'Show'} {hiddenNeeds.length} hidden
                </button>
              )}
            </h2>
            {notice && (
              <p role="status" data-jarvis-notice className="jarvis-in flex min-w-0 flex-wrap items-baseline gap-x-2 rounded-[var(--radius-panel)] bg-warn/10 px-2.5 py-1.5 text-[12.5px] text-warn">
                <span className="min-w-0">{notice.text}</span>
                <button type="button" onClick={() => unhide(notice.key)} className="text-accent hover:underline">Undo</button>
              </p>
            )}
            {leaving.length === 0 ? (
              <p data-jarvis-needs-none className="rounded-[var(--radius-panel)] border border-border bg-panel px-2.5 py-2 text-[13px] text-fg-muted">
                <span className="text-ok">✓</span> Nothing needs you right now. A permission, a question or a stuck agent shows up here first.
              </p>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                {leaving.map(({ item, gone, fresh }) => (
                  <NeedRow key={needKey(item)} need={item} gone={gone} fresh={fresh} now={now} canControl={canControl} onOpen={open} onChanged={changed}
                    hidden={isHidden(item, later, dismissed, clock)} onHide={hide} onUnhide={() => unhide(needKey(item))}
                    answered={answered.get(needKey(item))?.text ?? ''} onAnswered={markAnswered} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <JarvisHandled count={digest.handled_today} now={now} canControl={canControl} onOpen={open} onChanged={changed} />

      {!nothing && (
        <>
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

      <JarvisChat digest={digest} only={only} muted={muted} canControl={canControl} onOpen={open} onChanged={changed} />
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

/** The one compact line: the name, the chips, the brain, the day's figures. */
function JarvisHead({ digest, muted, only, onOnly, onToggleMute, brain }: {
  digest: JarvisDigest
  muted: ReadonlySet<string>
  only: string
  onOnly: (p: string) => void
  onToggleMute: (p: string) => void
  brain: ReactNode
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
      {brain}
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

/**
 * One thing waiting on you, as a card: what it is and where, how long it has
 * waited, the question, and the answer one tap away where Caprock may type
 * (JarvisCards). Later hides it an hour, Dismiss until it changes; a hidden
 * one shown again offers Show again. Once answered it says so in place
 * until the digest drops it.
 */
function NeedRow({ need, gone, fresh, now, canControl, hidden, onOpen, onChanged, onHide, onUnhide, answered, onAnswered }: {
  need: JarvisNeed
  /** "✓ Answered …" once a tap answered it; '' before. */
  answered: string
  onAnswered: (n: JarvisNeed, text: string) => void
  gone: boolean
  fresh: boolean
  now: number
  canControl: boolean
  hidden: boolean
  onOpen: (id: string) => void
  onChanged: () => void
  onHide: (n: JarvisNeed, how: 'later' | 'dismiss') => void
  onUnhide: () => void
}) {
  const ours = need.controllable && canControl
  // A task runner's approval names no session: it opens Tasks.
  const task = need.kind === 'approval' && !need.session_id
  // A turn stopped on an error ("Stopped: rate limit") arrives as a question;
  // what it wants is to carry on.
  const stopped = isStopped(need)
  const old = now - need.since > OLD_NEED_MS
  const tap = tapAnswerable(need, canControl)
  const setAnswered = (text: string) => onAnswered(need, text)
  // A plan to approve arrives as a question; its prompt says what it is.
  const [plan, setPlan] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn(); onChanged() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  let actions: ReactNode = null
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
  } else if (need.kind === 'loop') {
    actions = (
      <>
        <button type="button" onClick={() => onOpen(need.session_id)} className={smallBtn}>Open</button>
        <StopButton sessionId={need.session_id} onStopped={onChanged} />
      </>
    )
  }
  // The question itself leads a question's card, in its own words.
  // With its options as buttons the question alone leads; the detail's
  // option list would say them twice.
  const asks = need.kind === 'question' && !stopped && tap ? need.title
    : need.kind === 'question' && !stopped && need.detail && need.detail !== need.title ? need.detail : ''
  const detail = !asks && need.detail && need.detail !== need.title ? need.detail : ''
  const detailLine = detail ? <p className="line-clamp-2 min-w-0 whitespace-pre-line text-[12px] text-fg-muted [overflow-wrap:anywhere]" title={detail}>{detail}</p> : null
  const terminal = ours && need.session_id ? () => onOpen(need.session_id) : undefined
  const more = need.more_questions ?? 0
  const canDismiss = need.kind !== 'permission' && need.kind !== 'approval'

  let body: ReactNode = null
  if (answered) {
    body = <p data-jarvis-answered role="status" className="rounded-[8px] bg-ok/10 px-2.5 py-1.5 text-[13px] text-ok">{answered}</p>
  } else if (!ours) {
    body = <>{detailLine}{!task && <p className="text-[11.5px] text-fg-faint">Started outside Caprock: answer it in its own terminal.</p>}</>
  } else if (need.kind === 'permission') {
    body = (
      <PermissionButtons sessionId={need.session_id} onAnswered={setAnswered} onChanged={onChanged} onOpen={() => onOpen(need.session_id)}
        fallback={detailLine} />
    )
  } else if (need.kind === 'question' && tap) {
    body = <OptionButtons need={need} onAnswered={setAnswered} onChanged={onChanged} />
  } else if (need.kind === 'question') {
    // No tap: several questions, several answers to pick, or no options
    // read. A plan to approve arrives here too: it is a permission prompt.
    body = (
      <PermissionButtons sessionId={need.session_id} onAnswered={setAnswered} onChanged={onChanged} onOpen={() => onOpen(need.session_id)} onPlan={setPlan}
        fallback={(
          <>
            {detailLine}
            {more > 0 && <p className="text-[12px] text-fg-muted">This dialog asks {more} more {more === 1 ? 'question' : 'questions'}: answer it in the terminal, or reply here once it is done.</p>}
            {more === 0 && (need.options?.length ?? 0) > 0 && !need.answerable && <p className="text-[12px] text-fg-muted">This one takes more than a tap (several answers can be picked): answer it in the terminal.</p>}
            <ReplyBox sessionId={need.session_id} placeholder={stopped ? 'Message — or press Continue' : 'Reply — sent when it is ready'} onSent={onChanged}
              quick={stopped ? 'continue' : undefined} />
          </>
        )} />
    )
  } else {
    body = detailLine
  }

  return (
    <li data-jarvis-need={need.kind} data-session={need.session_id} data-controllable={ours ? 'true' : 'false'} data-answerable={tap ? 'true' : undefined}
      data-hidden={hidden ? 'true' : undefined}
      data-old={old ? 'true' : undefined} title={old ? 'Waiting for over 12 hours' : undefined}
      className={`jarvis-row-wrap ${gone ? 'jarvis-gone' : ''} ${fresh ? 'jarvis-in' : ''} ${old || hidden ? 'opacity-60 hover:opacity-100 focus-within:opacity-100' : ''}`} aria-hidden={gone || undefined}>
      <div className="min-h-0 overflow-hidden">
        <div className={`grid grid-cols-[minmax(0,1fr)] gap-2 rounded-[var(--radius-panel)] border border-border border-l-[3px] bg-panel px-3 py-2 ${need.kind === 'loop' ? 'border-l-danger' : 'border-l-warn'}`}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span className={`shrink-0 text-[12px] font-semibold ${need.kind === 'loop' ? 'text-danger' : 'text-warn'}`}>{plan ? 'Plan to approve' : needWord(need.kind)}</span>
            <span className="min-w-0 flex-[1_1_12rem]">
              {task ? (
                <a href={href({ name: 'tasks' })} title="Open Tasks" className="block min-w-0 truncate text-fg hover:underline">{need.title}</a>
              ) : <OpenTitle project={need.project} title={asks ? '' : need.title} id={need.session_id} onOpen={onOpen} />}
            </span>
            <span className="num shrink-0 text-[11.5px] text-fg-faint" title="Waiting since">{fmtAgo(need.since, now)}</span>
            {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
          </div>
          {asks && !answered && <p data-jarvis-question className="min-w-0 whitespace-pre-line text-[14px] font-semibold leading-snug text-fg [overflow-wrap:anywhere]">{asks}</p>}
          {body}
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          {!answered && !gone && (
            <div data-jarvis-foot className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-fg-muted">
              {terminal && (need.kind === 'permission' || need.kind === 'question') && <button type="button" onClick={terminal} className="hover:text-fg">Open terminal</button>}
              {hidden ? (
                <button type="button" onClick={onUnhide} className="hover:text-fg">Show again</button>
              ) : (
                <>
                  <button type="button" onClick={() => onHide(need, 'later')} title="Hide it for an hour; it comes back if it is still waiting" className="hover:text-fg">Later</button>
                  {canDismiss && <button type="button" onClick={() => onHide(need, 'dismiss')} title="Hide it until the agent asks something new" className="hover:text-fg">Dismiss</button>}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
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
      className={`${smallBtn} ${armed ? 'border-danger bg-danger text-white hover:brightness-110' : 'hover:border-danger hover:text-danger'}`}>
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
