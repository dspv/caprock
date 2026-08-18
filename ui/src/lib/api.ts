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
export interface ProjectShare { project: string; tokens: number; cost_usd: number }
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
}

export interface DailyStat { day: string; project: string; model: string; tokens_total: number; cost_usd: number; sessions: number }

export interface Status {
  version: string
  pid: number
  started_at: number
  uptime_s: number
  url: string
  data_dir: string
  pricing: { version: string; source: string; fetched_at: string; user_override: boolean; models: number }
  ingest?: { files_known: number; lines_parsed: number; lines_malformed: number; lines_skipped: number; events_stored: number; events_deduped: number; backfill_done: boolean }
  hooks?: { settings_path: string; shim_path: string; installed: string[] | null; missing: string[] | null; shim_exists: boolean }
  ui_built: boolean
  loop_k: number
  loop_t_minutes: number
  active_loops: number
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
  diff: (id: string) => get<DiffResult>(`/v1/sessions/${encodeURIComponent(id)}/diff`),
  summary: (range: 'today' | '7d' | '30d' | 'all' = 'today') => get<Summary>(`/v1/stats/summary?range=${range}`),
  daily: (days = 30) => get<DailyStat[]>(`/v1/stats/daily?days=${days}`),
  status: () => get<Status>('/v1/status'),
}
