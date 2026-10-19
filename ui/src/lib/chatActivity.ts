/**
 * What a chat's agent is doing right now, read from the session's events
 * (.ai/04-ui.md § Chat, *Working*): whether a turn is open — a prompt with no
 * Stop after it — since when, and the call it is running, if any.
 *
 * A turn can run for minutes before the first word arrives, and a chat that
 * shows nothing in that time reads as broken (a user's report, 2026-10-19:
 * "no sign the agent was thinking about anything").
 */
import type { Event } from './api'
import { noticeLine, normalInput, toolCommand } from './chat'
import { runVerb, toolKind } from './cockpit'

export interface TurnState {
  /** The prompt's timestamp: when the turn began. */
  since: string
  /** The call it runs now, as a phrase ("Running npm test"); '' while it thinks. */
  step: string
}

function mainThread(e: Event): boolean {
  if (e.agent_id) return false
  return (e.payload as { sidechain?: boolean } | null)?.sidechain !== true
}

function promptText(e: Event): string {
  const p = (e.payload ?? {}) as Record<string, unknown>
  return String(p.prompt ?? p.text ?? '')
}

function baseName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** A running call as a phrase: the verb for its kind and what it works on. */
export function stepPhrase(tool: string, input: unknown): string {
  const kind = toolKind(tool)
  const i = normalInput(input)
  const str = (v: unknown) => (typeof v === 'string' ? v.split('\n')[0]!.trim() : '')
  let what = ''
  switch (kind) {
    case 'run': what = str(toolCommand(tool, input)); break
    case 'read': case 'edit': what = baseName(str(i.file_path ?? i.notebook_path ?? i.path)); break
    case 'search': what = str(i.pattern ?? i.query ?? i.path); break
    case 'web': what = str(i.url ?? i.query); break
    case 'agent': return str(i.description) ? `Delegating: ${str(i.description)}` : runVerb(kind)
    case 'plan': case 'ask': return runVerb(kind)
    default: what = tool
  }
  if (what.length > 80) what = `${what.slice(0, 79)}…`
  if (!what) return kind === 'read' ? 'Reading files' : kind === 'run' ? 'Running a command' : `${runVerb(kind)} ${tool}`
  return `${runVerb(kind)} ${what}`
}

/**
 * The open turn in `events` (server order), or null when there is none: no
 * prompt yet, the main thread's Stop after the last prompt, or the session
 * over. A harness notice (a background task done) is not a prompt.
 */
export function openTurn(events: readonly Event[], ended = false): TurnState | null {
  if (ended) return null
  const done = new Set<string>()
  let running: Event | null = null
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k]!
    if (!mainThread(e)) continue
    if (e.kind === 'agent.stop' || e.kind === 'session.end') return null
    if (e.kind === 'tool.post') {
      const use = (e.payload as { tool_use_id?: unknown } | null)?.tool_use_id
      if (typeof use === 'string') done.add(use)
      continue
    }
    if (e.kind === 'tool.pre' && !running) {
      const use = (e.payload as { tool_use_id?: unknown } | null)?.tool_use_id
      if (typeof use !== 'string' || !done.has(use)) running = e
      continue
    }
    if (e.kind === 'turn.user') {
      const text = promptText(e)
      if (!text.trim() || noticeLine(text) !== null) continue
      if (!running) return { since: e.ts, step: '' }
      const p = (running.payload ?? {}) as Record<string, unknown>
      return { since: e.ts, step: stepPhrase(running.tool || String(p.tool_name ?? 'tool'), p.tool_input) }
    }
  }
  return null
}

/** The agent's name in "Claude is thinking…", from the session's `agent`. */
export function agentDisplayName(agent?: string): string {
  switch (agent) {
    case undefined: case '': case 'claude': return 'Claude'
    case 'codex': return 'Codex'
    case 'opencode': return 'OpenCode'
    case 'gemini': return 'Gemini'
    case 'deepseek': return 'DeepSeek'
    case 'hermes': return 'Hermes'
    default: return 'The agent'
  }
}

/** Elapsed time as m:ss, or h:mm:ss past an hour. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** One piece of a prompt: the person's own words, or a block they pasted. */
export type PromptPart =
  | { kind: 'text'; text: string }
  | { kind: 'pasted'; text: string; lines: number }

/**
 * Claude Code wraps pasted text in the prompt it records —
 * `<pasted_content id="…">…</pasted_content id="…">` — and a reminder it adds
 * as `<system-reminder>…</system-reminder>`. A bubble showed both raw.
 */
const WRAPPED = /<pasted_content(?:\s[^>]*)?>([\s\S]*?)<\/pasted_content(?:\s[^>]*)?>|<system-reminder>[\s\S]*?<\/system-reminder>|\[Pasted text #\d+(?: \+(\d+) lines?)?\]/g

/**
 * A prompt split into what was typed and what was pasted, in order. Reminders
 * are dropped; a paste placeholder whose text was never recorded
 * (`[Pasted text #1 +12 lines]`) becomes a pasted part that says so.
 */
export function promptParts(text: string): PromptPart[] {
  const out: PromptPart[] = []
  const words = (s: string) => {
    const t = s.replace(/^[ \t]*\n+|\n+[ \t]*$/g, '')
    if (t.trim()) out.push({ kind: 'text', text: t })
  }
  let at = 0
  for (const m of text.matchAll(WRAPPED)) {
    words(text.slice(at, m.index))
    at = m.index + m[0].length
    if (m[0].startsWith('<system-reminder>')) continue
    if (m[0].startsWith('[')) {
      const n = m[2] ? Number(m[2]) : 0
      out.push({ kind: 'pasted', text: '', lines: n })
      continue
    }
    const body = m[1]!.replace(/^\n+|\n+$/g, '')
    out.push({ kind: 'pasted', text: body, lines: body ? body.split('\n').length : 0 })
  }
  words(text.slice(at))
  return out
}

/** A prompt on one line: each paste as `[pasted · N lines]`, reminders gone. */
export function promptPlain(text: string): string {
  return promptParts(text)
    .map((p) => (p.kind === 'text' ? p.text : `[pasted${p.lines ? ` · ${p.lines} line${p.lines === 1 ? '' : 's'}` : ''}]`))
    .join(' ')
}
