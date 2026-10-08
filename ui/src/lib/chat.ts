/**
 * The chat view's model (WP-14): a session's stored events turned into the
 * conversation — what you typed, what the agent wrote, and each tool call on
 * one line.
 *
 * **Order comes from the server, never from arrival.** The daemon orders a
 * session's events by `(ts, id)` (store.EventsBefore), and every event carries
 * its row id, which never changes. Events are merged by that id and sorted by
 * that key, so a frame delivered late, or replayed after a reconnect, lands
 * where it belongs and never twice (owner, 2026-10-05: Orca showed an old
 * message as just sent, after newer ones). The live feed's own frame `seq`
 * (WP-12) decides only what to ask for again; it plays no part here.
 */
import type { Event } from './api'

export type ChatKind = 'user' | 'assistant' | 'tool' | 'notice'

export interface ChatMessage {
  /** The event's id: stable, unique, the React key. */
  id: number
  kind: ChatKind
  ts: string
  /** The prompt, the reply, or a tool call's one-line summary. */
  text: string
  tool?: string
  /** A tool call's input, as sent. */
  input?: unknown
  /** A tool call's output, once its result arrived. */
  result?: string
  failed?: boolean
  /** A notice's full text, behind its one line. */
  raw?: string
}

const msCache = new Map<string, number>()

/** An event's timestamp in ms; the daemon stores ms, so nothing finer is lost. */
function msOf(ts: string): number {
  let v = msCache.get(ts)
  if (v === undefined) {
    v = Date.parse(ts)
    if (!Number.isFinite(v)) v = 0
    if (msCache.size > 50_000) msCache.clear()
    msCache.set(ts, v)
  }
  return v
}

/** The server's order: by time, then by id (ORDER BY ts, id). */
export function compareEvents(a: Pick<Event, 'ts' | 'id'>, b: Pick<Event, 'ts' | 'id'>): number {
  return msOf(a.ts) - msOf(b.ts) || a.id - b.id
}

/**
 * `current` with `incoming` added: each id once, in server order. Returns
 * `current` itself when nothing was new, so a replayed frame renders nothing.
 */
export function mergeEvents(current: readonly Event[], incoming: readonly Event[]): readonly Event[] {
  if (incoming.length === 0) return current
  const seen = new Set(current.map((e) => e.id))
  const fresh: Event[] = []
  for (const e of incoming) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    fresh.push(e)
  }
  if (fresh.length === 0) return current
  fresh.sort(compareEvents)
  const last = current[current.length - 1]
  // The usual case: everything new is newer than everything held.
  if (!last || compareEvents(fresh[0]!, last) > 0) return [...current, ...fresh]
  return [...current, ...fresh].sort(compareEvents)
}

/** A subagent's own steps belong to its tool call in the main thread, not to the conversation. */
function isMainThread(e: Event): boolean {
  if (e.agent_id) return false
  const p = e.payload as { sidechain?: boolean } | null
  return p?.sidechain !== true
}

function payloadOf(e: Event): Record<string, unknown> {
  return (e.payload ?? {}) as Record<string, unknown>
}

/** The text a user or assistant event carries; DeepSeek Harness keeps a prompt as `text`. */
function textOf(e: Event): string {
  const p = payloadOf(e)
  return String((e.kind === 'turn.user' ? p.prompt ?? p.text : p.text) ?? '')
}

/** Whether an event becomes a message of its own (a tool result joins its call). */
export function isMessageEvent(e: Event): boolean {
  if (!isMainThread(e)) return false
  if (e.kind === 'tool.pre') return true
  if (e.kind === 'turn.user' || e.kind === 'turn.assistant') return textOf(e).trim() !== ''
  return false
}

/** A tool call as one line: its name and the first line of what it was given. */
export function toolLine(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const arg = i.command ?? i.file_path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt ?? ''
  const first = String(arg).split('\n')[0]!.trim()
  return first ? `${tool}  ${first}` : tool
}

function resultText(r: unknown): string {
  if (r === undefined || r === null) return ''
  return typeof r === 'string' ? r : JSON.stringify(r, null, 2)
}

/** XML-ish blocks Claude Code writes into the user's turn itself, not typed by anyone. */
const HARNESS = /^\s*<(task-notification|system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|bash-stdout|bash-input)>/

function tag(text: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
  return m ? m[1]!.trim() : ''
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/**
 * A user turn Claude Code wrote for itself — a background task finishing, a
 * reminder, a slash command's output — as one line, or null for a real
 * prompt. Shown as a speech bubble it read as the user pasting XML, a screen
 * long (owner, 2026-10-08).
 */
export function noticeLine(text: string): string | null {
  const m = HARNESS.exec(text)
  if (!m) return null
  switch (m[1]) {
    case 'task-notification': {
      const summary = unescape(tag(text, 'summary'))
      const status = tag(text, 'status')
      const line = (summary || `background task ${status || 'update'}`).split('\n')[0]!
      return line.length > 160 ? `${line.slice(0, 157)}…` : line
    }
    case 'command-name':
    case 'command-message':
      return tag(text, 'command-name') || tag(text, 'command-message') || 'command'
    case 'local-command-stdout':
    case 'local-command-stderr':
    case 'bash-stdout':
      return 'command output'
    case 'bash-input':
      return `! ${tag(text, 'bash-input')}`
    default:
      return 'system note'
  }
}

/** The conversation in `events`, which must already be in server order. */
export function toMessages(events: readonly Event[]): ChatMessage[] {
  const results = new Map<string, { text: string; failed: boolean }>()
  for (const e of events) {
    if (e.kind !== 'tool.post') continue
    const p = payloadOf(e)
    const use = typeof p.tool_use_id === 'string' ? p.tool_use_id : ''
    if (use) results.set(use, { text: resultText(p.tool_response), failed: p.is_error === true })
  }
  const out: ChatMessage[] = []
  for (const e of events) {
    if (!isMessageEvent(e)) continue
    if (e.kind === 'tool.pre') {
      const p = payloadOf(e)
      const tool = e.tool || String(p.tool_name ?? 'tool')
      const r = typeof p.tool_use_id === 'string' ? results.get(p.tool_use_id) : undefined
      out.push({ id: e.id, kind: 'tool', ts: e.ts, text: toolLine(tool, p.tool_input), tool, input: p.tool_input, result: r?.text, failed: r?.failed })
    } else {
      const text = textOf(e)
      const notice = e.kind === 'turn.user' ? noticeLine(text) : null
      if (notice !== null) out.push({ id: e.id, kind: 'notice', ts: e.ts, text: notice, raw: text })
      else out.push({ id: e.id, kind: e.kind === 'turn.user' ? 'user' : 'assistant', ts: e.ts, text })
    }
  }
  return out
}
