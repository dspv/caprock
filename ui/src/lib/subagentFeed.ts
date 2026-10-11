/**
 * A subagent opened in the cockpit (.ai/21-app.md § Agent cockpit): its calls
 * as the daemon read them (`/subagents/{agent}`), then followed on the live
 * socket — the frames the page already receives, no polling. Pure, so the
 * follow rule can be tested without a DOM.
 */
import type { Event, SubagentCall } from './api'
import { toolDetail } from './cockpit'

/** Calls the feed shows at first and adds per "Show earlier". */
export const FEED_PAGE = 30

/** Prompts and results longer than this many lines (or characters) fold to six lines with "Show all". */
const CLAMP_LINES = 6
const CLAMP_CHARS = 420

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** True when a text is long enough to fold. */
export function needsClamp(text: string): boolean {
  return text.split('\n').length > CLAMP_LINES || [...text].length > CLAMP_CHARS
}

/**
 * The feed after one live event, or the same array when the event is not
 * this subagent's call or its result: a call is appended once (a call heard
 * on both planes shares its tool_use_id), a result closes its call.
 */
export function followSubagent(calls: readonly SubagentCall[], e: Event, sessionId: string, agentId: string): readonly SubagentCall[] {
  if (e.session_id !== sessionId || e.agent_id !== agentId) return calls
  const p = (e.payload ?? {}) as Record<string, unknown>
  const use = str(p.tool_use_id)
  const ts = Date.parse(e.ts)
  const at = Number.isFinite(ts) ? ts : Date.now()
  if (e.kind === 'tool.pre') {
    const tool = e.tool || str(p.tool_name)
    if (!tool) return calls
    if (use && calls.some((c) => c.tool_use_id === use)) return calls
    if (!use && calls.some((c) => c.id === e.id)) return calls
    const detail = toolDetail(tool, p.tool_input)
    return [...calls, { id: e.id, tool_use_id: use || undefined, tool, detail: detail || undefined, started_at: at }]
  }
  if (e.kind === 'tool.post') {
    const tool = e.tool || str(p.tool_name)
    let i = use ? calls.findIndex((c) => c.tool_use_id === use) : -1
    if (i < 0 && !use) i = calls.findIndex((c) => c.ended_at === undefined && !c.tool_use_id && c.tool === tool)
    if (i < 0 || calls[i]!.ended_at !== undefined) return calls
    const next = calls.slice()
    next[i] = { ...calls[i]!, ended_at: Math.max(calls[i]!.started_at, at), error: p.is_error === true || undefined }
    return next
  }
  return calls
}
