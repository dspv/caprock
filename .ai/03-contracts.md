# Caprock — Contracts

The wire-level and on-disk contracts: hook shim protocol, HTTP API, WebSocket frames, SQLite DDL and migrations, pricing table, runtime file, and the observed transcript shape. This file is the canonical home for every contract; other files link here instead of restating. Hive-side file formats (task files, mailbox messages, ledger) live in [05-orchestration.md](05-orchestration.md).

Conventions that apply to every contract here: JSON casing is **snake_case**; all money is **USD float**; all tokens are **int64**; everything is versioned under **`/v1`** from day one.

## Hook shim

- Single Go binary `caprock-hook` (same repo, tiny), installed to Caprock's data dir.
- Registered in `~/.claude/settings.json` under events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `StopFailure`. Installer merges JSON non-destructively; `caprock hooks uninstall` reverts; back up the settings file before first write.
- Behavior (Phase 0–1: fire-and-forget): read stdin JSON → POST to `http://127.0.0.1:<port>/v1/hook` with `Authorization: Bearer <run-token>` → always exit 0 within a 1s budget. Never print to stdout (a broken shim must not affect the user's Claude session). If the daemon is down, drop silently.
- One server, one port: `/v1/hook` lives on the same listener as the API and UI (default **4173**); `<data_dir>/runtime.json` holds `{port, token}`, written by the daemon, read by the shim per invocation.
- Phase 2 extended this protocol for **Stop events only** — request-response with a 5s timeout; see [05-orchestration.md § Stop-hook decision protocol](05-orchestration.md#stop-hook-decision-protocol-shim-upgrade-t19).
- Why a shim binary rather than Claude Code's native `type: "http"` hook: [ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type).

### Hook payload (what the shim forwards, verbatim)

Claude Code sends one JSON object per event on the shim's stdin. Fields common to all events (per the hooks reference, verified 2026-08-18): `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `effort` (`{level}`), and for subagents `agent_id`, `agent_type`. Event-specific fields the daemon reads:

| Event              | Fields consumed                                            |
| ------------------ | ---------------------------------------------------------- |
| `PreToolUse`       | `tool_name`, `tool_input`, `tool_use_id`                   |
| `PostToolUse`      | `tool_name`, `tool_input`, `tool_use_id`, `tool_response`  |
| `UserPromptSubmit` | `prompt`                                                   |
| `Stop`             | `stop_reason`, `last_assistant_message`                    |
| `SubagentStop`     | `stop_reason`, `last_assistant_message`, `agent_id`        |
| `SessionStart`     | `source` (`startup`, `resume`, `clear`, `compact`, `fork`) |
| `PreCompact`       | `trigger` (`manual`, `auto`)                               |
| `StopFailure`      | `error` / `stop_reason` (rate_limit, overloaded, billing)  |

The daemon stores the raw payload untouched in `events.payload`; unknown events and unknown fields are logged and ignored, never fatal ([06-engineering-rules.md](06-engineering-rules.md)).

**Dedupe keys.** hookd keys events as `pre:<tool_use_id>`, `post:<tool_use_id>`, `prompt:<prompt_id>`; ingest derives the *same* keys from transcript `tool_use` / `tool_result` blocks and `promptId`, and keys assistant turns as `msg:<message.id>`. `(session_id, key)` is unique in the store, so whichever plane arrives first wins and the other is a no-op — this is how "dedupe against hook events by session_id" is implemented, and it also makes re-reading a transcript after restart idempotent. Stop / SubagentStop / SessionStart / PreCompact are keyless (never deduped).

### settings.json registration shape

The installer writes, for each of the eight events, a matcher-less entry (`matcher` omitted — `UserPromptSubmit` and `Stop` do not accept matchers) of the form `{"hooks":[{"type":"command","command":"<data_dir>/caprock-hook","timeout":5}]}` and leaves every other key, every pre-existing hook, **and the user's key order** untouched (ordered-JSON merge). A path containing spaces is double-quoted. When no `caprock-hook` binary sits beside the `caprock` executable, the registered command is `<caprock> hook` (a hidden subcommand running the same shim code). Uninstall removes only entries whose `command` points at a Caprock shim (exact path, or basename `caprock-hook[.exe]`, or `<caprock> hook`) and drops empty containers it leaves behind. The backup is `settings.json.caprock-backup-<unix-ts>` next to the original, written once before the first modification. An unparsable settings.json is never modified.

## HTTP API (daemon, `127.0.0.1:4173`)

### Phase 0

```
GET  /v1/sessions?active=true          → SessionSummary[]
GET  /v1/sessions/{id}                 → SessionDetail (stats + last N events)
GET  /v1/sessions/{id}/events?after=…  → Event[] (paginated)
GET  /v1/sessions/{id}/diff            → { files: FileDiff[] } | 409 not-a-git-repo
GET  /v1/stats/summary?range=today     → totals: tokens, cost, sessions, models
GET  /v1/settings                      → user-stated settings (plan, update checks)
PUT  /v1/settings                      → store them
GET  /v1/update                        → cached release status (no network I/O)
POST /v1/update/check                  → check now (403 unless enabled)
GET  /v1/stats/daily?days=30           → DailyStat[]
POST /v1/hook                          → 204 (shim only, bearer-token gated)
WS   /v1/live                          → server-push frames: {type:"event"|"session"|"alert", data:…}
```

Added during T6 (same conventions; not in the spec's list):

```
GET  /v1/events?after=…&limit=…        → Event[] across all sessions (live-feed catch-up)
GET  /v1/status                        → daemon status: version, pid, uptime, data dir, pricing, ingest, hooks
GET  /v1/pricing                       → the pricing table in force
POST /v1/shutdown                      → 200 (bearer-token gated; `caprock down`)
POST /v1/statusline                    → 204 (bearer-token gated) {session_id, five_hour?, seven_day?} — records rate-limit windows
GET  /healthz                          → {status:"ok", version}
WS   /v1/live                          → first frame is {type:"hello", data:{server_time}}; a "session" frame carries {session, stats}
```

`GET /v1/update` returns `{enabled, current, latest, update_available, command, url, checked_at, error}` from cache and **performs no network I/O** — a page load must never cause an outbound call. `POST /v1/update/check` performs one, and returns **403 while `update_checks` is false**: the opt-in is enforced by the server, not merely hidden in the UI, so no page or local script can make Caprock reach the network uninvited. Checks are throttled to once a day unless forced, the request carries no body or credentials, and a failure is reported in `error` rather than as an error status — not knowing about a release must not read as a broken dashboard. `command` is the upgrade command inferred from the running binary's path (Homebrew, Scoop, `go install`); when no package manager owns the binary it is empty and the UI offers `url` instead. `update_available` is never true for a `dev` or `git describe` build. Caprock does not install the update: replacing the running binary would mean the daemon killing the process executing the command, and running a package manager on the user's behalf from a web page is a surface a local tool should not open.

`GET`/`PUT /v1/settings` carry `{plan_kind, plan_label, plan_usd_per_month}` — how the user pays for Claude Code. Caprock **cannot detect this and never guesses**: Claude Code does not report the plan, and inferring one from usage would be an invented number (rule 6), so the user states it and it is stored in `config.json` like every other setting. `plan_kind` is `""` (not stated), `"flat"` (Pro/Max/Team seat — usage at API list price is an *equivalent*, so comparing it to the fee is meaningful), or `"metered"` (API key, Bedrock, Vertex, or Enterprise usage billed at API rates — the API-list figure **is** approximately the bill, so it is never framed as a saving). `PUT` validates rather than coerces: an unknown `plan_kind` or a negative/non-finite price is a 400, because a typo would otherwise drive a wrong headline figure. Both return 501 when the daemon has no settings controller.

`SessionSummary` = the `sessions` row + `stats` (session_stats) + `activity` ({phrase, tool, at, health, plan, repeats} from `internal/narrate`) + `savings` (cache math) + `loop` (active alert, if any) + `context` ({tokens, window, pct} — last turn's prompt size vs the model's context window from `pricing.json`). `SessionDetail` adds `files` and the last 60 `events`. `?range=` on `/v1/stats/summary` accepts `today` (default), `7d`, `30d`, `all`, or a Go duration; ranges are calendar-aware in the daemon's local time zone. The summary carries `burn` ($/h and tokens/min over the last 10 minutes) and `pricing_version`. Each entry in `projects` is `{project, tokens, cost_usd, sessions}` — `sessions` counts the distinct sessions that touched the project in the range, so a per-repo roll-up can state both what a repo cost and how many sessions worked in it.
### Phase 1 additions

```
POST   /v1/agents                    {cwd, worktree?, model?, permission_mode?, command?, args?} → {session_id, cwd}
POST   /v1/agents/{id}/input         {data}            → 204   (owned PTYs only)
POST   /v1/agents/{id}/signal        {action: pause|resume|kill} → 204 (owned PTYs only)
WS     /v1/agents/{id}/term          bidirectional binary stream (xterm.js); snapshot on connect, closes on exit
GET    /v1/history?range=…           lifetime totals + tool distribution + model mix + daily
```

Owned sessions are spawned as `claude --session-id <uuid> [--model …] [--permission-mode …]`, so hooks and the transcript arrive under the id Caprock generated; the spawn environment strips inherited `CLAUDE_CODE_CHILD_SESSION` / `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` markers so the session is a normal top-level one. Before spawning, Caprock pre-accepts Claude Code's folder-trust dialog for the session's cwd by setting `projects["<cwd>"].hasTrustDialogAccepted = true` in **`~/.claude.json`** (a second user-level Claude Code file, distinct from `settings.json`) — otherwise an interactive session blocks on the trust prompt, which `--dangerously-skip-permissions` does not suppress. The write is best-effort, atomic, preserves all other keys, and is skipped if the folder is already trusted; an unparsable `~/.claude.json` is never modified. Spawning is unavailable (endpoints return 501, `status.claude_available=false`) when no `claude` binary is found; Caprock then stays observe-only. The manager resolves `claude` via PATH then `~/.local/bin`, `~/.claude/local`, `~/bin`, Homebrew and `/usr/local/bin`. Control operations are refused for sessions Caprock did not spawn.

### Phase 2 additions

```
GET/POST /v1/tasks
GET      /v1/tasks/{id}
POST     /v1/tasks/{id}/approve | /v1/tasks/{id}/reject
POST     /v1/tasks/{id}/verify        → runs the task's done_criteria, returns VerifyResult
GET      /v1/approvals
POST     /v1/orchestrator/start       → spawns the orchestrator session → {session_id}
```

Live frames gained `mail.*` events (router) in Phase 2.

## SQLite schema (DDL v1)

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,          -- rowid, monotonic
  ts          INTEGER NOT NULL,             -- unix ms
  session_id  TEXT NOT NULL,
  source      TEXT NOT NULL,                -- 'hook' | 'transcript'
  kind        TEXT NOT NULL,                -- see 02-architecture.md § Event model
  tool        TEXT,
  payload     TEXT NOT NULL,                -- raw JSON
  tokens_in   INTEGER, tokens_out INTEGER,
  cache_read  INTEGER, cache_write INTEGER,
  cost_usd    REAL
);
CREATE INDEX idx_events_session_ts ON events(session_id, ts);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  cwd          TEXT, project TEXT, model TEXT,
  started_at   INTEGER, last_event_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'active',  -- active|idle|ended
  transcript_path TEXT
);

CREATE TABLE session_stats (       -- rollup, updated on write
  session_id  TEXT PRIMARY KEY REFERENCES sessions(session_id),
  turns INTEGER, tool_calls INTEGER, files_touched INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_usd REAL
);

CREATE TABLE daily_stats (
  day TEXT, project TEXT, model TEXT,
  tokens_total INTEGER, cost_usd REAL, sessions INTEGER,
  PRIMARY KEY (day, project, model)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- schema_version, pricing_version
```

**Migrations:** embedded, sequential, `meta.schema_version` gated.

### DDL v2 (added in T2, `0002_event_keys.sql`)

Additive only; DDL v1 stays verbatim in `0001_init.sql`.

- `events` + `key TEXT` (dedupe handle, see § Hook shim), `model TEXT`, `cache_write_1h INTEGER`, `agent_id TEXT`; `UNIQUE INDEX (session_id, key) WHERE key IS NOT NULL`.
- `sessions` + `has_hooks`, `has_transcript` (which planes have been seen), `git_branch`, `version` (Claude Code version).
- `session_files (session_id, path, first_ts, last_ts)` — files touched, so `files_touched` is a real count.
- `transcript_offsets (path, session_id, offset, updated_at)` — resume tailing after restart.
- `meta.transcript_schema_version` — parser schema version in force.

### Phase 1 DDL additions

```sql
ALTER TABLE sessions ADD COLUMN owned INTEGER NOT NULL DEFAULT 0;  -- spawned by Caprock
ALTER TABLE sessions ADD COLUMN worktree TEXT;
CREATE TABLE throttle_observations (ts INTEGER, session_id TEXT, kind TEXT, payload TEXT);
```

`throttle_observations` records each `StopFailure` (rate_limit / overloaded / billing) — a post-hoc "a limit was hit" fact; the Cost screen shows the count per range.

### Rate-limit snapshots DDL (migration 0005)

```sql
CREATE TABLE rate_limit_latest  (window TEXT PRIMARY KEY, ts INTEGER, session_id TEXT, used_percentage REAL, resets_at INTEGER);
CREATE TABLE rate_limit_history (ts INTEGER, window TEXT, used_percentage REAL, resets_at INTEGER);
```

`rate_limit_latest` holds the current state per window (upserted); `rate_limit_history` is a throttled sample (≥30s apart) used to compute an honest "at current pace" forecast. Fed by the statusline (below).

## Statusline

`caprock statusline` is registered as Claude Code's `statusLine.command`. Registration is offered by `caprock up` (same consent contract as hooks — TTY prompt or `--yes`) and can be done or reverted explicitly with `caprock statusline install` / `caprock statusline uninstall`; it writes the single `statusLine` key in `~/.claude/settings.json` (backed up once) and never clobbers a statusLine the user set to something else. Claude Code pipes its status JSON on stdin (per assistant message, 300ms debounce); the command prints a compact one-line status to stdout (`model · ctx% · $cost · 5h N% resets HH:MM · 7d N%`) and, best-effort, forwards the `rate_limits` windows (`used_percentage` 0–100, `resets_at` unix seconds) to the daemon via `POST /v1/statusline`. Like the shim it is fire-and-forget and can never break the session: it prints from the stdin JSON **first**, then POSTs with a ≤300ms budget, drops silently if the daemon is down, and always exits 0. `rate_limits` is present only for Pro/Max subscribers (absent → the line still renders, no POST). The daemon's `/v1/stats/summary` returns `rate_limits` (current window state) with a `forecast` string only when the measured usage slope is rising and would reach the limit before the window resets — otherwise the fact alone, never a guess.

### Phase 2 DDL additions

Tables `tasks` (mirror of file state for querying) and `verifications` (`task_id`, `round`, `command`, `exit_code`, `output_path`). Files are the source of truth for hive state; SQLite mirrors them for the UI (rebuildable by rescan). Forced-continue counter for the Stop-loop lives in SQLite per (session, task).

## Pricing table

- Embedded JSON `pricing/pricing.json` (the spec's "ported from Caprock-python" — authored from the Anthropic pricing page in practice, [ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson)); overridable by a user file (`<data_dir>/pricing.json`); `pricing_version` recorded in `meta` so historical cost is never silently recomputed.
- Cost per assistant turn = `tokens_in × input + cache_write × cache_write_price + cache_read × cache_read_price + tokens_out × output`, all prices per token (table values are per MTok ÷ 1e6).
- Cache-savings math (ported from Caprock-python `_savings.py`): `billed_with = in + 1.25·cache_write + 0.10·cache_read` in input-token equivalents; `billed_without = in + cache_write + cache_read`; `saved = billed_without − billed_with`; hit-rate reported as `cache_read / (in + cache_read + cache_write)`. Where the transcript reports the 1h-TTL split (`cache_creation.ephemeral_1h_input_tokens`), those tokens are priced at the 1h write price (2×), not 1.25×.
- **Source of the numbers:** Anthropic first-party pricing page (`platform.claude.com/docs/en/about-claude/pricing`), fetched 2026-08-18. Bedrock/Vertex have separate partner pricing — first-party only across v0.1–v0.3; recorded as [OQ-02](12-risks.md#open-questions).
- The parity target and its fixture story: [OQ-01](12-risks.md#open-questions).

## Runtime file

`<data_dir>/runtime.json` = `{"port": 4173, "token": "<random per run>", "pid": <daemon pid>, "started_at": <unix ms>}`; written 0600 by `caprock up`, deleted by `caprock down`; the shim reads it on every invocation. What `<data_dir>` resolves to per OS is owned by [ADR-013](08-decisions.md#adr-013--data-dir-and-config-conventions).

## Transcript JSONL (observed shape)

Not a public contract — the parser is schema-versioned and degrades to hooks-only mode on unknown shapes ([12-risks.md RISK-02](12-risks.md#risks)). What `ingest` relies on, as observed in a real Claude Code 2.1.x transcript on 2026-08-18:

- One JSON object per line; `type` ∈ `user`, `assistant`, `system`, `attachment`, plus session-meta lines (`mode`, `permission-mode`, `ai-title`, `last-prompt`, `file-history-snapshot`, `bridge-session`) which are ignored.
- `user`/`assistant`/`system` lines carry `uuid`, `parentUuid`, `timestamp` (RFC 3339), `sessionId`, `cwd`, `version`, `gitBranch`, `isSidechain`.
- `assistant` lines: `message.model`, `message.id`, `message.usage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`; `message.content[]` blocks (`text`, `tool_use`, …).
- `system` lines with `subtype: "turn_duration"` carry `durationMs`.
- The transcript is written asynchronously and may lag the in-memory conversation (Claude Code documents this) — hence hooks are the real-time source and transcripts the accounting source.
- Files live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; `transcript_path` in hook payloads points at the exact file. Subagent transcripts live at `<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl` and carry the parent `sessionId` plus `agentId`, `isSidechain: true`.
- **One API response is written as several `assistant` lines** (thinking / text / tool_use blocks split across lines), each repeating the *same* `message.id`, `requestId` and `usage`. Verified 2026-08-18 across 16,210 such groups in local transcripts: usage never differs within a `message.id`. Ingest therefore counts usage once per `message.id` (dedupe key `msg:<id>`); summing per line would over-count cache tokens 2–3×.
- Lines with `message.model == "<synthetic>"` are Claude Code's own notices, not turns; ignored.

Golden fixtures for the parser (normal, compacted, malformed line, unknown schema field) live in `testdata/transcripts/`.
