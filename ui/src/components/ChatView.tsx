/**
 * A session as a conversation (WP-14, .ai/21-app.md § Phone v2): what you
 * typed, what the agent wrote, each tool call on one line that opens, and a
 * field that types into the session.
 *
 * - **Order is the server's.** Events are held merged by id and sorted by the
 *   daemon's `(ts, id)` (lib/chat.ts), so a late or replayed event lands in
 *   place and never twice. After a reconnect the newest page is fetched again
 *   and merged; whatever overlaps is dropped by id. A page that does not reach
 *   back to what is held is filled with earlier pages until it does.
 * - **The scrolling rule** (useStickToBottom): it follows only at the bottom,
 *   a reader scrolled up stays put to the pixel, and a "↓ N new" pill counts
 *   what arrived. Live events are batched to one update per frame.
 * - **Windowed.** Only the newest messages are in the DOM at first; scrolling
 *   to the top reveals the next page from memory, then from the daemon, and
 *   the hook keeps the first visible message where it was.
 * - **Bottom-anchored.** A conversation shorter than the view sits at its
 *   bottom, next to the field, as in a messenger.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errText, type Event, type QueueView } from '@/lib/api'
import { downscalePhoto } from '@/lib/downscale'
import { compareEvents, isMessageEvent, mergeEvents, toMessages, toolInputText, type ChatMessage } from '@/lib/chat'
import { BrainDropButton } from './BrainDrop'
import { live, useLiveConn, useLiveLink } from '@/lib/live'
import type { TermState } from '@/lib/termv2'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { useQueue } from '@/lib/queue'
import { QueuedList } from './QueuedList'
import { NewPill } from './NewPill'
import { LinkedText, Prose } from './Prose'
import { requestOpenPath } from '@/lib/mdreader'
import { TerminalKeys } from './TerminalKeys'
import { ChevronIcon } from './AppIcons'
import { touchScreen } from '@/lib/phone'
import { QuickReplies } from './QuickReplies'
import { agentDisplayName, donePhrase, fmtElapsed, openTurn, promptParts, type TurnState } from '@/lib/chatActivity'
import { useNow } from '@/lib/useNow'
import { PermissionPrompt, usePermission } from './PermissionPrompt'

/** Events fetched when the view opens, and per page back. */
export const CHAT_PAGE_EVENTS = 300
/** Messages in the DOM when the view opens, and revealed per step back. */
export const CHAT_WINDOW = 120
/** Pages fetched back to close the hole a reconnect left, before starting over. */
export const CHAT_GAP_PAGES = 10
/** How near the top a reader gets before the next page is revealed. */
const REVEAL_PX = 400
/** A tool result longer than this is cut, with the remainder counted. */
const RESULT_CAP = 20_000

type Key = Pick<Event, 'ts' | 'id'>

/** The first message at or after `key`. */
function indexFrom(messages: readonly ChatMessage[], key: Key): number {
  let lo = 0
  let hi = messages.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compareEvents(messages[mid]!, key) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function keyOf(m: ChatMessage | undefined): Key | null {
  return m ? { ts: m.ts, id: m.id } : null
}

/**
 * The events between `held` (the newest event this view has) and `page` (the
 * newest page, which starts after it), by paging back with `before=` until a
 * page reaches `held`. Null when CHAT_GAP_PAGES are not enough.
 */
async function fillGap(sessionId: string, page: readonly Event[], held: Key): Promise<Event[] | null> {
  const got: Event[][] = [page.slice()]
  let oldest = page[0]!
  for (let i = 0; i < CHAT_GAP_PAGES; i++) {
    const back = await api.eventsBefore(sessionId, oldest.id, CHAT_PAGE_EVENTS)
    if (back.length === 0) return got.flat()
    got.unshift(back)
    oldest = back[0]!
    if (compareEvents(oldest, held) <= 0 || back.length < CHAT_PAGE_EVENTS) return got.flat()
  }
  return null
}

/** A file's bytes as base64, in chunks: one call over a large array blows the argument limit. */
async function base64Of(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192))
  return btoa(bin)
}

const nextFrame: (fn: () => void) => void =
  typeof requestAnimationFrame === 'function' ? (fn) => { requestAnimationFrame(fn) } : (fn) => { setTimeout(fn, 16) }

export function ChatView({ sessionId, earlier = NONE, canType, ended = false, className = '', phone = false, foldKeys, chat = false, footer, boxRef, scrollRef, topInset = 0, agent, prompt = false, desk = false, onOpenTerminal }: {
  sessionId: string
  /** The sessions this one continues in the same process, oldest first
   *  (lib/clearChain.ts clearedParts): shown read-only above it once its
   *  start is reached, each with the divider a /clear leaves. */
  earlier?: readonly string[]
  /** The session's agent (Session.agent), for *Claude is thinking…*. */
  agent?: string
  /** Draw the permission card (components/PermissionPrompt) under the
   *  conversation, where the chat's reader is looking. Off where the page
   *  already draws it (the session screen, the app's inspector). */
  prompt?: boolean
  /** The session takes input from here: owned, live, and this device may control. */
  canType: boolean
  /** The session's process is gone: what waits to be sent becomes a draft. */
  ended?: boolean
  className?: string
  /** The phone's chat: dictation, the raw keys folded behind a Keys button,
   *  a messenger's field, and no quick replies over it. */
  phone?: boolean
  /** The raw keys folded behind a Keys button off a phone too: a chat
   *  (ADR-071) is a conversation, not a terminal. Defaults to `phone`. */
  foldKeys?: boolean
  /** A chat (ADR-071): a messenger's field (*Message…*) and no coding
   *  quick replies (Run tests, Commit), which mean nothing without a repo. */
  chat?: boolean
  /** Said where the field would be, when there is none: why, and what to do. */
  footer?: ReactNode
  /** The outer element, for a caller that sizes it (useFillViewport). */
  boxRef?: (el: HTMLDivElement | null) => void
  /** The scrolling log, for a caller that watches it (the phone's bar hides
   *  on scroll, lib/phone useHideOnScroll). */
  scrollRef?: (el: HTMLDivElement | null) => void
  /** Space kept at the top of the log, in px, for a bar drawn over it: the
   *  first message starts below the bar and scrolls under it. */
  topInset?: number
  /** The app's Chat view of a tab (.ai/04-ui.md § Chat, *Chat or Terminal*):
   *  a reading column on a wide window, each tool call in plain words
   *  (*Searched the web: …*), and a messenger's field. */
  desk?: boolean
  /** Brings this session's terminal forward in place of the chat, for what
   *  only the terminal answers (a question with options, several prompts). */
  onOpenTerminal?: () => void
}) {
  const [events, setEvents] = useState<readonly Event[]>([])
  const eventsRef = useRef<readonly Event[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [startKey, setStartKey] = useState<Key | null>(null)
  const [received, setReceived] = useState(0)
  const [sendError, setSendError] = useState('')
  const stick = useStickToBottom({ total: received })
  // A `.md` path in a reply opens in a file tab; the workspace resolves it
  // against this session's folder (lib/mdreader OPEN_PATH_EVENT).
  const onPath = useCallback((path: string) => requestOpenPath({ path, sessionId }), [sessionId])
  const box = useRef<HTMLDivElement | null>(null)

  const commit = useCallback((incoming: readonly Event[]): number => {
    const prev = eventsRef.current
    const next = mergeEvents(prev, incoming)
    if (next === prev) return 0
    eventsRef.current = next
    setEvents(next)
    // A reply rewritten in place (an `event_update`) counts when it became a
    // message: its first line had no words, so it was not one before.
    const held = new Map(prev.map((e) => [e.id, e]))
    return incoming.filter((e) => {
      const was = held.get(e.id)
      return isMessageEvent(e) && (!was || !isMessageEvent(was))
    }).length
  }, [])

  const loadNewest = useCallback(async (first: boolean) => {
    try {
      const page = await api.recentEvents(sessionId, CHAT_PAGE_EVENTS)
      const held = eventsRef.current[eventsRef.current.length - 1]
      // A full page that starts after the newest event held leaves a hole
      // between them. It is filled by paging back to what is held, so the
      // reader keeps their place; only a hole wider than CHAT_GAP_PAGES starts
      // again from this page rather than show two halves as one conversation.
      const gap = !first && held && page.length === CHAT_PAGE_EVENTS && compareEvents(page[0]!, held) > 0
      const filled = gap ? await fillGap(sessionId, page, held) : page
      const hole = gap && filled === null
      if (hole) {
        eventsRef.current = []
        setStartKey(null)
        setExhausted(false)
      }
      const added = commit(filled ?? page)
      if (!first && !hole && added > 0) setReceived((n) => n + added)
      if (first || hole) {
        if (page.length < CHAT_PAGE_EVENTS) setExhausted(true)
        const msgs = toMessages(eventsRef.current)
        setStartKey(keyOf(msgs[Math.max(0, msgs.length - CHAT_WINDOW)]))
        setLoaded(true)
      }
      setError('')
    } catch (e) {
      if (first) setError(errText(e))
    }
  }, [sessionId, commit])

  useEffect(() => {
    eventsRef.current = []
    setEvents([])
    setLoaded(false)
    setExhausted(false)
    setStartKey(null)
    setError('')
    void loadNewest(true)
  }, [loadNewest])

  // Live events, batched to one update per frame. They are merged by id, so
  // one that the first page already held is dropped.
  useEffect(() => {
    let batch: Event[] = []
    let pending = false
    let alive = true
    const flush = () => {
      pending = false
      if (!alive || batch.length === 0) return
      const added = commit(batch)
      batch = []
      if (added > 0) setReceived((n) => n + added)
    }
    const off = live.onFrame((f) => {
      // The daemon no longer holds the frames this client missed (WP-12).
      if (f.type === 'reset') { void loadNewest(false); return }
      // An event_update is a reply's words merged into a row already held
      // (03-contracts.md § Live socket): merged by id, it replaces that row.
      if ((f.type !== 'event' && f.type !== 'event_update') || f.data.session_id !== sessionId) return
      batch.push(f.data)
      if (!pending) { pending = true; nextFrame(flush) }
    })
    return () => { alive = false; off() }
  }, [sessionId, commit, loadNewest])

  // Back from a dropped connection: the live socket replays the gap (WP-12),
  // and the newest page is merged as well — a replayed or refetched event is
  // the same id, so whatever overlaps is dropped.
  const conn = useLiveConn()
  const dropped = useRef(false)
  useEffect(() => {
    if (conn === 'closed') dropped.current = true
    else if (conn === 'open' && dropped.current) {
      dropped.current = false
      void loadNewest(false)
    }
  }, [conn, loadNewest])

  const messages = useMemo(() => toMessages(events, { ended }), [events, ended])
  const turn = useMemo(() => (loaded ? openTurn(events, ended) : null), [loaded, events, ended])
  const [permission] = usePermission(sessionId)
  const start = startKey ? indexFrom(messages, startKey) : Math.max(0, messages.length - CHAT_WINDOW)
  const shown = messages.slice(start)
  // A question the agent asks with options (AskUserQuestion) still open: the
  // daemon draws no card for it (its answers are not Yes and No), so the
  // chat says what is asked and where it is answered.
  const question = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.kind === 'tool' && m.tool === 'AskUserQuestion') return m.result === undefined && !m.interrupted ? m : null
      if (m.kind === 'user') return null
    }
    return null
  }, [messages])

  const busy = useRef(false)
  const revealOlder = useCallback(async () => {
    if (busy.current || !loaded) return
    const msgs = toMessages(eventsRef.current)
    const at = startKey ? indexFrom(msgs, startKey) : 0
    if (at > 0) {
      setStartKey(keyOf(msgs[Math.max(0, at - CHAT_WINDOW)]))
      return
    }
    const oldest = eventsRef.current[0]
    if (exhausted || !oldest) return
    busy.current = true
    setLoadingOlder(true)
    try {
      const page = await api.eventsBefore(sessionId, oldest.id, CHAT_PAGE_EVENTS)
      if (page.length < CHAT_PAGE_EVENTS) setExhausted(true)
      if (page.length > 0) {
        commit(page)
        const next = toMessages(eventsRef.current)
        const from = startKey ? indexFrom(next, startKey) : 0
        setStartKey(keyOf(next[Math.max(0, from - CHAT_WINDOW)]))
      }
    } catch (e) {
      setError(errText(e))
    } finally {
      busy.current = false
      setLoadingOlder(false)
    }
  }, [loaded, startKey, exhausted, sessionId, commit])

  const onScroll = useCallback(() => {
    const el = box.current
    if (el && el.scrollTop < REVEAL_PX) void revealOlder()
  }, [revealOlder])

  // Too few messages to scroll: nothing would ever reach the top, so keep
  // revealing until the view is full or the session's start is reached.
  useEffect(() => {
    const el = box.current
    if (!el || !loaded || loadingOlder) return
    if (el.scrollHeight <= el.clientHeight && (start > 0 || !exhausted)) void revealOlder()
  }, [loaded, loadingOlder, start, exhausted, shown.length, revealOlder])

  // Input goes through the daemon one write at a time, in order: the text and
  // the Enter after it are two requests, and the Enter must not overtake.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const send = useCallback((data: string) => {
    queue.current = queue.current
      .then(() => api.agentInput(sessionId, data))
      .then(() => setSendError(''))
      .catch((e: unknown) => setSendError(`Not sent: ${errText(e)}`))
  }, [sessionId])

  // The offline queue (WP-13) on the live socket's state: the chat types over
  // HTTP, and the live socket is what says the daemon is reachable now.
  const link = useLiveLink()
  const inputState: TermState = ended ? 'ended' : link.phase

  // The message queue (ADR-053): a message sent while the agent works is held
  // by the daemon and typed in when the turn ends. The daemon decides — it is
  // the one that sees the turn end — so what is sent goes to it, and a
  // message held while offline reaches it on reconnect the same way.
  const msgQueue = useQueue(sessionId, canType)
  const applyQueue = msgQueue.apply
  const jumpToEnd = stick.jump
  // What you sent, as your bubble at once (*Sending…*, then *Sent ✓*), until
  // the session's own record of the prompt lands and takes its place. A
  // message the daemon held is the queue's bubble instead (QueuedList).
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const outSeq = useRef(0)
  const submitText = useCallback(async (text: string, retry?: number): Promise<boolean> => {
    const key = retry ?? ++outSeq.current
    const after = eventsRef.current.reduce((m, e) => Math.max(m, e.id), 0)
    setOutgoing((list) => [...list.filter((o) => o.key !== key), { key, text, phase: 'sending', at: Date.now(), after }])
    nextFrame(jumpToEnd)
    try {
      const r = await api.queueSend(sessionId, text)
      applyQueue(r.queue)
      setOutgoing((list) => (r.sent === false
        ? list.filter((o) => o.key !== key)
        : list.map((o) => (o.key === key ? { ...o, phase: 'sent' as const } : o))))
      setSendError('')
      // What you just sent is at the bottom, as in a messenger: a queued
      // bubble lands there while the field shrinks back to one line, and the
      // two moving at once could leave the view a few pixels off the edge.
      nextFrame(jumpToEnd)
      return true
    } catch (e) {
      // One place says "Not sent", not two: the composer holds the message
      // with Retry and Edit (and keeps it across a reload), so the bubble
      // goes. A bubble's own Retry that fails again stays, marked failed.
      setOutgoing((list) => (retry === undefined
        ? list.filter((o) => o.key !== key)
        : list.map((o) => (o.key === key ? { ...o, phase: 'failed' as const } : o))))
      setSendError(`Not sent: ${errText(e)}`)
      return false
    }
  }, [sessionId, applyQueue, jumpToEnd])
  // A sent bubble goes when the session records a prompt with its words, or
  // after OUTGOING_KEEP_MS (a slash command records none).
  useEffect(() => {
    if (!outgoing.some((o) => o.phase === 'sent')) return
    const prompts = events
      .filter((e) => e.kind === 'turn.user' && !e.agent_id)
      .map((e) => {
        const p = (e.payload ?? {}) as { prompt?: unknown; text?: unknown }
        return { id: e.id, text: sameText(String(p.prompt ?? p.text ?? '')) }
      })
    const now = Date.now()
    const keep = outgoing.filter((o) => {
      if (o.phase !== 'sent') return true
      if (now - o.at > OUTGOING_KEEP_MS) return false
      const t = sameText(o.text)
      return !prompts.some((p) => p.id > o.after && p.text.includes(t))
    })
    if (keep.length !== outgoing.length) { setOutgoing(keep); return }
    const t = window.setTimeout(() => setOutgoing((list) => list.filter((o) => o.phase !== 'sent' || Date.now() - o.at <= OUTGOING_KEEP_MS)), OUTGOING_KEEP_MS)
    return () => window.clearTimeout(t)
  }, [events, outgoing])
  const [queueError, setQueueError] = useState('')
  const queueAct = useCallback(async (act: () => Promise<QueueView>): Promise<boolean> => {
    try {
      applyQueue(await act())
      setQueueError('')
      return true
    } catch (e) {
      setQueueError(errText(e))
      return false
    }
  }, [applyQueue])
  // Typed while it was live, then it ended: the field stays, so what waited
  // to be sent shows as a draft rather than vanishing with it.
  const [typable, setTypable] = useState(canType)
  if (canType && !typable) setTypable(true)
  const showInput = canType || (ended && typable)

  // A photo: made small enough to send and saved by the daemon (the paste
  // path a dropped file takes). The field shows it as an "Image N" chip, one
  // path per file ('' for one that failed), and on Send it is pasted in
  // before the words, as the desktop terminal pastes a dropped image, so
  // Claude Code shows `[Image #N]` (sendPaths).
  const attachPhotos = useCallback(async (files: File[]): Promise<string[]> => {
    const paths: string[] = []
    for (const f of files) {
      try {
        const photo = await downscalePhoto(f)
        const { path } = await api.paste({ name: photo.name, type: photo.type, data: await base64Of(photo) })
        paths.push(path)
      } catch (e) {
        paths.push('')
        setSendError(`${f.name ? `${f.name}: ` : ''}not added — ${errText(e)}`)
      }
    }
    return paths
  }, [])
  // In the input's own order, behind any keys already on their way.
  const sendPaths = useCallback((paths: readonly string[]): Promise<void> => {
    const sent = queue.current.then(() => api.agentPaths(sessionId, paths))
    queue.current = sent.then(() => setSendError(''), (e: unknown) => setSendError(`Not sent: ${errText(e)}`))
    return sent
  }, [sessionId])

  // Dictation on a phone or a tablet, where typing is the slow part (owner's
  // report, 2026-10-11). The desktop chat is unchanged: its keyboard is fast,
  // and the OS has its own dictation key there.
  const [voice] = useState(() => phone || touchScreen())

  const stickRef = stick.ref
  const attach = useCallback((el: HTMLDivElement | null) => {
    box.current = el
    stickRef(el)
    scrollRef?.(el)
  }, [stickRef, scrollRef])

  return (
    <div ref={boxRef} className={`flex min-h-0 flex-col ${className}`} data-chat-view>
      <div className="relative min-h-0 flex-1">
        <div
          ref={attach}
          onScroll={onScroll}
          role="log"
          aria-label="Conversation"
          className={`absolute inset-0 flex flex-col overflow-y-auto [&>*]:shrink-0 overscroll-contain pt-9 pb-2 ${desk ? DESK_COLUMN : 'px-3'}`}
          style={topInset ? { paddingTop: 36 + topInset } : undefined}
        >
          {/* No height of its own, drawn in the padding above the first
            * message: the scrolling rule anchors on the first visible row with
            * a height, and older messages are inserted below this one — as an
            * anchor it would let them push the reader down. Its auto top
            * margin puts a short conversation at the bottom; once the log
            * overflows, the margin is zero and it scrolls as before. */}
          <div className="relative mt-auto h-0">
            <div className="absolute inset-x-0 -top-7 text-center text-[11px] text-fg-faint">
            {error ? (
              <span className="text-danger">{error} <button type="button" className="link" onClick={() => void (loaded ? revealOlder() : loadNewest(true))}>retry</button></span>
            ) : !loaded ? 'loading…'
              : loadingOlder ? 'loading earlier…'
              : start === 0 && exhausted ? (earlier.length ? 'start of conversation' : messages.length ? 'start of session' : 'No messages yet')
              : <button type="button" className="link" onClick={() => void revealOlder()}>load earlier</button>}
            </div>
          </div>
          {loaded && start === 0 && exhausted && earlier.length > 0 && <ClearedParts ids={earlier} onPath={onPath} plain={desk} />}
          {shown.map((m) => <Message key={m.id} m={m} onPath={onPath} plain={desk} />)}
          {outgoing.map((o) => (
            <OutgoingBubble key={`out-${o.key}`} o={o} onRetry={() => void submitText(o.text, o.key)} onDismiss={() => setOutgoing((list) => list.filter((x) => x.key !== o.key))} />
          ))}
          {!ended && (turn || permission) && (
            <ChatWorking turn={turn} agent={agentDisplayName(agent)} waiting={!!permission} />
          )}
          {!ended && question && <QuestionLine m={question} onOpenTerminal={onOpenTerminal} />}
          {prompt && !ended && <div className="py-1.5 empty:hidden" data-chat-permission><PermissionPrompt sessionId={sessionId} keys={false} onOpenTerminal={onOpenTerminal} /></div>}
          {showInput && msgQueue.messages.length > 0 && (
            <QueuedList
              messages={msgQueue.messages}
              waiting={msgQueue.waiting}
              error={queueError}
              onEdit={(m, text) => queueAct(() => api.queueEdit(sessionId, m.id, text))}
              onCancel={(m) => queueAct(() => api.queueCancel(sessionId, m.id))}
              onSendNow={(m) => queueAct(() => api.queueSendNow(sessionId, m.id))}
            />
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <NewPill count={stick.newCount} onJump={stick.jump} />
        </div>
      </div>
      {showInput && (
        <div className={`shrink-0 ${desk ? DESK_COLUMN : ''}`}>
          {sendError && <div role="alert" className="px-3 pt-1.5 text-[12px] text-danger">{sendError}</div>}
          {/* One click sends a reply (lib/quickReplies.ts); only while it can be typed into (rule 7). */}
          {/* Not on a phone, where the row crowds a small screen. */}
          {canType && !phone && <QuickReplies sessionId={sessionId} onSend={submitText} chat={chat} className="px-3" />}
          <TerminalKeys send={send} attach={attachPhotos} sendPaths={sendPaths} state={inputState} sessionId={sessionId} submitText={submitText} chips pickers voice={voice} foldKeys={foldKeys ?? phone} placeholder={chat || phone || desk ? 'Message…' : undefined} />
        </div>
      )}
      {!showInput && footer && <div className="shrink-0 border-t border-border px-3 py-2.5 text-[13px] leading-snug text-fg-muted">{footer}</div>}
    </div>
  )
}

const NONE: readonly string[] = []

/** The words under each part a /clear left behind. */
export const CLEARED_DIVIDER = 'Context cleared — Claude no longer remembers the part above'

/**
 * The parts of the conversation before each /clear (.ai/04-ui.md § One card
 * per conversation): the newest page of each, read-only, with the divider
 * that says the model no longer has it. Fetched once per set of parts.
 */
function ClearedParts({ ids, onPath, plain }: { ids: readonly string[]; onPath?: (path: string) => void; plain?: boolean }) {
  const key = ids.join('\n')
  const [parts, setParts] = useState<{ id: string; messages: ChatMessage[] }[] | null>(null)
  useEffect(() => {
    let alive = true
    const list = key ? key.split('\n') : []
    void Promise.all(list.map((id) => api.recentEvents(id, CHAT_PAGE_EVENTS)
      .then((evs) => ({ id, messages: toMessages(evs, { ended: true }).slice(-CHAT_WINDOW) }))
      .catch(() => ({ id, messages: [] as ChatMessage[] }))))
      .then((p) => { if (alive) setParts(p) })
    return () => { alive = false }
  }, [key])
  if (!parts) return null
  return (
    <>
      {parts.map((p) => (
        <div key={p.id} data-cleared-part={p.id}>
          {p.messages.map((m) => <Message key={m.id} m={m} onPath={onPath} plain={plain} />)}
          <div role="separator" data-cleared-divider className="my-3 flex items-center gap-2 text-[11px] text-fg-faint">
            <span className="h-px flex-1 bg-border" />
            <span className="shrink-0">{CLEARED_DIVIDER}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        </div>
      ))}
    </>
  )
}

/** A finished message never changes, so it renders once. */
const Message = memo(function Message({ m, onPath, plain = false }: { m: ChatMessage; onPath?: (path: string) => void; plain?: boolean }) {
  if (m.kind === 'user') {
    return (
      <div data-msg-id={m.id} className="flex flex-col items-end py-1.5">
        <div className="grid max-w-[85%] min-w-0 gap-1.5 whitespace-pre-wrap rounded-[12px] rounded-br-[4px] bg-panel-2 px-3 py-2 text-[14px] leading-relaxed text-fg [overflow-wrap:anywhere]" title={m.ts}>
          <PromptText text={m.text} />
        </div>
        {m.via === 'telegram' && <div className="mt-0.5 text-[11px] text-fg-faint" data-via="telegram">from Telegram</div>}
      </div>
    )
  }
  if (m.kind === 'assistant') {
    return (
      <div data-msg-id={m.id} className="group py-1.5 [&_div]:text-fg [&>div]:text-[14px]">
        <Prose text={m.text} onPath={onPath} />
        {/* Keep it in Second Brain (ADR-063): quiet until the reply is hovered or focused. */}
        <span className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
          <BrainDropButton eventId={m.id} className="-ml-1 mt-0.5" />
        </span>
      </div>
    )
  }
  if (m.kind === 'notice') return <NoticeLine m={m} />
  return <ToolLine m={m} plain={plain} />
}, (a, b) => a.plain === b.plain && a.m.id === b.m.id && a.m.text === b.m.text && a.m.result === b.m.result && a.m.failed === b.m.failed && a.m.exitCode === b.m.exitCode)

/** What Claude Code told itself (a background task done, a reminder): one quiet line, the text behind it. */
function NoticeLine({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-msg-id={m.id} className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 max-sm:min-h-11 text-left text-[12px] text-fg-faint hover:bg-panel-2"
      >
        <ChevronIcon size={12} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate">{m.text}</span>
      </button>
      {open && (
        <pre className="mono ml-5 max-h-[240px] overflow-auto whitespace-pre-wrap border-l border-border pl-2.5 text-[11.5px] text-fg-muted [overflow-wrap:anywhere]">{m.raw}</pre>
      )}
    </div>
  )
}

function ToolLine({ m, plain = false }: { m: ChatMessage; plain?: boolean }) {
  const [open, setOpen] = useState(false)
  const shownInput = toolInputText(m.tool ?? '', m.input)
  const result = m.result ?? ''
  return (
    <div data-msg-id={m.id} className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 max-sm:min-h-11 text-left text-[12.5px] hover:bg-panel-2 ${m.failed ? 'text-danger' : 'text-fg-muted'}`}
      >
        <ChevronIcon size={12} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        {plain
          ? <span className="min-w-0 flex-1 truncate" title={m.text}>{donePhrase(m.tool ?? '', m.input)}</span>
          : <span className="mono min-w-0 flex-1 truncate">{m.text}</span>}
        {m.interrupted ? (
          <span className="shrink-0 text-[11px] text-fg-faint">interrupted</span>
        ) : m.result === undefined && <span className="shrink-0 text-[11px] text-fg-faint">running</span>}
        {m.failed && <span className="shrink-0 text-[11px]">{m.exitCode ? `exit ${m.exitCode}` : 'failed'}</span>}
      </button>
      {open && (
        <div className="ml-5 grid gap-1.5 border-l border-border pl-2.5 pb-1">
          <pre className="mono max-h-[240px] overflow-auto whitespace-pre-wrap text-[12px] text-fg [overflow-wrap:anywhere]">{shownInput}</pre>
          {result && (
            <pre className="mono max-h-[320px] overflow-auto whitespace-pre-wrap text-[12px] text-fg-muted [overflow-wrap:anywhere]">
              {result.length > RESULT_CAP ? `${result.slice(0, RESULT_CAP)}\n… ${result.length - RESULT_CAP} more characters` : result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The agent at work (.ai/04-ui.md § Chat, *Working*): from the prompt until
 * its Stop, one line under the conversation says it is working, for how
 * long, and the call it runs — or that it waits on your permission. Its own
 * one-second clock, so the conversation does not redraw with it.
 */
function ChatWorking({ turn, agent, waiting }: { turn: TurnState | null; agent: string; waiting: boolean }) {
  const now = useNow(1000)
  const since = turn ? Date.parse(turn.since) : NaN
  const clock = Number.isFinite(since) ? fmtElapsed(now - since) : ''
  const text = waiting ? 'Waiting for your permission' : turn?.step ? turn.step : `${agent} is thinking…`
  return (
    <div role="status" aria-live="polite" data-chat-working={waiting ? 'permission' : 'working'} className="flex min-w-0 items-center gap-2 py-2 text-[13px] text-fg-muted">
      {waiting ? (
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-warn" />
      ) : (
        <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-accent motion-reduce:animate-none" />
      )}
      <span className={`min-w-0 truncate ${waiting ? 'font-medium text-warn' : ''}`}>{text}</span>
      {clock && <span className="num shrink-0 text-fg-faint">{clock}</span>}
    </div>
  )
}

/**
 * The app's chat as a reading column: no wider than a comfortable line on a
 * wide window, centred by its padding so the scrollbar stays at the edge.
 */
const DESK_COLUMN = 'px-[max(12px,calc((100%-780px)/2))]'

/** What AskUserQuestion asks, as its input carries it: each question and its options. */
function questionsOf(input: unknown): { question: string; options: string[] }[] {
  const qs = (input && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined)
  if (!Array.isArray(qs)) return []
  return qs.flatMap((q: unknown) => {
    if (!q || typeof q !== 'object') return []
    const { question, options } = q as { question?: unknown; options?: unknown }
    if (typeof question !== 'string' || !question.trim()) return []
    const opts = Array.isArray(options)
      ? options.map((o: unknown) => (typeof o === 'string' ? o : o && typeof o === 'object' ? String((o as { label?: unknown }).label ?? '') : '')).filter(Boolean)
      : []
    return [{ question: question.trim(), options: opts }]
  })
}

/**
 * A question the agent asks with options (AskUserQuestion), while it waits:
 * what it asks and its options, read-only — they are picked in the terminal's
 * menu, which the chat cannot drive safely — and the one way there.
 */
function QuestionLine({ m, onOpenTerminal }: { m: ChatMessage; onOpenTerminal?: () => void }) {
  const qs = questionsOf(m.input)
  return (
    <div data-chat-question className="my-1.5 grid gap-1 rounded-[10px] border border-accent/50 bg-accent/10 px-3 py-2 text-[13px] text-fg">
      {qs.length ? qs.map((q, i) => (
        <div key={i} className="grid gap-0.5">
          <p className="font-medium">{q.question}</p>
          {q.options.length > 0 && <p className="text-[12.5px] text-fg-muted">{q.options.join(' · ')}</p>}
        </div>
      )) : <p className="font-medium">The agent asks you a question.</p>}
      <p className="text-[12px] text-fg-muted">
        Answered in the terminal{onOpenTerminal ? ' · ' : '.'}
        {onOpenTerminal && <button type="button" className="link" onClick={onOpenTerminal}>Open in Terminal</button>}
      </p>
    </div>
  )
}

/** A pasted block longer than this many lines is folded. */
const PASTE_FOLD_LINES = 6

/** A prompt as typed: the person's words as they are, each paste as a quiet block. */
function PromptText({ text }: { text: string }) {
  const parts = promptParts(text)
  if (parts.length === 0) return <LinkedText text={text} />
  return (
    <>
      {parts.map((p, i) => (p.kind === 'text' ? <span key={i}><LinkedText text={p.text} /></span> : <PastedBlock key={i} text={p.text} lines={p.lines} />))}
    </>
  )
}

function PastedBlock({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false)
  const long = lines > PASTE_FOLD_LINES
  const shown = long && !open ? text.split('\n').slice(0, PASTE_FOLD_LINES).join('\n') : text
  return (
    <div data-pasted className="min-w-0 rounded-[8px] border border-border bg-bg/60 px-2.5 py-1.5 text-[12.5px] leading-snug text-fg-muted">
      <div className="text-[11px] uppercase tracking-wide text-fg-faint">Pasted{lines ? ` · ${lines} line${lines === 1 ? '' : 's'}` : ''}</div>
      {text && <div className="mono mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{shown}</div>}
      {long && (
        <button type="button" className="link mt-0.5 text-[12px]" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : `Show ${lines - PASTE_FOLD_LINES} more lines`}
        </button>
      )}
    </div>
  )
}

/** How long a sent bubble waits for the session's record of it. */
const OUTGOING_KEEP_MS = 120_000

/** A message on its way: sending, taken by the daemon, or refused. */
interface Outgoing {
  key: number
  text: string
  phase: 'sending' | 'sent' | 'failed'
  at: number
  /** The newest event id held when it was sent: its record comes after. */
  after: number
}

/** Text compared without its spacing: the terminal and the transcript differ there. */
function sameText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Your message the moment you send it, with its state under it. */
function OutgoingBubble({ o, onRetry, onDismiss }: { o: Outgoing; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div data-outgoing={o.phase} className="flex justify-end py-1.5">
      <div className="grid max-w-[85%] min-w-0 gap-1 rounded-[12px] rounded-br-[4px] bg-panel-2 px-3 py-2 text-[14px] leading-relaxed text-fg">
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{o.text}</div>
        <div className={`flex items-center justify-end gap-2 text-[11.5px] ${o.phase === 'failed' ? 'text-danger' : 'text-fg-faint'}`}>
          {o.phase === 'sending' ? 'Sending…' : o.phase === 'sent' ? 'Sent ✓' : (
            <>
              <span>Not sent</span>
              <button type="button" className="link min-h-[32px] text-[12px]" onClick={onRetry}>Retry</button>
              <button type="button" className="min-h-[32px] px-1 text-[12px] text-fg-muted underline underline-offset-2" onClick={onDismiss}>Dismiss</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
