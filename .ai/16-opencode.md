# OpenCode support

**Status: the observation half is built.** Sessions, turns and tool calls are
imported from OpenCode's database, tagged with their agent, and shown on the
same screens as Claude Code. Live SSE and session control are not built and are
scoped below. Everything below was
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

| Step | Work                                                      | Done |
| ---- | --------------------------------------------------------- | ---- |
| 1    | `internal/opencode` — read sessions, messages, tool calls | yes  |
| 2    | Migration `0015_agent_source.sql` — `sessions.agent`      | yes  |
| 3    | `event.SourceOpenCode`                                    | yes  |
| 4    | Ingester — sessions, turns and tool calls into the store  | yes  |
| 5    | UI — agent label on OpenCode sessions                     | yes  |
| 6    | Tests: portable fixtures plus live checks, 89% coverage   | yes  |
| 7    | Documentation — this file, `03-contracts.md`, README      | yes  |

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

## How it works

The daemon looks for OpenCode's database at startup. Finding none is the normal
case and is silent; finding one starts a poller alongside the transcript tailer.

**Polling, not tailing.** Every five seconds the poller lists sessions and reads
the ones whose `time_updated` moved since the last pass. That upper bound on
latency is deliberate: the database is the only source that also carries history
from before Caprock was installed, and a few seconds on a cost figure does not
justify holding every screen for the streaming work.

**Idempotent by construction.** Each event is keyed on OpenCode's own identifier
(`oc-msg:<message id>`, `oc-tool:<part id>`), and `(session_id, key)` is unique
in the store, so re-reading a session stores nothing new. The live test asserts
this by running a full second pass and requiring zero new rows.

**Cost is carried, not recomputed.** `rollup.Recorder` prices a turn only when
`CostUSD` is nil, so setting OpenCode's own figure suppresses the pricing table
for that row. Two arithmetics over the same tokens would otherwise produce two
different totals for one session.

**Read-only.** The database is opened `mode=ro`. It belongs to a program that may
be writing to it, and a monitor that corrupts what it monitors is worse than
none.

## What is verified

`internal/opencode/ingest_live_test.go` imports whatever OpenCode database is on
the machine into a throwaway store and asserts what would silently break:
sessions carry the agent tag, events carry cost, per-repository grouping is
non-empty, and a second pass is a no-op. On the owner's machine it imports 70
sessions and 19,236 events totalling $156.28, matching the source database
exactly, and attributes them across three repositories.

Those tests skip where OpenCode is absent, which is most machines and all of
CI. The portable suite is what CI runs: `fixture_test.go` builds an OpenCode
database from the schema copied verbatim out of a real installation, and the
reader and ingester are exercised against it. Coverage is **89.1%, identical
with and without OpenCode installed** — it was 2.3% in CI before.

The fixture is deliberately built from the real schema rather than from the
reader's assumptions, including the columns the reader never touches: a fixture
invented from the same understanding as the code proves only that the code
agrees with itself.

**Two defects were found by writing these tests**, both of which had shipped:

- **Per-directory attribution was silently empty.** `touch_dir` is derived from
  the event payload by the store, deliberately, so that no writer can supply a
  hand-made value. The OpenCode ingester emitted its own field names, so every
  tool call was stored unplaced. The payload is now shaped like a Claude Code
  hook payload, which also makes work-kind classification and narration work
  without changes.
- **The pricing table was applied to unpriced OpenCode turns.** Suppression
  relied on `CostUSD` already being set, so a turn OpenCode had not priced
  acquired a figure from different arithmetic — one column holding two costing
  methods, with nothing on screen to say which produced a given row.
  `rollup.Recorder` now refuses to price any event whose source is OpenCode.

The suite is checked by mutation rather than by coverage alone: removing the
agent tag, dropping OpenCode's cost, removing tool-name normalisation, or
re-enabling the pricing table each turns it red.

## The agent filter

The Now screen carries `both / claude / opencode` beside the pricing note, and
it applies to the whole screen: today's totals, the live pulse, the activity
feed, the projects list and the session cards all answer the same question. A
filtered list beside an unfiltered total is how a reader ends up quoting a
number that means something other than what the heading says.

**Where the control appears.** Only when the daemon reports it is reading
OpenCode (`status.opencode`). Neither the session list nor a day's summary can
answer this on their own: the Now screen fetches only live sessions unless
"show ended" is ticked, and a machine's OpenCode history is usually all ended
and older than today, so both are legitimately empty on exactly the machines
that need the control.

**Where the filtering happens.** Totals come from the server —
`GET /v1/stats/summary?agent=` — because they are aggregates the browser cannot
recompute. Everything else is filtered in the browser from data it already has:
sessions carry their own agent, and the activity feed filters live frames by
session membership because a frame carries a session id and no agent.

**An unknown agent is a 400.** Returning everything under a heading that says
`opencode` is worse than an error, because nothing on screen would say so.

**A repository worked on with both agents** carries no agent of its own and
appears under either filter. Its spend is partly each agent's, so hiding it
from both would drop money off the screen; claiming it for one would be a
quiet lie.

**What is verified.** `internal/store/agent_filter_test.go` pins the arithmetic
rather than the wiring: that claude + opencode equals the unfiltered total for
cost, sessions, turns, tool calls and tokens; that projects and models never
appear under the wrong agent; that a shared project survives both filters; that
the unfiltered entry point is unchanged; and that sessions predating the agent
column count as Claude Code. The suite is checked by mutation — dropping the
filter from the event, model or spark queries each turns it red.

Writing those tests found a defect that had shipped in the projects list: spend
whose session the filter excluded fell through to the "orphan" row, which
exists for sessions that were deleted. Under a filter that row collected the
*other* agent's money and showed it, unlabelled, under this agent's heading.
