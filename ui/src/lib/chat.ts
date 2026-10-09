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
  /** The shell's exit code, where the agent recorded one (Codex's `shell`). */
  exitCode?: number
  /**
   * A tool call that will never get a result: its turn ended first. Only a
   * call with neither a result nor this is still running.
   */
  interrupted?: boolean
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

/**
 * A tool call's input as an object, with a command line under `command` where
 * there is one.
 *
 * Codex rows stored before the daemon unwrapped them carry a function call's
 * arguments as the JSON string they arrive in —
 * `{command: '{"command":["bash","-lc","ls"]}'}` — and `shell`'s command as an
 * argv array; both are read here as the daemon now stores them, so a row whose
 * transcript is gone reads right too.
 */
export function normalInput(input: unknown): Record<string, unknown> {
  let i = (input ?? {}) as Record<string, unknown>
  if (typeof i !== 'object' || Array.isArray(i)) return {}
  if (typeof i.command === 'string' && i.command.trimStart().startsWith('{')) {
    try {
      const inner: unknown = JSON.parse(i.command)
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) i = inner as Record<string, unknown>
    } catch {
      // JavaScript that opens with a brace, not JSON: a command as it is.
    }
  }
  if (Array.isArray(i.command) && i.command.every((w) => typeof w === 'string')) {
    const argv = i.command as string[]
    const line = argv.length === 3 && (argv[1] === '-lc' || argv[1] === '-c') ? argv[2]! : argv.join(' ')
    i = { ...i, command: line }
  }
  return i
}

/** A JavaScript string literal opening at `src[at]`, decoded; null when there is none. */
function jsString(src: string, at: number): string | null {
  const q = src[at]
  if (q !== '"' && q !== "'" && q !== '`') return null
  let out = ''
  for (let k = at + 1; k < src.length; k++) {
    const c = src[k]!
    if (c === q) return out
    if (c !== '\\') {
      out += c
      continue
    }
    const n = src[++k]
    if (n === undefined) return null
    if (n === 'n') out += '\n'
    else if (n === 't') out += '\t'
    else if (n === 'r') out += '\r'
    else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(k + 1, k + 5))) {
      out += String.fromCharCode(parseInt(src.slice(k + 1, k + 5), 16))
      k += 4
    } else out += n
  }
  return null
}

/**
 * What a Codex `exec` script ran, read out of the JavaScript it sends.
 *
 * `exec` does not run a command: it runs a script that calls Codex's own
 * tools — `tools.exec_command({cmd: "git status"})` for a shell command,
 * `tools.apply_patch(…)` for an edit. Shown as sent, every line read as a wall
 * of JavaScript. The shell command is the `cmd` string; any other call is
 * named, with the file it patches where it says. `call` is the tool it
 * called. Null when the input is not such a script.
 */
export function codexScript(script: string): { line: string; detail: string; call: string } | null {
  const call = /tools\.([A-Za-z0-9_]+)\(/.exec(script)
  if (!call) return null
  const name = call[1]!
  if (name === 'exec_command') {
    const key = /["']?cmd["']?\s*:\s*/g
    key.lastIndex = call.index
    const m = key.exec(script)
    const cmd = m ? jsString(script, m.index + m[0].length) : null
    if (cmd !== null && cmd.trim()) return { line: cmd.trim().split('\n')[0]!, detail: cmd, call: name }
  }
  if (name === 'apply_patch') {
    const file = /\*\*\* (?:Add|Update|Delete) File: ([^\n\\]+)/.exec(script)
    if (file) return { line: `apply_patch ${file[1]!.trim()}`, detail: script, call: name }
  }
  return { line: name, detail: script, call: name }
}

/**
 * The command line a call ran, where it ran one: Codex's `exec` script read
 * for what it ran (codexScript), a `shell` argv as its line, a Bash command as
 * it is. '' for a call that carries no command. The daemon reads the same way
 * (internal/toolcmd) for the Now phrase, notifications and loop alerts.
 */
export function toolCommand(tool: string, input: unknown): string {
  const i = normalInput(input)
  if (typeof i.command !== 'string') return ''
  if (tool === 'exec') return codexScript(i.command)?.line ?? i.command
  return i.command
}

/** A tool call as one line: its name and the first line of what it was given. */
export function toolLine(tool: string, input: unknown): string {
  const i = normalInput(input)
  if (tool === 'exec' && typeof i.command === 'string') {
    const run = codexScript(i.command)
    if (run) return `${tool}  ${run.line}`
  }
  const arg = i.command ?? i.cmd ?? i.file_path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt ?? i.title ?? i.code ?? ''
  const first = String(arg).split('\n')[0]!.trim()
  return first ? `${tool}  ${first}` : tool
}

/** A tool call's input in full, for the open line: the command where there is one, else the input as JSON. */
export function toolInputText(tool: string, input: unknown): string {
  const i = normalInput(input)
  if (typeof i.command === 'string') {
    const run = tool === 'exec' ? codexScript(i.command) : null
    return run ? run.detail : i.command
  }
  if (typeof i.cmd === 'string') return i.cmd
  if (typeof i.code === 'string') return i.code
  return JSON.stringify(input ?? {}, null, 2)
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

/**
 * Whether `e` ends the turn a still-unanswered call belongs to: a prompt the
 * person typed (a harness notice is not one), or the main thread's Stop.
 */
function endsTurn(e: Event): boolean {
  if (!isMainThread(e)) return false
  if (e.kind === 'agent.stop' || e.kind === 'session.end') return true
  return e.kind === 'turn.user' && textOf(e).trim() !== '' && noticeLine(textOf(e)) === null
}

/**
 * The conversation in `events`, which must already be in server order.
 *
 * A call with no result is running only while its turn is: once the turn has
 * ended — the next prompt, a Stop, the session over (`ended`), or the agent's
 * own record that it ended (Codex's `interrupted` result, written at
 * turn_aborted) — nothing will ever answer it, and it reads "interrupted".
 * It used to say "running" forever.
 */
export function toMessages(events: readonly Event[], opts: { ended?: boolean } = {}): ChatMessage[] {
  const results = new Map<string, { text: string; failed: boolean; exitCode?: number; interrupted?: boolean }>()
  let lastEnd = -1
  events.forEach((e, k) => {
    if (endsTurn(e)) lastEnd = k
    if (e.kind !== 'tool.post') return
    const p = payloadOf(e)
    const use = typeof p.tool_use_id === 'string' ? p.tool_use_id : ''
    if (!use) return
    if (p.interrupted === true) {
      // The agent's mark that no output came; a real output, if one ever
      // does, wins whichever arrives first.
      if (!results.has(use)) results.set(use, { text: '', failed: false, interrupted: true })
      return
    }
    const exitCode = typeof p.exit_code === 'number' ? p.exit_code : undefined
    results.set(use, { text: resultText(p.tool_response), failed: p.is_error === true, exitCode })
  })
  const out: ChatMessage[] = []
  events.forEach((e, k) => {
    if (!isMessageEvent(e)) return
    if (e.kind === 'tool.pre') {
      const p = payloadOf(e)
      const tool = e.tool || String(p.tool_name ?? 'tool')
      const r = typeof p.tool_use_id === 'string' ? results.get(p.tool_use_id) : undefined
      const msg: ChatMessage = { id: e.id, kind: 'tool', ts: e.ts, text: toolLine(tool, p.tool_input), tool, input: p.tool_input }
      if (r?.interrupted || (!r && (opts.ended || lastEnd > k))) msg.interrupted = true
      else if (r) Object.assign(msg, { result: r.text, failed: r.failed, exitCode: r.exitCode })
      out.push(msg)
    } else {
      const text = textOf(e)
      const notice = e.kind === 'turn.user' ? noticeLine(text) : null
      if (notice !== null) out.push({ id: e.id, kind: 'notice', ts: e.ts, text: notice, raw: text })
      else out.push({ id: e.id, kind: e.kind === 'turn.user' ? 'user' : 'assistant', ts: e.ts, text })
    }
  })
  return out
}
