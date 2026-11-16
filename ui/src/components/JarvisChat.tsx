/**
 * The chat with Jarvis (.ai/04-ui.md § Jarvis, *Chat*): the thread — what you
 * said, where it went, what Jarvis answered, and "Done:" when an agent it
 * gave the work to finished — and the field pinned at the bottom, with hold
 * to talk beside it.
 *
 * A message goes to `@project` when it starts with one, else to the project
 * chip picked on top, else to the project worked in last; the field says
 * where before it is sent ("→ caprock"). POST /v1/jarvis/say routes it on the
 * daemon (deterministically, or through the brain); replies that take time
 * arrive as "jarvis" live frames. A daemon from before the chat (404) gets
 * the V1 routing right here: the project's agent's queue, or a new session.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api, ApiError, errText, type JarvisDigest, type JarvisMessage } from '@/lib/api'
import { live } from '@/lib/live'
import { keys, TALK_KEY } from '@/lib/appkeys'
import { chatTarget, clockTime, isDoneMessage, mergeMessages, routeCommand, suggest } from '@/lib/jarvis'
import { projectsApi } from '@/lib/projects'
import { speechWhere } from '@/lib/speech'
import { micOffered, useHoldToTalk } from '@/lib/useHoldToTalk'
import { useAgentChoice, useSpawnableAgents } from './AgentPicker'
import { useBypassConsent } from './BypassConsent'
import { useInitialMode } from '@/lib/permissionMode'
import { DEFAULT_MODE } from './SpawnDialog'

/** How many messages the thread shows before *Show earlier*. */
export const THREAD_SHOWN = 20

/** A message only this page has: sent and not yet confirmed, or failed, or the V1 routing's own reply. */
type Local = JarvisMessage & { failed?: string }

let localSeq = 0
/** Ids below zero are this page's own, never the daemon's. */
const localId = () => -(++localSeq)

export function JarvisChat({ digest, only, muted, canControl, onOpen, onChanged }: {
  digest: JarvisDigest
  only: string
  muted: ReadonlySet<string>
  canControl: boolean
  onOpen: (id: string) => void
  onChanged: () => void
}) {
  const [messages, setMessages] = useState<Local[]>([])
  // The daemon has no chat yet (404): the field routes as V1 did.
  const [legacy, setLegacy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [line, setLine] = useState('')
  const [pick, setPick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const [known, setKnown] = useState<{ name: string; root: string }[]>([])
  const lastSent = useRef<number | null>(null)
  const listEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    api.jarvisThread(100).then(
      (r) => { if (alive) setMessages((cur) => mergeMessages(cur, r.messages ?? [])) },
      (e) => { if (alive && e instanceof ApiError && (e.status === 404 || e.status === 405)) setLegacy(true) },
    )
    projectsApi.list().then((ps) => { if (alive) setKnown(ps.map((p) => ({ name: p.name, root: p.root }))) }, () => {})
    return () => { alive = false }
  }, [])
  useEffect(() => live.onFrame((f) => {
    if (f.type === 'jarvis' && f.data.op === 'thread') { const m = f.data.message; setMessages((cur) => mergeMessages(cur, [m])) }
  }), [])
  // A reply to what was just sent comes into view.
  useEffect(() => {
    if (lastSent.current === null) return
    listEnd.current?.scrollIntoView?.({ block: 'nearest' })
  }, [messages])
  useEffect(() => {
    if (!note || note.error) return
    const t = setTimeout(() => setNote(null), 8000)
    return () => clearTimeout(t)
  }, [note])

  const names = useMemo(() => {
    const s = new Set<string>((digest.projects ?? []).map((p) => p.name))
    for (const a of digest.agents ?? []) s.add(a.project)
    for (const k of known) s.add(k.name)
    return [...s].filter(Boolean)
  }, [digest, known])
  const options = suggest(line, names)
  const target = chatTarget(line, names, only, digest, muted)
  const atUnknown = /^@\S/.test(line.trim()) && target?.by !== 'mention'

  const agents = useSpawnableAgents()
  const [agent] = useAgentChoice(agents)
  const [mode] = useInitialMode(DEFAULT_MODE)
  const consent = useBypassConsent(agent, mode)

  /** V1's routing, for a daemon without the chat: the reply is this page's own. */
  const routeHere = useCallback(async (project: string, text: string): Promise<{ text: string; session?: string }> => {
    const route = routeCommand(digest, project)
    if (route.kind === 'queue') {
      await api.queueSend(route.agent.session_id, text)
      const which = route.of > 1 ? ` — the most recently active of ${route.of}: ${route.agent.title || route.agent.session_id.slice(0, 8)}` : ''
      return { text: `Sent to ${project}${which}. It goes in when the agent is ready.`, session: route.agent.session_id }
    }
    const dir = route.dir ?? known.find((k) => k.name === project)?.root
    if (!dir) return { text: `Caprock does not know ${project}’s folder yet: add it as a project first.` }
    if (consent.needed) return { text: 'Your new sessions start in bypass, which needs a one-time consent on this computer: start this one from New agent.' }
    const req: Parameters<typeof api.spawn>[0] = { cwd: dir, prompt: text }
    if (agent !== 'claude') req.agent = agent
    if (mode) req.permission_mode = mode
    try {
      const { session_id } = await api.spawn(req)
      const why = route.skipped > 0 ? ' (the agent running there was not started by Caprock, so it was left alone)' : ''
      return { text: `Started a new session in ${project}${why}.`, session: session_id }
    } catch (e) {
      if (consent.noteRefusal(e)) return { text: 'Bypass needs a one-time consent on this computer: start this one from New agent.' }
      throw e
    }
  }, [digest, known, consent, agent, mode])

  const send = useCallback(async (raw: string, via: 'text' | 'voice') => {
    const said = raw.trim()
    if (!said || busy) return
    const t = chatTarget(said, names, only, digest, muted)
    const text = t?.by === 'mention' ? t.text : said
    if (/^@\S/.test(said) && t?.by !== 'mention') { setNote({ text: `No project named ${said.slice(1).split(/\s+/)[0]}`, error: true }); return }
    if (!text) { setNote({ text: `Say what ${t?.project ?? 'it'} should do`, error: true }); return }
    if (!canControl) { setNote({ text: 'This device only watches: it cannot send to agents.', error: true }); return }
    const mine: Local = { id: localId(), at: Date.now(), role: 'user', text: said, project: t?.project, via, pending: true }
    setMessages((cur) => [...cur, mine])
    lastSent.current = mine.id
    setLine(''); setPick(0); setNote(null); setBusy(true)
    const drop = (cur: Local[]) => cur.filter((m) => m.id !== mine.id)
    try {
      if (legacy) throw new ApiError(404, 'no chat')
      const r = await api.jarvisSay({ text, ...(t ? { project: t.project } : {}), via })
      setMessages((cur) => mergeMessages(drop(cur), [r.message, ...(r.replies ?? [])]))
      onChanged()
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
        setLegacy(true)
        if (!t) {
          setMessages((cur) => [...cur.map((m) => (m.id === mine.id ? { ...m, pending: false } : m)),
            { id: localId(), at: Date.now(), role: 'jarvis', text: 'Name a project: @project what to do.' }])
          return
        }
        try {
          const r = await routeHere(t.project, text)
          setMessages((cur) => [...cur.map((m) => (m.id === mine.id ? { ...m, pending: false } : m)),
            { id: localId(), at: Date.now(), role: 'jarvis', text: r.text, project: t.project, session_id: r.session }])
          onChanged()
        } catch (e2) {
          setMessages((cur) => cur.map((m) => (m.id === mine.id ? { ...m, pending: false, failed: errText(e2) } : m)))
        }
        return
      }
      setMessages((cur) => cur.map((m) => (m.id === mine.id ? { ...m, pending: false, failed: errText(e) } : m)))
    } finally {
      setBusy(false)
    }
  }, [busy, names, only, digest, muted, canControl, legacy, routeHere, onChanged])

  const mic = micOffered()
  const talk = useHoldToTalk({ enabled: mic && canControl, line, setLine, send: (text) => void send(text, 'voice') })

  const complete = (name: string) => { setLine(`@${name} `); setPick(0) }
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(line, 'text') }
    if (e.key === 'Escape' && !talk.listening) { setLine(''); setNote(null) }
  }

  const shown = showAll ? messages : messages.slice(-THREAD_SHOWN)
  const earlier = messages.length - shown.length
  const where = target ? `→ ${target.project}` : '→ Jarvis'
  const whereTitle = !target ? 'No project yet: Jarvis decides, or asks you to name one with @project'
    : target.by === 'mention' ? `To ${target.project}, as you wrote`
      : target.by === 'chip' ? `To ${target.project}, the project picked on top; type @ to pick another`
        : `To ${target.project}, where you worked last; type @ to pick another`

  return (
    <>
      {messages.length > 0 && (
        <section aria-label="Chat with Jarvis" data-jarvis-thread className="grid grid-cols-[minmax(0,1fr)] gap-1">
          <h2 className="px-1 text-[12px] font-medium text-fg-muted">Chat with Jarvis</h2>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-[var(--radius-panel)] border border-border bg-panel px-2.5 py-2.5">
            {earlier > 0 && (
              <button type="button" onClick={() => setShowAll(true)} className="justify-self-center text-[12px] text-fg-muted hover:text-fg">Show {earlier} earlier</button>
            )}
            {shown.map((m) => <Message key={m.id} m={m} onOpen={onOpen} />)}
            <div ref={listEnd} />
          </div>
        </section>
      )}
      <div data-jarvis-command className="sticky bottom-0 z-10 -mx-1 grid grid-cols-[minmax(0,1fr)] gap-1 bg-bg px-1 pb-2 pt-1">
        {talk.listening && (
          <p role="status" data-jarvis-listening className="jarvis-in justify-self-center rounded-full border border-border-strong bg-panel px-3 py-1 text-center text-[12.5px] text-fg shadow-sm">
            <span aria-hidden className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full bg-danger align-middle" />
            Listening… release to send · Esc cancels
            <span className="block text-[11px] text-fg-muted">{speechWhere()}</span>
          </p>
        )}
        {(note || talk.note) && (
          <p role="status" data-jarvis-toast className={`jarvis-in min-w-0 text-[12px] ${note?.error || (!note && talk.note) ? 'text-warn' : 'text-fg-muted'}`}>{note?.text ?? talk.note}</p>
        )}
        <div className="relative flex min-w-0 items-center gap-2">
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
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] border border-border-strong bg-panel px-2.5 focus-within:border-accent">
            <input value={line} onChange={(e) => { setLine(e.target.value); setPick(0) }} onKeyDown={onKey} disabled={busy}
              aria-label="Message to Jarvis" placeholder="Just say what you need"
              className="h-[38px] min-w-0 flex-1 bg-transparent text-[13.5px] text-fg placeholder:text-fg-faint focus:outline-none" />
            <span data-jarvis-to title={whereTitle} className={`max-w-[40%] shrink-0 truncate text-[12px] ${atUnknown ? 'text-warn' : 'text-accent'}`}>
              {atUnknown ? `No project ${line.trim().slice(1).split(/\s+/)[0]}` : where}
            </span>
          </div>
          {mic && canControl && (
            <button type="button" data-jarvis-mic aria-label="Hold to talk" aria-pressed={talk.listening}
              title={`Hold to talk (${keys(TALK_KEY)}); release to send, Esc cancels`}
              onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* */ } talk.start() }}
              onPointerUp={() => talk.release()}
              onPointerCancel={() => talk.cancel()}
              onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); talk.start() } }}
              onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); talk.release() } }}
              onContextMenu={(e) => e.preventDefault()}
              className={`grid h-[40px] w-[40px] shrink-0 touch-none select-none place-items-center rounded-full bg-accent text-bg transition-shadow motion-reduce:transition-none ${talk.listening ? 'ring-4 ring-accent/30' : 'hover:brightness-110'}`}>
              <MicIcon />
            </button>
          )}
        </div>
        <p className="hidden min-w-0 text-[11px] text-fg-faint sm:block">
          {mic && canControl ? `Hold ${keys(TALK_KEY)} (or the mic) and speak; release to send. ` : ''}Type @ to pick a project.
          {legacy && ' This daemon routes @project messages only; update Caprock for the chat.'}
        </p>
      </div>
    </>
  )
}

function MicIcon() {
  return (
    <svg aria-hidden width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

function Message({ m, onOpen }: { m: Local; onOpen: (id: string) => void }) {
  const mine = m.role === 'user'
  const done = isDoneMessage(m)
  const waiting = m.pending && !mine
  const meta = mine
    ? [m.project ? `to ${m.project}` : 'to Jarvis', clockTime(m.at), m.via === 'voice' ? 'voice' : '', m.pending ? 'sending…' : ''].filter(Boolean).join(' · ')
    : ['Jarvis', clockTime(m.at), waiting ? 'working on it…' : ''].filter(Boolean).join(' · ')
  return (
    <div data-jarvis-msg={m.role} data-done={done ? 'true' : undefined} data-pending={m.pending ? 'true' : undefined}
      className={`grid max-w-[85%] min-w-0 gap-0.5 rounded-[12px] px-3 py-1.5 text-[13px] leading-snug [overflow-wrap:anywhere] ${
        mine ? 'justify-self-end rounded-br-[4px] bg-accent text-bg' : `justify-self-start rounded-bl-[4px] bg-panel-2 text-fg ${done ? 'border-l-[3px] border-l-ok' : ''}`
      } ${m.pending ? 'opacity-70' : ''}`}>
      <span className={`whitespace-pre-line ${waiting && !m.text ? 'italic text-fg-muted' : ''}`}>{m.text || (waiting ? 'Thinking…' : '')}</span>
      <span className={`flex flex-wrap items-baseline gap-x-2 text-[11px] ${mine ? 'text-bg/75' : 'text-fg-muted'}`}>
        <span>{meta}</span>
        {m.session_id && !mine && <button type="button" onClick={() => onOpen(m.session_id!)} className="text-accent hover:underline">Open</button>}
      </span>
      {m.failed && <span role="alert" className="text-[11.5px] font-medium text-bg">Not sent: {m.failed}</span>}
    </div>
  )
}
