/**
 * The agent cockpit's derivations (.ai/21-app.md § Agent cockpit): what the
 * panel beside an agent's terminal reads out of the figures Caprock already
 * holds — the session row the sidebar fetches, the session's own events, and
 * the day's summary for the plan windows.
 *
 * Every function here is pure, so the panel's honesty can be tested without a
 * DOM: a figure the data does not carry comes back undefined, never zero.
 */
import type { Event, Permission, RateLimits, SessionSummary, Subagent, Summary } from './api'
import { toolCommand } from './chat'

/** What kind of work a tool call is, for its glyph and colour. */
export type ToolKind = 'edit' | 'read' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'ask' | 'mcp' | 'other'

/** One tool call: when it started, when its result came back (absent while it runs). */
export interface ToolRun {
  id: number
  tool: string
  kind: ToolKind
  /** The file, command, pattern or URL it was given — one short line. */
  detail: string
  startMs: number
  endMs?: number
  failed: boolean
}

/** One priced turn: what the model call cost. */
export interface TurnCost {
  id: number
  ts: number
  cost: number
}

export type CockpitState = 'working' | 'waiting' | 'looping' | 'idle' | 'ended'

/** Past this, a call with no result is not "running": its result was lost, or the agent was stopped. */
export const RUNNING_STALE_MS = 15 * 60_000

export function toolKind(tool: string): ToolKind {
  if (tool.startsWith('mcp__')) return 'mcp'
  switch (tool) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
    case 'edit': case 'write': case 'apply_patch': case 'patch':
      return 'edit'
    case 'Read': case 'NotebookRead': case 'read': case 'view':
      return 'read'
    case 'Bash': case 'BashOutput': case 'KillShell': case 'bash': case 'exec': case 'exec_command': case 'shell': case 'local_shell': case 'run_shell_command':
      return 'run'
    case 'Grep': case 'Glob': case 'LS': case 'ToolSearch': case 'grep': case 'glob': case 'list': case 'search_file_content':
      return 'search'
    case 'WebFetch': case 'WebSearch': case 'webfetch': case 'web_fetch': case 'web_search': case 'google_web_search':
      return 'web'
    case 'Agent': case 'Task': case 'task':
      return 'agent'
    case 'TodoWrite': case 'todowrite': case 'update_plan': case 'ExitPlanMode':
      return 'plan'
    case 'AskUserQuestion':
      return 'ask'
    default:
      return 'other'
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function base(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function oneLine(s: string, n = 80): string {
  const flat = s.split('\n')[0]!.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : flat
}

/** The short line a call was given: a file's name, a command, a pattern, a URL. */
export function toolDetail(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const file = str(i.file_path) || str(i.notebook_path) || str(i.filePath)
  if (file) return base(file)
  const cmd = i.command
  if (Array.isArray(cmd)) return oneLine(cmd.filter((x) => typeof x === 'string').join(' '))
  // Codex's exec carries a script: the line is what it ran (lib/chat).
  if (typeof cmd === 'string' && cmd) return oneLine(toolCommand(tool, input) || cmd)
  // A search's pattern says more than the folder it searched.
  const other = str(i.pattern) || str(i.query) || str(i.url) || str(i.description) || str(i.subagent_type) || str(i.skill) || str(i.prompt)
  if (other) return oneLine(other)
  if (str(i.path)) return base(str(i.path))
  if (tool.startsWith('mcp__')) return tool.replace(/^mcp__(.+?)__/, '$1·')
  return ''
}

/** A subagent's own steps are its parent call's business, not the session's line. */
export function mainThread(e: Event): boolean {
  if (e.agent_id) return false
  const p = e.payload as { sidechain?: boolean } | null
  return p?.sidechain !== true
}

function msOf(ts: string): number {
  const v = Date.parse(ts)
  return Number.isFinite(v) ? v : 0
}

/**
 * The main thread's tool calls, oldest first, each joined to its result. A
 * result is matched by `tool_use_id`; one without an id takes the oldest
 * unanswered call of the same tool. A call seen twice (both planes, a replay)
 * is kept once.
 */
export function toolRuns(events: readonly Event[]): ToolRun[] {
  const runs: ToolRun[] = []
  const byUse = new Map<string, ToolRun>()
  const open = new Map<string, ToolRun[]>()
  for (const e of events) {
    if (!mainThread(e)) continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    const tool = e.tool || str(p.tool_name)
    const use = str(p.tool_use_id)
    if (e.kind === 'tool.pre') {
      if (!tool) continue
      if (use && byUse.has(use)) continue
      const run: ToolRun = { id: e.id, tool, kind: toolKind(tool), detail: toolDetail(tool, p.tool_input), startMs: msOf(e.ts), failed: false }
      runs.push(run)
      if (use) byUse.set(use, run)
      else open.set(tool, [...(open.get(tool) ?? []), run])
    } else if (e.kind === 'tool.post') {
      let run = use ? byUse.get(use) : undefined
      if (!run) {
        const q = open.get(tool)
        run = q?.shift()
      }
      if (!run || run.endMs !== undefined) continue
      run.endMs = Math.max(run.startMs, msOf(e.ts))
      run.failed = p.is_error === true
    }
  }
  return runs
}

/** The call running now: the newest without a result, if it started recently and nothing came after it. */
export function runningTool(runs: readonly ToolRun[], now: number): ToolRun | undefined {
  const last = runs[runs.length - 1]
  if (!last || last.endMs !== undefined) return undefined
  return now - last.startMs < RUNNING_STALE_MS ? last : undefined
}

/** The main thread's priced model calls, oldest first — what each turn cost as it happened. */
export function turnCosts(events: readonly Event[]): TurnCost[] {
  const seen = new Set<number>()
  const out: TurnCost[] = []
  for (const e of events) {
    if (e.kind !== 'turn.assistant' || !mainThread(e) || typeof e.cost_usd !== 'number' || !Number.isFinite(e.cost_usd)) continue
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push({ id: e.id, ts: msOf(e.ts), cost: e.cost_usd })
  }
  return out
}

/** The state the character and the "now" line show. */
export function cockpitState(s: Pick<SessionSummary, 'status' | 'activity' | 'loop'>, hasPermission: boolean): CockpitState {
  if (s.status === 'ended') return 'ended'
  if (hasPermission) return 'waiting'
  switch (s.activity?.health) {
    case 'working': return 'working'
    case 'waiting-on-you': return 'waiting'
    case 'looping': case 'error': return 'looping'
    default: return 'idle'
  }
}

/** The plan windows that apply to this agent: Claude Code's from its status line, Codex's from its transcript; none for the rest. */
export function planWindowsFor(agent: string | undefined, summary: Summary | undefined): RateLimits | undefined {
  if (!summary) return undefined
  const limits = (agent ?? 'claude') === 'claude' ? summary.rate_limits : agent === 'codex' ? summary.codex_rate_limits : undefined
  if (!limits || (!limits.five_hour && !limits.seven_day)) return undefined
  return limits
}

/** "3s", "1.2s", "2m 04s": a tool call's duration, short enough for a column. */
export function fmtRun(ms: number): string {
  if (!(ms >= 0)) return ''
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10).toFixed(1)}s`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A duration's share of the bar beside it: log-scaled, so a 40 s build and a 0.3 s read both show. */
export function runShare(ms: number, maxMs: number): number {
  if (!(ms > 0) || !(maxMs > 0)) return 0
  const v = Math.log10(1 + ms / 100) / Math.log10(1 + maxMs / 100)
  return Math.max(0.04, Math.min(1, v))
}

/** The verb a running call is described by. */
export function runVerb(kind: ToolKind): string {
  switch (kind) {
    case 'edit': return 'Editing'
    case 'read': return 'Reading'
    case 'run': return 'Running'
    case 'search': return 'Searching'
    case 'web': return 'Fetching'
    case 'agent': return 'Delegating to a subagent'
    case 'plan': return 'Updating its plan'
    case 'ask': return 'Asking you'
    case 'mcp': return 'Calling'
    default: return 'Using'
  }
}

/**
 * Whether a subagent waits on a permission prompt: its newest event is one,
 * or the session's outstanding prompts include one it asked.
 */
export function subagentWaiting(a: Pick<Subagent, 'agent_id' | 'asking'>, p?: Permission | null): boolean {
  if (a.asking) return true
  if (!p) return false
  return (p.waiting ?? [p]).some((w) => w.agent_id === a.agent_id)
}

/** Who asked a permission prompt: "Subagent (general-purpose)", or the agent itself. */
export function requester(p: Pick<Permission, 'agent_id' | 'agent_type'>, agent = 'Claude'): string {
  if (!p.agent_id) return agent
  const t = (p.agent_type ?? '').trim()
  return t && t !== 'subagent' ? `Subagent (${t})` : 'Subagent'
}

/** "Subagent (general-purpose) wants to run Bash": the prompt's question, naming who asks. */
export function askLine(p: Pick<Permission, 'agent_id' | 'agent_type' | 'tool'>, agent = 'Claude'): string {
  const tool = p.tool.startsWith('mcp__') ? p.tool.replace(/^mcp__(.+?)__/, '$1·') : p.tool
  return `${requester(p, agent)} wants to ${toolKind(p.tool) === 'run' ? 'run' : 'use'} ${tool}`
}

/**
 * The first part of a command that says what it does: the leading variable
 * assignments, `cd` and `set -e` that set a shell up are skipped, so
 * `C=/tmp/x; rm -f $C/*; ls` reads `rm -f $C/*`. `more` says something was
 * left out, and the full text belongs beside it.
 */
export function commandGist(detail: string, n = 100): { gist: string; more: boolean } {
  const parts = detail.split(/\n|;|&&|\|\|/).map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return { gist: '', more: false }
  const setup = (s: string) => /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(s) || /^cd(\s|$)/.test(s) || /^set\s+[-+]\w+$/.test(s)
  const i = Math.max(0, parts.findIndex((s) => !setup(s)))
  const first = parts[i]!.replace(/\s+/g, ' ')
  const chars = [...first]
  const clipped = chars.length > n
  return { gist: clipped ? chars.slice(0, n - 1).join('') + '…' : first, more: clipped || parts.length > 1 }
}
