/**
 * Turns raw live events into the one-line phrases the activity feed shows.
 *
 * The daemon narrates a session's *current* state (internal/narrate); the feed
 * needs something different — a short past-tense line per event, so a scroll
 * back through the last few minutes reads as a log of what actually happened
 * across every session on the machine.
 *
 * Anything we cannot describe usefully is dropped rather than rendered as a raw
 * kind: a feed of "tool.post" lines is noise, and noise is what makes people
 * stop looking at a feed.
 */
import type { Event } from '@/lib/api'

export interface FeedItem {
  id: string
  ts: number
  sessionId: string
  /** Repo the session runs in, when known — reads better than a session id. */
  project?: string
  /** Short verb-ish glyph shown in the gutter. */
  icon: string
  /** What happened, in plain words. */
  text: string
  /** Optional monospace detail (a path, a command). */
  detail?: string
  tone: 'normal' | 'ok' | 'warn' | 'danger'
}

interface ToolInput {
  file_path?: string
  command?: string
  description?: string
  url?: string
  query?: string
  skill?: string
  subagent_type?: string
  pattern?: string
}

interface EventPayload {
  tool_name?: string
  tool_input?: ToolInput
  is_error?: boolean
  text?: string
  model?: string
}

// Only the last path segment matters in a dense feed; the directory is noise.
function baseName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

// A shell line is mostly path noise: absolute paths crowd out the verb that
// makes the row worth reading. Shorten every long path to its last two
// segments, and collapse $HOME to ~, before clipping.
function shortenPaths(cmd: string): string {
  return cmd.replace(/(\/[\w.@%+-]+){3,}/g, (m) => {
    const parts = m.split('/').filter(Boolean)
    return '…/' + parts.slice(-2).join('/')
  })
}

// describeTool maps a tool call to a line. Returns null for tools whose calls
// say nothing a human would want in a feed.
function describeTool(tool: string, input: ToolInput): { icon: string; text: string; detail?: string } | null {
  switch (tool) {
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path ? { icon: '✎', text: 'editing', detail: baseName(input.file_path) } : null
    case 'Write':
      return input.file_path ? { icon: '✎', text: 'writing', detail: baseName(input.file_path) } : null
    case 'Read':
      return input.file_path ? { icon: '◇', text: 'reading', detail: baseName(input.file_path) } : null
    case 'Bash':
      return input.command ? { icon: '$', text: 'running', detail: clip(shortenPaths(input.command), 46) } : null
    case 'Grep':
    case 'Glob':
      return { icon: '⌕', text: 'searching', detail: clip(input.pattern ?? input.query ?? '', 40) || undefined }
    case 'WebFetch':
    case 'WebSearch':
      return { icon: '⇢', text: 'fetching', detail: clip(input.url ?? input.query ?? '', 44) || undefined }
    case 'Agent':
      return { icon: '⚑', text: 'spawned a subagent', detail: input.subagent_type }
    case 'Skill':
      return { icon: '⚑', text: 'invoked skill', detail: input.skill }
    case 'TodoWrite':
      return { icon: '☑', text: 'updated its plan' }
    default:
      // A tool we have no phrasing for still reads fine as its own name.
      return tool ? { icon: '·', text: 'used', detail: tool } : null
  }
}

/**
 * toFeedItem converts one live event into a feed line, or null to drop it.
 * `project` is looked up by the caller (events carry only a session id).
 */
export function toFeedItem(e: Event, project?: string): FeedItem | null {
  const payload = (e.payload ?? {}) as EventPayload
  const ts = Date.parse(e.ts)
  const base = {
    id: `${e.id}`,
    ts: Number.isNaN(ts) ? Date.now() : ts,
    sessionId: e.session_id,
    project,
  }

  switch (e.kind) {
    case 'tool.pre': {
      const tool = payload.tool_name ?? e.tool ?? ''
      const d = describeTool(tool, payload.tool_input ?? {})
      return d ? { ...base, ...d, tone: 'normal' } : null
    }
    case 'tool.post':
      // Only failures are worth a line — successes are implied by what follows.
      return payload.is_error
        ? { ...base, icon: '✕', text: 'a tool call failed', tone: 'danger' }
        : null
    case 'agent.spawn':
      return { ...base, icon: '▸', text: 'session started', tone: 'ok' }
    case 'agent.stop':
      return { ...base, icon: '■', text: 'session ended', tone: 'normal' }
    case 'context.compact':
      return { ...base, icon: '⇱', text: 'compacted its context', tone: 'warn' }
    case 'throttle':
      return { ...base, icon: '⏳', text: 'rate-limited by the API', tone: 'warn' }
    case 'task.created':
      return { ...base, icon: '＋', text: 'task created', tone: 'normal' }
    case 'task.done':
      return { ...base, icon: '✓', text: 'task verified — tests passed', tone: 'ok' }
    case 'approval.requested':
      return { ...base, icon: '!', text: 'needs your approval', tone: 'warn' }
    // turn.assistant / turn.user / cost.tick / mail.* carry no line a human
    // wants in a feed; the numbers they drive are shown elsewhere.
    default:
      return null
  }
}

/** Newest-first, capped — the feed is a window, never a growing buffer. */
export function pushItem(items: FeedItem[], item: FeedItem, cap = 60): FeedItem[] {
  if (items.length > 0 && items[0]!.id === item.id) return items
  return [item, ...items].slice(0, cap)
}
