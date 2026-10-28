/**
 * The agent cockpit's derivations (.ai/21-app.md § Agent cockpit): what the
 * panel beside an agent's terminal reads out of the figures Caprock already
 * holds — the session row the sidebar fetches, the session's own events, and
 * the day's summary for the plan windows.
 *
 * Every function here is pure, so the panel's honesty can be tested without a
 * DOM: a figure the data does not carry comes back undefined, never zero.
 */
import type { Event, Permission, RateLimits, SessionSummary, Subagent, SubagentsNow, Summary } from './api'
import { toolCommand } from './chat'
import { clip } from './clip'

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
  /** A failed command's exit code, where its result said one (*Exit code 1*, Codex's `exit_code`). */
  exit?: number
  /** The call was stopped before it finished (the hook's `tool_response.interrupted`, Codex's interrupted record). */
  interrupted?: boolean
  /** What the call was given, for the tool list's target (toolTarget). */
  input?: unknown
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
      const run: ToolRun = { id: e.id, tool, kind: toolKind(tool), detail: toolDetail(tool, p.tool_input), startMs: msOf(e.ts), failed: false, input: p.tool_input }
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
      const how = resultOutcome(p)
      if (how.exit !== undefined) run.exit = how.exit
      if (how.interrupted) run.interrupted = true
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

/**
 * How many subagents keep a session working after its turn ended — the
 * daemon's `activity.background` — or 0. Such a session waits on nobody; a
 * pending permission prompt still does, and outranks this.
 */
export function backgroundAgents(s: Pick<SessionSummary, 'status' | 'activity'>): number {
  if (s.status === 'ended') return 0
  const n = s.activity?.background ?? 0
  return n > 0 ? n : 0
}

/** "Background agents working · 2": what such a session says. */
export function backgroundLabel(n: number): string {
  return `Background agents working · ${n}`
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

/** A finished call this long or longer shows its duration in the tool list; a quicker one only its outcome. */
export const SLOW_MS = 5_000

/** The start of a call's result as text: a string, the first text block, or a shell's stderr. */
function resultText(r: unknown): string {
  if (typeof r === 'string') return r
  if (Array.isArray(r)) {
    for (const b of r) {
      const t = (b as { text?: unknown } | null)?.text
      if (typeof t === 'string') return t
    }
    return ''
  }
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    return str(o.content) || str(o.error) || str(o.stderr)
  }
  return ''
}

/**
 * What a `tool.post` says beyond success: a failed command's exit code
 * (Claude Code's transcript writes *Exit code 1* at the head of an erroring
 * Bash result; Codex records `exit_code`), and whether the call was stopped.
 */
export function resultOutcome(p: Record<string, unknown>): { exit?: number; interrupted?: boolean } {
  const out: { exit?: number; interrupted?: boolean } = {}
  if (typeof p.exit_code === 'number' && Number.isFinite(p.exit_code) && p.exit_code !== 0) out.exit = p.exit_code
  const r = p.tool_response
  if (p.interrupted === true || (r && typeof r === 'object' && !Array.isArray(r) && (r as { interrupted?: unknown }).interrupted === true)) out.interrupted = true
  if (p.is_error === true && out.exit === undefined) {
    const m = /^\s*(?:Error:\s*)?Exit code (\d+)/i.exec(resultText(r).slice(0, 200))
    if (m) out.exit = Number(m[1])
  }
  return out
}

/**
 * A `tool.post` as the cockpit holds it: the result's outcome and nothing of
 * its body. The payload carries the tool's whole answer (a command's output,
 * a file read in full, an edit's original file) and the tool list reads only
 * whether it failed, its exit code and whether it was stopped. Everything
 * else in the payload stays; `tool_input` goes too (the call's own
 * `tool.pre` has it). Other kinds pass through untouched.
 */
export function slimToolResult(e: Event): Event {
  if (e.kind !== 'tool.post' || !e.payload || typeof e.payload !== 'object') return e
  const p = e.payload as Record<string, unknown>
  const r = p.tool_response
  const out: Record<string, unknown> = { ...p }
  delete out.tool_response
  delete out.tool_input
  if (r && typeof r === 'object' && !Array.isArray(r) && (r as { interrupted?: unknown }).interrupted === true) out.interrupted = true
  // The head an erroring result's exit code is read from (resultOutcome).
  if (p.is_error === true) out.tool_response = clip(resultText(r), 200)
  return { ...e, payload: out }
}

function slashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * A file as the tool list names it: relative to the session's folder when it
 * is inside it (*ui/src/lib/cockpit.ts*), else its last two parts
 * (*…/scratchpad/shots.py*). A long relative path keeps its first folder
 * and its last two parts (*ui/…/components/Cockpit.tsx*), so the file's
 * name is never the part cut.
 */
export function shortPath(path: string, cwd?: string): string {
  const p = slashes(path)
  const root = slashes(cwd ?? '').replace(/\/+$/, '')
  // Windows paths compare without case.
  const fold = /^[A-Za-z]:/.test(p) ? (x: string) => x.toLowerCase() : (x: string) => x
  const rel = root && fold(p).startsWith(fold(root) + '/') ? p.slice(root.length + 1) : ''
  const parts = (rel || p).split('/').filter(Boolean)
  if (!rel) return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || path
  if (rel.length <= 40 || parts.length <= 3) return rel
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`
}

/** Shell words that run the next word rather than being the program. */
const WRAPPERS = new Set(['env', 'sudo', 'time', 'exec', 'nohup', 'command', 'xargs'])
/** Flags whose value is a folder, not something the command acts on. */
const DIR_FLAGS = new Set(['-C', '--prefix', '--cwd', '--dir', '--manifest-path'])

function isAbs(w: string): boolean {
  return w.startsWith('/') || /^[A-Za-z]:[\\/]/.test(w)
}

/**
 * What a command line runs, as a person would name it: its program and the
 * first two words it acts on (*go test ./internal/api*, *git commit*,
 * *python3 shots.py*). Leading `cd`, `set -e`, variable assignments
 * (`S=/private/tmp/… python3 …`) and `env`/`sudo` are skipped, as is
 * everything after a pipe; redirections are left out, a flag after the
 * first word and quoted text end it, and an absolute path reads as
 * shortPath does.
 */
export function commandTarget(cmd: string, cwd?: string): string {
  const parts = cmd.split(/\n|;|&&|\|\|/).map((x) => x.trim()).filter(Boolean)
  const setup = (x: string) => /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(x) || /^(cd|pushd|popd)(\s|$)/.test(x) || /^set\s+[-+]\w+$/.test(x)
  const first = parts.find((x) => !setup(x))
  if (!first) return ''
  const words = first.split(/\s\|(?:\s|$)/)[0]!.trim().split(/\s+/)
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || WRAPPERS.has(words[i]!))) i++
  const prog = words[i]
  if (!prog) return ''
  const out = [base(prog.replace(/^['"]|['"]$/g, ''))]
  for (let j = i + 1; j < words.length && out.length < 3; j++) {
    const w = words[j]!
    if (DIR_FLAGS.has(w)) { j++; continue }
    // A redirection and its file: `> out.txt`, `2>/dev/null`, `<<EOF`.
    if (/^\d*[<>]+&?$/.test(w)) { j++; continue }
    if (/^\d*[<>]/.test(w)) continue
    // A flag before the first word is skipped (`python3 -m pytest`); after
    // it, what follows is the flags' business (`shots.py --out a`).
    if (w.startsWith('-')) { if (out.length > 1) break; continue }
    if (/^['"$`(]/.test(w)) break
    out.push(isAbs(w) ? shortPath(w, cwd) : w)
  }
  return oneLine(out.join(' '), 48)
}

/**
 * The target the tool list shows for a call: a file relative to the
 * session's folder, a command as commandTarget names it, a search's pattern
 * in quotes, a page's host and path; else the short line the call already
 * carries (toolDetail).
 */
export function toolTarget(r: Pick<ToolRun, 'tool' | 'detail' | 'input'>, cwd?: string): string {
  const i = (r.input && typeof r.input === 'object' && !Array.isArray(r.input) ? r.input : {}) as Record<string, unknown>
  const file = str(i.file_path) || str(i.notebook_path) || str(i.filePath)
  if (file) return shortPath(file, cwd)
  const cmd = toolCommand(r.tool, r.input)
  if (cmd) return commandTarget(cmd, cwd) || r.detail
  const pattern = str(i.pattern)
  if (pattern) return `'${oneLine(pattern, 40)}'`
  const url = str(i.url)
  if (url) {
    try {
      const u = new URL(url)
      return oneLine(u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname), 48)
    } catch { /* not a URL: the detail */ }
  }
  if (!str(i.query) && str(i.path)) return shortPath(str(i.path), cwd)
  return r.detail
}

/** One row of the tool list: the newest of `count` calls in a row with the same tool, target and outcome. */
export interface ToolGroup {
  run: ToolRun
  count: number
  target: string
  /** The group's calls together, start to end, for the hover. */
  totalMs: number
}

/**
 * The newest calls as the tool list draws them, newest first, at most `rows`:
 * a run of finished calls with the same tool, target and outcome in a row
 * is one row with ×N (a Read of the same file five times, a test run
 * retried); a running or stopped call is never folded into another.
 */
export function toolGroups(runs: readonly ToolRun[], rows: number, cwd?: string): ToolGroup[] {
  const out: ToolGroup[] = []
  for (let k = runs.length - 1; k >= 0; k--) {
    const r = runs[k]!
    const target = toolTarget(r, cwd)
    const ms = r.endMs !== undefined ? Math.max(0, r.endMs - r.startMs) : 0
    const last = out[out.length - 1]
    if (last && r.endMs !== undefined && last.run.endMs !== undefined && last.run.tool === r.tool && last.target === target
      && last.run.failed === r.failed && last.run.exit === r.exit && !last.run.interrupted && !r.interrupted) {
      last.count++
      last.totalMs += ms
      continue
    }
    if (out.length === rows) break
    out.push({ run: r, count: 1, target, totalMs: ms })
  }
  return out
}

/** "now", "12s", "4m", "3h", "2d": how long ago, short enough for a column. */
export function fmtAge(ms: number): string {
  if (!(ms >= 0)) return ''
  const s = Math.floor(ms / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
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

/** One mini-avatar in the cockpit header's subagent strip. */
export interface SubagentChip {
  id: string
  /** The type's first letter, upper case: E for Explore, G for general-purpose; "·" when no hook named one. */
  initial: string
  state: 'working' | 'waiting' | 'done'
  /** One of four tints, fixed per type so an Explore is always the same colour. */
  tone: 0 | 1 | 2 | 3
  /** "Explore · find the pricing table · Haiku 4.5 · working". */
  label: string
}

/** Claude Code's own types keep a tint each, so the common three never share one. */
const KNOWN_TONES: Record<string, 0 | 1 | 2 | 3> = { 'general-purpose': 0, Explore: 1, Plan: 2 }

/** The tint a subagent type takes: fixed for the built-in types, a stable hash of the name otherwise. */
export function subagentTone(type: string | undefined): 0 | 1 | 2 | 3 {
  const known = type ? KNOWN_TONES[type] : undefined
  if (known !== undefined) return known
  let h = 0
  for (const ch of type ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (h % 4) as 0 | 1 | 2 | 3
}

/** A subagent type's letter, upper case: G for general-purpose, E for Explore; "·" when no hook named one. */
export function subagentInitial(type: string | undefined): string {
  return (type?.trim()[0] ?? '·').toUpperCase()
}

/**
 * What a subagent row says it is doing: the daemon's `doing` (its newest
 * call's own description, a phrase from its tool and target, or its task);
 * from a daemon that predates it, the task, else the raw call. `from` says
 * which, so the row can leave out a raw command a description already says.
 */
export function subagentDoing(a: Pick<Subagent, 'doing' | 'doing_from' | 'description' | 'tool' | 'detail'>): { text: string; from: 'call' | 'tool' | 'task' | '' } {
  if (a.doing) return { text: a.doing, from: a.doing_from ?? 'tool' }
  if (a.description) return { text: a.description, from: 'task' }
  if (a.tool) return { text: [a.tool.replace(/^mcp__(.+?)__/, '$1·'), a.detail].filter(Boolean).join(' '), from: 'tool' }
  return { text: '', from: '' }
}

/**
 * The header's strip, in the order the subagents started, so a chip keeps
 * its place while others start and finish (owner, 2026-10-14: "lay them out
 * in fives so you can see by fives how many there are", translated). The
 * working come first in the count: up to `max` of them, the earliest
 * started; the recently finished fill the places left, muted, in the same
 * start order. `more` counts the working left out — finished ones past the
 * strip are the Subagents section's business, not a count to chase.
 */
export function subagentChips(subs: SubagentsNow | undefined, permission?: Permission | null, max = MAX_SUBAGENT_CHIPS): { chips: SubagentChip[]; more: number } {
  if (!subs) return { chips: [], more: 0 }
  const chip = (a: { agent_id: string; agent_type?: string; description?: string; model_display?: string; started_at?: number }, state: SubagentChip['state']) => ({
    at: a.started_at ?? 0,
    chip: {
      id: a.agent_id,
      initial: subagentInitial(a.agent_type),
      state,
      tone: subagentTone(a.agent_type),
      label: [a.agent_type || 'subagent', a.description, a.model_display, state === 'waiting' ? 'waiting on you' : state === 'working' ? 'working' : 'finished'].filter(Boolean).join(' · '),
    } satisfies SubagentChip,
  })
  // A stable sort: the same start keeps the daemon's order.
  const byStart = <T extends { at: number }>(xs: T[]) => xs.map((x, i) => [x, i] as const).sort((p, q) => p[0].at - q[0].at || p[1] - q[1]).map(([x]) => x)
  const working = byStart(subs.working.map((a) => chip(a, subagentWaiting(a, permission) ? 'waiting' : 'working')))
  const shown = working.slice(0, max)
  const done = (subs.recent ?? []).slice(0, Math.max(0, max - shown.length)).map((a) => chip(a, 'done'))
  return { chips: byStart([...shown, ...done]).map((x) => x.chip), more: working.length - shown.length }
}

/** One kind of working subagent in the hero's line: its type, how many, and the first of them to open. */
export interface SubagentKind { type: string; count: number; first: string }

/**
 * The working subagents by type, for the hero's "3 subagents · 2 Explore,
 * 1 general-purpose" (owner, 2026-10-28, translated: "I need to understand
 * the configuration of the agents that are working right now"): the most
 * first, a tie in the order the first of each started. A subagent no hook
 * named is counted in the total and left out here, never given a type.
 */
export function subagentKinds(working: readonly { agent_id: string; agent_type?: string; started_at?: number }[]): SubagentKind[] {
  const by = new Map<string, SubagentKind & { at: number }>()
  for (const a of working) {
    if (!a.agent_type) continue
    const k = by.get(a.agent_type)
    const at = a.started_at ?? 0
    if (!k) by.set(a.agent_type, { type: a.agent_type, count: 1, first: a.agent_id, at })
    else {
      k.count++
      if (at < k.at) { k.at = at; k.first = a.agent_id }
    }
  }
  return [...by.values()].sort((p, q) => q.count - p.count || p.at - q.at).map(({ type, count, first }) => ({ type, count, first }))
}

/** Chips the cockpit's hero draws at most, compact, in the widest inspector. */
export const MAX_SUBAGENT_CHIPS = 80
/** Chips sit in groups of this many, a wider gap between groups: counted by fives at a glance. */
export const CHIP_GROUP = 5
/** Lines of chips the hero gives its subagents at most. */
export const CHIP_LINES = 2

/** A chip, the gap inside a group and between groups (px), as the hero draws them, at full size and compact. */
const CHIP_SIZES = {
  normal: { chip: 18, gap: 3, group: 8 },
  compact: { chip: 10, gap: 2, group: 6 },
} as const
/** The "+N" chip after the last group, with its gap. */
const MORE_PX = 34

/** How many whole groups fit one line of chips this wide, with room for "+N" or without; at least one. */
export function chipGroupsThatFit(width: number, withMore: boolean, size: keyof typeof CHIP_SIZES = 'normal'): number {
  const s = CHIP_SIZES[size]
  const groupPx = CHIP_GROUP * s.chip + (CHIP_GROUP - 1) * s.gap
  const room = width - (withMore ? MORE_PX : 0) + s.group
  return Math.max(1, Math.floor(room / (groupPx + s.group)))
}

/**
 * How the hero lays out its subagent chips in a row this wide: full-size,
 * in groups of five, wrapping onto a second line between groups; when the
 * working need more than two lines, compact chips — a smaller square, no
 * letter, the tint and state kept — so they fit in two; when even those
 * do not, as many as two compact lines hold with "+N" after them. `room` is
 * how many chips to draw. Decided from the width and the working count only.
 */
export function chipLayout(width: number, working: number): { compact: boolean; room: number } {
  const lines = (size: keyof typeof CHIP_SIZES) => chipGroupsThatFit(width, false, size) * CHIP_GROUP * CHIP_LINES
  const full = lines('normal')
  if (working <= full) return { compact: false, room: Math.min(MAX_SUBAGENT_CHIPS, full) }
  const compact = lines('compact')
  if (working <= compact) return { compact: true, room: Math.min(MAX_SUBAGENT_CHIPS, compact) }
  const capped = chipGroupsThatFit(width, false, 'compact') * CHIP_GROUP * (CHIP_LINES - 1) + chipGroupsThatFit(width, true, 'compact') * CHIP_GROUP
  return { compact: true, room: Math.min(MAX_SUBAGENT_CHIPS, capped) }
}

/** The chips in groups of five, in order: the hero wraps a line between groups, never inside one. */
export function chipGroups<T>(chips: readonly T[], size = CHIP_GROUP): T[][] {
  const out: T[][] = []
  for (let i = 0; i < chips.length; i += size) out.push(chips.slice(i, i + size))
  return out
}
