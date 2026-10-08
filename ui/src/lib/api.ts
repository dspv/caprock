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
  /** The agent's own name for the session (Claude Code's ai-title, OpenCode's title). */
  title?: string
  /** Which coding agent produced this session. Absent means Claude Code,
   *  which is what every session was before OpenCode support. */
  agent?: 'claude' | 'opencode' | 'gemini' | 'codex' | 'deepseek'
  /** The agent's own id for a Codex or OpenCode session Caprock started under
   *  an id of its own — the thread or session its importer files under this
   *  one. Absent until the first message is sent, and for every other session. */
  native_id?: string
  /** The session this one was started to carry on, with a brief rather than
   *  its conversation (a relay). */
  relay_from?: string
  /** The repository the session's folder belongs to (a linked worktree resolves to its main repository). */
  repo_root?: string
  /** The worktree's name when the session runs in a linked worktree. */
  worktree?: string
  /** `shell` for a shell tab's session (.ai/21-app.md § Shell tabs); absent for an agent. */
  kind?: 'agent' | 'shell'
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
  /**
   * What the repeated calls paid to re-read the conversation. NOT what the
   * loop cost -- see the note on AttentionItem.costUSD for why that number
   * cannot be computed honestly. Absent when the calls carried no usage.
   */
  tax_usd?: number
  /** What those calls would have paid for context in a subagent. Informational. */
  isolated_usd?: number
  /** How many of the `count` calls the tax covers. Below count when some
   *  arrived on the hook plane, which carries no message id to price them by. */
  tax_priced_calls?: number
}

export interface ContextFill {
  tokens: number
  window: number
  pct: number
  /** What the next tool call costs at this context, before it does any work. */
  next_call_usd: number
}

export interface SessionSummary extends Session {
  stats: Stats
  /** The pricing table's name for the session's latest main-thread model ("Opus 5.5"). */
  model_display?: string
  /** Subagents working in the session now (heard from in the last 30 minutes, not stopped). */
  live_subagents?: number
  activity: Activity
  savings: Savings
  loop?: LoopAlert
  context?: ContextFill
  /** Why `context` is absent — a model the pricing table does not carry, or a
   *  session that has not answered yet. The two look identical from here and
   *  mean opposite things, so the server names which it is. */
  context_note?: string
  /** What tells this session from the others: the agent's own title, else the
   *  first prompt that says something. */
  description?: string
  description_source?: 'title' | 'prompt'
  /** Last prompt, reply or tool call — not the exit or restart that followed it (FB-037). */
  worked_at?: number
  /** The session this one continues: the one a /clear replaced, or the one it was forked from (FB-039). */
  parent_session?: string
  /** Whether it can be carried on from here. On the list: ended sessions only. */
  resume?: ResumeInfo
  /** Caprock started it and still running, but its terminal is not here (an older release's session, or its pty-host died). */
  detached?: boolean
  /** A live session Caprock started whose terminal is in a pty-host: restarting or upgrading Caprock leaves it running (ADR-033). */
  survives_restart?: boolean
  /** How it can be opened in the user's own terminal app; absent when it cannot at all. */
  open_terminal?: OpenTerminalInfo
}

/** How a session can be opened in the user's own terminal application.
 *  `modes` are what is allowed, the first being what the main button does;
 *  `reason` says why there is none, or why one is missing. */
export interface OpenTerminalInfo {
  modes: OpenTerminalMode[]
  reason?: string
}

/** resume: carry an ended session on. move: stop Caprock's process for it,
 *  then resume it there. fork: branch it under a new id; the original runs on. */
export type OpenTerminalMode = 'resume' | 'move' | 'fork'

/** A session as POST /v1/sessions/remove lists it (ADR-037). */
export interface RemovalCandidate {
  session_id: string
  cwd: string
  project: string
  agent: string
  status: string
  owned: boolean
  last_event_at: number
  turns: number
  cost_usd: number
}

/** What removing sessions did, or with dry_run would do. */
export interface RemoveResult {
  dry_run: boolean
  sessions: RemovalCandidate[]
  skipped: (RemovalCandidate & { reason: string })[]
  cost_usd: number
  unmatched_usd: number
}

/** A terminal application installed on this machine. */
export interface NativeTerminal {
  id: string
  name: string
}

export interface TerminalList {
  terminals: NativeTerminal[]
  /** The one a button opens when none is named. */
  preferred: string
}

/** An editor installed on this machine (F18). */
export interface Editor {
  id: string
  name: string
}

export interface EditorList {
  editors: Editor[]
  /** The one used when none is named: the Settings choice, else the first found. */
  preferred: string
}

/** Whether a session can be carried on from here, and if not, why. */
export interface ResumeInfo {
  ok: boolean
  reason?: string
  /** Resumes it from the user's own terminal; offered even when Caprock cannot. */
  command?: string
  /** The permission mode continuing it here starts in when none is picked:
   *  the one it was last running in, else the spawn preference. Absent when
   *  neither says one (the agent's own default). */
  permission_mode?: string
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
  /** Absent when the session's directory is not in a git repository. */
  repo?: RepoLink
  /** Latest first. An older daemon sends none. */
  prs?: SessionPR[]
  /** The session this one carries on (a relay), when Caprock still has it. */
  relayed_from?: RelayLink
  /** The sessions started to carry this one on, oldest first. */
  relayed_to?: RelayLink[]
}

/** One end of a relay, as a session page names it. */
export interface RelayLink {
  session_id: string
  agent: string
  title?: string
  started_at: number
}

/** What the "Continue in…" dialog shows: the proposed first message for a new
 *  session that carries this one on, and what it was built from. Built locally
 *  by the daemon; nothing is sent until the user starts the session. */
export interface RelayBrief {
  session_id: string
  agent: string
  cwd: string
  cwd_exists: boolean
  /** When the relayed passage was written (unix ms); absent when there is none. */
  passage_at?: number
  git?: { branch?: string; base?: string; files: string[]; more?: number; stat?: string; not_repo?: boolean }
  prs: { number: number; url: string }[]
  text: string
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

export interface ModelShare {
  model: string
  tokens: number
  cost_usd: number
  turns: number
  /** What the model generated — the part of a token total that is entirely its
   *  own work and entirely at the top rate. The combined figure is ~99% cache
   *  read on a normal workload, which swamps everything it is added to. */
  output?: number
}

/** Volume whose model is not in the pricing table, so it contributes nothing to
 *  cost_usd. Absent when everything in range was priced. The models are named
 *  because "some tokens are unpriced" is not something a user can act on,
 *  whereas an unknown model id is. */
export interface Unpriced { turns: number; tokens: number; models: string[] }
/** Measured usage from known internal product machinery. It is kept outside
 *  user session/turn/cost totals and carries no dollar guess when the vendor
 *  publishes no price. */
export interface BackgroundUsage { turns: number; tokens: number; models: string[] }
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
export interface ProjectShare {
  project: string; agent?: string; tokens: number; cost_usd: number; sessions: number; paths?: PathShare[]; spark?: Spark
  /** The directory the row is keyed on (repository root, else the session's own
   *  folder). `api.sessionsInDir` lists the row's sessions from it. */
  dir?: string
  /** The repository's web address, from its git remote. Absent without one. */
  repo_url?: string
  /** The latest pull request any session in this row opened or merged. */
  last_pr?: SessionPR
}

/** Where a session's directory lives on the web, read from its git remote. */
export interface RepoLink {
  /** The repository's top level on this machine. */
  root: string
  /** https address; absent when there is no remote a browser can open. */
  url?: string
  branch?: string
  default_branch?: string
  /** The branch's page, when it is not the default and the host is known. */
  branch_url?: string
}

/** A pull request a session opened or merged, from its own `gh pr` output. */
export interface SessionPR {
  session_id: string
  url: string
  number: number
  title?: string
  opened_at?: number
  /** Set only when a merge was recorded. Absent is "not known merged". */
  merged_at?: number
  closed_at?: number
  last_at: number
}
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
export interface Burn {
  window_min: number
  usd_per_hour: number
  tokens_per_min: number
  turns: number
  /** The daemon has been up for less than the window, so the rate is an
   *  extrapolation from a short sample rather than a measured ten minutes. */
  filling?: boolean
}

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
  /** Codex's plan windows as its newest transcript last recorded them —
   *  measured, with observed_at, never a forecast. Absent without Codex. */
  codex_rate_limits?: RateLimits
  /** Present only when some turns could not be priced — see Unpriced. */
  unpriced?: Unpriced
  /** Known internal model work, measured but excluded from user-work totals. */
  background?: BackgroundUsage
}

export interface RateWindow {
  used_percentage: number
  resets_at: number
  forecast?: string
  /** When the same pace reaches 100% (unix ms); set exactly when `forecast` is. */
  limit_at?: number
  /** When the agent wrote the figure (unix ms). Set for Codex, whose windows
   *  come from a transcript that may be hours old. */
  observed_at?: number
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

/** One plan window as the plan-window stop sees it (GET /v1/window-stop). */
export interface WindowStopFigure {
  window: 'five_hour' | 'seven_day'
  used_percentage: number
  /** Unix seconds. */
  resets_at: number
  /** Unix ms: when Claude Code's status line last reported it. */
  observed_at: number
  /** Whether the stop would act on it; `stale` says why not. */
  fresh: boolean
  stale?: string
}

/** A session the plan-window stop paused and will resume. */
export interface WindowStopPaused {
  session_id: string
  project: string
  title?: string
  window: 'five_hour' | 'seven_day'
  /** Unix seconds: the reset after which it resumes (a minute after). */
  resume_at: number
  paused_at: number
}

export interface WindowStopEvent {
  kind: 'paused' | 'resumed'
  at: number
  window?: string
  used_percentage?: number
  threshold_pct?: number
  resume_at?: number
  sessions: string[]
}

/** GET /v1/window-stop: the Premium plan-window stop's state. */
export interface WindowStop {
  /** The share in percent; 0 is off. */
  pct: number
  licensed: boolean
  /** How old a figure may be and still pause anything. */
  fresh_for_s: number
  windows: WindowStopFigure[]
  paused: WindowStopPaused[]
  last?: WindowStopEvent
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

/** One arm of the handoff comparison: sessions, how many reached a first edit, and the medians to get there. */
export interface HandoffGroup { sessions: number; reached: number; median_min: number; median_calls: number }

export interface Settings {
  /** Whether Claude is told what the last session left in the same folder. */
  memory?: boolean
  /** Share of new sessions (0–50) the handoff is held back from, to measure it. */
  memory_holdout_pct?: number
  /** Where the folder picker may look. Empty means the home directory. */
  browse_root?: string
  /** The terminal app sessions open in ("ghostty", "iterm2", ...). Empty: the first installed. */
  terminal?: string
  /** The editor "Open in editor" uses ("vscode", "zed", ...). Empty: the first installed. */
  editor?: string
  /** The permission mode new sessions start in, in Claude Code's words. Empty: not set. */
  spawn_permission_mode?: string
  /** The daily spend ceiling in USD; 0 is off. See internal/cap. */
  cap_usd_per_day?: number
  /** The share of a Claude plan window (50–99) at which Premium pauses the
   *  Claude Code sessions Caprock started until the window resets; 0 is off.
   *  90 until someone chooses. See internal/cap/window.go. */
  window_stop_pct?: number
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
  /** Phone alerts through the same bot (ADR-036): off unless turned on, free. */
  alert_approval?: boolean
  alert_finished?: boolean
  /** The first line of the final reply in a finished alert; on unless turned off. */
  alert_reply?: boolean
  /** The desktop app's OS notifications, apart from Telegram's (WP-09):
   *  approval on unless turned off, finished off unless turned on. */
  notify_approval?: boolean
  notify_finished?: boolean
  /** Why the last alert failed, absent when it did not; when one last arrived. */
  alert_last_error?: string
  alert_last_sent_ms?: number
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
  /** The desktop app's upgrade command, when Homebrew's cask installed it. */
  app_command?: string
  url?: string
  checked_at?: number
  error?: string
  /** The published release's own description of what changed. */
  notes?: string
  /** The version `notes` describes — never assume it is `latest`. */
  notes_for?: string
}

export interface DailyStat { day: string; project: string; model: string; tokens_total: number; cost_usd: number; sessions: number }

export interface ToolCount {
  tool: string
  count: number
  /** Bytes this tool handed back, summed. Not tokens: a tool spends none — the
   *  turn that reads its output does — so a per-tool token figure could only
   *  be a turn's tokens divided up, which looks measured and is not. */
  bytes: number
}
export interface HistoryTotals { sessions: number; owned_sessions: number; turns: number; tool_calls: number; files_touched: number; cost_usd: number; avg_session_sec: number; days: number; unpriced?: Unpriced; background?: BackgroundUsage }
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

/** What a range paid to re-send its own context: every turn re-reads the whole
 *  conversation before it does anything. Absent when nothing could be priced. */
export interface ContextTax { tax_usd: number; cost_usd: number; share: number; unpriced_tokens?: number }
/** GET /v1/glance — the all-time agent split and the bill by token type, for
 *  the Now screen's At a glance block. */
export interface Glance {
  agents: WeekAgent[]
  bill?: { input_usd: number; output_usd: number; cache_write_usd: number; cache_read_usd: number; unpriced_tokens?: number }
  display: Record<string, string>
}

/** GET /v1/week — seven local days of what this machine's agents did, for the
 *  Week card. Nothing in it names a repository, a path, a prompt or a session
 *  title. `estimates` lists the fields a renderer must mark with "≈". */
export interface WeekDay { day: string; prs_opened: number; cost_usd: number; active: boolean }
export interface WeekAgent { agent: string; subagent: boolean; turns: number; cost_usd: number; sessions: number; threads?: number }
export interface WeekLoop {
  agent: string
  tool: string
  /** What the repeated call did: poll, input, command, edit, fetch, subagent, other. */
  kind: string
  calls: number
  first_ms: number
  last_ms: number
  /** What the loop paid to re-read context — an estimate; absent when unpriceable. */
  tax_usd?: number
  tax_priced_calls?: number
}
export interface Week {
  /** The named window asked for (`today`, `7d`, `30d`, `all`); absent for a week picked by its first day. */
  period?: string
  start: string
  end: string
  partial: boolean
  from_ms: number
  to_ms: number
  days: WeekDay[]
  sessions: number
  active_days: number
  turns: number
  cost_usd: number
  unpriced_turns?: number
  models: { model: string; cache_read: number; cost_usd: number }[]
  prs_opened: number
  prs_merged: number
  merges_unresolved: number
  commits: number
  files_edited: number
  lines_added: number
  lines_removed: number
  ci_wait_ms: number
  tool_ms: number
  agents: WeekAgent[]
  loop?: WeekLoop
  biggest?: { agent: string; cost_usd: number; turns: number; active_days: number }
  tax?: ContextTax
  cost_per_merged_pr?: number
  estimates: string[]
  pricing_version?: string
}

/** One group of a tool's calls. Results, failures, bytes and trend are Premium:
 *  the daemon leaves them out without a licence. */
export interface DrillRow { key: string; calls: number; results?: number; failures?: number; bytes?: number; trend?: number[] }
export interface DrillHint { kind: 'failures' | 'output' | 'repeats'; key: string; text: string }
/** GET /v1/tools/drill: one tool's calls grouped by what they were about. */
export interface ToolDrill {
  tool: string
  kind: 'shell' | 'files' | 'web' | 'mcp' | 'other'
  group_by: string
  calls: number
  results?: number
  failures?: number
  bytes?: number
  rows: DrillRow[]
  other: number
  trend_from_ms?: number
  trend_width_ms?: number
  hints?: DrillHint[]
  range: string
  locked: boolean
  /** The strongest hint, sent in full even without a licence. */
  teaser?: DrillHint
}

/** Which Caprock hook events are registered in Claude Code's settings file. */
export interface HooksStatus { settings_path: string; shim_path: string; installed: string[] | null; missing: string[] | null; shim_exists: boolean }

export interface History { range: string; totals: HistoryTotals; tools: ToolCount[]; daily: DailyStat[]; savings: Savings; summary: Summary; tax?: ContextTax }

export interface Status {
  /** Present when the daemon is reading OpenCode; absent when it is not
   *  installed. This is what tells the UI whether an agent filter has
   *  anything to switch between — a session list or a day's summary cannot
   *  answer it, because either may legitimately be empty. */
  opencode?: { sessions: number; events: number; last_poll_ms?: number }
  /** Codex reports `unpriced` too: turns whose transcript never named a model,
   *  which therefore carry tokens but no cost. */
  codex?: { sessions: number; events: number; unpriced?: number; last_poll_ms?: number }
  /** DeepSeek Harness reports the same terms; absent when DSH has no sessions. */
  deepseek?: { sessions: number; events: number; unpriced?: number; last_poll_ms?: number }
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
  hooks?: HooksStatus
  /** The terminal error that stopped transcript ingest, when one happened.
   *  While this is set nothing new is being captured, however healthy the rest
   *  of the status looks. */
  ingest_error?: string
  /** Sessions the last stop of Caprock (or of the machine) cut off and nobody
   *  has continued yet; absent when there are none. */
  interrupted?: { stopped_at: number; ids: string[] }
  ui_built: boolean
  claude_available: boolean
  /** The user accepted Claude Code's one-time bypass warning, so a bypass
   *  session starts without it (ADR-041). Absent on older daemons. */
  claude_bypass_accepted?: boolean
  /** The Gemini CLI is on PATH, so the new-session dialog can offer it as an
   *  agent. Absent on daemons older than this feature. */
  gemini_available?: boolean
  /** Codex and OpenCode, found on the login shell's PATH or where their
   *  installers put them. Absent on daemons older than this feature. */
  codex_available?: boolean
  opencode_available?: boolean
  owned_active: number
  loop_k: number
  loop_t_minutes: number
  active_loops: number
  orchestration: boolean
  /** What the session handoff can speak for: repositories, and since when. */
  memory?: {
    repos: number; since?: string; held?: string
    /** The handoff experiment: the holdout in force, and how each group has done. */
    holdout_pct?: number
    served?: HandoffGroup
    withheld?: HandoffGroup
  }
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

/** What Caprock keeps on disk: GET /v1/storage. The database composition is
 *  measured in the background and cached, so `database` is absent for the
 *  first minute after the daemon starts. */
export interface StorageReport {
  data_dir: string
  total_bytes: number
  files: { name: string; bytes: number; dir?: boolean }[]
  database?: {
    page_size: number
    page_count: number
    free_pages: number
    tables?: { name: string; data_bytes: number; index_bytes: number }[]
    events: number
    payload_bytes: number
    oldest_ts: number
    agents: StorageSlice[]
    kinds: StorageSlice[]
    recent: StorageWindow[]
    older: StorageWindow[]
  }
  measured_at?: number
  measure_ms?: number
  error?: string
  reclaimable_bytes: number
  /** An estimate, and named as one: see 03-contracts.md § Storage. */
  growth_bytes_per_day_est: number
  retention_days: number
}
export interface StorageSlice { name: string; events: number; payload_bytes: number }
export interface StorageWindow { days: number; events: number; payload_bytes: number }

/** One directory the folder picker may offer. */
export interface BrowseEntry { name: string; path: string; repo: boolean }
export interface BrowseResponse { dir: string; parent: string; root: string; entries: BrowseEntry[] }
/** A directory Caprock has already seen sessions run in. */
export interface RecentDir { dir: string; name: string; sessions: number; last_event_at: number }

export interface SpawnRequest {
  /** Which coding agent to launch: "claude" (default), "codex", "opencode" or
   *  "gemini". They take different flags, so the daemon builds the argv per
   *  agent. A resume is continued in the agent that ran the session,
   *  whatever this says. */
  agent?: 'claude' | 'codex' | 'opencode' | 'gemini'
  cwd?: string; chat?: boolean; create?: boolean; worktree?: string
  model?: string; permission_mode?: string; args?: string[]
  /** Continue an existing conversation instead of starting a new one. Caprock
   *  cannot type into a process it did not start, so picking a session up
   *  means starting a second one on the same history. */
  resume?: string
  /** Branch rather than continue: a new session id for the copy, leaving the
   *  original alone. Needed when the session being picked up is still
   *  running, or both would write one transcript between them. */
  fork?: boolean
  /** The first message, sent as the session starts — a relay's brief, which
   *  the user has read and may have edited. Ignored on a resume. */
  prompt?: string
  /** The session this new one carries on (a relay). The folder defaults to
   *  that session's when `cwd` is left out. */
  relay_from?: string
}

/**
 * The device token, for a dashboard being read from a tablet.
 *
 * On the machine itself this is always empty and nothing changes: loopback
 * needs no token, and the daemon does not ask for one. A device on the local
 * network gets one by pairing, keeps it, and sends it on every request from
 * then on.
 *
 * localStorage rather than a cookie, deliberately. A cookie rides along on
 * requests the user did not make, which is what makes CSRF possible, and this
 * API starts sessions and runs commands. A header is sent only by code that
 * meant to send it.
 */
const DEVICE_TOKEN_KEY = 'caprock.device.token'

export function deviceToken(): string {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY) ?? ''
  } catch {
    return '' // private mode: pairing will simply be asked for again
  }
}

/**
 * Whether this dashboard is being read from a paired device rather than on
 * the machine Caprock runs on.
 *
 * The token is kept per origin, and a paired device reaches the dashboard at
 * the LAN address while the machine itself uses loopback, so holding one is
 * exactly "this is the tablet". A paired device may read and nothing else
 * (ADR-029) — the daemon refuses the rest with 403 — so controls it cannot use
 * are not drawn there. The exception is a device the owner made a controller
 * (ADR-034): ask `useCanControl` for the controls that role unlocks.
 */
export function isPairedDevice(): boolean {
  return deviceToken() !== ''
}

export function setDeviceToken(token: string) {
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, token)
  } catch { /* nothing to do; the next request will 401 and ask again */ }
}

export function clearDeviceToken() {
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY)
  } catch { /* ignore */ }
}

/** Headers for a request, carrying the device token when there is one. */
function withDevice(h: Record<string, string> = {}): Record<string, string> {
  const t = deviceToken()
  return t ? { ...h, 'X-Caprock-Device': t } : h
}

async function post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(path, { method, headers: withDevice({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
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
  const res = await fetch(path, { headers: withDevice({ Accept: 'application/json' }) })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* ignore */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  return (await res.json()) as T
}

/**
 * The sessions list, with how many exist behind it.
 *
 * The list is capped server-side at 200. Without the total, a screen labels
 * the array it received — "Ended · 200" — which reads as a count of every
 * ended session and is a count of the page. `get` drops response headers, so
 * this one call does its own fetch rather than teaching every call to carry a
 * total it does not have.
 */
async function sessionsWithTotal(activeOnly: boolean, search = '', limit = 0): Promise<{ items: SessionSummary[]; total: number }> {
  const qs = new URLSearchParams()
  if (activeOnly) qs.set('active', 'true')
  if (search.trim()) qs.set('q', search.trim())
  if (limit > 0) qs.set('limit', String(limit))
  const query = qs.toString()
  const res = await fetch(`/v1/sessions${query ? `?${query}` : ''}`, {
    headers: withDevice({ Accept: 'application/json' }),
  })
  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { /* ignore */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body)
  }
  const items = (await res.json()) as SessionSummary[]
  const n = Number(res.headers.get('X-Total-Count'))
  // An older daemon sends no header; then the page is all we know of.
  return { items, total: Number.isFinite(n) && n > 0 ? n : items.length }
}

/** A device that has been let in from the local network. */
export interface PairedDevice {
  id: string
  name: string
  paired_at: number
  last_seen: number
  /** A viewer reads; a controller may also start, type into and stop
   *  sessions (ADR-034). Granted on the machine, never by pairing. */
  role: 'viewer' | 'controller'
}

/** What the owner sees on the pairing panel. */
export interface PairState {
  /** Whether this daemon is listening on the network at all. */
  enabled: boolean
  /** What to type into the other device. Empty when disabled. */
  url?: string
  /** The outstanding code, shown only on the machine itself. */
  code?: string
  expires_in_sec?: number
  /** The address reaches other networks (a tunnel), not just this one. */
  tunnelled?: boolean
  /** Every address a phone can open, `url` first: the LAN one, the Tailscale
   *  one and its MagicDNS name (WP-15). A code works on any of them. */
  addresses?: PairAddress[]
  devices: PairedDevice[]
}

/** One address network access answers on. */
export interface PairAddress {
  url: string
  /** `lan`: the same Wi-Fi only; `tailscale`: a 100.x address, anywhere the
   *  phone has Tailscale; `magicdns`: the same, by its MagicDNS name. */
  kind: 'lan' | 'tailscale' | 'magicdns'
}

export const api = {
  sessions: (activeOnly = false) => get<SessionSummary[]>(`/v1/sessions${activeOnly ? '?active=true' : ''}`),
  sessionsWithTotal,
  /** One Projects row's sessions, newest first, each with whether it can be picked up. */
  sessionsInDir: (dir: string) => get<SessionSummary[]>(`/v1/sessions?dir=${encodeURIComponent(dir)}`),
  session: (id: string) => get<SessionDetail>(`/v1/sessions/${encodeURIComponent(id)}`),
  events: (id: string, after = 0, limit = 500) => get<Event[]>(`/v1/sessions/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`),
  /** The events immediately preceding `before`, oldest-first — paging back
   *  through a long session without refetching from its start. */
  eventsBefore: (id: string, before: number, limit = 200) =>
    get<Event[]>(`/v1/sessions/${encodeURIComponent(id)}/events?before=${before}&limit=${limit}`),
  /** The newest events for a session, for anything showing recent activity. */
  recentEvents: (id: string, limit = 2000) => get<Event[]>(`/v1/sessions/${encodeURIComponent(id)}/events?newest=1&limit=${limit}`),
  /** The main thread's newest events of these kinds, filtered before the
   *  limit: a parent's own calls, however busy its subagents are. */
  recentMainEvents: (id: string, kinds: readonly string[], limit = 400) =>
    get<Event[]>(`/v1/sessions/${encodeURIComponent(id)}/events?newest=1&main=1&kind=${encodeURIComponent(kinds.join(','))}&limit=${limit}`),
  /** The subagents working in a session now, and how many finished lately. */
  subagents: (id: string) => get<SubagentsNow>(`/v1/sessions/${encodeURIComponent(id)}/subagents`),
  diff: (id: string) => get<DiffResult>(`/v1/sessions/${encodeURIComponent(id)}/diff`),
  notes: (id: string, limit = 200) => get<AssistantNote[]>(`/v1/sessions/${encodeURIComponent(id)}/notes?limit=${limit}`),
  /** `before` pages backwards: pass the lowest event_id already shown. */
  searchNotes: (q: string, limit = 100, before = 0) =>
    get<AssistantNote[]>(`/v1/notes?q=${encodeURIComponent(q)}&limit=${limit}${before ? `&before=${before}` : ''}`),
  /** Sends this week's report now, so a bot can be tested without waiting
   *  for Monday. The failure mode of this feature is silence, which is
   *  indistinguishable from a quiet week. */
  testReport: () => post<{ sent: string }>('/v1/report/test', {}),
  testAlert: () => post<{ sent: string }>('/v1/alerts/test', {}),
  /** Runs `caprock hooks install` in the daemon; answers with what is registered after. */
  installHooks: () => post<{ hooks: HooksStatus; backup?: string }>('/v1/hooks/install', {}),
  /** The user accepted Caprock's copy of Claude Code's bypass warning (ADR-041). */
  acceptBypass: () => post<{ accepted: boolean }>('/v1/claude/bypass-consent', {}),
  pairState: () => get<PairState>('/v1/pair/state'),
  /** Exchange a code for a token. The one call a device makes before it is trusted. */
  pairRedeem: (code: string, name: string) =>
    post<{ token: string; id: string; name: string }>('/v1/pair', { code, name }),
  pairCode: () => post<{ code: string; expires_in_sec: number; url: string }>('/v1/pair/code', {}),
  /** Withdraw the outstanding code, so it stops working before it expires. */
  pairCancelCode: () => post<{ cleared: boolean }>('/v1/pair/code', {}, 'DELETE'),
  /** Turn network access on or off without restarting the daemon. */
  setLAN: (on: boolean) => post<{ enabled: boolean; url?: string }>('/v1/pair/lan', { on }),
  pairRevoke: (id: string) => post<{ revoked: number }>(`/v1/pair/devices/${encodeURIComponent(id)}`, {}, 'DELETE'),
  /** Give a paired device control of sessions, or take it away. Machine only. */
  pairSetRole: (id: string, role: PairedDevice['role']) =>
    post<{ id: string; role: string }>(`/v1/pair/devices/${encodeURIComponent(id)}/role`, { role }, 'PUT'),
  /** Which role this dashboard's device holds: "owner" on the machine itself. */
  pairMe: () => get<{ role: 'owner' | PairedDevice['role']; id?: string; name?: string }>('/v1/pair/me'),
  settings: () => get<Settings>('/v1/settings'),
  update: () => get<UpdateStatus>('/v1/update'),
  checkUpdate: () => post<UpdateStatus>('/v1/update/check', {}),
  saveSettings: (s: Settings) => post<Settings>('/v1/settings', s, 'PUT'),
  summary: (range: 'today' | '7d' | '30d' | 'all' = 'today', agent?: string) =>
    get<Summary>(`/v1/stats/summary?range=${range}${agent && agent !== 'all' ? `&agent=${agent}` : ''}`),
  daily: (days = 30) => get<DailyStat[]>(`/v1/stats/daily?days=${days}`),
  premium: () => get<PremiumPricing>('/v1/premium'),
  windowStop: () => get<WindowStop>('/v1/window-stop'),
  gemini: () => get<GeminiStatus>('/v1/gemini'),
  askGemini: (prompt: string, model?: string) => post<GeminiReply>('/v1/gemini/ask', { prompt, model }),
  browse: (dir = '') => get<BrowseResponse>(`/v1/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  recentDirs: () => get<RecentDir[]>('/v1/recent-dirs'),
  history: (range: 'today' | '7d' | '30d' | 'all' = 'all') => get<History>(`/v1/history?range=${range}`),
  /** `start` is the first local day (YYYY-MM-DD); omitted, the seven days ending today. */
  glance: () => get<Glance>('/v1/glance'),
  toolDrill: (tool: string, range: 'today' | '7d' | '30d' | 'all' = 'all', agent?: string) =>
    get<ToolDrill>(`/v1/tools/drill?tool=${encodeURIComponent(tool)}&range=${range}${agent && agent !== 'all' ? `&agent=${agent}` : ''}`),
  week: (start?: string) => get<Week>(`/v1/week${start ? `?start=${start}` : ''}`),
  /** The same card for a named window: today, the last 7 or 30 days, or all time. */
  weekFor: (period: 'today' | '7d' | '30d' | 'all') => get<Week>(`/v1/week?period=${period}`),
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
  storage: () => get<StorageReport>('/v1/storage'),
  /** Terminal applications installed here, most preferred first. */
  terminals: () => get<TerminalList>('/v1/terminals'),
  /** Open a session in the user's own terminal app. */
  openTerminal: (id: string, req: { terminal?: string; mode?: OpenTerminalMode }) =>
    post<{ terminal: NativeTerminal; mode: OpenTerminalMode; command: string }>(`/v1/sessions/${encodeURIComponent(id)}/open-terminal`, req),
  /** Editors installed here (F18). Refused off this machine. */
  editors: () => get<EditorList>('/v1/editors'),
  /** Open a folder, or a file at a line, in an editor. Refused off this machine. */
  openInEditor: (req: { path: string; line?: number; editor?: string }) => post<{ editor: Editor }>('/v1/editors/open', req),
  /** Remove sessions from Caprock for good — the machine only (ADR-037). */
  removeSessions: (req: { ids?: string[]; cwd_prefix?: string; dry_run?: boolean }) => post<RemoveResult>('/v1/sessions/remove', req),
  spawn: (req: SpawnRequest) => post<{ session_id: string; cwd: string }>('/v1/agents', req),
  /** The models an agent's own CLI lists — Codex's on-disk catalog and its
   *  configured default. Empty for the other agents. */
  /** The proposed brief for carrying a session on in a new one (a relay). */
  relayBrief: (id: string) => get<RelayBrief>(`/v1/sessions/${encodeURIComponent(id)}/relay`),
  agentModels: (agent: string) =>
    get<{ agent: string; default?: string; models: { id: string; label: string }[] }>(`/v1/agents/models?agent=${encodeURIComponent(agent)}`),
  signal: (id: string, action: 'pause' | 'resume' | 'kill') => post<void>(`/v1/agents/${encodeURIComponent(id)}/signal`, { action }),
  /**
   * Write a pasted or dropped file and get back the path Claude Code can read.
   * `name` is the file's own name: the daemon keeps a sanitised copy of it and
   * decides what is accepted by its extension, because a browser leaves
   * `type` empty for Markdown, CSV, JSON and source files.
   *
   * Base64 inside JSON rather than a raw upload, because the daemon's forgery
   * guard turns away a state-changing request that is not `application/json` —
   * and `image/png` is a simple content type, so a raw upload would have been
   * an endpoint any page in the browser could use to write files into the
   * user's data directory.
   */
  paste: (file: { name: string; type: string; data: string }) => post<{ path: string }>('/v1/paste', file),
  agentInput: (id: string, data: string) => post<void>(`/v1/agents/${encodeURIComponent(id)}/input`, { data }),
  /** The permission prompt an owned session is waiting on, or null (ADR-035). */
  permission: (id: string) => get<{ permission: Permission | null }>(`/v1/agents/${encodeURIComponent(id)}/permission`),
  /** Answer it: the daemon presses the key, while `promptId` is still the one waiting (409 otherwise). */
  answerPermission: (id: string, promptId: string, choice: PermissionChoice) =>
    post<void>(`/v1/agents/${encodeURIComponent(id)}/permission`, { id: promptId, choice }),
}

/** One subagent working in a session (GET /v1/sessions/{id}/subagents). */
export interface Subagent {
  agent_id: string
  /** "general-purpose", "Explore"…; absent when no hook named one. */
  agent_type?: string
  /** What the parent asked it to do, when its launch says. */
  description?: string
  tool_calls: number
  /** Unix ms. */
  started_at: number
  last_at: number
  /** Its newest call: the tool, its short line, when it started (unix ms). */
  tool?: string
  detail?: string
  tool_at?: number
  /** That call has no result yet. */
  running: boolean
  /** Its newest event is a permission prompt. */
  asking: boolean
}

export interface SubagentsNow {
  working: Subagent[]
  /** How many stopped in the same window after making a tool call. */
  finished: number
}

/** A permission prompt an owned Claude Code session is showing (ADR-035). */
export interface Permission {
  id: string
  /** The tool being asked about: Bash, Write, an MCP tool… */
  tool: string
  /** What it would do: the command, the file, the URL. */
  detail: string
  /** The "don't ask again" option's label, when the hook suggests one. The
   * daemon still checks the menu on the screen has it before typing (422). */
  always?: string
  since: string
  /** How many more prompts are outstanding besides this one. */
  queued?: number
  /** Set when a subagent asked: Claude Code draws its dialog in the parent's terminal. */
  agent_id?: string
  /** The subagent's type ("general-purpose"), with agent_id. */
  agent_type?: string
  /** Every outstanding prompt, oldest first, when there is more than one.
   * Which the terminal shows is unknown then, so no key answers any of them. */
  waiting?: Permission[]
}

/** `dismiss` types nothing: it takes away the card of a prompt settled where no hook saw it. */
export type PermissionChoice = 'allow' | 'always' | 'deny' | 'dismiss'
