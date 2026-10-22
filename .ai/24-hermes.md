# Hermes Agent support

**Status: built — observation and launch.** Hermes Agent's sessions, prompts,
replies, tool calls, tokens and cost are read from its own state database and
shown on the same screens as every other agent, with background runs (cron, a
chat through its gateway) split out on the Cost screen. Caprock can also start
Hermes in a terminal tab, and carry an ended Hermes session on in a Caprock
tab or in the user's own terminal (*Open in …*), both with `hermes chat
--resume <id>`. The decision is [ADR-069](08-decisions.md); this file is what
it rests on.

Everything below was read from Hermes Agent **v0.21.6** (git `97a9ae8`)
installed on the owner's machine on 2026-10-11, and re-read on 2026-10-15:
its source under `~/.hermes/hermes-agent` and its own `hermes --help` and
`hermes chat --help`. No Hermes conversation was run against a real API to
build it, and no row of a real `state.db` was read; the tests build their
database from Hermes's own `CREATE TABLE` statements.

## Why

A user asked for it, and the owner installed Hermes to have it measured. Hermes
is different in kind from the other agents Caprock reads: besides a CLI and a
TUI it runs **cron jobs** and answers **chats through its gateway** (Telegram,
Slack, Discord…) with nobody watching, and that spend never passes a terminal
anyone looks at. One screen over every agent is the product; spend that runs
while you sleep is the part most worth putting on it.

## What Hermes gives us

One SQLite database, `<hermes home>/state.db`, in WAL mode. The home is
Hermes's own resolution (`hermes_constants.get_hermes_home`): `HERMES_HOME`,
else `%LOCALAPPDATA%\hermes` on native Windows and `~/.hermes` elsewhere.

- **`sessions`** — one row per conversation, with cumulative counters kept by
  Hermes itself: `input_tokens` (fresh input — Hermes's prompt is input +
  cache read + cache write, `CanonicalUsage.prompt_tokens`, the same split as
  Caprock's), `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
  `reasoning_tokens`, `api_call_count`, `tool_call_count`, `message_count`;
  `model`, `billing_provider`, `billing_mode`; `estimated_cost_usd`,
  `actual_cost_usd`, `cost_status`, `cost_source`; `source`; `cwd`,
  `git_branch`; `title`; `started_at`, `ended_at`, `end_reason`,
  `last_activity_at`; `parent_session_id` and `model_config`.
- **`messages`** — `role` (user, assistant, tool, system), **`content`, the
  text itself** (a plain string, or `\x00json:` and JSON for multimodal parts),
  `tool_calls` (OpenAI's shape, arguments as a JSON string), `tool_name`,
  `timestamp`, `_compressed_summary`.
- Also there and not read: `session_model_usage` (per-model splits of the same
  counters), the FTS indexes, gateway routing and leases.

## How it maps

- **A session** becomes a Caprock session under Hermes's own id (`agent =
  'hermes'`), with its folder, branch and title.
- **A user message** becomes `turn.user` (`prompt`), so Memory finds a reply
  by the question asked.
- **An assistant message** becomes `turn.assistant` with its prose (`text`),
  and each call in its `tool_calls` a `tool.pre` tied to it by `msg_id`. Core
  tools take Caprock's spellings — `terminal` Bash, `read_file` Read,
  `write_file` Write, `patch` Edit, `search_files` Grep, `web_search`,
  `web_extract`, `delegate_task` Task — with Hermes's name kept as
  `hermes_tool`, and a relative `path` resolved against the session's folder
  as `file_path`, so per-directory attribution places it. Tool results and
  Hermes's compression summaries are not stored.
- **Usage is reconciled, not per message.** Hermes adds each API call's tokens
  and cost to the session row (`update_token_counts`, the delta path; the
  absolute path exists and 0.21.6 never calls it) and writes no usage on a
  message. Each pass, the importer subtracts what Caprock has stored for the
  session from Hermes's counters and records the difference on the newest
  assistant message of the pass — or, when the counters moved with no new
  message (Hermes queues them and flushes at the end of a turn), on a
  `turn.assistant` of its own marked `usage_only`, keyed by the counters it
  brings the session to. Caprock's totals therefore equal Hermes's, and a
  re-read or a restart adds nothing. A counter that went down is clamped at
  zero, never turned into negative spend.

## Cost

Hermes prices every call itself (`agent/usage_pricing.py`) and Caprock's table
is never applied to its turns, as with OpenCode: two arithmetics over the same
tokens would give two totals for one session.

- **Actual** when Hermes says the figure is real — `cost_status = 'actual'`,
  or a `cost_source` of `provider_cost_api` or `provider_generation_api`:
  `actual_cost_usd` when it is set, else `estimated_cost_usd`, where Hermes
  writes a provider-reported figure handed back by a provider profile
  (`providers/base.py`, `get_usage_cost`). Hermes's own readers take
  `COALESCE(actual_cost_usd, estimated_cost_usd)`, the same figure.
- **Estimated** otherwise: `estimated_cost_usd`, which Hermes computes from its
  own price list (`official_docs_snapshot`, `provider_models_api`).
- **Included**: a subscription route (`cost_status = 'included'`, or
  `billing_mode = 'subscription_included'`) is $0 and called that.
- **Unknown**: Hermes had no price. The tokens are stored with no cost, so
  they count as unpriced — never a guessed figure (rule 6) — in the Hermes
  panel and in the Cost screen's general unpriced note, named by model.

Each usage-carrying event says which in its payload (`cost_basis`,
`cost_source`), and the Cost screen's Hermes panel adds them up separately.
In 0.21.6 no writer sets `actual_cost_usd` (both, `turn_usage.py` and
`codex_runtime.py`, pass the estimate only) and no bundled provider profile
returns status `actual`, so on today's Hermes every figure is an estimate; the
actual path is there for when Hermes reconciles with a provider. `cost_status`
is the status of the session's latest call (`COALESCE(?, cost_status)`), so a
session whose calls were priced differently carries the latest one's label.

**Subagents are not double-counted.** `delegate_tool_results._rollup_children_cost`
adds a child's cost to the parent agent's figure in memory only; the database
receives each call's delta on the row of the session that made it. Summing
parent and child rows is therefore exact, and the tests check it.

## Subagents, continuations, branches

`parent_session_id` means three things, and Hermes marks which itself
(`hermes_state_common.py`, `delegate_tool.py`):

- **`model_config._delegate_from = parent`** — a delegated subagent. Filed
  inside the parent's Caprock session under `agent_id` = its own id, its
  events marked `sidechain`, as a Claude Code subagent's are. A nested one is
  filed under the main thread it descends from.
- **`_branched_from` / `_reset_from`** — a branch or a reset: a new
  conversation, its own session.
- **A parent that ended with `end_reason = 'compression'`** — the same
  conversation continuing under a new id: its own session (Caprock ends the
  parent row when Hermes records its `ended_at`).
- Any other child is read as a subagent, as Hermes's own pickers hide it.

## Background runs

Hermes defines which sessions a person reads as they run
(`agent/session_source.py`, `ATTENDED_SOURCES`): `cli`, `tui`, `desktop`,
`acp`. Every other `source` — `cron`, `telegram` and the other gateway
platforms, `oneshot`, `kanban`, `tool`, `api_server` — is **background**.
Each event carries `hermes_source`, and `background: true` when it is one; a
subagent takes its main thread's source. The Cost screen shows background
spend as its own figure with a split by source; it is inside the total, not
added to it.

## Liveness

Hermes records no process id per session, so an observed session is judged
like the other imported agents (`ownsItsProcess` excludes `hermes`): idle after
the idle threshold, ended after a day of silence — and ended at once when
Hermes writes `ended_at` on it. A session Caprock started has its own process,
recorded at spawn, and goes by that.

## Launch

`New agent → Hermes` starts `hermes chat` in a Caprock terminal tab, built from
the real `hermes chat --help` (`internal/agents/hermes.go`):

- `-m <model>`; `--yolo` for Bypass (Hermes's one approval switch; it has no
  plan or accept-edits mode, and those start Hermes as it is); `-q <prompt>`
  for a first message — on a TTY it "seeds an interactive session".
- `chat --resume <id>` continues a session; there is no fork. Continue in a
  Caprock tab and *Open in …* (`internal/api/openterm.go`) both use it, with
  Hermes's own id. `resumeState` (`internal/api/resume.go`) offers it as it
  does for Codex and OpenCode: once the session has ended, its folder exists,
  something was sent (a Caprock-started session is linked), `hermes` is
  installed and `state.db` is still there.
- Hermes has no flag that names a new session's id. It mints one when the CLI
  starts — `YYYYMMDD_HHMMSS_<hex>`, local time — and writes the row on the
  first message. The importer links that row to the spawn the way Codex's
  rollouts are linked (`internal/sessionlink`, heuristic): same folder, a
  `cli` or `tui` session with no parent, whose **id time** falls within the
  window after the spawn. The row's `started_at` is not used for it: it can
  be minutes late.
- A Caprock-started Hermes session can be typed into and stopped; an
  observed one is read only ([rule 7](../CLAUDE.md)).
- **Setup is the user's.** The catalog shows Hermes as installed and ready,
  and when `config.yaml` names no `model.default` it shows `hermes model` as
  the step to run in a shell tab — Hermes's own picker for a provider and its
  sign-in. Caprock reads only whether that key is set, never its value, and
  never enters a credential.

## Safety

The database is opened `mode=ro` with a busy timeout and one connection: no
write lock, no migration, and a moment where Hermes holds the database is a
wait, then a skipped pass. It is never opened `immutable=1`, which in WAL
mode would miss what is in the WAL and could read a page mid-change. A
column an older Hermes lacks reads as NULL (the query asks `pragma_table_info`
first), so a schema change is a missing field, not a broken import. Nothing
leaves the machine.

## What is not read yet

- **Hermes profiles** (`hermes profile`): only the default home's database is
  read; a second profile's sessions are not.
- **Per-model splits** (`session_model_usage`): a session that switched models
  with `/model` is shown under the model its row names.
- **Per-call attribution.** Because usage lands on the newest reply of a pass,
  the reply that asked for the tools usually carries none of it, so *What it
  went on* reads a Hermes turn as "no tool call" more often than it was. The
  totals are exact; the split by kind of work is not, for Hermes.
- **Live latency**: polled every five seconds, like OpenCode's database.
- **Hermes's webhooks and shell hooks** are not used; cost lives only in the
  database.

## Where it lives

- `internal/hermes/hermes.go` — home, `Open`, `Sessions`, `Messages`, `Cost`,
  `Background`, `IDTime`.
- `internal/hermes/text.go` — content decoding, tool calls and their mapping.
- `internal/hermes/ingest.go` — the poller and the usage reconciliation.
- `internal/hermes/live_check_test.go` — compares the fixture's schema with the
  installed Hermes source, where there is one (text only, no data).
- `internal/store/hermes.go` — `HermesSpend`, the Cost screen's split.
- `internal/agents/hermes.go`, `internal/agentcat/hermes.go` — the launcher and
  the catalog entry.
