/**
 * "What happened" — the Home screen's activity block as moments, not commands.
 *
 * The raw feed (lib/feed.ts) gave every tool call a line, so a busy hour read
 * as `sed -n 150,260p …`, `cat …/tasks/b20x0vmxc.output`, `ls`, `grep` — the
 * owner (2026-10-14, translated): "This block is completely uninformative."
 * Measured on his machine, nine calls in ten are reads, searches and other
 * look-arounds that change nothing.
 *
 * A moment is something a person would tell a colleague: files were edited,
 * tests ran and passed (or failed, with the exit code), a commit with its
 * message, a push, a pull request opened or merged, a subagent started or
 * finished, a session waiting on you, a command that failed. Everything else
 * is counted, not shown — `+38 calls` on the moment it led up to.
 *
 * Outcomes are read, never guessed. Claude Code sends PostToolUse only for a
 * call that succeeded; a call that failed reaches us from the transcript as a
 * result with `is_error` and Claude's own "Exit code N" line. So a test run
 * with a hook result passed, one with an error result failed with that code,
 * and one with neither says so — "no result recorded" — instead of choosing.
 *
 * Pure: the component keeps a window of raw events and calls toMoments on it,
 * so a live frame that lands before the history seed cannot leave the moments
 * in the wrong order.
 */
import type { Event } from '@/lib/api'
import { codexScript, normalInput, toolCommand } from '@/lib/chat'
import { commandTarget, shortPath } from '@/lib/cockpit'

export type MomentKind =
  | 'edit' | 'test' | 'build' | 'commit' | 'push' | 'pr' | 'release' | 'failed'
  | 'subagent' | 'subagent.done' | 'turn' | 'ask' | 'start' | 'end'
  | 'compact' | 'clear' | 'throttle' | 'task'

/** What a call's result says: passed, failed with a code, or not known. */
export type Outcome = 'ok' | 'fail' | 'interrupted' | 'background' | 'running' | 'unknown'

export interface Moment {
  /** Stable across recomputes: the kind and the first event it was built from. */
  id: string
  kind: MomentKind
  sessionId: string
  /** The newest event folded into it, unix ms. */
  ts: number
  /** How many same-kind moments were folded into this one (×N). */
  count: number
  /** Calls before it that were not moments: reads, searches, look-arounds. */
  quiet: number
  outcome?: Outcome
  exitCode?: number
  /** Files edited, as the session's folder names them, in order, unique. */
  files?: string[]
  /** The command, a commit message, a PR title, a subagent's task. */
  detail?: string
  /** Words for the verb: "tests" or "checks"; a PR's action. */
  label?: string
  pr?: number
  /** The subagent that did it, when it was not the session's main thread:
   *  its task as it was launched ("Fix PTY width after phone attach"), else
   *  "a subagent". */
  agent?: string
}

export interface MomentLine {
  icon: string
  text: string
  detail?: string
  tone: 'normal' | 'ok' | 'warn' | 'danger'
}

/** Folding stops at a quarter of an hour: an edit after lunch is a new moment. */
const MERGE_WINDOW_MS = 15 * 60_000
/** A test with no result this long after it started is not "running" any more. */
const RUNNING_MS = 10 * 60_000

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : flat
}

// ── Shell commands ──────────────────────────────────────────────────────────

/** The kinds a shell command can be, strongest first. */
type CmdKind = 'pr' | 'release' | 'push' | 'commit' | 'test' | 'build' | 'read' | 'other'

/** Shell words that only set up the next command. */
const SETUP = /^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*|export|cd|pushd|popd|set|source|timeout|gtimeout|\.|env|sudo|time|nohup|exec|command)$/

/** Programs whose run looks around and changes nothing worth a line. */
const READS = new Set([
  'cat', 'sed', 'head', 'tail', 'ls', 'grep', 'rg', 'egrep', 'fgrep', 'find', 'fd', 'wc', 'echo', 'printf',
  'pwd', 'which', 'type', 'file', 'stat', 'jq', 'yq', 'awk', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp',
  'tree', 'less', 'more', 'du', 'df', 'date', 'sleep', 'true', 'false', 'test', '[', 'until', 'while', 'for',
  'if', 'sqlite3', 'curl', 'ps', 'pgrep', 'lsof', 'sysctl', 'basename', 'dirname', 'realpath', 'readlink',
  'uname', 'id', 'whoami', 'hostname', 'xxd', 'od', 'strings', 'shasum', 'md5', 'base64', 'column', 'nl',
  'tee', 'man', 'dig', 'nslookup', 'ping', 'open', 'mkdir', 'touch', 'kill', 'wait',
])

/** Shell grammar around a command in a loop or a condition. */
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'done', 'fi', 'xargs', '{', '}'])

/** git and gh subcommands that only read. */
const GIT_READS = /^(status|log|diff|show|branch|rev-parse|remote|fetch|config|ls-files|ls-tree|blame|describe|reflog|shortlog|grep|cat-file|merge-base|worktree|stash|tag\s*$|-)/
const GH_READS = /^(pr (view|list|checks|diff|status)|run (view|list|watch)|api|issue (view|list)|release (view|list)|repo view|auth|search|workflow (view|list))/

/** The segments of a command line: one per program run, setup removed. */
function segments(cmd: string): string[][] {
  const out: string[][] = []
  // A heredoc body is data, not commands.
  const body = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1(?=\s|$)/g, '<<$1')
  for (const part of body.split(/\n|;|&&|\|\||\|/)) {
    const words = part.trim().replace(/^[({!]\s*/, '').split(/\s+/).filter(Boolean)
    while (words.length && (SETUP.test(words[0]!) || KEYWORDS.has(words[0]!))) {
      // `cd dir`, `export X=1`, `set -e`: the word after the setup word is its argument.
      const w = words.shift()!
      if (/^(cd|pushd|source|\.|set|timeout|gtimeout)$/.test(w) && words.length) words.shift()
      // `env -i HOME=… prog`, `xargs -0 grep`: their flags are not the program.
      if (/^(env|xargs|sudo|nohup|time)$/.test(w)) while (words.length && /^-/.test(words[0]!)) words.shift()
    }
    if (words.length) out.push(words)
  }
  return out
}

/** `git -C dir commit` reads as `git commit`. */
function gitWords(words: string[]): string[] {
  const w = [...words]
  for (let i = 1; i < w.length - 1; ) {
    if (w[i] === '-C' || w[i] === '-c') { w.splice(i, 2); continue }
    break
  }
  return w
}

function segKind(raw: string[]): CmdKind {
  let words = raw
  const prog = (words[0] ?? '').split('/').pop() ?? ''
  if (prog === 'git') words = gitWords(words)
  const rest = words.slice(1).join(' ')
  // Package runners wrap the program they run.
  const run = /^(npx|bunx|pnpx)$/.test(prog) ? words.slice(1).join(' ') : `${prog} ${rest}`.trim()
  if (prog === 'gh') {
    // `gh -R owner/repo pr view` reads as `gh pr view`.
    const r = words.slice(1)
    while (r.length > 1 && /^(-R|--repo)$/.test(r[0]!)) r.splice(0, 2)
    const rest = r.join(' ')
    if (/^pr (create|merge|close|ready|reopen)\b/.test(rest)) return 'pr'
    if (/^release create\b/.test(rest)) return 'release'
    return GH_READS.test(rest) ? 'read' : 'other'
  }
  if (prog === 'git') {
    if (/^push\b/.test(rest)) return 'push'
    if (/^commit\b/.test(rest)) return 'commit'
    if (/^tag\s+(-a\s+|-s\s+)?v?\d/.test(rest)) return 'release'
    return GIT_READS.test(rest) || rest === '' ? 'read' : 'other'
  }
  if (/^(go (test|vet)|gotestsum|vitest|jest|mocha|playwright test|pytest|cargo (test|nextest|clippy)|bun test|deno test|tsc\b|eslint|golangci-lint|staticcheck|ruff|mypy|rspec|phpunit)\b/.test(run)) return 'test'
  if (/^python3? -m (pytest|unittest|mypy|ruff)\b/.test(run)) return 'test'
  if (/^(npm|pnpm|yarn|bun) (run )?(test|typecheck|lint|check)\b/.test(run)) return 'test'
  if (/^make (-\S+ (\S+ )?)*(test|tests|check|lint|vet|smoke|typecheck)\b/.test(run)) return 'test'
  if (/^(go (build|install)|cargo build|vite build|goreleaser|docker build|xcodebuild|swift build)\b/.test(run)) return 'build'
  if (/^(npm|pnpm|yarn|bun) (run )?build\b/.test(run)) return 'build'
  if (/^make (-\S+ (\S+ )?)*(build|dist|release|app|ui|install)\b/.test(run)) return 'build'
  if (READS.has(prog)) return 'read'
  // `python3 -c '…'` and `node -e '…'` are, nearly always, a look at some data.
  if (/^(python3?|node|ruby|perl)$/.test(prog) && /^(-I\s+)?-[ce]\b/.test(rest)) return 'read'
  return 'other'
}

/** A run that lints or type-checks rather than tests: judged by its program words, not its paths. */
function checksOnly(target: string): boolean {
  const words = target.split(' ').filter((w) => !w.includes('/') && !w.startsWith('.')).join(' ')
  return /\b(lint|vet|typecheck|tsc|eslint|clippy|check|golangci-lint|staticcheck|ruff|mypy)\b/.test(words) && !/\btests?\b/.test(words)
}

const RANK: CmdKind[] = ['pr', 'release', 'push', 'commit', 'test', 'build', 'other', 'read']

/** What a whole command line is: its strongest segment. */
export function commandKind(cmd: string): CmdKind {
  const kinds = segments(cmd).map(segKind)
  if (kinds.length === 0) return 'read'
  return RANK.find((k) => kinds.includes(k)) ?? 'read'
}

/** The words of the segment that made the command its kind, for the detail. */
function segmentOf(cmd: string, kind: CmdKind): string {
  const seg = segments(cmd).find((s) => segKind(s) === kind)
  return seg ? seg.join(' ') : cmd
}

/** A commit message's first line, from `-m "…"` or a heredoc. */
export function commitMessage(cmd: string): string {
  const here = /<<-?\s*['"]?(\w+)['"]?\s*\n\s*([^\n]*)/.exec(cmd)
  if (here && here[2]!.trim()) return oneLine(here[2]!, 90)
  const m = /(?:^|\s)(?:-m|--message)(?:=|\s+)(["'])([\s\S]*?)\1/.exec(cmd)
  if (m) return oneLine(m[2]!.split('\n')[0]!, 90)
  return ''
}

function prTitle(cmd: string): string {
  const m = /--title(?:=|\s+)(["'])([\s\S]*?)\1/.exec(cmd) ?? /\s-t\s+(["'])([\s\S]*?)\1/.exec(cmd)
  return m ? oneLine(m[2]!, 90) : ''
}

function pushTarget(cmd: string): string {
  const seg = segments(cmd).find((s) => segKind(s) === 'push')
  if (!seg) return ''
  const words = gitWords(seg).slice(2).filter((w) => !w.startsWith('-') && !/[<>&]/.test(w))
  const ref = words.length >= 2 ? words[words.length - 1]! : ''
  return ref === 'HEAD' ? '' : ref.replace(/^HEAD:/, '')
}

function releaseTag(cmd: string): string {
  const m = /gh release create\s+(\S+)/.exec(cmd) ?? /git\s+(?:-C\s+\S+\s+)?tag\s+(?:-[as]\s+)?(v?\d\S*)/.exec(cmd)
  return m ? m[1]!.replace(/^['"]|['"]$/g, '') : ''
}

// ── Results ─────────────────────────────────────────────────────────────────

/** The text of a tool result, whatever shape the plane stored it in. */
function resultText(resp: unknown): string {
  if (typeof resp === 'string') return resp
  if (Array.isArray(resp)) return resp.map((b) => str(rec(b).text)).join('\n')
  const r = rec(resp)
  return str(r.stdout) || str(r.output) || str(r.error)
}

interface CallResult {
  outcome: Outcome
  exitCode?: number
  resp: Record<string, unknown>
}

function readResult(post: Event | undefined, preTs: number, now: number): CallResult {
  if (!post) {
    return { outcome: now - preTs < RUNNING_MS ? 'running' : 'unknown', resp: {} }
  }
  const p = rec(post.payload)
  const resp = rec(p.tool_response)
  if (p.is_error === true || str(p.hook_event_name) === 'PostToolUseFailure') {
    const m = /Exit code (\d+)/.exec(resultText(p.tool_response) || str(p.error))
    return { outcome: 'fail', exitCode: m ? Number(m[1]) : undefined, resp }
  }
  if (resp.interrupted === true) return { outcome: 'interrupted', resp }
  if (str(resp.backgroundTaskId)) return { outcome: 'background', resp }
  return { outcome: 'ok', resp }
}

// ── Building ────────────────────────────────────────────────────────────────

interface Call {
  useId: string
  first: Event
  pre?: Event
  posts: Event[]
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const SHELL_TOOLS = new Set(['Bash', 'exec', 'shell', 'local_shell', 'exec_command'])
/** Kinds that fold into the one before when they repeat (×N, a file list). */
const MERGEABLE = new Set<MomentKind>(['edit', 'test', 'build', 'commit', 'push', 'failed', 'subagent', 'subagent.done', 'ask', 'compact', 'throttle'])

function tsOf(e: Event): number {
  const t = Date.parse(e.ts)
  return Number.isNaN(t) ? 0 : t
}

function toolOf(e: Event): string {
  return e.tool || str(rec(e.payload).tool_name)
}

/** The post that tells a call's result: an error beats a success, a hook post beats a bare transcript one. */
function decisive(posts: Event[]): Event | undefined {
  return posts.find((p) => rec(p.payload).is_error === true) ?? posts.find((p) => p.source === 'hook') ?? posts[0]
}

/**
 * toMoments turns a window of raw events into moments, newest first.
 * `now` decides whether a call with no result yet is still running.
 * `tasks` names subagents launched before the window (agent id → the task it
 * was given, from `/v1/sessions/{id}/subagents`); launches inside the window
 * name themselves.
 */
export function toMoments(events: readonly Event[], now: number, cap = 60, known?: ReadonlyMap<string, string>): Moment[] {
  const seen = new Set<number>()
  const sorted = [...events].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.id - b.id)

  // Pair each call's start with its results by tool_use_id. A post with no
  // start in the window still counts: the hook post carries the input too.
  const calls = new Map<string, Call>()
  const callAt = new Map<number, Call>()
  for (const e of sorted) {
    if (e.kind !== 'tool.pre' && e.kind !== 'tool.post') continue
    const use = str(rec(e.payload).tool_use_id)
    if (!use) {
      if (e.kind === 'tool.pre') callAt.set(e.id, { useId: '', first: e, pre: e, posts: [] })
      continue
    }
    let c = calls.get(use)
    if (!c) {
      c = { useId: use, first: e, posts: [] }
      calls.set(use, c)
      callAt.set(e.id, c)
    }
    if (e.kind === 'tool.pre') c.pre ??= e
    else c.posts.push(e)
  }
  // A subagent's task, by the id its launch handed back, so its finish can name it.
  const tasks = new Map<string, string>(known ?? [])
  for (const c of calls.values()) {
    if (!['Agent', 'Task'].includes(toolOf(c.pre ?? c.first))) continue
    const desc = str(normalInput(rec((c.pre ?? c.first).payload).tool_input).description)
    for (const p of c.posts) {
      const id = str(rec(rec(p.payload).tool_response).agentId)
      if (id && desc) tasks.set(id, desc)
    }
  }

  // A subagent's last stop in the window, and only if it made no call after.
  const lastStop = new Map<string, number>()
  for (const e of sorted) {
    if (!e.agent_id) continue
    if (e.kind === 'agent.stop') lastStop.set(e.agent_id, e.id)
    else if (e.kind === 'tool.pre') lastStop.delete(e.agent_id)
  }

  const out: Moment[] = []
  const last = new Map<string, Moment>()
  const quiet = new Map<string, number>()

  const add = (e: Event, m: Omit<Moment, 'id' | 'sessionId' | 'ts' | 'count' | 'quiet'>, ts = tsOf(e)) => {
    const sid = e.session_id
    // One lane per thread: a session's main thread and each of its subagents
    // fold separately, or six parallel subagents interleave and nothing ever
    // repeats back to back.
    const lane = `${sid}/${e.agent_id ?? ''}`
    const prev = last.get(lane)
    const q = quiet.get(lane) ?? 0
    quiet.set(lane, 0)
    if (prev && prev.kind === m.kind && MERGEABLE.has(m.kind) && ts - prev.ts < MERGE_WINDOW_MS &&
      prev.outcome === m.outcome && prev.label === m.label && (m.kind !== 'failed' || prev.detail === m.detail)) {
      prev.count++
      prev.ts = Math.max(prev.ts, ts)
      prev.quiet += q
      if (m.files) prev.files = [...new Set([...(prev.files ?? []), ...m.files])]
      if (m.detail && m.kind !== 'failed') prev.detail = prev.kind === 'subagent' || prev.kind === 'subagent.done' ? joinTasks(prev.detail, m.detail) : m.detail
      if (m.exitCode !== undefined) prev.exitCode = m.exitCode
      return
    }
    const agent = e.agent_id ? tasks.get(e.agent_id) || 'subagent' : undefined
    const moment: Moment = { ...m, id: `${m.kind}:${e.id}`, sessionId: sid, ts, count: 1, quiet: q, ...(agent ? { agent } : {}) }
    out.push(moment)
    last.set(lane, moment)
  }
  const hush = (e: Event) => {
    const lane = `${e.session_id}/${e.agent_id ?? ''}`
    quiet.set(lane, (quiet.get(lane) ?? 0) + 1)
  }

  for (const e of sorted) {
    const p = rec(e.payload)
    const sub = !!e.agent_id
    switch (e.kind) {
      case 'tool.pre':
      case 'tool.post': {
        const c = callAt.get(e.id)
        if (!c) continue // a later half of a call already placed
        const start = c.pre ?? c.first
        const tool = toolOf(start) || c.posts.map(toolOf).find(Boolean) || ''
        const input = normalInput(rec((c.pre ?? c.posts.find((x) => rec(x.payload).tool_input) ?? start).payload).tool_input)
        const cwd = str(rec(start.payload).cwd)
        const post = decisive(c.posts)
        const res = readResult(post, tsOf(start), now)
        const ts = post ? tsOf(post) : tsOf(start)
        if (EDIT_TOOLS.has(tool) || (tool === 'exec' && codexScript(str(input.command))?.call === 'apply_patch')) {
          if (res.outcome === 'fail') { hush(start); continue }
          let path = str(input.file_path) || str(input.notebook_path)
          if (!path && tool === 'exec') path = (codexScript(str(input.command))?.line ?? '').slice('apply_patch '.length).trim()
          if (!path) { hush(start); continue }
          add(start, { kind: 'edit', files: [shortPath(path, cwd)], outcome: undefined }, ts)
          continue
        }
        if (tool === 'Agent' || tool === 'Task') {
          const desc = str(input.description) || str(input.subagent_type)
          add(start, { kind: 'subagent', detail: desc || undefined, outcome: undefined })
          continue
        }
        if (!SHELL_TOOLS.has(tool)) { hush(start); continue }
        const cmd = toolCommand(tool, input)
        if (!cmd) { hush(start); continue }
        const kind = commandKind(cmd)
        const target = commandTarget(segmentOf(cmd, kind), cwd) || oneLine(cmd, 48)
        const base = { outcome: res.outcome, exitCode: res.exitCode }
        switch (kind) {
          case 'test':
            add(start, { ...base, kind: 'test', label: checksOnly(target) ? 'checks' : 'tests', detail: target }, ts)
            break
          case 'build':
            add(start, { ...base, kind: 'build', detail: target }, ts)
            break
          case 'commit':
            add(start, { ...base, kind: 'commit', detail: commitMessage(cmd) || undefined }, ts)
            break
          case 'push':
            add(start, { ...base, kind: 'push', detail: pushTarget(cmd) || undefined }, ts)
            break
          case 'release':
            add(start, { ...base, kind: 'release', detail: releaseTag(cmd) || undefined }, ts)
            break
          case 'pr': {
            const op = rec(rec(res.resp.gitOperation).pr)
            const action = str(op.action) || (/gh pr merge/.test(cmd) ? 'merged' : /gh pr create/.test(cmd) ? 'created' : /gh pr close/.test(cmd) ? 'closed' : 'updated')
            const num = typeof op.number === 'number' ? op.number : Number(/gh pr (?:merge|close|ready|reopen)\s+(\d+)/.exec(cmd)?.[1] ?? 0) || undefined
            if (action === 'edited' && res.outcome === 'ok') { hush(start); break }
            add(start, { ...base, kind: 'pr', label: action, pr: num, detail: action === 'created' ? prTitle(cmd) || undefined : undefined }, ts)
            break
          }
          default:
            // A look-around, or a run that worked: counted, not shown. A
            // command that changes things and failed is worth a line.
            if (kind === 'other' && res.outcome === 'fail') add(start, { ...base, kind: 'failed', detail: target }, ts)
            else hush(start)
        }
        continue
      }
      case 'agent.stop': {
        if (sub) {
          // A SubagentStop with no agent_type is one of Claude Code's own
          // helpers (the one-line progress summaries): 1,743 of 1,846 stops
          // in a day on the owner's machine, none of them work anyone asked
          // for. And a subagent stops after every turn — one waiting on CI
          // stopped eight times — so only its last stop in view is the finish.
          if (!str(p.agent_type) && !tasks.has(e.agent_id!)) continue
          if (lastStop.get(e.agent_id!) !== e.id) continue
          add(e, { kind: 'subagent.done', detail: tasks.get(e.agent_id!) || undefined })
        } else {
          // Claude's Stop: the turn is over and the session waits on you. It
          // was labelled "session ended" — 313 times on the owner's machine in
          // a day in which no session ended.
          const said = str(p.last_assistant_message).split('\n').map((l) => l.trim()).find(Boolean) ?? ''
          add(e, { kind: 'turn', detail: said ? oneLine(said.replace(/[*_`#>]/g, ''), 120) : undefined })
        }
        continue
      }
      case 'agent.spawn': {
        const src = str(p.source)
        // `compact` and `clear` restart the same session; they are not starts.
        if (src === 'compact' || src === 'clear') continue
        add(e, { kind: 'start', label: src === 'resume' ? 'resumed' : src === 'fork' ? 'forked' : 'started' })
        continue
      }
      case 'session.end':
        add(e, { kind: 'end' })
        continue
      case 'permission.prompt':
      case 'approval.requested':
        add(e, { kind: 'ask', detail: str(e.tool) || str(p.tool_name) || undefined })
        continue
      case 'context.compact':
        add(e, { kind: 'compact' })
        continue
      case 'context.clear':
        add(e, { kind: 'clear' })
        continue
      case 'throttle':
        add(e, { kind: 'throttle' })
        continue
      case 'task.created':
      case 'task.done':
        add(e, { kind: 'task', label: e.kind === 'task.done' ? 'done' : 'created' })
        continue
      default:
        continue
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, cap)
}

/** Keys of a tool's input and result that moments and the raw feed read. */
const INPUT_KEYS = ['command', 'file_path', 'notebook_path', 'description', 'subagent_type', 'pattern', 'url', 'query', 'skill', 'cmd']
const RESULT_KEYS = ['interrupted', 'backgroundTaskId', 'gitOperation', 'agentId', 'description', 'returnCodeInterpretation']

function clipText(v: unknown, n: number): unknown {
  return typeof v === 'string' && v.length > n ? v.slice(0, n) : v
}

/**
 * The fields of an event this block reads, and nothing else. A live frame
 * carries the whole stored payload — up to 32 KB of a command's output — and
 * the block keeps a window of a thousand-odd events, so it keeps the command,
 * the path, the error's first lines and the result's flags, not the output.
 */
export function slimEvent(e: Event): Event {
  const p = rec(e.payload)
  const q: Record<string, unknown> = {}
  for (const k of ['tool_use_id', 'tool_name', 'cwd', 'is_error', 'hook_event_name', 'source', 'agent_type', 'error']) {
    if (k in p) q[k] = clipText(p[k], 400)
  }
  if (p.tool_input && typeof p.tool_input === 'object') {
    const ti = rec(p.tool_input)
    q.tool_input = Object.fromEntries(INPUT_KEYS.filter((k) => k in ti).map((k) => [k, clipText(ti[k], 4000)]))
  }
  const tr = p.tool_response
  if (typeof tr === 'string') q.tool_response = tr.slice(0, 200)
  else if (Array.isArray(tr)) q.tool_response = tr.slice(0, 1).map((b) => ({ type: 'text', text: str(rec(b).text).slice(0, 200) }))
  else if (tr && typeof tr === 'object') {
    const r = rec(tr)
    q.tool_response = Object.fromEntries(RESULT_KEYS.filter((k) => k in r).map((k) => [k, r[k]]))
  }
  if ('last_assistant_message' in p) q.last_assistant_message = clipText(p.last_assistant_message, 400)
  return { ...e, payload: q }
}

function joinTasks(a: string | undefined, b: string): string {
  if (!a) return b
  return a.split(' · ').includes(b) ? a : `${a} · ${b}`
}

/** A file list as a short phrase: the first two names, then "+N". */
function fileList(files: string[]): string {
  const names = files.map((f) => f.split('/').pop() ?? f)
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
}

/** The folder all the files share, when they share one. */
function commonDir(files: string[]): string {
  const dirs = files.map((f) => f.split('/').slice(0, -1))
  if (dirs.some((d) => d.length === 0 || d[0] === '…')) return ''
  const first = dirs[0] ?? []
  let n = first.length
  for (const d of dirs) {
    let i = 0
    while (i < n && d[i] === first[i]) i++
    n = i
  }
  return first.slice(0, n).join('/')
}

function times(n: number): string {
  return n > 1 ? ` ×${n}` : ''
}

function exit(m: Moment): string {
  return m.exitCode !== undefined ? ` (exit ${m.exitCode})` : ''
}

/** The words a moment is shown in. */
export function momentLine(m: Moment): MomentLine {
  switch (m.kind) {
    case 'edit': {
      const files = m.files ?? []
      if (files.length === 1) return { icon: '✎', text: `edited${times(m.count)}`, detail: files[0], tone: 'normal' }
      const dir = commonDir(files)
      return { icon: '✎', text: `edited ${files.length} files${dir ? ` in ${dir}` : ''}`, detail: fileList(files), tone: 'normal' }
    }
    case 'test':
    case 'build': {
      const what = m.kind === 'build' ? 'build' : m.label ?? 'tests'
      const verb = m.kind === 'build'
        ? { ok: 'built', fail: `build failed${exit(m)}`, interrupted: 'build interrupted', background: 'build started in the background', running: 'building…', unknown: 'built — no result recorded' }
        : { ok: `${what} passed`, fail: `${what} failed${exit(m)}`, interrupted: `${what} interrupted`, background: `${what} started in the background`, running: `running ${what}…`, unknown: `ran ${what} — no result recorded` }
      const o = m.outcome ?? 'unknown'
      return { icon: o === 'ok' ? '✓' : o === 'fail' ? '✕' : '▷', text: verb[o] + times(m.count), detail: m.detail, tone: o === 'ok' ? 'ok' : o === 'fail' ? 'danger' : 'normal' }
    }
    case 'commit':
      if (m.outcome === 'fail') return { icon: '✕', text: `commit failed${exit(m)}`, detail: m.detail, tone: 'danger' }
      return { icon: '●', text: m.count > 1 ? `committed ×${m.count}` : 'committed', detail: m.detail, tone: 'normal' }
    case 'push':
      if (m.outcome === 'fail') return { icon: '✕', text: `push failed${exit(m)}`, detail: m.detail, tone: 'danger' }
      return { icon: '↑', text: `pushed${times(m.count)}`, detail: m.detail, tone: 'normal' }
    case 'release':
      if (m.outcome === 'fail') return { icon: '✕', text: `release failed${exit(m)}`, detail: m.detail, tone: 'danger' }
      return { icon: '◆', text: 'released', detail: m.detail, tone: 'ok' }
    case 'pr': {
      const n = m.pr ? ` #${m.pr}` : ''
      if (m.outcome === 'fail') return { icon: '✕', text: `PR${n} ${m.label === 'merged' ? 'merge' : m.label ?? ''} failed${exit(m)}`.replace(/\s+/g, ' '), detail: m.detail, tone: 'danger' }
      const verb = m.label === 'created' ? 'opened' : m.label ?? 'updated'
      return { icon: '⇡', text: `${verb} PR${n}`, detail: m.detail, tone: m.label === 'merged' ? 'ok' : 'normal' }
    }
    case 'failed':
      return { icon: '✕', text: `command failed${exit(m)}${times(m.count)}`, detail: m.detail, tone: 'danger' }
    case 'subagent':
      return { icon: '⚑', text: m.count > 1 ? `started ${m.count} subagents` : 'started a subagent', detail: m.detail, tone: 'normal' }
    case 'subagent.done':
      return { icon: '⚐', text: m.count > 1 ? `${m.count} subagents finished` : 'subagent finished', detail: m.detail, tone: 'normal' }
    case 'turn':
      return { icon: '⏎', text: 'your turn', detail: m.detail, tone: 'normal' }
    case 'ask':
      return { icon: '!', text: `waiting for your approval${times(m.count)}`, detail: m.detail, tone: 'warn' }
    case 'start':
      return { icon: '▸', text: `session ${m.label ?? 'started'}`, tone: 'ok' }
    case 'end':
      return { icon: '■', text: 'session ended', tone: 'normal' }
    case 'compact':
      return { icon: '⇱', text: `compacted its context${times(m.count)}`, tone: 'warn' }
    case 'clear':
      return { icon: '⌫', text: 'context cleared', tone: 'warn' }
    case 'throttle':
      return { icon: '⏳', text: `rate-limited by the API${times(m.count)}`, tone: 'warn' }
    case 'task':
      return m.label === 'done'
        ? { icon: '✓', text: 'task verified — tests passed', tone: 'ok' }
        : { icon: '＋', text: 'task created', tone: 'normal' }
  }
}
