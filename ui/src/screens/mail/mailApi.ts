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
  /** The local junk filter hides it from the inbox (inbox mail only). */
  junk?: boolean
  /** 0–100; 50 is the threshold. */
  junk_score?: number
  /** Comma-separated rule codes that pushed it towards junk, strongest first. */
  junk_why?: string
  /** The assistant's label for the conversation (list rows only). */
  ai?: Triage
}

/** AI triage categories, in the order the inbox filters show them. */
export type Category = 'important' | 'updates' | 'newsletter' | 'spam'

export type Triage = {
  category: Category
  /** The last message waits on the user's answer. */
  reply?: boolean
  summary?: string
  /** provider[/model] that answered; "user" for the user's own label, "sample" in sample mode. */
  model?: string
  user?: boolean
  at: number
}

export type TriageState = {
  running: boolean
  pending: number
  /** Who sorts: "Claude Code · haiku". */
  by: string
  counts: { account_id: number; category: Category; n: number }[]
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
  /** 'password' (the default), 'oauth2:google' or 'oauth2:microsoft'. */
  auth?: string
}

/** What removing an account says before it goes (ADR-057): Google's grant is
 *  revoked there too; Microsoft offers apps no way to, so the user is told where. */
export function removeAccountPrompt(a: Pick<Account, 'email' | 'auth'>): string {
  const base = `Remove ${a.email}? Mail stays on the server.`
  if (a.auth === 'oauth2:google') return `${base} Caprock also gives back its access to this Google account.`
  if (a.auth === 'oauth2:microsoft') return `${base} Microsoft keeps Caprock's access until you remove it at account.live.com/consent/Manage (work accounts: myapps.microsoft.com).`
  return base
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
  /** junk: inbox mail the junk filter hides (not the Junk folder). */
  counts: { inbox: number; unread: number; flagged: number; junk?: number }
  /** Sample mode: every route serves made-up accounts; nothing is real. */
  sample?: boolean
  /** AI triage, from daemons that have it. */
  triage?: TriageState
}

export type ImportAccount = {
  name: string
  email: string
  username: string
  imap_host: string
  imap_port: number
  imap_tls: string
  smtp_host: string
  smtp_port: number
  smtp_tls: string
  has_password: boolean
  /** google | microsoft | icloud | yahoo | fastmail, or absent for any other server. */
  provider?: string
  /** When the mail app last wrote the profile it came from (unix ms). */
  last_used?: number
}

export type ImportSource = {
  kind: string
  label: string
  accounts: ImportAccount[]
  needs_permission?: string
  /** With needs_permission: the file to allow in Full Disk Access (the daemon's own). */
  program?: string
  error?: string
  /** The newest last_used of its accounts (unix ms). */
  last_used?: number
}

export type ImportResult = { email: string; ok: boolean; error?: string; already?: boolean }

/** What an imported account still needs: nothing, a browser sign-in, an app password, or its password. */
export type Signin = 'ready' | 'oauth' | 'app_password' | 'password'

/** One account of "Import everything": every mail app's copies of an address merged. */
export type FoundAccount = ImportAccount & { source: string; from: string[]; signin: Signin }

export type ImportScan = {
  sources: ImportSource[]
  accounts: FoundAccount[]
  oauth: OAuthProviders
}

export type OAuthFlowStatus = { status: 'pending' | 'ok' | 'error' | 'expired'; email?: string; error?: string }

export type OAuthProviders = { google?: boolean; microsoft?: boolean }

/** An HTTP failure that keeps its status, so a missing route can be told apart. */
export class HttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** A route this daemon does not have yet (an older build, or not merged). */
export const missingRoute = (e: unknown) => e instanceof HttpError && (e.status === 404 || e.status === 405 || e.status === 501)

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
  /** How the servers were found: preset, mx, srv, autoconfig or guess (newer daemons). */
  source?: string
  /** The sign-in name, when the domain's autoconfig names one other than the address. */
  username?: string
}

export type CleanupQuery = { view: 'junk' | 'trash'; account: number; before: number; min_score: number }

export type Settings = Record<string, string>

/** One provider the assistant can ask, as GET /v1/mail/ai/status lists it. */
export type AIProvider = {
  id: string
  label: string
  kind: 'cli' | 'api' | 'local'
  command?: string
  default_model?: string
  needs_model?: boolean
  model_hint?: string
  /** Where the mail text goes when an AI action runs. */
  sends_to: string
  available: boolean
  /** Why not, when not available. */
  why?: string
  model: string
  key_set?: boolean
  key_where?: { kind: string; path?: string; note?: string }
}

export type AIStatus = {
  /** The saved choice; '' is automatic. */
  chosen: string
  /** The provider in use ('' when automatic finds none). */
  provider: string
  label: string
  sends_to: string
  available: boolean
  error?: string
  /** The local server's models, when it is the one in use. */
  models: string[]
  /** The model that answers ("" for a CLI's own default). */
  model?: string
  providers: AIProvider[]
}

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
  if (!res.ok) throw new HttpError((data as { error?: string }).error || res.statusText || String(res.status), res.status)
  return data as T
}

export const api = {
  state: () => req<State>('GET', '/v1/mail/state')
    .then((r) => ({ ...r, accounts: r.accounts ?? [], folders: r.folders ?? [] })),
  sample: (on: boolean) => req<{ sample: boolean }>('POST', '/v1/mail/sample', { on }),
  // A source found with no accounts came back as null before 0.117 and the
  // first-run screen crashed counting it: every source gets a list here.
  importSources: () => req<{ sources: ImportSource[] | null }>('GET', '/v1/mail/import')
    .then((r) => ({ sources: (r.sources ?? []).map((x) => ({ ...x, accounts: x.accounts ?? [] })) })),
  importAccounts: (source: string, emails: string[], passwords?: Record<string, string>) =>
    req<{ results: ImportResult[] }>('POST', '/v1/mail/import', { source, emails, passwords }),
  /** macOS: open Full Disk Access in System Settings and show Caprock's file in Finder. */
  importGrant: () => req<{ program: string }>('POST', '/v1/mail/import/grant'),
  /** The same scan with every account merged across mail apps and the step each needs. */
  importScan: () => req<Partial<ImportScan>>('GET', '/v1/mail/import').then((r): ImportScan => {
    const sources = (r.sources ?? []).map((x) => ({ ...x, accounts: x.accounts ?? [] }))
    return { sources, accounts: r.accounts ?? [], oauth: r.oauth ?? {} }
  }),
  oauthProviders: () => req<OAuthProviders>('GET', '/v1/mail/oauth/providers'),
  oauthStart: (provider: string, loginHint?: string) =>
    req<{ auth_url: string; flow?: string }>('POST', '/v1/mail/oauth/start', loginHint ? { provider, login_hint: loginHint } : { provider }),
  oauthFlow: (id: string) => req<OAuthFlowStatus>('GET', '/v1/mail/oauth/flow?id=' + encodeURIComponent(id)),
  list: (p: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== 0) q.set(k, String(v))
    return req<Message[]>('GET', '/v1/mail/messages?' + q.toString())
  },
  message: (id: number) => req<Message>('GET', `/v1/mail/messages/${id}`),
  thread: (id: number) => req<Message[]>('GET', `/v1/mail/messages/${id}/thread`),
  cleanupPreview: (q: CleanupQuery) => req<{ ids: number[]; identities: Record<string, string> }>('POST', '/v1/mail/cleanup/preview', q),
  cleanup: (q: CleanupQuery & { ids: number[]; identities: Record<string, string> }) => req<{ ok: boolean }>('POST', '/v1/mail/cleanup', q),
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
  // A daemon before provider choice answered only available/models/error.
  aiStatus: () => req<Partial<AIStatus> & { available: boolean }>('GET', '/v1/mail/ai/status')
    .then((r): AIStatus => ({ chosen: '', provider: '', label: '', sends_to: '', ...r, models: r.models ?? [], providers: r.providers ?? [] })),
  /** Stores a provider's API key in the system keychain; '' removes it. Never read back. */
  aiKey: (provider: string, key: string) => req<{ ok: boolean; key_set: boolean }>('PUT', '/v1/mail/ai/key', { provider, key }),
  /** `provider` and `label` name who answered (absent from a daemon before provider choice). */
  summarize: (id: number) => req<{ text: string; provider?: string; label?: string; model?: string }>('POST', '/v1/mail/ai/summarize', { message_id: id }),
  draft: (id: number, instruction: string) => req<{ text: string; provider?: string; label?: string }>('POST', '/v1/mail/ai/draft', { message_id: id, instruction }),
  /** The user's own label for a conversation (Not spam), kept from then on. */
  label: (id: number, category: Category) => req<{ ok: boolean }>('POST', '/v1/mail/triage/label', { message_id: id, category }),
}

export function partURL(id: number, path: string, download = false) {
  return `/v1/mail/messages/${id}/part/${encodeURIComponent(path)}${download ? '?download=1' : ''}`
}

/** Who does the AI work, for the screen: "Claude Code · haiku", or the label alone. */
export const whoText = (s: { label?: string; model?: string } | null | undefined) =>
  s?.label ? s.label + (s.model ? ' · ' + s.model : '') : ''

/** The same client under a name that reads clearly outside the mail screen. */
export const mailApi = api
