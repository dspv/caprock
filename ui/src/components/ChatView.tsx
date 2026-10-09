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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type Event } from '@/lib/api'
import { downscalePhoto } from '@/lib/downscale'
import { compareEvents, isMessageEvent, mergeEvents, toMessages, toolInputText, type ChatMessage } from '@/lib/chat'
import { live, useLiveConn, useLiveLink } from '@/lib/live'
import type { TermState } from '@/lib/termv2'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { NewPill } from './NewPill'
import { Prose } from './Prose'
import { TerminalKeys } from './TerminalKeys'
import { ChevronIcon } from './AppIcons'

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

export function ChatView({ sessionId, canType, ended = false, className = '' }: {
  sessionId: string
  /** The session takes input from here: owned, live, and this device may control. */
  canType: boolean
  /** The session's process is gone: what waits to be sent becomes a draft. */
  ended?: boolean
  className?: string
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
  const box = useRef<HTMLDivElement | null>(null)

  const commit = useCallback((incoming: readonly Event[]): number => {
    const prev = eventsRef.current
    const next = mergeEvents(prev, incoming)
    if (next === prev) return 0
    eventsRef.current = next
    setEvents(next)
    const seen = new Set(prev.map((e) => e.id))
    return incoming.filter((e) => !seen.has(e.id) && isMessageEvent(e)).length
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
      if (f.type !== 'event' || f.data.session_id !== sessionId) return
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
  const start = startKey ? indexFrom(messages, startKey) : Math.max(0, messages.length - CHAT_WINDOW)
  const shown = messages.slice(start)

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
  const isPromptWaiting = useCallback(
    () => api.permission(sessionId).then((r) => r.permission !== null),
    [sessionId],
  )
  // Typed while it was live, then it ended: the field stays, so what waited
  // to be sent shows as a draft rather than vanishing with it.
  const [typable, setTypable] = useState(canType)
  if (canType && !typable) setTypable(true)
  const showInput = canType || (ended && typable)

  // A photo: made small enough to send, saved by the daemon (the paste path a
  // dropped file takes), and its path put in the field, where it is read
  // with the words about it and sent with them.
  const attachPhotos = useCallback(async (files: File[]): Promise<string[]> => {
    const paths: string[] = []
    for (const f of files) {
      try {
        const photo = await downscalePhoto(f)
        const { path } = await api.paste({ name: photo.name, type: photo.type, data: await base64Of(photo) })
        paths.push(path)
      } catch (e) {
        setSendError(`${f.name ? `${f.name}: ` : ''}not added — ${errText(e)}`)
      }
    }
    return paths
  }, [])

  const stickRef = stick.ref
  const attach = useCallback((el: HTMLDivElement | null) => {
    box.current = el
    stickRef(el)
  }, [stickRef])

  return (
    <div className={`flex min-h-0 flex-col ${className}`} data-chat-view>
      <div className="relative min-h-0 flex-1">
        <div
          ref={attach}
          onScroll={onScroll}
          role="log"
          aria-label="Conversation"
          className="absolute inset-0 flex flex-col overflow-y-auto [&>*]:shrink-0 overscroll-contain px-3 pt-9 pb-2"
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
              : start === 0 && exhausted ? (messages.length ? 'start of session' : 'No messages yet')
              : <button type="button" className="link" onClick={() => void revealOlder()}>load earlier</button>}
            </div>
          </div>
          {shown.map((m) => <Message key={m.id} m={m} />)}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <NewPill count={stick.newCount} onJump={stick.jump} />
        </div>
      </div>
      {showInput && (
        <div className="shrink-0">
          {sendError && <div role="alert" className="px-3 pt-1.5 text-[12px] text-danger">{sendError}</div>}
          <TerminalKeys send={send} attach={attachPhotos} state={inputState} sessionId={sessionId} isPromptWaiting={isPromptWaiting} />
        </div>
      )}
    </div>
  )
}

/** A finished message never changes, so it renders once. */
const Message = memo(function Message({ m }: { m: ChatMessage }) {
  if (m.kind === 'user') {
    return (
      <div data-msg-id={m.id} className="flex justify-end py-1.5">
        <div className="max-w-[85%] min-w-0 whitespace-pre-wrap rounded-[12px] rounded-br-[4px] bg-panel-2 px-3 py-2 text-[14px] leading-relaxed text-fg [overflow-wrap:anywhere]" title={m.ts}>
          {m.text}
        </div>
      </div>
    )
  }
  if (m.kind === 'assistant') {
    return (
      <div data-msg-id={m.id} className="py-1.5 [&_div]:text-fg [&>div]:text-[14px]">
        <Prose text={m.text} />
      </div>
    )
  }
  if (m.kind === 'notice') return <NoticeLine m={m} />
  return <ToolLine m={m} />
}, (a, b) => a.m.id === b.m.id && a.m.text === b.m.text && a.m.result === b.m.result && a.m.failed === b.m.failed && a.m.exitCode === b.m.exitCode)

/** What Claude Code told itself (a background task done, a reminder): one quiet line, the text behind it. */
function NoticeLine({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-msg-id={m.id} className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-[12px] text-fg-faint hover:bg-panel-2"
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

function ToolLine({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const shownInput = toolInputText(m.tool ?? '', m.input)
  const result = m.result ?? ''
  return (
    <div data-msg-id={m.id} className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-[12.5px] hover:bg-panel-2 ${m.failed ? 'text-danger' : 'text-fg-muted'}`}
      >
        <ChevronIcon size={12} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        <span className="mono min-w-0 flex-1 truncate">{m.text}</span>
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
