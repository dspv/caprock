// Caprock Mail's slice of the daemon API (/v1/mail, internal/mail). Writes go
// as JSON, which the CSRF guard requires; a paired device sends its token.
import { deviceToken } from '@/lib/api'

export type Address = { name: string; addr: string }

export type Part = {
  path: string
  type: string
  filename?: string
  size: number
  cid?: string
  inline?: boolean
  attachment: boolean
}

export type Message = {
  id: number
  account_id: number
  folder_id: number
  uid: number
  message_id: string
  in_reply_to: string
  references: string
  thread_key: string
  subject: string
  from_name: string
  from_addr: string
  to: Address[]
  cc: Address[]
  reply_to: string
  date: number
  size: number
  seen: boolean
  flagged: boolean
  answered: boolean
  has_attach: boolean
  snippet: string
  body_text?: string
  body_html?: string
  structure: { text?: Part; html?: Part; parts: Part[] | null }
  body_state: number
}

export type Account = {
  id: number
  name: string
  email: string
  username: string
  imap_host: string
  imap_port: number
  imap_tls: string
  smtp_host: string
  smtp_port: number
  smtp_tls: string
  color: string
  signature: string
  last_sync: number
  last_error: string
}

export type Folder = {
  id: number
  account_id: number
  name: string
  delim: string
  role: string
  total: number
  unread: number
}

export type State = {
  version: number
  accounts: Account[]
  folders: Folder[]
  counts: { inbox: number; unread: number; flagged: number }
}

export type ProviderGuess = {
  provider: string
  imap_host: string
  imap_port: number
  imap_tls: string
  smtp_host: string
  smtp_port: number
  smtp_tls: string
  note?: string
  help_url?: string
  known: boolean
  needs_username?: boolean
}

export type Settings = Record<string, string>

export type Draft = {
  account_id: number
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  in_reply_to: number
  attachments: { filename: string; type: string; data: string }[]
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
  const t = deviceToken()
  if (t) headers['X-Caprock-Device'] = t
  const res = await fetch(path, { method, headers, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText)
  return data as T
}

export const api = {
  state: () => req<State>('GET', '/v1/mail/state'),
  list: (p: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== 0) q.set(k, String(v))
    return req<Message[]>('GET', '/v1/mail/messages?' + q.toString())
  },
  message: (id: number) => req<Message>('GET', `/v1/mail/messages/${id}`),
  thread: (id: number) => req<Message[]>('GET', `/v1/mail/messages/${id}/thread`),
  action: (ids: number[], action: string, folder = 0) => req('POST', '/v1/mail/actions', { ids, action, folder }),
  send: (d: Draft) => req('POST', '/v1/mail/send', d),
  sync: () => req('POST', '/v1/mail/sync'),
  guess: (email: string) => req<ProviderGuess>('GET', '/v1/mail/providers?email=' + encodeURIComponent(email)),
  addAccount: (a: Partial<Account> & { password: string }) => req<Account>('POST', '/v1/mail/accounts', a),
  updateAccount: (a: Partial<Account> & { id: number; password?: string }) => req<Account>('PUT', `/v1/mail/accounts/${a.id}`, a),
  deleteAccount: (id: number) => req('DELETE', `/v1/mail/accounts/${id}`),
  contacts: (q: string) => req<Address[]>('GET', '/v1/mail/contacts?q=' + encodeURIComponent(q)),
  settings: () => req<Settings>('GET', '/v1/mail/settings'),
  putSettings: (s: Settings) => req<Settings>('PUT', '/v1/mail/settings', s),
  aiStatus: () => req<{ available: boolean; models: string[]; error?: string }>('GET', '/v1/mail/ai/status'),
  summarize: (id: number) => req<{ text: string }>('POST', '/v1/mail/ai/summarize', { message_id: id }),
  draft: (id: number, instruction: string) => req<{ text: string }>('POST', '/v1/mail/ai/draft', { message_id: id, instruction }),
}

export function partURL(id: number, path: string, download = false) {
  return `/v1/mail/messages/${id}/part/${encodeURIComponent(path)}${download ? '?download=1' : ''}`
}

/** The same client under a name that reads clearly outside the mail screen. */
export const mailApi = api
