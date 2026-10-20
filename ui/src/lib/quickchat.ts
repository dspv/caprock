/**
 * What a quick chat is called, and what a window remembers about one.
 *
 * A quick chat lives in its own dated folder under the daemon's data
 * directory, `<data_dir>/chats/<YYYY-MM-DD-HHMMSS>[-N]` (internal/agents
 * newChatDir); the daemon labels its project the same way (internal/store
 * chatLabel). Its tab, its sidebar row and the inspector say "Quick chat ·
 * Opus 5.5" — the sidebar's Outside projects is the group it sits in, not its
 * name (owner, 2026-10-12: the tab said "Outside projects").
 *
 * The model is the pricing table's name once the chat has answered
 * (`model_display`); before that, the model it was started on, which only
 * the window that started it knows, so that window keeps it here.
 */
import type { SessionSummary } from './api'

const STARTED_KEY = 'caprock.quickchat.started'
const HINT_KEY = 'caprock.quickchat.hint'
/** Enough for every chat a person keeps open; the oldest are forgotten first. */
const KEEP = 40

/** A chat's own folder name: the daemon's stamp, with a counter for a second chat in the same second. */
const STAMP = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/

/** Whether a session is a quick chat, by the folder the daemon gave it. */
export function isQuickChat(s: Pick<SessionSummary, 'cwd'> | undefined): boolean {
  if (!s?.cwd) return false
  const parts = s.cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length >= 2 && parts[parts.length - 2] === 'chats' && STAMP.test(parts[parts.length - 1]!)
}

/** What a window that started a chat remembers of it: the agent, and the model's short name. */
export interface StartedChat { agent: string; model: string; label: string }

function readStarted(): Record<string, StartedChat> {
  try {
    const v = JSON.parse(localStorage.getItem(STARTED_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Record<string, StartedChat>) : {}
  } catch {
    return {}
  }
}

export function rememberStartedChat(sessionId: string, c: StartedChat) {
  const all = readStarted()
  delete all[sessionId]
  const kept = Object.entries(all).slice(-(KEEP - 1))
  try { localStorage.setItem(STARTED_KEY, JSON.stringify(Object.fromEntries([...kept, [sessionId, c]]))) } catch { /* the name falls back to the agent's */ }
}

export function startedChat(sessionId: string): StartedChat | undefined {
  const c = readStarted()[sessionId]
  return c && typeof c.agent === 'string' ? c : undefined
}

const AGENTS: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', grok: 'Grok', deepseek: 'DeepSeek', 'claude.ai': 'Claude.ai', chatgpt: 'ChatGPT' }

/** The agent's short name: "Claude", "Codex". */
export function chatAgentName(agent: string | undefined): string {
  const a = agent || 'claude'
  return AGENTS[a] ?? a
}

/** The model's name for a chat: the pricing table's, else the one it was started on; '' when neither is known. */
export function chatModel(s: Pick<SessionSummary, 'session_id' | 'model_display'>): string {
  return s.model_display || startedChat(s.session_id)?.label || ''
}

/** "Quick chat · Opus 5.5"; "Quick chat · Codex" when the model is the agent's own default. */
export function quickChatTitle(s: Pick<SessionSummary, 'session_id' | 'model_display' | 'agent'>): string {
  return `Quick chat · ${chatModel(s) || chatAgentName(s.agent ?? startedChat(s.session_id)?.agent)}`
}

/** When a chat started, as its row says it: "09:40" today, else "19 Oct 09:40". */
export function chatStartedAt(ms: number | undefined, now = Date.now()): string {
  if (!ms) return ''
  const d = new Date(ms)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date(now).toDateString()) return time
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const date = d.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  return `${date} ${time}`
}

/**
 * The quiet words after a quick chat's title in a sidebar row: its model,
 * unless the title already says it ("Quick chat · Opus 5.5"), and, for a
 * row with no tab, when it started — the one thing that tells two chats
 * apart once their tabs are gone.
 */
export function chatRowSuffix(s: Pick<SessionSummary, 'session_id' | 'model_display' | 'started_at'>, title: string, tabless: boolean, now = Date.now()): { model?: string; when?: string } {
  const m = chatModel(s)
  const out: { model?: string; when?: string } = {}
  if (m && !title.includes(m)) out.model = m
  if (tabless) {
    const when = chatStartedAt(s.started_at, now)
    if (when) out.when = when
  }
  return out
}

/**
 * How long a quick chat with no tab stays under "Running, no tab" once it
 * has answered and sits at its prompt (lib/sidebar.ts): ten minutes, long
 * enough to come back to an answer you walked away from, short enough that
 * a chat whose tab was lost does not stay there for days (owner, 2026-10-20).
 * After that it is on the Chats screen and in the palette.
 */
export const CHAT_LINGER_MS = 10 * 60 * 1000

/** The agent's command that ends it: Gemini's is /quit, the others take /exit. */
function exitCommand(agent: string | undefined): string {
  return agent === 'gemini' ? '/quit' : '/exit'
}

/**
 * The line above a quick chat's terminal: who it is with, and the two ways
 * out. Closing the tab ends the chat too (AppShell requestClose), so both
 * say "ends it". `closeKey` is ⌘W in this platform's words.
 */
export function quickChatHint(s: Pick<SessionSummary, 'session_id' | 'model_display' | 'agent'>, closeKey: string): string {
  const agent = s.agent ?? startedChat(s.session_id)?.agent
  const model = chatModel(s)
  return `Quick chat with ${chatAgentName(agent)}${model ? ` · ${model}` : ''} — ${closeKey} or ${exitCommand(agent)} ends it`
}

export function hintDismissed(): boolean {
  try { return localStorage.getItem(HINT_KEY) === 'dismissed' } catch { return false }
}

export function dismissHint() {
  try { localStorage.setItem(HINT_KEY, 'dismissed') } catch { /* shown again next time */ }
}
