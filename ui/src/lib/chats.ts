/**
 * Chats as a kind of session (ADR-071, .ai/04-ui.md § Chats).
 *
 * A chat is a session Caprock started in its own chats workspace,
 * `<data_dir>/chats/<stamp>/`, to ask something rather than to work on a
 * repository. The daemon marks it (`chat`, migration 0059); a daemon from
 * before the mark is recognised by its folder (lib/quickchat isQuickChat).
 * A chat is read as a conversation (ChatView), never as a terminal, and is
 * listed on the Chats screen instead of with the work.
 */
import { api, type ChatFile, type ChatImport, type SessionSummary, type SpawnRequest } from './api'
import { chatAgentName, isQuickChat, rememberStartedChat, startedChat } from './quickchat'
import { quickChoiceLabel, rememberQuickChoice, type QuickChoice } from '@/components/QuickChat'
import { sessionAbout } from './sidebar'

/** Whether a session is a chat: marked so by the daemon, or in a chat's folder. */
export function isChat(s: Pick<SessionSummary, 'cwd' | 'chat'> | undefined): boolean {
  return !!s && (!!s.chat || isQuickChat(s))
}

/**
 * The service an imported chat came from (ADR-074): "Claude.ai" or
 * "ChatGPT", or '' for a chat Caprock ran. An imported chat is a copy of a
 * conversation held there, read here and never written into.
 */
export function importedFrom(s: Pick<SessionSummary, 'agent'> | undefined): string {
  if (s?.agent === 'claude.ai') return 'Claude.ai'
  if (s?.agent === 'chatgpt') return 'ChatGPT'
  return ''
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** One line on what an import did: "Read 12 conversations from ChatGPT: 3 new, 9 already here." */
export function importSummary(r: ChatImport): string {
  const names = Object.keys(r.sources ?? {}).map((k) => importedFrom({ agent: k as SessionSummary['agent'] }) || k)
  if (r.conversations === 0) return r.error ? `Nothing imported — ${r.error}` : 'That file holds no conversation with a message in it.'
  const parts = [
    r.added > 0 && `${r.added} new`,
    r.updated > 0 && `${r.updated} with new messages`,
    r.unchanged > 0 && `${r.unchanged} already here`,
    r.deleted > 0 && `${r.deleted} you deleted stay deleted`,
  ].filter(Boolean)
  const line = `Read ${plural(r.conversations, 'conversation')} from ${names.join(' and ')}: ${parts.join(', ')}.`
  return r.error ? `${line} It stopped part way — ${r.error}` : line
}

/** The longest a title made from the first message runs, in characters. */
const TITLE_MAX = 80

/**
 * What a chat is called: the name the user gave it, else the agent's own
 * title, else its first message — "title from the first message", as a
 * messenger names a thread — else "New chat".
 */
export function chatTitle(s: SessionSummary): string {
  const name = s.name?.trim()
  if (name) return name
  const about = sessionAbout(s).replace(/\s+/g, ' ').trim()
  if (about) return about.length > TITLE_MAX ? `${about.slice(0, TITLE_MAX - 1).trimEnd()}…` : about
  return 'New chat'
}

/** "Claude · Opus 5.5": the agent, and the model it answers with or was started on. */
export function chatModelLabel(s: Pick<SessionSummary, 'session_id' | 'agent' | 'model_display'>): string {
  const started = startedChat(s.session_id)
  const agent = chatAgentName(s.agent ?? started?.agent)
  const model = s.model_display || started?.label || ''
  return model ? `${agent} · ${model}` : agent
}

/** What `POST /v1/agents` is sent for a new chat on a choice, with a first message when there is one. */
export function newChatRequest(c: Pick<QuickChoice, 'agent' | 'model' | 'subscription'>, prompt = ''): SpawnRequest {
  const req: SpawnRequest = { chat: true }
  if (c.agent !== 'claude') req.agent = c.agent
  if (c.model) req.model = c.model
  if (c.subscription) req.subscription = c.subscription
  if (prompt.trim()) req.prompt = prompt.trim()
  return req
}

/** Starts a chat on a choice and remembers the choice; the new chat's id. */
export async function startChat(c: QuickChoice, prompt = ''): Promise<string> {
  const { session_id } = await api.spawn(newChatRequest(c, prompt))
  rememberQuickChoice(c)
  rememberStartedChat(session_id, { agent: c.agent, model: c.model, label: quickChoiceLabel(c) })
  return session_id
}

/** A file's name without its folder. */
export function fileName(path: string): string {
  return path.split('/').pop() || path
}

/** The folder part of a chat file's path, '' at the top. */
export function fileFolder(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** A path relative to a Markdown file's folder, made relative to the chat's: '' when it leaves the chat. */
export function resolveChatPath(from: string, rel: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/') || rel.startsWith('#')) return ''
  const out = fileFolder(from).split('/').filter(Boolean)
  for (const seg of rel.split(/[?#]/)[0]!.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return ''
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/** What a file kind is called in a row. */
export function kindLabel(k: ChatFile['kind']): string {
  switch (k) {
    case 'markdown': return 'Markdown'
    case 'html': return 'HTML'
    case 'pdf': return 'PDF'
    case 'image': return 'Image'
    case 'text': return 'Text'
    default: return 'File'
  }
}

/**
 * An HTML file for a sandboxed frame. The frame is `sandbox=""` — no script,
 * no same origin, no form, no popup — and the document carries a policy that
 * fetches nothing but what it holds inline, so opening a page an agent wrote
 * neither runs its code nor calls the network (rule 4).
 */
export const HTML_POLICY = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:; media-src data: blob:"

export function sandboxedHTML(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}">${html}`
}

/** Saves a blob as a file, the way a download link does. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
