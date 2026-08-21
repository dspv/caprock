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

export interface FileDiff { path: string; status: string; additions: number; deletions: number; patch?: string; binary?: boolean }
export interface DiffResult { root: string; branch: string; files: FileDiff[]; stat: string }

export interface ModelShare { model: string; tokens: number; cost_usd: number; turns: number }
/** One directory inside a repository: the second level of the projects roll-up.
 *  `path` is the first segment under the repo root; "." is the root itself. */
export interface PathShare { path: string; tokens: number; cost_usd: number; sessions: number }
/** One REPOSITORY's spend. `paths` is the per-directory breakdown, absent when
 *  the repository has only one directory (it would restate the row's total). */
export interface ProjectShare { project: string; tokens: number; cost_usd: number; sessions: number; paths?: PathShare[] }
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
  savings: Savings
  burn: Burn
  pricing_version: string
  throttles: number
  rate_limits?: RateLimits
}

export interface RateWindow {
  used_percentage: number
  resets_at: number
  forecast?: string
}

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
  update_checks: boolean
  plan_kind: '' | 'flat' | 'metered'
  plan_label: string
  plan_usd_per_month: number
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
}

export interface DailyStat { day: string; project: string; model: string; tokens_total: number; cost_usd: number; sessions: number }

export interface ToolCount { tool: string; count: number }
export interface HistoryTotals { sessions: number; owned_sessions: number; turns: number; tool_calls: number; files_touched: number; cost_usd: number; avg_session_sec: number; days: number }
export interface Task { id: string; title: string; status: string; assignee: string; budget_usd: number; verify_rounds: number; cost_usd: number; created_at: number; updated_at: number }
// The live WS "task" frame carries the on-disk hive.Task (no cost_usd — that's
// computed for the REST TaskRow). Enough to drive the orchestration graph's
// node/edge state and animation; cost comes from the /v1/tasks snapshot.
export interface TaskFrame { id: string; title: string; status: string; assignee: string; budget_usd: number; verify_rounds_used: number; body: string }
export interface TaskDetail { task: Task; body: string }
export interface CreateTaskRequest { title: string; budget_usd?: number; done_criteria?: string[]; body?: string }

export interface History { range: string; totals: HistoryTotals; tools: ToolCount[]; daily: DailyStat[]; savings: Savings; summary: Summary }

export interface Status {
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
  ui_built: boolean
  claude_available: boolean
  owned_active: number
  loop_k: number
  loop_t_minutes: number
  active_loops: number
  orchestration: boolean
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

export interface SpawnRequest { cwd: string; worktree?: string; model?: string; permission_mode?: string; args?: string[] }

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
  summary: (range: 'today' | '7d' | '30d' | 'all' = 'today') => get<Summary>(`/v1/stats/summary?range=${range}`),
  daily: (days = 30) => get<DailyStat[]>(`/v1/stats/daily?days=${days}`),
  history: (range: 'today' | '7d' | '30d' | 'all' = 'all') => get<History>(`/v1/history?range=${range}`),
  tasks: () => get<Task[]>('/v1/tasks'),
  task: (id: string) => get<TaskDetail>(`/v1/tasks/${encodeURIComponent(id)}`),
  createTask: (req: CreateTaskRequest) => post<TaskDetail>('/v1/tasks', req),
  approve: (id: string, approve: boolean) => post<void>(`/v1/tasks/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`, {}),
  startOrchestrator: () => post<{ session_id: string }>('/v1/orchestrator/start', {}),
  status: () => get<Status>('/v1/status'),
  spawn: (req: SpawnRequest) => post<{ session_id: string; cwd: string }>('/v1/agents', req),
  signal: (id: string, action: 'pause' | 'resume' | 'kill') => post<void>(`/v1/agents/${encodeURIComponent(id)}/signal`, { action }),
  agentInput: (id: string, data: string) => post<void>(`/v1/agents/${encodeURIComponent(id)}/input`, { data }),
}
