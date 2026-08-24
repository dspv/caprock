# OpenCode support

**Status: decided, groundwork committed, full build not started.** Waiting on an
explicit go-ahead before the remaining work is done. Everything below was
measured against a real OpenCode installation, not inferred from documentation;
where a number appears it came from a live database.

## Why

A user asked for it. The owner reports knowing many developers whose main agent
is [OpenCode](https://github.com/sst/opencode) rather than Claude Code — for
them Caprock currently shows an empty dashboard, which is indistinguishable from
a broken one.

The strategic point is not "support a second agent" but **one screen over both**.
A machine that runs Claude Code and OpenCode has its spend split across two tools
that each know only their own half. Nothing else shows the whole bill. That is
the differentiator, and it is why the two streams merge rather than sit behind a
mode switch.

## Decisions

Both were made by the owner on 2026-08-24 and are binding on the implementation.

- **One screen over both agents.** Sessions from either agent share one stream,
  tagged with which agent produced them and filterable by it. Project cost sums
  across both. Not a Claude-Code/OpenCode toggle.
- **Breadth before depth.** The first pass makes Now, Cost and History work from
  OpenCode's database, refreshing on the daemon's normal cadence. The live SSE
  stream is a later pass; a few seconds of latency on a cost figure is not worth
  delaying every screen for.

## What OpenCode gives us

OpenCode is markedly easier to observe than Claude Code, and the ingestion is a
translation rather than a pipeline.

- **One SQLite database**, at `~/.local/share/opencode/opencode.db`
  (`$XDG_DATA_HOME/opencode`, `%LOCALAPPDATA%\opencode` on Windows,
  `$OPENCODE_DB` overrides). Opened read-only — it belongs to another running
  program, and a monitor that corrupts what it monitors is worse than none.
- **Cost and tokens are already columns** on `session`: `cost`, `tokens_input`,
  `tokens_output`, `tokens_cache_read`, `tokens_cache_write`, alongside
  `directory`, `title`, `model` (JSON `{id, providerID}`), `parent_id`,
  `time_created`, `time_updated`. Per-message figures live in `message.data`
  with the same shape plus `path.cwd`.
- **Tool calls keep full fidelity** in `part.data`: `tool`, `callID`, and a
  `state` carrying `input` (the real argument object, including `filePath`),
  `output`, and `time.{start,end}`.
- **No shim, no config injection, no transcript parsing.** Claude Code needs all
  three; OpenCode needs none of them.
- **A headless server** (`opencode serve`, default `127.0.0.1:4096`) exposes an
  SSE stream at `GET /event` — verified emitting `server.connected` — for the
  later live pass.

The one thing OpenCode does not need from us is pricing: it computes cost itself
from models.dev rates. `pricing.json` is therefore **not** applied to OpenCode
rows, and `event.SourceOpenCode` is what records whose arithmetic produced a
figure.

## Traps

- **Subagents double-count.** `session.parent_id` is set on subagent sessions,
  which carry their own cost on their own row. A naive `SUM(cost)` over a
  project therefore overstates against a parent-inclusive view. Measured on the
  owner's machine: 70 sessions, 47 of them children, `$156.25` summed versus
  `$154.06` root-only — 1.4%. The rollup has to be chosen deliberately and
  stated in the UI, not left to whichever query runs first.
- **Cost is modelled, not billed.** OpenCode prices from list rates, so a
  subscription user's stored cost is not their invoice. This is the same caveat
  Caprock already states about its own figures, and the same wording applies.
- **Tool names differ in case only.** OpenCode writes `bash`, `read`, `edit`;
  Claude Code writes `Bash`, `Read`, `Edit`. `opencode.NormalizeTool` maps them
  so loop detection, narration and work-kind classification need no changes.
  `task` maps to `Agent`, `patch` to `Edit`, `question` to `AskUserQuestion`.
  MCP-style names pass through verbatim.
- **The JSON storage tree is legacy.** `storage/session/*.json` still exists and
  is migrated into SQLite by OpenCode itself. Build against the database.

## Plan

Estimated at roughly seven hours for the observation half.

| Step | Work                                                           | Done |
| ---- | -------------------------------------------------------------- | ---- |
| 1    | `internal/opencode` — read sessions, messages, tool calls      | yes  |
| 2    | Migration `0015_agent_source.sql` — `sessions.agent`           | yes  |
| 3    | `event.SourceOpenCode`                                         | yes  |
| 4    | Ingester — sessions, turns and tool calls into the store       | no   |
| 5    | UI — agent label, filter, combined totals                      | no   |
| 6    | Tests, fixtures, `make check` green on three operating systems | no   |
| 7    | Documentation — this file, `03-contracts.md`, README           | part |

Deliberately excluded from the first pass, each a separate piece of work:

- **Live SSE** (`GET /event`) — around a day and a half, mostly reconnection and
  deduplication against the database reader.
- **Spawning and controlling OpenCode sessions** — around two days;
  `internal/agents` assumes the `claude` binary and its flags throughout.
- **Verified Windows and Linux behaviour** — the first pass compiles everywhere
  but is only exercised on macOS.

## Verification

`internal/opencode/live_check_test.go` runs against whatever OpenCode database
exists on the machine and skips where there is none, so it is a smoke check on a
real installation rather than a fixture test. On the owner's machine it reports
70 sessions across three repositories, `$156.25` total, and 144 of 403 tool calls
carrying a file path — enough to confirm that per-repository and per-directory
attribution both have the data they need.

Fixture-based tests that run everywhere are step 6 and are not written yet.
