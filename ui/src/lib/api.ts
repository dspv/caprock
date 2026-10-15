// Typed client for the daemon API (.ai/03-contracts.md § HTTP API). snake_case
// on the wire, kept as-is in the types so the contract is visible in the code.
import type { ReapResult, ResourceReport } from './resources'
import type { Footprint, OrphanStopResult, OrphanTarget } from './footprint'
import type { PullRequest } from './github'
import type { Usual } from './usual'
import type { ActionsUsage, CICost, RunnerCost } from './runnercost'
import type { BranchPR, SessionBranches } from './branches'
import type { PRBoard } from './prboard'
import type { ReposCI } from './reposci'

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
  /** The user's own name for the session, renamed from its tab or sidebar
   *  row (`PUT /v1/sessions/{id}/name`); outranks `title`. Empty: not renamed. */
  name?: string
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
  /** The sign-in it ran on (ADR-048): a subscription id from Settings →
   *  Subscriptions; absent for the Default sign-in. */
  subscription?: string
  /** The repository the session's folder belongs to (a linked worktree resolves to its main repository). */
  repo_root?: string
  /** The worktree's name when the session runs in a linked worktree. */
  worktree?: string
  /** `shell` for a shell tab's session (.ai/21-app.md § Shell tabs); absent for an agent. */
  kind?: 'agent' | 'shell'
  /** A shell's foreground program (`GET /v1/shells`): "claude", "npm"; absent while it is idle. */
  program?: string
  /** One prompt, N attempts (ADR-052): the group, which attempt this is and of how many. */
  attempt_group?: string
  attempt?: number
  attempts?: number
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
  /** Subagents still working after the main thread ended its turn: health is
   *  working, nothing is wanted from the user, and Claude Code resumes the
   *  parent when they finish. Absent otherwise. */
  background?: number
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
  /** What tells this session from the others: the name the user gave it, else
   *  the agent's own title, else the first prompt that says something. */
  description?: string
  description_source?: 'name' | 'title' | 'prompt'
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

/** Another live session in the same checkout (`GET /v1/overlap`): named as
 *  its card names it, with the files both edited in the window. */
export interface OverlapPeer {
  session_id: string
  name: string
  name_source?: 'name' | 'title' | 'prompt'
  started_at: number
  files: string[]
}

/** `GET /v1/overlap`: only sessions with a neighbour in their checkout are keyed. */
export interface Overlap {
  window_minutes: number
  sessions: Record<string, { checkout: string; with: OverlapPeer[] }>
}

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

/** One priced main-thread model call (`GET /v1/sessions/{id}/calls`), oldest first. */
export interface SessionCall {
  id: number
  /** Unix ms. */
  ts: number
  model?: string
  model_display?: string
  cost_usd: number
  tokens?: TokenDelta
  /** The tool calls it asked for, the first six, joined by message id; absent when none or unknown. */
  tools?: { tool: string; detail?: string }[]
  tool_count?: number
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
export interface Spark {
  from_ms: number; width_ms: number; cost: number[]; tokens: number[]
  /** The input side of `tokens` (fresh input, cache reads and writes) and the assistant turns, per bucket; absent from an older daemon. */
  input?: number[]; turns?: number[]
  /** Active session-hours per bucket (an hour in which one session made five or more priced calls) and what they cost: the chart's burn rate. Absent from an older daemon. */
  active_hours?: number[]; active_cost?: number[]
}
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
/** One of a session's PRs with what GitHub says of it now (`GET /v1/sessions/{id}/prs`). */
export interface SessionPRLive extends SessionPR {
  /** Absent while GitHub is not connected or could not be read. */
  live?: PullRequest
  error?: { message: string }
}
/** How fresh a deck answer is: when the daemon composed it (unix ms), and
 *  whether it is the one kept while a newer one is composed. */
export interface DeckFresh {
  fetched_at?: number
  refreshing?: boolean
  /** Why the daemon's newest composition failed (at refresh_failed_at, unix
   *  ms): the answer is the one before it. */
  refresh_error?: string
  refresh_failed_at?: number
}
/** `GET /v1/sessions/{id}/prs`. */
export interface SessionPRs extends DeckFresh {
  connected: boolean
  prs: SessionPRLive[]
}
/** One step of a GitHub Actions job (`GET /v1/sessions/{id}/ci`). Times are unix ms. */
export interface CIStep {
  number: number
  name: string
  status: string
  conclusion?: string
  started_at?: number
  completed_at?: number
  duration_ms?: number
}
export interface CIJob {
  id: number
  run_id: number
  name: string
  /** queued | in_progress | completed (and waiting, pending, requested). */
  status: string
  /** success | failure | cancelled | skipped | timed_out | neutral…, once completed. */
  conclusion?: string
  started_at?: number
  completed_at?: number
  /** completed_at - started_at, from GitHub's own timestamps; absent until it finished. */
  duration_ms?: number
  labels: string[]
  /** linux | windows | macos | self-hosted, read from the labels; absent when they name none. */
  os?: string
  runner_name?: string
  html_url?: string
  steps: CIStep[]
  /** The median duration of the job of this name in the workflow's last
   *  successful runs (up to 5); absent with fewer than 2 of them. */
  baseline?: CIBaseline
  /** What its minutes cost at list rate (lib/runnercost.ts); unpriced with a reason. */
  cost?: RunnerCost
}
/** What a run or a job usually takes: a median, and how many runs it is of. */
export interface CIBaseline { median_ms: number; runs: number }
export interface CIRun {
  id: number
  name: string
  event?: string
  status: string
  conclusion?: string
  attempt?: number
  html_url?: string
  created_at?: number
  updated_at?: number
  /** When this attempt started (GitHub's run_started_at). */
  started_at?: number
  /** The branch, or for a tag push or a release the tag. */
  head_branch?: string
  head_sha?: string
  workflow_id?: number
  jobs: CIJob[]
  /** The median wall-clock span of the workflow's last successful runs (up
   *  to 5); absent with fewer than 2 of them. */
  baseline?: CIBaseline
  /** The sum of its finished jobs' cost. */
  cost?: CICost
}
/** A commit's GitHub Actions. runner_ms sums the finished jobs; by_os splits it, no billing multiplier. */
export interface CIState {
  repo: string
  head_sha: string
  /** Set on a branch's CI (the Main view). */
  branch?: string
  state: 'running' | 'fail' | 'pass' | 'none'
  runs: CIRun[]
  runner_ms: number
  by_os: { os: string; ms: number }[]
  /** The sum over every run's finished jobs: the commit's cost. */
  cost?: CICost
  at: number
  error?: { message: string; kind?: string }
}
/** `GET /v1/sessions/{id}/ci`: the CI of the session's open PR, else its newest. */
export interface SessionCI extends DeckFresh {
  connected: boolean
  pr?: { number: number; url: string; title?: string; state?: string; repo: string; head_sha?: string; live?: PullRequest }
  ci?: CIState
  error?: { message: string; kind?: string }
}
/** A repository's newest release run: a tag push or a release event. */
export interface ReleaseCI {
  repo: string
  tag?: string
  state: 'running' | 'fail' | 'pass' | 'none'
  run?: CIRun
  /** The median span of the last `runs` successful release runs of the same workflow; set while it runs. An estimate. */
  estimate?: { median_ms: number; runs: number }
  /** The GitHub release published for the tag, once the run passed. */
  release?: { url: string; published_at?: number; draft?: boolean }
  at: number
  error?: { message: string; kind?: string }
}
/** `GET /v1/sessions/{id}/ci/release` and `…/ci/main`: the session's repository's release build or default branch. */
/** One workflow's runs over the window (`github.WorkflowStats`). */
export interface WorkflowStats {
  name: string
  runs: number
  red: number
  /** The median of its successful runs (ms); absent with fewer than two. */
  median_ms?: number
  median_runs: number
  /** Per day, oldest first; 0 for a day without two successful runs. */
  daily_median_ms: number[]
}
/** A repository's figures over the last 14 days (`github.RepoStats`). */
export interface RepoStats {
  /** Local calendar days, oldest first, "2006-01-02". */
  days: string[]
  merged: number[]
  ttm_median_ms?: number
  ttm_count: number
  prs_listed: number
  ci: {
    runs: number
    red: number
    reruns: number
    listed: number
    oldest?: number
    per_day: { runs: number; red: number }[]
    workflows: WorkflowStats[]
  }
}
/** One listed repository with a session in it: GET /v1/repos/activity. */
export interface RepoActivity {
  project_id: number
  root: string
  name: string
  /** Local calendar days, oldest first; the arrays below are per day. */
  days: string[]
  commits: number[]
  added: number[]
  deleted: number[]
  last_commit_at?: number
  /** Files the working tree has changed or new. */
  dirty: number
  sessions: number
  checked_ms: number
  error?: string
  /** Only while GitHub is connected and the remote is on GitHub; each part only once the deck or the Pipeline page read it. */
  github?: {
    repo: string
    pulls?: { open: number; merged_7d: number; ttm_median_ms?: number; listed: number }
    ci?: { runs: number; red: number; workflow?: string; median_ms?: number }
    release?: { tag?: string; state: string; at?: number }
  }
}

export interface ReposActivity {
  repos: RepoActivity[]
  github_connected: boolean
}

/** `GET /v1/sessions/{id}/ci/stats`: the Pipeline page. */
export interface SessionCIStats extends DeckFresh {
  connected: boolean
  repo?: string
  reason?: string
  prs: BranchPR[]
  stats?: RepoStats
  /** The Board view: the pull requests by stage, the releases, the flow strip. */
  board?: PRBoard
  /** GitHub's refusal of the newest read: with prs, those are the ones read at read_at, not refreshed. */
  error?: { message: string; kind?: string }
  /** When GitHub last answered what the board draws on (unix ms). */
  read_at?: number
}
export interface SessionRepoCI extends DeckFresh {
  connected: boolean
  /** owner/name, from the session's directory's remote. */
  repo?: string
  /** Why there is no repository: no_repo | not_github. */
  reason?: string
  branch?: string
  release?: ReleaseCI
  ci?: CIState
  error?: { message: string; kind?: string }
}
/** The lines around a failed job's last error (`GET /v1/sessions/{id}/ci/jobs/{job}/log`). */
export interface CILog {
  job_id: number
  lines: string[]
  /** Index in lines of the error, -1 when the log marks none. */
  error_line: number
  truncated?: boolean
}
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
  /** The viewer's own usual over the last 30 days (lib/usual.ts); absent with too little history. */
  usual?: Usual
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

/** GET /v1/telegram: the bridge to the owner's own bot (ADR-047). */
/** Where a credential is kept (internal/secret): the macOS login keychain,
 *  a 0600 file (with its path), or still config.json when moving it failed. */
export interface SecretWhere {
  kind: 'keychain' | 'file' | 'config'
  path?: string
  /** Why it is not in the keychain, when it could have been. */
  note?: string
}

export interface TelegramStatus {
  bot_set: boolean
  /** Bullets and the token's last four characters; the token never comes back. */
  token_masked?: string
  bot_username?: string
  chat_set: boolean
  /** The paired chat's name; absent for a chat id typed by hand before pairing. */
  chat_name?: string
  manual_chat?: boolean
  pairing?: { code: string; link?: string; expires_ms: number }
  /** Reading updates now (pairing, buttons, two-way chat). */
  polling: boolean
  last_error?: string
  mute_all?: boolean
  muted?: number
}

export type KeepAwakeMode = 'off' | 'working' | 'always'

/** GET /v1/keepawake: the mode, and whether the computer is being kept awake now. */
export interface KeepAwakeStatus {
  mode: KeepAwakeMode
  holding: boolean
  /** When the current hold began, Unix ms. */
  since?: number
  /** Sessions counted as working at the last check. */
  working: number
  /** False where the OS offers nothing to ask (Linux without systemd-inhibit); reason says why. */
  available: boolean
  reason?: string
  /** Why the last attempt to hold failed. */
  error?: string
}

/** Settings → Status line (config.json statusline_mode). */
export type StatuslineMode = 'full' | 'short' | 'hidden' | 'off'

export interface Settings {
  /** Whether Claude is told what the last session left in the same folder. */
  memory?: boolean
  /** Share of new sessions (0–50) the handoff is held back from, to measure it. */
  memory_holdout_pct?: number
  /** Where the folder picker may look. Empty means the home directory. */
  browse_root?: string
  /** Where the Add project sheet starts (its field, a new project, a clone, Browse). Empty: home. */
  default_folder?: string
  /** The terminal app sessions open in ("ghostty", "iterm2", ...). Empty: the first installed. */
  terminal?: string
  /** The editor "Open in editor" uses ("vscode", "zed", ...). Empty: the first installed. */
  editor?: string
  /** The permission mode new sessions start in, in Claude Code's words. Empty: not set. */
  spawn_permission_mode?: string
  /** When the computer is kept from idle-sleeping (ADR-049). The daemon returns "working" when never chosen. */
  keep_awake?: KeepAwakeMode
  /** What happens to finished copies (lib/copies CleanupMode). The daemon returns "ask" when never chosen. */
  worktree_cleanup?: 'off' | 'ask' | 'auto'
  /** What Caprock's Claude Code status line shows. The daemon returns "full" when never chosen; "hidden" prints nothing but keeps relaying plan limits; "off" removes Caprock's own statusLine entry. */
  statusline_mode?: StatuslineMode
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
  /** Where the bot token is kept; absent when none is set. */
  report_bot_where?: SecretWhere
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
  /** Two-way Telegram chat (Premium, ADR-047): replies, /sessions, /new,
   *  /stop, Approve and Deny. Off unless turned on, and inert without a licence. */
  telegram_chat?: boolean
  /** Replies sent to Telegram keep their code blocks; off unless turned on. */
  telegram_code?: boolean
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
  /** Whether a DeepSeek key is stored, and its first and last characters. */
  deepseek_key_set?: boolean
  deepseek_key_hint?: string
  /** Where the DeepSeek key is kept; absent when none is set. */
  deepseek_key_where?: SecretWhere
  /** Write-only: an empty string removes it. */
  deepseek_api_key?: string
  update_checks: boolean
  plan_kind: '' | 'flat' | 'metered'
  plan_label: string
  plan_usd_per_month: number
  /** The paid key, checked locally against the expiry it carries. */
  license_key?: string
  /** When each dashboard offer (star strip, Premium and Teams nudges, share
   *  prompt) was last answered: prompt id → Unix ms. PUT merges; 0 clears one. */
  prompts?: Record<string, number>
}

/** GET /v1/team-signal: distinct commit authors across the listed repositories. */
export interface TeamSignal { authors: number; repos: number; window_days: number; checked_ms: number }

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
/** What a detected check proves; the templates ask for kinds, not commands. */
export type CheckKind = 'all' | 'test' | 'lint' | 'typecheck' | 'build'
/** One check command the repository declares (internal/projcheck). */
export interface DetectedCheck { command: string; kind: CheckKind; source: string }
/** GET /v1/hive/starter — what the Tasks templates prefill from. Answers with
 *  the runner off too. `checks` is found from the repo's files, never run. */
export interface TaskStarter { repo: string; checks: DetectedCheck[]; default_budget_usd: number }

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

/** One local day of /v1/stats/trends, up to the same time of day as now. */
export interface TrendDay {
  day: string
  cost_usd: number
  sessions: number
  turns: number
  tool_calls: number
  /** 0..1; absent with no input at all. */
  hit_rate?: number
  /** Median of the day's active 10-minute windows, $/h (whole day). */
  burn_usd_per_hour?: number
  /** Any priced turn that day, at any hour. */
  active: boolean
}

/** The Today cells' trends: the previous `days` days and today, cut at `cut_min`. */
export interface Trends {
  days: number
  /** Minutes after local midnight at which every day is cut. */
  cut_min: number
  /** Oldest first; the last entry is today so far. */
  series: TrendDay[]
  /** The median active 10-minute window of the previous days, as $/h. */
  burn?: { median_usd_per_hour: number; windows: number; days: number }
}

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
  /** xAI's Grok Build CLI (ADR-046). Absent on older daemons. */
  grok_available?: boolean
  /** The version of the OpenCode a new session would start ("2.0.26"),
   *  absent while the daemon has not asked it. OpenCode 1 and 2 take
   *  different flags, so a mode can become something different in each. */
  opencode_version?: string
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
 *  measured in the background and cached: a request that finds it a day old
 *  (or missing) starts a measurement and says `measuring`, and `database` is
 *  absent until the first one finishes. */
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
  /** A measurement is running; the figures are the previous one's. */
  measuring?: boolean
  error?: string
  reclaimable_bytes: number
  /** Free pages go back to the disk on their own while Caprock is idle
   *  (auto_vacuum INCREMENTAL); false until an older database's one VACUUM. */
  returns_free_space?: boolean
  /** An estimate, and named as one: see 03-contracts.md § Storage. */
  growth_bytes_per_day_est: number
  retention_days: number
}
export interface StorageSlice { name: string; events: number; payload_bytes: number }
export interface StorageWindow { days: number; events: number; payload_bytes: number }

/** One directory the folder picker may offer. */
export interface BrowseEntry { name: string; path: string; repo: boolean }
export interface BrowseResponse { dir: string; parent: string; root: string; entries: BrowseEntry[] }
/** What a typed path is (GET /v1/browse/stat), held to the browse root: a 404 outside it. */
export interface BrowseStat { path: string; exists: boolean; is_dir: boolean; empty: boolean; parent_exists: boolean; guarded?: boolean; project_id?: number; project_name?: string }
/** A directory Caprock has already seen sessions run in. */
export interface RecentDir { dir: string; name: string; sessions: number; last_event_at: number }

/** `GET /v1/browse/repos`: what the daemon found under the default folder. */
export interface LocalRepos { root: string; home?: string; scanned_at: number; truncated?: boolean; repos: { name: string; path: string }[] }

/** One agent in the pickers (`GET /v1/agents/catalog`, ADR-046). */
export interface CatalogEntry {
  /** "claude", "grok", "custom:aider". */
  id: string
  label: string
  installed: boolean
  /** Installed, and nothing Caprock can see is missing. */
  ready: boolean
  /** The model its own config names. */
  default?: string
  /** The models its own files list; empty for Claude Code and Gemini CLI, whose lists the page keeps. */
  models: { id: string; label: string }[]
  /** A model may be typed (OpenCode's provider/model). */
  typed_model?: boolean
  /** Caprock reads its sessions' turns and cost. */
  observed: boolean
  custom?: boolean
  /** A custom agent the licence no longer covers. */
  locked?: boolean
  /** A first message reaches it (a custom agent's args may have no {prompt}). */
  prompt: boolean
  setup?: { reason: 'not_installed' | 'no_provider' | 'signin'; text: string; command?: string; docs?: string }
}

export interface AgentCatalog { agents: CatalogEntry[]; licensed: boolean; home?: string }

/** A coding agent the user added by command (Settings → Agents, Premium). */
export interface CustomAgent { id?: string; name: string; command: string; args?: string[]; models?: string[] }

/** A saved prompt or command (ADR-051); see lib/saved.ts. */
export interface SavedPrompt {
  id: number
  kind: 'prompt' | 'command'
  name: string
  text: string
  /** Absent for every project. */
  project_id?: number
  project_root?: string
  project_name?: string
  sort: number
  created_at: number
  updated_at: number
}

/** What a saved prompt is made or changed from; project_id 0 is every project. */
export interface SavedDraft { kind: 'prompt' | 'command'; name: string; text: string; project_id: number }

/** Second Brain's node kinds (03-contracts.md § Second Brain): four memories, then three entities. */
export type BrainKind = 'idea' | 'decision' | 'finding' | 'question' | 'topic' | 'person' | 'project'
export type BrainEdgeKind = 'relates' | 'follows' | 'contradicts' | 'part_of'

/** One node of Second Brain: a memory, or a topic, person or project it hangs off. */
export interface BrainNode {
  id: number
  kind: BrainKind
  title: string
  /** Empty in a graph read unless asked for; the node's own read carries it. */
  summary: string
  /** Where it was taken from; empty for a line typed into the quick capture. */
  source: { session_id?: string; event_id?: number; ts?: number; project?: string }
  manual: boolean
  pinned: boolean
  run_id?: number
  created_at: number
  updated_at: number
  /** Edges in the graph read that touch it. */
  degree?: number
}

export interface BrainEdge { from: number; to: number; kind: BrainEdgeKind; weight: number }

export interface BrainGraph { nodes: BrainNode[]; edges: BrainEdge[]; total: number }

/** A node's neighbour and the edge between them; `out` when the edge leaves the node asked about. */
export interface BrainLink { node: BrainNode; kind: BrainEdgeKind; out: boolean; weight: number }

export interface BrainStatus {
  memories: number
  manual: number
  projects: { project: string; count: number }[]
  auto?: BrainAutoStatus
}

/** The automatic extraction's state; absent from a daemon without it (03-contracts.md § Second Brain). */
export interface BrainAutoStatus {
  /** The user has answered the question; until then it never runs. */
  chosen: boolean
  /** Turned on. */
  on: boolean
  /** On, so it reads; no licence is needed (Second Brain is free). */
  enabled: boolean
  claude_found: boolean
  model: string
  daily_tokens: number
  /** Tokens the reads used in the last 24 hours. */
  spent: number
  running: boolean
  /** Sessions waiting to be read. */
  pending: number
  since?: number
  backfill_since?: number
  last_wake?: number
  /** When the next wake is due, unix ms; absent while off. At or before now
   * just after turning on (the first wake starts at once) or while one runs. */
  next_wake?: number
  last_error?: string
  recent: BrainRun[]
}

/** One read of one session. */
export interface BrainRun {
  id: number
  session_id: string
  status: 'ok' | 'failed' | 'skipped'
  model?: string
  tokens_in: number
  tokens_out: number
  cost_usd: number
  nodes: number
  error?: string
  finished_at: number
  project?: string
}

/** What a backfill would read: an estimate, from the transcript's length. */
export interface BrainEstimate {
  sessions: number
  tokens_estimate: number
  days_estimate: number
  daily_tokens: number
  truncated?: boolean
}

export interface BrainSettings { auto?: boolean; daily_tokens?: number; model?: string }

/** What POST /v1/brain/nodes takes: text (or a title), or an assistant note by its event id. */
export interface BrainDrop {
  text?: string
  title?: string
  summary?: string
  kind?: BrainKind
  event_id?: number
  session_id?: string
  project?: string
  topics?: string[]
  pinned?: boolean
}

export interface BrainFilterQuery { q?: string; project?: string; since?: number; until?: number; limit?: number; summaries?: boolean }

/** One thing saved for later from the phone or the machine (03-contracts.md § Inbox). */
export interface InboxItem {
  id: number
  text: string
  /** Absolute paths under the daemon's inbox directory. */
  files: string[]
  /** Absent for the Inbox itself, no project. */
  project_id?: number
  project_root?: string
  project_name?: string
  /** The paired device's name; absent when saved on the machine. */
  from_device?: string
  created_at: number
}

/** What POST /v1/inbox takes: text and/or files (base64), to a project or the Inbox (0). */
export interface InboxDraft {
  text: string
  project_id?: number
  files?: { name: string; type: string; data: string }[]
}

/** The agents that have subscriptions (ADR-048). */
export type SubscriptionAgentId = 'claude' | 'codex'

/** One plan window as last reported for a subscription. */
export interface SubscriptionWindow {
  window: 'five_hour' | 'seven_day'
  used_percentage: number
  /** Unix seconds. */
  resets_at: number
  /** Unix ms. */
  observed_at: number
}

/** How one sign-in is paid for, as the user stated it. */
export interface SubscriptionPlan { kind: 'flat' | 'metered'; label?: string; usd_per_month?: number }

/** A sign-in to Claude Code or Codex (ADR-048). `id` is "default" for the
 *  user's own, and `default` is true for it alone (the name predates Make
 *  default). `preferred` is the one new sessions start on when none is picked. */
export interface Subscription {
  id: string
  agent: SubscriptionAgentId
  label: string
  default: boolean
  preferred?: boolean
  /** Its own plan; absent means the main plan (Settings) stands for it. */
  plan?: SubscriptionPlan
  dir: string
  env_var?: string
  signed_in: boolean
  account?: string
  /** The agent's own sign-in for this directory, typed into a shell tab, never run by Caprock. */
  login_command: string
  windows: SubscriptionWindow[]
  sessions_7d: number
  cost_7d_usd: number
  /** Sessions Caprock started that are running on it. */
  running: number
  created_at?: number
  /** Set on an entry that is not a sign-in but a model provider Claude Code
   *  runs on with the user's own key ("deepseek", id "deepseek"): offered in
   *  the pickers, never renamed, removed, made the default or counted. */
  provider?: 'deepseek'
}

export interface SubscriptionsResponse {
  agents: { agent: SubscriptionAgentId; label: string; installed: boolean; subscriptions: Subscription[] }[]
  licensed: boolean
  free_per_agent: number
  home?: string
}

export interface SpawnRequest {
  /** Which coding agent to launch: "claude" (default), "codex", "opencode",
   *  "gemini", "grok" or a custom one ("custom:<id>"). They take different
   *  flags, so the daemon builds the argv per agent. A resume is continued in
   *  the agent that ran the session, whatever this says. */
  agent?: string
  cwd?: string; chat?: boolean; create?: boolean; worktree?: string
  /** The branch a new worktree starts from (HEAD when absent); with
   *  worktree_pull it is fetched from its remote first. */
  worktree_base?: string; worktree_pull?: boolean
  /** Start the new worktree at GitHub pull request N's head (refs/pull/N/head, fetched from the remote) instead of a branch. */
  worktree_pr?: number
  model?: string; permission_mode?: string; args?: string[]
  /** The sign-in to run on (ADR-048): a subscription id, "default" for the
   *  user's own, or absent for the one made the default in Settings →
   *  Subscriptions. Claude Code and Codex only; a resume keeps its own. */
  subscription?: string
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
  /** One prompt, N attempts (ADR-052): 2 to 4 sessions, one new copy each
   *  (`<worktree>-1` …), the same first message; needs `worktree`. */
  attempts?: number
}

/** What POST /v1/agents answers; the attempt fields only for `attempts` > 1. */
export interface SpawnResult {
  session_id: string
  cwd: string
  session_ids?: string[]
  attempt_group?: string
  /** Why an attempt after the first did not start; the ones before it run. */
  error?: string
}

/** What one attempt's copy changed since the commit the group started from. */
export interface AttemptChanges { files: number; additions: number; deletions: number; binary?: number }

/** One attempt as GET /v1/attempts/{group} returns it. */
export interface AttemptView {
  session_id: string
  group_id: string
  n: number
  total: number
  base?: string
  base_commit?: string
  created_at: number
  session: Session & { exit_code?: number; worked_at?: number }
  stats: Stats
  changes?: AttemptChanges
  changes_error?: string
}

export interface AttemptsResponse { group: string; base?: string; attempts: AttemptView[] }

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

/**
 * A run's jobs as a list even when a daemon sent `null`: 0.115.1 did for a
 * release run GitHub listed no jobs for, and the app's deck read `.some` on
 * it and went black on every launch.
 */
export function listedJobs<T extends { ci?: CIState; release?: ReleaseCI }>(d: T): T {
  for (const r of [...(d.ci?.runs ?? []), ...(d.release?.run ? [d.release.run] : [])]) r.jobs ??= []
  return d
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
   *  sessions (ADR-034). Decided on the machine: by the tick beside Show a
   *  code, which the code carries, or by Let it control sessions afterwards. */
  role: 'viewer' | 'controller'
  /** How it last reached the machine: `relay` (anywhere, ADR-058),
   *  `tailscale` (the network listener over Tailscale), `lan` (the network
   *  listener on the home Wi-Fi: that link works nowhere else). Absent when
   *  it has not been seen since this was recorded. */
  via?: PairedVia
  /** The phone last said it runs as the installed app. A label only. */
  app?: boolean
}

export type PairedVia = 'lan' | 'tailscale' | 'relay'

/** What `GET /v1/pair/me` says about the device a dashboard runs on. */
export interface PairMe {
  role: 'owner' | PairedDevice['role']
  id?: string
  name?: string
  /** How this request reached the machine; absent on the machine itself. */
  via?: PairedVia
  /** Access from anywhere is on, so a Wi-Fi link has a better one to move to. */
  anywhere?: boolean
  /** The phone's page for access from anywhere, sent with anywhere. */
  app?: string
  /** The machine has this device down as running the installed app. */
  installed?: boolean
}

/** What the owner sees on the pairing panel. */
export interface PairState {
  /** Whether this daemon is listening on the network at all. */
  enabled: boolean
  /** What to type into the other device. Empty when disabled. */
  url?: string
  /** The outstanding code, shown only on the machine itself. */
  code?: string
  /** The role a phone pairing with `code` gets. */
  code_role?: PairedDevice['role']
  expires_in_sec?: number
  /** The address reaches other networks (a tunnel), not just this one. */
  tunnelled?: boolean
  /** Every address a phone can open, `url` first: the LAN one, the Tailscale
   *  one and its MagicDNS name (WP-15). A code works on any of them. */
  addresses?: PairAddress[]
  /** This machine has a Tailscale address now, listened on or not — reported
   *  while access is off too, so the panel can say where it will work. */
  tailscale?: boolean
  /** *Keep on after Caprock restarts* (ADR-060). */
  keep_on?: boolean
  /** Access from anywhere through a relay (ADR-058); absent from a daemon
   *  without it. The same code pairs over it. */
  remote?: RemoteState
  devices: PairedDevice[]
}

/** Access from anywhere: this machine waits at a relay (ADR-058). */
export interface RemoteState {
  enabled: boolean
  status: 'off' | 'connecting' | 'online' | 'offline'
  error?: string
  phones: number
  relay: string
  app: string
  host_id?: string
  /** What the QR opens: the phone's page, with the code while one is live. */
  link?: string
}

/** One address network access answers on. */
export interface PairAddress {
  url: string
  /** `lan`: the same Wi-Fi only; `tailscale`: a 100.x address, anywhere the
   *  phone has Tailscale; `magicdns`: the same, by its MagicDNS name. */
  kind: 'lan' | 'tailscale' | 'magicdns' | 'anywhere'
}

export const api = {
  sessions: (activeOnly = false) => get<SessionSummary[]>(`/v1/sessions${activeOnly ? '?active=true' : ''}`),
  sessionsWithTotal,
  /** One Projects row's sessions, newest first, each with whether it can be picked up. */
  sessionsInDir: (dir: string) => get<SessionSummary[]>(`/v1/sessions?dir=${encodeURIComponent(dir)}`),
  session: (id: string) => get<SessionDetail>(`/v1/sessions/${encodeURIComponent(id)}`),
  /** The user's own name for a session; '' clears it. */
  /** Send one offer-survey answer to caprock.dev, through the daemon (ADR-062). Only on the user's click. */
  sendOffer: (a: { offer: string; answers: Record<string, string>; email?: string }) => post<{ status: string }>('/v1/offer', a),
  renameSession: (id: string, name: string) => post<{ session_id: string; name: string }>(`/v1/sessions/${encodeURIComponent(id)}/name`, { name }, 'PUT'),
  /** Live sessions sharing a checkout with another, and the files both edited lately (lib/overlap.ts). */
  overlap: () => get<Overlap>('/v1/overlap'),
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
  /** Every priced model call of the session's main thread, oldest first (the spend scrubber). */
  sessionCalls: (id: string) => get<SessionCall[]>(`/v1/sessions/${encodeURIComponent(id)}/calls`),
  /** The subagents working in a session now, and how many finished lately. */
  subagents: (id: string, recent = 0) => get<SubagentsNow>(`/v1/sessions/${encodeURIComponent(id)}/subagents${recent > 0 ? `?recent=${recent}` : ''}`),
  /** One subagent opened up: its task, its newest `limit` calls (before a call id), its result and numbers. */
  subagent: (id: string, agent: string, opts: { before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.before) q.set('before', String(opts.before))
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return get<SubagentDetail>(`/v1/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(agent)}${qs ? `?${qs}` : ''}`)
  },
  /** The task list the session's agent keeps for itself (TodoWrite, TaskCreate/TaskUpdate, update_plan). */
  todos: (id: string) => get<SessionTodos>(`/v1/sessions/${encodeURIComponent(id)}/todos`),
  diff: (id: string) => get<DiffResult>(`/v1/sessions/${encodeURIComponent(id)}/diff`),
  /** The session's latest PRs, with CI and review when GitHub is connected (the session deck). */
  sessionPRs: (id: string) => get<SessionPRs>(`/v1/sessions/${encodeURIComponent(id)}/prs`),
  /** Re-run a session PR's checks on GitHub: its failed jobs, else every finished run (the deck's Re-run checks). */
  sessionPRRerun: (id: string, n: number) => post<{ ok: boolean; mode: 'failed' | 'all'; runs: number; jobs: number }>(`/v1/sessions/${encodeURIComponent(id)}/prs/${n}/rerun`, {}),
  /** Merge the base into a session PR's branch on GitHub (the deck's Update branch). */
  sessionPRUpdateBranch: (id: string, n: number) => post<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(id)}/prs/${n}/update-branch`, {}),
  /** The GitHub Actions runs, jobs and steps of the session's PR (the session deck's CI cell). */
  sessionCI: (id: string, pr?: number) => get<SessionCI>(`/v1/sessions/${encodeURIComponent(id)}/ci${pr ? `?pr=${pr}` : ''}`).then(listedJobs),
  /** The lines around a failed job's error, on demand. */
  sessionCILog: (id: string, job: number, view: 'pr' | 'release' | 'main' = 'pr', pr?: number) =>
    get<CILog>(`/v1/sessions/${encodeURIComponent(id)}/ci/jobs/${job}/log${view !== 'pr' ? `?view=${view}` : pr ? `?pr=${pr}` : ''}`),
  /** The newest release run of the session's repository (the CI cell's Release view, and the deck's release chip). */
  sessionCIRelease: (id: string) => get<SessionRepoCI>(`/v1/sessions/${encodeURIComponent(id)}/ci/release`).then(listedJobs),
  /** The newest run of each workflow on the session's repository's default branch (the CI cell's Main view). */
  sessionCIMain: (id: string) => get<SessionRepoCI>(`/v1/sessions/${encodeURIComponent(id)}/ci/main`).then(listedJobs),
  /** The Pipeline page: the repository's pull requests and its figures over 14 days. Asked only while the tab is shown. */
  sessionCIStats: (id: string) => get<SessionCIStats>(`/v1/sessions/${encodeURIComponent(id)}/ci/stats`),
  /** The branches of the session's repository, with their PRs and what Caprock's sessions on each cost. */
  /** The Now screen's Repos section (.ai/04-ui.md § Repos on Now). */
  reposActivity: () => get<ReposActivity>('/v1/repos/activity'),
  /** The Now screen's CI/CD section (.ai/04-ui.md § CI/CD on Now). */
  reposCI: (q: { older?: boolean; hide?: readonly string[] } = {}) => {
    const p = new URLSearchParams()
    if (q.older) p.set('older', '1')
    if (q.hide && q.hide.length > 0) p.set('hide', q.hide.join(','))
    const qs = p.toString()
    return get<ReposCI>(`/v1/repos/ci${qs ? `?${qs}` : ''}`)
  },
  sessionBranches: (id: string) => get<SessionBranches>(`/v1/sessions/${encodeURIComponent(id)}/branches`),
  /** What GitHub billed for Actions this month (its billing report); ?owner= an organization. */
  actionsUsage: (owner?: string) => get<ActionsUsage>(`/v1/github/actions-usage${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`),
  notes: (id: string, limit = 200) => get<AssistantNote[]>(`/v1/sessions/${encodeURIComponent(id)}/notes?limit=${limit}`),
  /** `before` pages backwards: pass the lowest event_id already shown. */
  searchNotes: (q: string, limit = 100, before = 0) =>
    get<AssistantNote[]>(`/v1/notes?q=${encodeURIComponent(q)}&limit=${limit}${before ? `&before=${before}` : ''}`),
  /** Sends this week's report now, so a bot can be tested without waiting
   *  for Monday. The failure mode of this feature is silence, which is
   *  indistinguishable from a quiet week. */
  testReport: () => post<{ sent: string }>('/v1/report/test', {}),
  testAlert: () => post<{ sent: string }>('/v1/alerts/test', {}),
  /** The Telegram bridge (ADR-047): bot, paired chat, a pairing in progress. Never the token. */
  telegram: () => get<TelegramStatus>('/v1/telegram'),
  /** Checks a token with Telegram (getMe) and stores it only when Telegram knows it. */
  telegramToken: (token: string) => post<TelegramStatus>('/v1/telegram/token', { token }, 'PUT'),
  /** A new one-time code; the first private chat that sends it becomes the bot's only chat. */
  telegramPair: () => post<TelegramStatus>('/v1/telegram/pair', {}),
  telegramCancelPair: () => post<TelegramStatus>('/v1/telegram/pair', {}, 'DELETE'),
  /** Forget the bot, the chat and what was learned about them. */
  telegramDisconnect: () => post<TelegramStatus>('/v1/telegram', {}, 'DELETE'),
  /** Runs `caprock hooks install` in the daemon; answers with what is registered after. */
  installHooks: () => post<{ hooks: HooksStatus; backup?: string }>('/v1/hooks/install', {}),
  /** The user accepted Caprock's copy of Claude Code's bypass warning (ADR-041). */
  acceptBypass: () => post<{ accepted: boolean }>('/v1/claude/bypass-consent', {}),
  pairState: () => get<PairState>('/v1/pair/state'),
  /** Exchange a code for a token. The one call a device makes before it is trusted. */
  pairRedeem: (code: string, name: string) =>
    post<{ token: string; id: string; name: string }>('/v1/pair', { code, name }),
  /** A code that pairs a phone as `role` — the owner's tick, on the machine. */
  pairCode: (role: PairedDevice['role'] = 'viewer') =>
    post<{ code: string; role?: PairedDevice['role']; expires_in_sec: number; url: string }>('/v1/pair/code', { role }),
  /** Withdraw the outstanding code, so it stops working before it expires. */
  pairCancelCode: () => post<{ cleared: boolean }>('/v1/pair/code', {}, 'DELETE'),
  /** Turn network access on or off without restarting the daemon. */
  /** Phone access on or off; `keep` also stores whether it comes back on
   *  after a restart. Turning it off always clears that (ADR-060). */
  setLAN: (on: boolean, keep?: boolean) =>
    post<{ enabled: boolean; url?: string; keep_on?: boolean }>('/v1/pair/lan', keep === undefined ? { on } : { on, keep }),
  setRemote: (on: boolean) => post<RemoteState>('/v1/pair/remote', { on }),
  pairRevoke: (id: string) => post<{ revoked: number }>(`/v1/pair/devices/${encodeURIComponent(id)}`, {}, 'DELETE'),
  /** Give a paired device control of sessions, or take it away. Machine only. */
  pairSetRole: (id: string, role: PairedDevice['role']) =>
    post<{ id: string; role: string }>(`/v1/pair/devices/${encodeURIComponent(id)}/role`, { role }, 'PUT'),
  /** Which role this dashboard's device holds: "owner" on the machine itself. */
  /** `app` reports whether this phone runs as the installed app, for the
   *  owner's checklist on the machine; omitted, nothing is reported. */
  pairMe: (app?: boolean) => get<PairMe>(app === undefined ? '/v1/pair/me' : `/v1/pair/me?app=${app ? 1 : 0}`),
  settings: () => get<Settings>('/v1/settings'),
  update: () => get<UpdateStatus>('/v1/update'),
  checkUpdate: () => post<UpdateStatus>('/v1/update/check', {}),
  saveSettings: (s: Settings) => post<Settings>('/v1/settings', s, 'PUT'),
  summary: (range: 'today' | '7d' | '30d' | 'all' = 'today', agent?: string) =>
    get<Summary>(`/v1/stats/summary?range=${range}${agent && agent !== 'all' ? `&agent=${agent}` : ''}`),
  daily: (days = 30) => get<DailyStat[]>(`/v1/stats/daily?days=${days}`),
  trends: (agent?: string) => get<Trends>(`/v1/stats/trends${agent && agent !== 'all' ? `?agent=${agent}` : ''}`),
  premium: () => get<PremiumPricing>('/v1/premium'),
  /** How many people committed to the listed repositories in 30 days (counts only). */
  teamSignal: () => get<TeamSignal>('/v1/team-signal'),
  windowStop: () => get<WindowStop>('/v1/window-stop'),
  keepAwake: () => get<KeepAwakeStatus>('/v1/keepawake'),
  gemini: () => get<GeminiStatus>('/v1/gemini'),
  askGemini: (prompt: string, model?: string) => post<GeminiReply>('/v1/gemini/ask', { prompt, model }),
  browse: (dir = '') => get<BrowseResponse>(`/v1/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  /** Whether a path exists, is a folder, is empty, is already a project. */
  browseStat: (path: string) => get<BrowseStat>(`/v1/browse/stat?path=${encodeURIComponent(path)}`),
  recentDirs: () => get<RecentDir[]>('/v1/recent-dirs'),
  /** GET /v1/browse/repos: the git repositories under the default folder, two levels deep (the project search). */
  localRepos: () => get<LocalRepos>('/v1/browse/repos'),
  history: (range: 'today' | '7d' | '30d' | 'all' = 'all') => get<History>(`/v1/history?range=${range}`),
  /** `start` is the first local day (YYYY-MM-DD); omitted, the seven days ending today. */
  /** All time; with a range, that range's agents and bill (the share card's agent mix). */
  activity: () => get<{ from: number; bucket_ms: number; buckets: number; sessions: Record<string, number[]> }>('/v1/activity'),
  glance: (range?: 'today' | '7d' | '30d' | 'all') => get<Glance>(range && range !== 'all' ? `/v1/glance?range=${range}` : '/v1/glance'),
  toolDrill: (tool: string, range: 'today' | '7d' | '30d' | 'all' = 'all', agent?: string) =>
    get<ToolDrill>(`/v1/tools/drill?tool=${encodeURIComponent(tool)}&range=${range}${agent && agent !== 'all' ? `&agent=${agent}` : ''}`),
  week: (start?: string) => get<Week>(`/v1/week${start ? `?start=${start}` : ''}`),
  /** The same card for a named window: today, the last 7 or 30 days, or all time. */
  weekFor: (period: 'today' | '7d' | '30d' | 'all') => get<Week>(`/v1/week?period=${period}`),
  /** Turns the task runner on over the running daemon — no restart. Empty
   *  fields mean the daemon's own suggestion (see status.suggested_hive). */
  enableHive: (hive?: string, repo?: string) => post<{ hive: string; repo: string }>('/v1/hive', { hive: hive ?? '', repo: repo ?? '' }),
  /** The templates' prefill: the repo, the checks it declares, the default budget. */
  taskStarter: () => get<TaskStarter>('/v1/hive/starter'),
  tasks: () => get<Task[]>('/v1/tasks'),
  task: (id: string) => get<TaskDetail>(`/v1/tasks/${encodeURIComponent(id)}`),
  createTask: (req: CreateTaskRequest) => post<TaskDetail>('/v1/tasks', req),
  approve: (id: string, approve: boolean) => post<void>(`/v1/tasks/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`, {}),
  startOrchestrator: () => post<{ session_id: string }>('/v1/orchestrator/start', {}),
  // Emergency stop: kills the orchestrator and every worker it spawned.
  stopOrchestrator: () => post<{ stopped: number }>('/v1/orchestrator/stop', {}),
  status: () => get<Status>('/v1/status'),
  storage: () => get<StorageReport>('/v1/storage'),
  /** What each live session's process tree and Caprock itself cost (lib/resources.ts). */
  resources: () => get<ResourceReport>('/v1/resources'),
  /** Stop the orphaned pty-hosts nothing runs in. Machine only. */
  reapOrphans: () => post<ReapResult>('/v1/resources/reap', {}),
  /**
   * What Caprock itself costs this machine: memory, disk, its disk I/O, duplicates (lib/footprint.ts).
   * `orphans` takes the orphan list now, for the open doctor; without it the counts are the last scan's.
   */
  footprint: (orphans = false) => get<Footprint>(orphans ? '/v1/footprint?orphans=1' : '/v1/footprint'),
  /** Stop processes the user picked from the doctor's orphan list, each by pid and start time (ADR-059). Machine only. */
  stopOrphans: (targets: OrphanTarget[]) => post<OrphanStopResult>('/v1/footprint/orphans/stop', { targets }),
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
  spawn: (req: SpawnRequest) => post<SpawnResult>('/v1/agents', req),
  /** GET /v1/attempts/{group}: the attempts started together, with their spend and changes (ADR-052). */
  attempts: (group: string) => get<AttemptsResponse>(`/v1/attempts/${encodeURIComponent(group)}`),
  /** The models an agent's own CLI lists — Codex's on-disk catalog and its
   *  configured default. Empty for the other agents. */
  /** The proposed brief for carrying a session on in a new one (a relay). */
  relayBrief: (id: string) => get<RelayBrief>(`/v1/sessions/${encodeURIComponent(id)}/relay`),
  /** GET /v1/agents/catalog: every agent here, installed or not, with its models and what it is missing. */
  agentCatalog: () => get<AgentCatalog>('/v1/agents/catalog'),
  customAgents: () => get<{ agents: CustomAgent[]; licensed: boolean }>('/v1/agents/custom'),
  /** PUT /v1/agents/custom: replaces the list; 402 without an active licence. */
  saveCustomAgents: (agents: CustomAgent[]) => post<{ agents: CustomAgent[]; licensed: boolean }>('/v1/agents/custom', { agents }, 'PUT'),
  /** Saved prompts and commands (ADR-051): all of them, or a session's — every project's and its own project's. */
  savedPrompts: (sessionId?: string) =>
    get<{ items: SavedPrompt[]; max: number }>(`/v1/saved-prompts${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
  /** The machine only; a paired device gets 403. */
  addSavedPrompt: (d: SavedDraft) => post<{ item: SavedPrompt }>('/v1/saved-prompts', d),
  updateSavedPrompt: (id: number, d: Partial<SavedDraft>) => post<{ item: SavedPrompt }>(`/v1/saved-prompts/${id}`, d, 'PATCH'),
  removeSavedPrompt: (id: number) => post<void>(`/v1/saved-prompts/${id}`, {}, 'DELETE'),
  /** Second Brain (03-contracts.md § Second Brain). Writing it is the machine's. */
  brain: (f: BrainFilterQuery = {}) => {
    const qs = new URLSearchParams()
    if (f.q) qs.set('q', f.q)
    if (f.project) qs.set('project', f.project)
    if (f.since) qs.set('since', String(f.since))
    if (f.until) qs.set('until', String(f.until))
    if (f.limit) qs.set('limit', String(f.limit))
    if (f.summaries) qs.set('summaries', '1')
    const tail = qs.toString()
    return get<BrainGraph>(`/v1/brain${tail ? `?${tail}` : ''}`)
  },
  brainStatus: () => get<BrainStatus>('/v1/brain/status'),
  brainNode: (id: number) => get<{ node: BrainNode; links: BrainLink[] }>(`/v1/brain/nodes/${id}`),
  dropBrain: (d: BrainDrop) => post<{ node: BrainNode; created: boolean }>('/v1/brain/nodes', d),
  patchBrain: (id: number, p: Partial<Pick<BrainNode, 'kind' | 'title' | 'summary' | 'pinned'>>) =>
    post<{ node: BrainNode }>(`/v1/brain/nodes/${id}`, p, 'PATCH'),
  removeBrain: (id: number) => post<void>(`/v1/brain/nodes/${id}`, {}, 'DELETE'),
  linkBrain: (from: number, to: number, kind: BrainEdgeKind = 'relates') => post<void>('/v1/brain/links', { from, to, kind }),
  unlinkBrain: (from: number, to: number) => post<void>('/v1/brain/links', { from, to }, 'DELETE'),
  /** The automatic extraction: on or off and its limits (machine only). Turning it on wakes the reader at once. */
  brainSettings: (b: BrainSettings) => post<BrainAutoStatus>('/v1/brain/settings', b, 'PUT'),
  /** What reading the last `days` would take; with run, starts it (needs building on). */
  brainBackfill: (days: number, run = false) => post<BrainEstimate>('/v1/brain/backfill', { days, dry_run: !run }),
  /** The Inbox (03-contracts.md § Inbox). Saving and deleting: the machine and a controller. */
  inbox: () => get<{ items: InboxItem[]; max: number }>('/v1/inbox'),
  addInbox: (d: InboxDraft) => post<{ item: InboxItem }>('/v1/inbox', d),
  removeInbox: (id: number) => post<void>(`/v1/inbox/${id}`, {}, 'DELETE'),
  /** An item's image, for a thumbnail: a blob, since an <img> cannot carry a paired device's token. */
  inboxFile: async (id: number, n: number): Promise<Blob> => {
    const res = await fetch(`/v1/inbox/${id}/files/${n}`, { headers: withDevice() })
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`)
    return res.blob()
  },
  /** Settings → Subscriptions (ADR-048). */
  subscriptions: () => get<SubscriptionsResponse>('/v1/subscriptions'),
  /** 402 at the free number without a licence. */
  addSubscription: (agent: SubscriptionAgentId, label: string) => post<Subscription>('/v1/subscriptions', { agent, label }),
  /** Rename, Make default, or set a plan (null clears it). `agent` names whose own sign-in "default" is. */
  updateSubscription: (id: string, patch: { agent?: SubscriptionAgentId; label?: string; make_default?: boolean; plan?: SubscriptionPlan | null }) =>
    post<Subscription>(`/v1/subscriptions/${encodeURIComponent(id)}`, patch, 'PATCH'),
  /** 409 while a session Caprock started runs on it. */
  removeSubscription: (id: string) => post<void>(`/v1/subscriptions/${encodeURIComponent(id)}`, {}, 'DELETE'),
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
  /** The messages waiting for an owned session's turn to end, and why (ADR-053). */
  queue: (id: string) => get<QueueView>(`/v1/agents/${encodeURIComponent(id)}/queue`),
  /** The Queue view: every owned session, what waits in its queue, rough estimates, recent turns. */
  queueBoard: () => get<QueueBoard>('/v1/queue'),
  /** The Work board: live sessions with their pull requests, tasks, queued messages, each repository's release cadence. */
  work: () => get<Work>('/v1/work'),
  /** The chat field's send: typed in now at the prompt, otherwise queued. */
  queueSend: (id: string, text: string) => post<QueueSendResult>(`/v1/agents/${encodeURIComponent(id)}/queue`, { text }),
  queueEdit: (id: string, qid: number, text: string) => post<QueueView>(`/v1/agents/${encodeURIComponent(id)}/queue/${qid}`, { text }, 'PATCH'),
  queueCancel: (id: string, qid: number) => post<QueueView>(`/v1/agents/${encodeURIComponent(id)}/queue/${qid}`, {}, 'DELETE'),
  /** Type one in now, whatever the turn is doing; 409 while a prompt is on the screen. */
  queueSendNow: (id: string, qid: number) => post<QueueView>(`/v1/agents/${encodeURIComponent(id)}/queue/${qid}/send`, {}),
  /** The `/` picker: the session's slash commands. */
  sessionCommands: (id: string) => get<{ agent: string; commands: SlashCommand[] }>(`/v1/sessions/${encodeURIComponent(id)}/commands`),
  /** The `@` picker: the files in the session's working directory. */
  sessionFiles: (id: string) => get<{ files: string[]; truncated?: boolean }>(`/v1/sessions/${encodeURIComponent(id)}/files`),
  /** The permission prompt an owned session is waiting on, or null (ADR-035). */
  permission: (id: string) => get<{ permission: Permission | null }>(`/v1/agents/${encodeURIComponent(id)}/permission`),
  /** Answer it: the daemon presses the key, while `promptId` is still the one waiting (409 otherwise). */
  answerPermission: (id: string, promptId: string, choice: PermissionChoice) =>
    post<void>(`/v1/agents/${encodeURIComponent(id)}/permission`, { id: promptId, choice }),
  /** A session's permission mode and, for one Caprock started, what can change it (ADR-054). */
  permissionMode: (id: string) => get<PermissionModeView>(`/v1/sessions/${encodeURIComponent(id)}/permission-mode`),
  /** Switch an owned session's mode by Shift+Tab, or with `restart`, resume it in a new process in that mode. */
  setPermissionMode: (id: string, mode: string, restart = false) =>
    post<PermissionModeView>(`/v1/agents/${encodeURIComponent(id)}/permission-mode`, { mode, restart }),
}

/** GET /v1/sessions/{id}/permission-mode (ADR-054). */
export interface PermissionModeView {
  session_id: string
  /** Claude Code's word: default, acceptEdits, plan, bypassPermissions, auto, dontAsk; '' unknown. */
  mode: string
  /** Where it was learned: the footer now, a hook, a switch Caprock saw take, the command line. */
  source?: 'screen' | 'hook' | 'switch' | 'launch'
  /** A Claude Code session Caprock started and holds: the mode can be changed here. */
  switchable: boolean
  /** Modes Shift+Tab reaches in this process ("auto" only if the account has it). */
  in_session?: string[]
  /** Modes only a restart in a new process reaches. */
  restart?: string[]
  /** What keeps a switch from happening now. */
  waiting?: QueueWaiting
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
  /**
   * Roughly what it is doing now, at most 60 characters, and where that came
   * from: its newest call's own description ("call"), its tool and target
   * ("tool", "Editing Cockpit.tsx") or the task it was spawned with ("task").
   * Absent when none says anything, and from a daemon that predates it.
   */
  doing?: string
  doing_from?: 'call' | 'tool' | 'task'
  /** That call has no result yet. */
  running: boolean
  /** Its newest event is a permission prompt. */
  asking: boolean
  /** The model of its newest turn, and the table's short name ("Haiku 4.5"); absent before its first turn. */
  model?: string
  model_display?: string
  /** What its own calls cost so far; absent when unknown (no turn yet, or one the table could not price). */
  cost_usd?: number
}

/** A subagent that finished lately (GET /v1/sessions/{id}/subagents `recent`). */
export interface SubagentDone {
  agent_id: string
  agent_type?: string
  description?: string
  tool_calls: number
  /** Unix ms: its first event in the window, and its SubagentStop. */
  started_at: number
  stopped_at: number
  model?: string
  model_display?: string
  cost_usd?: number
}

export interface SubagentsNow {
  working: Subagent[]
  /** How many stopped in the same window after making a tool call. */
  finished: number
  /** The newest of those, three unless `recent` asked for more (at most 30). Absent from a daemon that predates it. */
  recent?: SubagentDone[]
  /** What every subagent of the session has cost; absent when any is unknown. */
  cost_usd?: number
}

/** One call in a subagent's activity feed (GET /v1/sessions/{id}/subagents/{agent}). */
export interface SubagentCall {
  /** Its tool.pre event id: the cursor `before` pages by. */
  id: number
  tool_use_id?: string
  tool: string
  /** Its short line, as the tool list writes it. */
  detail?: string
  /** Unix ms; `ended_at` absent while it has no result. */
  started_at: number
  ended_at?: number
  error?: boolean
}

/** One subagent opened up (GET /v1/sessions/{id}/subagents/{agent}). */
export interface SubagentDetail {
  agent_id: string
  agent_type?: string
  /** The parent's Agent/Task call input; absent when no call is linked. */
  description?: string
  prompt?: string
  subagent_type?: string
  parent_tool_use_id?: string
  background?: boolean
  state: 'working' | 'finished' | 'quiet'
  asking: boolean
  started_at: number
  last_at: number
  stopped_at?: number
  /** What it returned to its parent; absent while it works or when none was recorded. */
  result?: string
  /** The newest calls, oldest first; `earlier` is how many came before them. */
  calls: SubagentCall[]
  earlier: number
  stats: {
    tool_calls: number
    turns: number
    tokens: TokenDelta
    duration_ms: number
    /** The costliest tool kinds, at most four; `tool` empty for turns that only wrote. */
    by_tool: { tool: string; calls: number; cost_usd?: number }[]
    model?: string
    model_display?: string
    /** Absent when unknown: no turn, or one the table could not price. */
    cost_usd?: number
  }
}

/** One entry of the agent's own task list (GET /v1/sessions/{id}/todos). */
export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  /** What the agent says while doing it ("Running the tests"); absent when it gave none. */
  active_form?: string
}

export interface SessionTodos {
  items: TodoItem[]
  /** Unix ms of the call that last changed the list; 0 when it never kept one. */
  updated_at: number
}

/** One message waiting for a session's turn to end (ADR-053). */
export interface QueuedMessage {
  id: number
  session_id: string
  text: string
  created_at: number
  updated_at: number
}

/** What holds a queued message: the turn, a permission prompt, a question; '' nothing. */
export type QueueWaiting = '' | 'turn' | 'permission' | 'question'

export interface QueueView {
  session_id: string
  messages: QueuedMessage[] | null
  waiting: QueueWaiting
}

/** An estimate in ms from the board's `now`: median and the p25–p75 range. */
export interface ETA {
  lo_ms: number
  mid_ms: number
  hi_ms: number
}

/** What the estimates are made from: the project's newest finished Claude Code turns. */
export interface TurnEstimate {
  turns: number
  p25_ms: number
  median_ms: number
  p75_ms: number
}

export interface BoardItem extends QueuedMessage {
  /** 1 = typed in when the current turn ends. */
  position: number
  start?: ETA
  finish?: ETA
}

/** One session Caprock started, as the Queue view shows it (GET /v1/queue). */
export interface BoardSession {
  session_id: string
  agent: string
  title?: string
  project?: string
  dir?: string
  branch?: string
  waiting: QueueWaiting
  /** Unix ms the running turn's prompt went in; absent when not known. */
  turn_started_at?: number
  todo?: BoardTodo
  queue: BoardItem[]
  turn_left?: ETA
  /** When a message added now would start; absent when it cannot be estimated. */
  free_in?: ETA
  estimate?: TurnEstimate
  estimate_note?: string
}

export interface BoardDone {
  session_id: string
  agent: string
  title?: string
  project?: string
  prompt: string
  started_at: number
  ended_at: number
  queued?: boolean
  failed?: boolean
}

export interface QueueBoard {
  now: number
  sessions: BoardSession[]
  done: BoardDone[]
  done_since: number
}

/** The agent's own task list in short: the step it is on, how many are done of how many. */
export interface BoardTodo {
  active?: string
  done: number
  total: number
}

/** What an agent session is doing, as the Work board says it. */
export type WorkState = 'working' | 'permission' | 'question' | 'at_prompt' | 'background'

/** A pull request a session opened or was recorded on. */
export interface WorkPR {
  number: number
  url: string
  title?: string
  opened_at?: number
  merged_at?: number
}

/** One live agent session on the Work board (GET /v1/work). */
export interface WorkSession {
  session_id: string
  agent: string
  /** Caprock started it (true), or it runs in the person's own terminal (false). */
  owned: boolean
  model?: string
  model_display?: string
  subscription?: string
  name?: string
  description?: string
  description_source?: string
  project: string
  repo_root?: string
  worktree?: string
  branch?: string
  /** It works on the repository's default branch. */
  on_default?: boolean
  started_at: number
  /** When it last did work (unix ms). */
  worked_at?: number
  state: WorkState
  turn_started_at?: number
  turn_left?: ETA
  estimate?: TurnEstimate
  estimate_note?: string
  todo?: BoardTodo
  /** At API list price, not a bill. */
  cost_usd: number
  today_usd: number
  prs: WorkPR[]
  /** How its pull requests were found: its branch's, the ones recorded on it, none. */
  link: 'branch' | 'recorded' | 'none'
  link_note?: string
}

/** A hive task (Tasks), when the hive is on. */
export interface WorkTask {
  id: string
  title: string
  status: string
  session_id?: string
  branch?: string
  budget_usd: number
  spent_usd: number
}

/** A message waiting for an owned session's turn to end (ADR-053). */
export interface WorkQueued {
  session_id: string
  position: number
  text: string
  start?: ETA
  finish?: ETA
}

/** A repository on the Work board: its release cadence and what waits for the next release. */
export interface WorkRepo {
  root: string
  name: string
  /** owner/name on GitHub; absent when the remote is not GitHub's. */
  remote?: string
  /** The session the repository's Pipeline answer is read through. */
  via_session: string
  live: number
  /** CHANGELOG's [Unreleased] section on `ref`, as of the last fetch. */
  unreleased?: { ref: string; items: string[]; count: number; more?: boolean }
  tags?: { last?: { name: string; at: number }; gap_median_ms?: number; gaps: number }
  /** Commits on the default branch since the last tag. */
  ahead_of_tag?: number
}

/** GET /v1/work: the work on its way to a release, across the machine. */
export interface Work {
  now: number
  day_start: number
  sessions: WorkSession[]
  tasks?: WorkTask[]
  hive: 'on' | 'off'
  queued: WorkQueued[]
  repos: WorkRepo[]
  totals: { live: number; working: number; waiting_you: number; today_usd: number; machine_today_usd: number }
}

export interface QueueSendResult {
  sent: boolean
  queued?: QueuedMessage
  queue: QueueView
}

/** One entry of the chat field's `/` picker. */
export interface SlashCommand {
  name: string
  description?: string
  hint?: string
  source: 'builtin' | 'project' | 'user' | 'project skill' | 'user skill'
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
