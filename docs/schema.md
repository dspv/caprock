# The Caprock record — export schema

Five coding agents write their history in five formats. None of them
promises a stable format, and each changes with the agent's releases. Caprock reads all of them and
stores one record with one set of columns, whichever agent wrote the source.
`caprock export` writes that record out:

```bash
caprock export --since 30d > events.tsv               # every turn and tool call, 30 days
caprock export sessions --format csv --out s.csv      # one row per session
caprock export --agent codex --format jsonl --payload # with the raw source payload
```

It reads the database read-only, so it works with the daemon stopped, and it
never writes. Formats are `tsv` (the default), `csv` and `jsonl`.

## Where the rows come from

| Agent       | `agent`    | `source`             | Read from                                                         |
| ----------- | ---------- | -------------------- | ----------------------------------------------------------------- |
| Claude Code | `claude`   | `hook`, `transcript` | Hooks via the shim, and `~/.claude/projects/**/*.jsonl`           |
| Codex       | `codex`    | `codex`              | `$CODEX_HOME/{sessions,archived_sessions}` rollouts (`~/.codex`)  |
| OpenCode    | `opencode` | `opencode`           | OpenCode's own SQLite database, read-only                         |
| Gemini CLI  | `gemini`   | `gemini`             | The telemetry file Caprock asks Gemini to write when it starts it |
| DeepSeek    | `deepseek` | `deepseek`           | `<dsh-home>/sessions/**/session*.jsonl.zstd`                      |

A Claude Code session is seen twice, live through hooks and again in its
transcript. The two planes share dedupe keys, so a turn or tool call is one row
whichever arrived first.

## `events` — one row per turn, tool call or lifecycle event

| Column           | Type    | Meaning                                                    |
| ---------------- | ------- | ---------------------------------------------------------- |
| `ts`             | time    | When it happened, RFC 3339 UTC with milliseconds           |
| `session_id`     | text    | The agent's own session id                                 |
| `agent`          | text    | `claude`, `codex`, `opencode`, `gemini` or `deepseek`      |
| `subagent_id`    | text    | Set on a subagent's events; empty for the main agent       |
| `source`         | text    | Which reader produced the row (table above)                |
| `kind`           | text    | See the kinds below                                        |
| `tool`           | text    | For `tool.*`: `Bash`, `Edit`, `Read`, `mcp__…`             |
| `model`          | text    | The model that answered, as the agent named it             |
| `tokens_in`      | integer | Fresh input tokens on an assistant turn                    |
| `tokens_out`     | integer | Output tokens                                              |
| `cache_read`     | integer | Input tokens read from the prompt cache                    |
| `cache_write`    | integer | Tokens written to the cache, both lifetimes                |
| `cache_write_1h` | integer | The part of `cache_write` with a 1-hour lifetime           |
| `cost_usd`       | real    | The turn at list price; OpenCode's own figure for OpenCode |
| `tool_bytes`     | integer | Size of what a tool call returned (on `tool.post`)         |
| `touch_dir`      | text    | Directory of the file a tool touched, slash-separated      |
| `project`        | text    | The session's project name                                 |
| `repo_root`      | text    | The session's repository root                              |
| `msg_id`         | text    | The provider's message id on an assistant turn             |
| `payload`        | JSON    | Only with `--payload`, jsonl only: the raw source record   |

Kinds:

- **`turn.user`, `turn.assistant`** — a prompt and a reply. Tokens and cost sit
  on `turn.assistant`.
- **`tool.pre`, `tool.post`** — a tool call and its result.
- **`agent.spawn`, `agent.stop`** — a session or subagent starting and
  finishing a turn.
- **`session.end`** — the agent process exited.
- **`context.compact`, `context.clear`, `session.continue`** — compaction,
  `/clear`, and a `SessionEnd` that left the session running.
- **`task.*`, `approval.requested`, `throttle`** — Caprock's own task runner
  and rate-limit observations.

Rules that hold for every row:

- **Cost is at list price, and `source` says who priced it.** Claude Code,
  Codex, Gemini and DeepSeek report tokens and no cost, so Caprock prices them
  from `pricing/pricing.json`. OpenCode reports its own cost, and that figure is
  carried through unchanged — pricing the same tokens a second way would give
  one session two totals. A flat-plan user pays the plan, not this figure; it is
  what the work is worth at list price.
- **Empty means unknown, not zero.** A missing token count is an empty cell in
  TSV and CSV and `null` in jsonl.
- **Hidden product machinery is left out.** Codex's automatic review turns
  (`codex-auto-review`) are not work a person started and are not exported.

## `sessions` — one row per session

| Column           | Type    | Meaning                                                  |
| ---------------- | ------- | -------------------------------------------------------- |
| `session_id`     | text    | The agent's own session id                               |
| `agent`          | text    | As in `events`                                           |
| `model`          | text    | The last model the session used                          |
| `project`        | text    | Project name                                             |
| `repo_root`      | text    | Repository root, when the session ran inside one         |
| `repo_path`      | text    | Path of the working directory inside the repository      |
| `cwd`            | text    | Working directory                                        |
| `git_branch`     | text    | Branch at the start                                      |
| `worktree`       | text    | Worktree path, when the session ran in one               |
| `started_at`     | time    | First event                                              |
| `last_event_at`  | time    | Last event of any kind                                   |
| `worked_at`      | time    | Last prompt, reply or tool call; empty if never measured |
| `status`         | text    | `active`, `idle` or `ended`                              |
| `title`          | text    | The short description shown on the session card          |
| `parent_session` | text    | The session this one continues, when that is a fact      |
| `owned`          | integer | 1 if Caprock started the session                         |
| `agent_version`  | text    | The agent's version string                               |

`--since` filters sessions by `last_event_at`; `--agent` by `agent`.

## Formats

- **TSV** — a header row, then one row per line. A tab, newline, carriage
  return or backslash inside a value is written `\t`, `\n`, `\r`, `\\`, so a
  line is always a row for `cut`, `awk` and any loader.
- **CSV** — RFC 4180 quoting via Go's `encoding/csv`.
- **jsonl** — one object per line, keys in column order; `payload`, when asked
  for, is embedded as JSON rather than as a string.

## What is not exported, and why

- **The payload, by default.** It is the prose: prompts, replies, tool output.
  It is yours and it is on your disk; it is still not something to put in a
  spreadsheet by accident. `--payload` adds it, as jsonl only.
- **Rollup tables.** `session_stats`, `daily_stats` and the rest are sums of
  these rows; sum them yourself and the totals reconcile.

## Compatibility

The column sets are a contract. A new column is added at the end of a table; a
column is never renamed, removed or moved. Changes are listed in
[`CHANGELOG.md`](../CHANGELOG.md).
