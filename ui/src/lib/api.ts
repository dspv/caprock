// Typed client for the daemon API (.ai/03-contracts.md § HTTP API). snake_case
// on the wire, kept as-is in the types so the contract is visible in the code.

export type Health = 'working' | 'idle' | 'waiting-on-you' | 'looping' | 'error' | 'ended'

export interface Session {
  session_id: string
  cwd: string
  project: string
  model: string
  started_at: number
  last_event_at: number
  status: 'active' | 'idle' | 'ended'
  transcript_path: string
  has_hooks: boolean
  has_transcript: boolean
  git_branch: string
  version: string
  owned: boolean
  /** Which coding agent produced this session. Absent means Claude Code,
   *  which is what every session was before OpenCode support. */
  agent?: 'claude' | 'opencode' | 'gemini'
}

export interface Stats {
  session_id: string
  turns: number
  tool_calls: number
  files_touched: number
  tokens_in: number
  tokens_out: number
  cache_read: number
  cache_write: number
  cost_usd: number
}

export interface Plan { done: number; total: number; next?: string }

export interface Activity {
  phrase: string
  tool?: string
  at: string
  health: Health
  plan?: Plan
  repeats?: number
}

export interface Savings { billed_with: number; billed_without: number; saved: number; hit_rate: number; cut_pct: number }

export interface LoopAlert {
  kind: 'loop'
  session_id: string
  tool: string
  count: number
  window_min: number
  sample: string
  first_ts: string
  last_ts: string
  ts: string
}

export interface ContextFill { tokens: number; window: number; pct: number }

export interface SessionSummary extends Session {
  stats: Stats
  activity: Activity
  savings: Savings
  loop?: LoopAlert
  context?: ContextFill
}

export interface TokenDelta { in: number; out: number; cache_read: number; cache_write: number; cache_write_1h?: number }

export interface Event {
  id: number
  ts: string
  agent_id?: string
  session_id: string
  source: 'hook' | 'transcript' | 'pty' | 'harness'
  kind: string
  tool?: string
  payload: unknown
  tokens?: TokenDelta
  cost_usd?: number
  model?: string
  key?: string
}

export interface SessionDetail extends SessionSummary {
  files: string[]
  events: Event[]
}

/** Whether asking Gemini is possible here, and why not when it is not.
 *  Deliberately says nothing about the key beyond its presence: the key lives
 *  in the daemon's environment and is never sent to this page (ADR-023). */
export interface GeminiStatus {
  /** A key is available — from the environment or entered in settings. */
  available: boolean
  /** The key comes from the environment, which wins over the stored one. */
  from_env?: boolean
  /** The variable to set — so the UI can tell the reader what to do. */
  env_var: string
  /** The licence is active. Asking is refused by the server without it. */
  licensed: boolean
  model: string
  /** The Gemini models in the pricing table, cheapest first, each with what a
   *  short question costs at its rates. */
  models?: GeminiModel[]
}

export interface GeminiModel {
  id: string
  display: string
  input: number
  output: number
  /** Roughly 2k in and 500 out — an example of a dashboard question, not a
   *  promise about the next one. */
  typical_usd: number
}

export interface GeminiUsage {
  prompt_tokens: number
  output_tokens: number
  cached_tokens: number
  thoughts_tokens: number
  total_tokens: number
}

export interface GeminiReply {
  text: string
  model: string
  usage: GeminiUsage
}

export interface FileDiff { path: string; status: string; additions: number; deletions: number; patch?: string; binary?: boolean }
export interface DiffResult { root: string; branch: string; files: FileDiff[]; stat: string; base?: string; base_branch?: string }

export interface ModelShare { model: string; tokens: number; cost_usd: number; turns: number }

/** Volume whose model is not in the pricing table, so it contributes nothing to
 *  cost_usd. Absent when everything in range was priced. The models are named
 *  because "some tokens are unpriced" is not something a user can act on,
 *  whereas an unknown model id is. */
export interface Unpriced { turns: number; tokens: number; models: string[] }
/** One directory inside a repository: the second level of the projects roll-up.
 *  `path` is the first segment under the repo root; "." is the root itself. */
/** One directory inside a repository, charged by what the repository's TURNS
 *  touched — which files Claude read and wrote — rather than by the directory a
 *  session was launched from. `turns` is the count charged to this row; a turn
 *  belongs to exactly one row, so the column partitions the repository.
 *
 *  `unattributed` marks the single row that is NOT a directory: the bucket for
 *  spend that belongs to the repository but to no one directory in it. Render
 *  it as its own thing — never as a directory (its `path` is a sentinel, not a
 *  name).
 *
 *  `tokens_pct` / `cost_pct` are shares of the REPOSITORY total including the
 *  unattributed bucket, so each column sums to 100%. Both are sent because they
 *  genuinely differ — cost per token varies by model. */
export interface PathShare {
  path: string
  tokens: number
  cost_usd: number
  turns: number
  /** The turns that ran before their session touched any file — the only ones
   *  carry-forward cannot place. Rendered as "repository-wide work", never as a
   *  directory. Usually absent: the server omits a bucket row that cost $0. */
  unattributed?: boolean
  /** The turns whose most recent file touch was outside the repository:
   *  Claude's notes on the project, agent scratchpads, test output, another
   *  checkout. Rendered as its own row, never as a directory. */
  outside?: boolean
  tokens_pct: number
  cost_pct: number
}
/** A project's spend over time: one value per fixed-width bucket, cost and
 *  tokens over the SAME buckets, so which one the panel plots is a display
 *  choice rather than a request — see components/Projects.tsx SPARK_BASIS.
 *  Bucket i covers [from_ms + i*width_ms, from_ms + (i+1)*width_ms). Absent on
 *  `range=all`, whose start is the first event ever captured — a fixed bucket
 *  count would make a column mean a different span on every machine. */
export interface Spark { from_ms: number; width_ms: number; cost: number[]; tokens: number[] }
/** One REPOSITORY's spend. `paths` is the per-directory breakdown, absent when
 *  the repository has only one directory (it would restate the row's total).
 *  `spark` is the series behind the row's sparkline. */
export interface ProjectShare { project: string; agent?: string; tokens: number; cost_usd: number; sessions: number; paths?: PathShare[]; spark?: Spark }
/** The KIND of work one turn did — what the money was spent on, beside the cuts
 *  by model and by project. A turn belongs to exactly one kind, so the rows sum
 *  to the range total exactly.
 *
 *  `kind` is a stable key, never a display string: the label and the sentence
 *  explaining it live in components/WorkMix.tsx. `none` is a turn that called no
 *  tool at all — it is NOT labelled "conversation" or "thinking", because a turn
 *  that called nothing may have been reasoning, planning or answering and the
 *  data does not say which. */
export type WorkKind = 'edit' | 'command' | 'read' | 'web' | 'mcp' | 'other' | 'none'
export interface WorkShare {
  kind: WorkKind
  turns: number
  tokens: number
  cost_usd: number
  tokens_pct: number
  cost_pct: number
}
export interface Burn { window_min: number; usd_per_hour: number; tokens_per_min: number; turns: number }

export interface Summary {
  range: string
  from_ms: number
  sessions: number
  active_sessions: number
  turns: number
  tool_calls: number
  tokens_in: number
  tokens_out: number
  cache_read: number
  cache_write: number
  cost_usd: number
  models: ModelShare[]
  projects: ProjectShare[]
  /** What the money was spent ON — see WorkShare. Empty when nothing was
   *  measured in the range. */
  work: WorkShare[]
  /** Tool calls in range that could not be attached to any turn, so their cost
   *  was counted in the "no tool" row instead of the row for the work they did.
   *  Non-zero means the breakdown understates every other row by up to this
   *  much, and the panel says so rather than presenting the figures as
   *  complete. */
  work_unlinked_calls: number
  savings: Savings
  burn: Burn
  pricing_version: string
  throttles: number
  rate_limits?: RateLimits
  /** Present only when some turns could not be priced — see Unpriced. */
  unpriced?: Unpriced
}

export interface RateWindow {
  used_percentage: number
  resets_at: number
  forecast?: string
}

/** What the paid plan costs. Served by the daemon so no price is hardcoded in
 *  the UI — one edit in Go changes every place it appears. */
export interface PremiumPlan { per_month_usd: number; charged_usd: number; period: string; url: string }
/** What a licence key grants, decided by the daemon from the key's own date. */
export interface LicenseState { active: boolean; in_grace: boolean; expires_at?: string; reason?: string }
/** A price the reader is already paying, quoted with its source and date, so
 *  ours has something to be measured against. Not a claim the two substitute
 *  for each other — see internal/premium. */
export interface PremiumCompare { plan: string; monthly_usd: number; source: string; read_on: string }
export interface PremiumPricing { yearly: PremiumPlan; monthly: PremiumPlan; lifetime: PremiumPlan; info_url: string; license?: LicenseState; compare?: PremiumCompare }

export interface RateLimits {
  five_hour?: RateWindow
  seven_day?: RateWindow
}

/** One thing Claude said, in prose — not a tool call. */
export interface AssistantNote {
  event_id: number
  session_id: string
  project: string
  ts: number
  model: string
  text: string
  /** Mid-thought aside rather than a conclusion; qualifies a final note. */
  fragment: boolean
}

export interface Settings {
  /** Where the folder picker may look. Empty means the home directory. */
  browse_root?: string
  /** The daily spend ceiling in USD; 0 is off. See internal/cap. */
  cap_usd_per_day?: number
  /** Where the weekly report goes. Not a credential, so it round-trips. */
  report_chat_id?: string
  /** Whether a bot token is stored. The token itself is never returned — it is
   *  the one write-only field in this API (ADR-024). */
  report_bot_set?: boolean
  /** Why the last send failed, absent when it did not. A weekly message that
   *  stops arriving is invisible otherwise. */
  report_last_error?: string
  report_last_sent_ms?: number
  /** Write-only: accepted by PUT, never present in a GET response. */
  report_bot_token?: string
  /** Whether a Gemini key is available, from the environment or this field. */
  gemini_key_set?: boolean
  /** True when GEMINI_API_KEY is set, which takes precedence over the field. */
  gemini_key_from_env?: boolean
  /** Write-only, like the bot token. */
  gemini_api_key?: string
  update_checks: boolean
  plan_kind: '' | 'flat' | 'metered'
  plan_label: string
  plan_usd_per_month: number
  /** The paid key, checked locally against the expiry it carries. */
  license_key?: string
}

export interface UpdateStatus {
  enabled: boolean
  current: string
  latest?: string
  update_available: boolean
  command?: string
  url?: string
  checked_at?: number
  error?: string
  /** The published release's own description of what changed. */
  notes?: string
  /** The version `notes` describes — never assume it is `latest`. */
  notes_for?: string
}

export interface DailyStat { day: string; project: string; model: string; tokens_total: number; cost_usd: number; sessions: number }

export interface ToolCount { tool: string; count: number }
export interface HistoryTotals { sessions: number; owned_sessions: number; turns: number; tool_calls: number; files_touched: number; cost_usd: number; avg_session_sec: number; days: number; unpriced?: Unpriced }
export interface Task { id: string; title: string; status: string; assignee: string; budget_usd: number; verify_rounds: number; cost_usd: number; created_at: number; updated_at: number }
// The live WS "task" frame carries the on-disk hive.Task (no cost_usd — that's
// computed for the REST TaskRow). Enough to drive the orchestration graph's
// node/edge state and animation; cost comes from the /v1/tasks snapshot.
export interface TaskFrame { id: string; title: string; status: string; assignee: string; budget_usd: number; verify_rounds_used: number; body: string }
/** One session that worked a task. The diff endpoint is keyed on a session id,
 *  so this is the bridge from a task card to what the worker actually changed. */
export interface TaskSession { session_id: string; cwd: string; from_ts: number; to_ts?: number }
/** One recorded `done_criteria` run — the evidence behind a green task. */
export interface TaskVerification { round: number; command: string; exit_code: number; output_path?: string; ts: number }
/** Where a task's work lives. Derived by the daemon, never stored: the branch and
 *  worktree are the same strings `git worktree add` was given. */
export interface TaskWork {
  branch?: string
  worktree?: string
  repo?: string
  sessions?: TaskSession[]
  verifications?: TaskVerification[]
}
export interface TaskDetail { task: Task; body: string; done_criteria?: string[]; work?: TaskWork }
export interface CreateTaskRequest { title: string; budget_usd?: number; done_criteria?: string[]; body?: string }

export interface History { range: string; totals: HistoryTotals; tools: ToolCount[]; daily: DailyStat[]; savings: Savings; summary: Summary }

export interface Status {
  /** Present when the daemon is reading OpenCode; absent when it is not
   *  installed. This is what tells the UI whether an agent filter has
   *  anything to switch between — a session list or a day's summary cannot
   *  answer it, because either may legitimately be empty. */
  opencode?: { sessions: number; events: number; last_poll_ms?: number }
  version: string
  /** GOOS/GOARCH — what a bug report needs and nobody remembers to include. */
  platform?: string
  pid: number
  started_at: number
  uptime_s: number
  url: string
  data_dir: string
  pricing: { version: string; source: string; fetched_at: string; user_override: boolean; models: number }
  ingest?: { files_known: number; lines_parsed: number; lines_malformed: number; lines_skipped: number; events_stored: number; events_deduped: number; backfill_done: boolean }
  hooks?: { settings_path: string; shim_path: string; installed: string[] | null; missing: string[] | null; shim_exists: boolean }
  /** The terminal error that stopped transcript ingest, when one happened.
   *  While this is set nothing new is being captured, however healthy the rest
   *  of the status looks. */
  ingest_error?: string
  ui_built: boolean
  claude_available: boolean
  /** The Gemini CLI is on PATH, so the new-session dialog can offer it as an
   *  agent. Absent on daemons older than this feature. */
  gemini_available?: boolean
  owned_active: number
  loop_k: number
  loop_t_minutes: number
  active_loops: number
  orchestration: boolean
  /** The queue directory in force, and the checkout its workers operate on.
   *  Absent when orchestration is off. */
  hive?: string
  repo?: string
  /** What `POST /v1/hive` would use if called with no body — the defaults the
   *  Tasks screen names in its confirmation. Present only while it is off. */
  suggested_hive?: string
  suggested_repo?: string
  events: number
  retention_days: number
  /** The Claude desktop app's own plan usage, when this machine has any. */
  desktop?: {
    five_hour_pct: number
    seven_day_pct: number
    at: number
    /** The app only writes while running, so an old reading describes the past. */
    stale: boolean
  }
}

/** One directory the folder picker may offer. */
export interface BrowseEntry { name: string; path: string; repo: boolean }
export interface BrowseResponse { dir: string; parent: string; root: string; entries: BrowseEntry[] }
/** A directory Caprock has already seen sessions run in. */
export interface RecentDir { dir: string; name: string; sessions: number; last_event_at: number }

export interface SpawnRequest {
  /** Which coding agent to launch: "claude" (default) or "gemini". They take
   *  different flags, so the daemon builds the argv per agent. */
  agent?: 'claude' | 'gemini'
  cwd?: string; chat?: boolean; create?: boolean; worktree?: string
  model?: string; permission_mode?: string; args?: string[]
}

async function post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    let b: unknown
    try { b = await res.json() } catch { /* */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, b)
  }
  return (res.status === 204 ? (undefined as T) : ((await res.json()) as T))
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
  }
}

/**
 * The human-readable message behind a failed request. The API answers errors
 * with `{error, detail}`, where `detail` is the part that tells the user what
 * to do — `String(e)` threw both away and rendered "Error: 501 Not
 * Implemented" over a payload that said "the task runner is off ... turn it on
 * with POST /v1/hive, or start the daemon with caprock up --hive <dir>".
 */
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; detail?: string } | undefined
    const head = b?.error ?? e.message
    return b?.detail ? `${head} — ${b.detail}` : head
  }
  return e instanceof Error ? e.message : String(e)
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* ignore */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as T
}

export const api = {
  sessions: (activeOnly = false) => get<SessionSummary[]>(`/v1/sessions${activeOnly ? '?active=true' : ''}`),
  session: (id: string) => get<SessionDetail>(`/v1/sessions/${encodeURIComponent(id)}`),
  events: (id: string, after = 0, limit = 500) => get<Event[]>(`/v1/sessions/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`),
  /** The events immediately preceding `before`, oldest-first — paging back
   *  through a long session without refetching from its start. */
  eventsBefore: (id: string, before: number, limit = 200) =>
    get<Event[]>(`/v1/sessions/${encodeURIComponent(id)}/events?before=${before}&limit=${limit}`),
  /** The newest events for a session, for anything showing recent activity. */
  recentEvents: (id: string, limit = 2000) => get<Event[]>(`/v1/sessions/${encodeURIComponent(id)}/events?newest=1&limit=${limit}`),
  diff: (id: string) => get<DiffResult>(`/v1/sessions/${encodeURIComponent(id)}/diff`),
  notes: (id: string, limit = 200) => get<AssistantNote[]>(`/v1/sessions/${encodeURIComponent(id)}/notes?limit=${limit}`),
  /** `before` pages backwards: pass the lowest event_id already shown. */
  searchNotes: (q: string, limit = 100, before = 0) =>
    get<AssistantNote[]>(`/v1/notes?q=${encodeURIComponent(q)}&limit=${limit}${before ? `&before=${before}` : ''}`),
  settings: () => get<Settings>('/v1/settings'),
  update: () => get<UpdateStatus>('/v1/update'),
  checkUpdate: () => post<UpdateStatus>('/v1/update/check', {}),
  saveSettings: (s: Settings) => post<Settings>('/v1/settings', s, 'PUT'),
  summary: (range: 'today' | '7d' | '30d' | 'all' = 'today', agent?: string) =>
    get<Summary>(`/v1/stats/summary?range=${range}${agent && agent !== 'all' ? `&agent=${agent}` : ''}`),
  daily: (days = 30) => get<DailyStat[]>(`/v1/stats/daily?days=${days}`),
  premium: () => get<PremiumPricing>('/v1/premium'),
  gemini: () => get<GeminiStatus>('/v1/gemini'),
  askGemini: (prompt: string, model?: string) => post<GeminiReply>('/v1/gemini/ask', { prompt, model }),
  browse: (dir = '') => get<BrowseResponse>(`/v1/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  recentDirs: () => get<RecentDir[]>('/v1/recent-dirs'),
  history: (range: 'today' | '7d' | '30d' | 'all' = 'all') => get<History>(`/v1/history?range=${range}`),
  /** Turns the task runner on over the running daemon — no restart. Empty
   *  fields mean the daemon's own suggestion (see status.suggested_hive). */
  enableHive: (hive?: string, repo?: string) => post<{ hive: string; repo: string }>('/v1/hive', { hive: hive ?? '', repo: repo ?? '' }),
  tasks: () => get<Task[]>('/v1/tasks'),
  task: (id: string) => get<TaskDetail>(`/v1/tasks/${encodeURIComponent(id)}`),
  createTask: (req: CreateTaskRequest) => post<TaskDetail>('/v1/tasks', req),
  approve: (id: string, approve: boolean) => post<void>(`/v1/tasks/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`, {}),
  startOrchestrator: () => post<{ session_id: string }>('/v1/orchestrator/start', {}),
  // Emergency stop: kills the orchestrator and every worker it spawned.
  stopOrchestrator: () => post<{ stopped: number }>('/v1/orchestrator/stop', {}),
  status: () => get<Status>('/v1/status'),
  spawn: (req: SpawnRequest) => post<{ session_id: string; cwd: string }>('/v1/agents', req),
  signal: (id: string, action: 'pause' | 'resume' | 'kill') => post<void>(`/v1/agents/${encodeURIComponent(id)}/signal`, { action }),
  /**
   * Write a pasted or dropped file and get back the path Claude Code can read.
   *
   * Base64 inside JSON rather than a raw upload, because the daemon's forgery
   * guard turns away a state-changing request that is not `application/json` —
   * and `image/png` is a simple content type, so a raw upload would have been
   * an endpoint any page in the browser could use to write files into the
   * user's data directory.
   */
  paste: (type: string, data: string) => post<{ path: string }>('/v1/paste', { type, data }),
  agentInput: (id: string, data: string) => post<void>(`/v1/agents/${encodeURIComponent(id)}/input`, { data }),
}
