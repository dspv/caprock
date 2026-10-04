# OpenCode support

**Status: observation and starting sessions are built.** Sessions, turns and
tool calls are imported from OpenCode's database, tagged with their agent, and
shown on the same screens as Claude Code. Live updates over OpenCode's SSE
stream are built (`internal/opencode/stream.go`), and Caprock can start, type
into, continue and stop an OpenCode TUI (§ Starting an OpenCode session). Everything below was
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

- **One SQLite database**, at `~/.local/share/opencode/opencode.db` — on
  *every* platform. OpenCode uses the `xdg-basedir` package with no platform
  branching at all, so Windows is `%USERPROFILE%\.local\share\opencode` and
  neither `LOCALAPPDATA` nor `APPDATA` is consulted; macOS is the XDG path
  rather than Application Support, which `opencode db path` confirms. Opened
  read-only — it belongs to another running program, and a monitor that
  corrupts what it monitors is worse than none.
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

- ~~Live SSE~~ — **built.** See "The live stream" below.
- ~~Spawning and controlling OpenCode sessions~~ — **built.** See "Starting an
  OpenCode session" below.
- **Verified Windows and Linux behaviour** — the first pass compiles everywhere
  but is only exercised on macOS.

## Verification

`internal/opencode/live_check_test.go` runs against whatever OpenCode database
exists on the machine and skips where there is none, so it is a smoke check on a
real installation rather than a fixture test. On the owner's machine it reports
70 sessions across three repositories, `$156.25` total, and 144 of 403 tool calls
carrying a file path — enough to confirm that per-repository and per-directory
attribution both have the data they need.

Fixture-based tests that run everywhere are step 6 and are written (`internal/opencode/fixture_test.go`).

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

## The prose

The Memory screen shows what an agent wrote, read from `payload.text` on
`turn.assistant` by a query that does not know which agent wrote the row. For
OpenCode that text lives in `part.data` as `text` parts, one or more per
message, beside the `reasoning`, `tool` and `step-*` parts; the importer joins a
message's text parts in order and stores them in the shape the Claude Code
parser does, clipped on runes to the same cap. The exact contract — what is
skipped, the sidechain rule, how already-stored turns are mended — is in
[03-contracts.md](03-contracts.md) beside the Claude Code rule it mirrors.

- **Reasoning is not prose.** `reasoning` parts are the model's thinking and
  are never read, for the reason Claude's extended thinking is never stored.
- **A subagent is a child session.** OpenCode runs a subagent in its own
  session with `parent_id` set rather than as a sidechain of the parent. Its
  turns are stored with `sidechain: true`, so "what did the agent say" answers
  with the main thread, as it does for Claude Code.
- **A turn is stored once, and its reply may not be finished.** The message row
  exists before its text parts are complete, and a re-read inserts nothing, so
  the importer compares and rewrites the text of turns already stored each time
  it reads a session. The first pass after a start reads every session, which
  is what filled the history: on a copy of the owner's database, 3,258 turns
  gained text and Memory went from no OpenCode passages to 3,048 across 23
  sessions.

## The prompts

OpenCode keeps what the person typed as `text` parts on `user` messages. Each
is stored as a `turn.user` keyed `oc-user:<message id>`, in a Claude Code
prompt's shape (`payload.prompt`, `cwd`), so every reader of a prompt works
unchanged: Memory finds a reply by the question that produced it, the session
is described and searched by its prompts, and the timeline shows them. The
exact contract is in [03-contracts.md](03-contracts.md).

- **Not every user part is the person.** Parts OpenCode marks `synthetic` or
  `ignored` are its own text — the "Continue if you have next steps…" after a
  compaction, "Summarize the task tool output above…" — and are skipped, as for
  replies. OpenCode does not mark text another program sends through it: four
  sessions on the owner's database open with a `<system-reminder>` persona
  greeting an agent app drove OpenCode with, as the whole user message. A part
  that opens with that tag is skipped; one that only mentions it is kept.
- **A child session's prompt is its parent's task.** It is the brief the parent
  agent wrote for the subagent, not the person's words. It is stored, as a Claude
  Code subagent's prompt is, and marked `sidechain` like the child's replies.
- **History is filled on the first pass after a start**, which reads every
  session; the stable key makes it insert only the prompts missing and leaves a
  second start with nothing to do. The prompts arrive with ids newer than every
  reply they produced, which is why the notes search looks for "the prompt
  before this reply" in time rather than in event id — under the id window none
  of the backfilled questions found its reply.
- **Measured on a copy of the owner's database (2026-10-01):** 1,609 prompts
  stored from the 1,613 user text parts not marked synthetic (the four
  `<system-reminder>` greetings skipped), 47 of them in child sessions;
  2,878 of 3,048 main-thread OpenCode replies now have a question within the
  search window, against none before. The backfill pass took 4.0 s, a later
  start with nothing to add 1.8–1.9 s, and the database grew by 2.9 MB.

## The agent filter

The Now screen carries `all / claude / opencode / gemini` beside the pricing note, and
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

## The live stream

The poller reads the database every five seconds, which is right for history
and for cost but visibly late on the Now screen: a session that just answered
showed up seconds after it did. When `opencode serve` is running — which is
whenever a TUI is open — Caprock subscribes to its SSE stream and re-reads the
one session an event names, immediately. Measured on a real installation: a
change is visible in **0.25s** rather than up to five seconds.

**It does not replace the poller.** The stream exists only while a server is
running and carries no history, so a machine that has been off all night still
needs the database read. The poller is the floor; the stream removes the
latency on top of it. A refused connection is therefore the normal case, not an
error — it retries with backoff up to thirty seconds and logs at debug level.

**Events are a signal, not data.** An event says "this session changed"; the
figures still come from the database, which is the only place OpenCode's own
cost arithmetic lives. Reading the event payload instead would mean maintaining
a second understanding of their schema that drifts from the first.

**Only eight of their event types are acted on** — the message and session ones.
OpenCode publishes over a hundred, most saying nothing about what Caprock
stores: a toast, a TUI selection, an LSP diagnostic. Re-reading a session on
those is work for nothing, and on a busy session the stream is chatty enough
that it matters.

`OPENCODE_URL` overrides the server address, which a user on a non-default port
needs and which the tests point at a stub.

**Two defects surfaced while building it**, both in the shape of database
contention rather than in the stream itself:

- `Touch` listed every session to find the one an event named, turning a
  per-event read into a full scan. It reads one row now.
- The poll loop and the stream both wrote, and SQLite refuses one of two
  concurrent writers — which surfaced as the daemon's own idle sweeps failing
  with `SQLITE_BUSY`, not as a failure in the importer that caused it. Imports
  are serialised; there is no throughput to gain from overlapping them.

`internal/opencode/stream_test.go` runs against a stub SSE server, so it covers
frame parsing, the narrow event filter, malformed frames, cancellation and the
retry — everywhere, not only where OpenCode is installed.

## Starting an OpenCode session

Since 2026-10-04 the New session dialog starts the OpenCode TUI in a PTY, next
to Claude Code and Codex ([ADR-031](08-decisions.md)). Built from `opencode
--help` and `opencode run --help`, **opencode 1.15.10**, read on 2026-10-04,
and each flag exercised by starting the TUI with it:

- **`--port <p>`** — the TUI runs its own server, and Caprock picks a free
  loopback port for it so it can learn the session id (below). `--hostname`
  defaults to `127.0.0.1` and is left alone.
- **`-m provider/model`** — OpenCode's own syntax. The dialog takes it as typed;
  empty sends nothing and the user's config decides. No list is offered:
  `opencode models` fetches the catalog over the network, and the providers a
  user has set up are theirs.
- **Permissions.** `plan` → `--agent plan`, OpenCode's built-in plan agent
  (`opencode agent list`: `edit` denied except plan files). `acceptEdits` →
  `OPENCODE_PERMISSION={"bash":"ask"}` in the child's environment — verified
  with `opencode agent list`, which then shows `bash: ask` on the build agent;
  edits stay allowed. **Bypass is not claimed:** the build agent already allows
  every tool, and `{"*":"allow"}` does not remove the asks OpenCode keeps for
  `doom_loop` and directories outside the project (measured: the same four
  `ask` rules before and after), so the dialog labels it "OpenCode's own
  rules" and sends nothing.
- **A first message** is `--prompt <text>` ("prompt to use"), which a relay's
  brief uses ([ADR-032](08-decisions.md)); measured on 1.15.10, a multi-line
  prompt is sent as the TUI opens, and the session it creates is linked as
  below.
- **Resume** is `--session <id>`. **Fork is refused**, as for Codex: `--fork`
  copies the session's messages, cost included, and Caprock would count them
  twice.
- **Newlines.** ESC CR inserts a line with text already in the prompt,
  measured on 1.15.10 — no per-agent key map.
- OpenCode may open an "Update available" dialog over the TUI on start. That
  is its own UI and is left to the user; Caprock does not switch auto-update
  off behind their back.

### Linking the session (exact)

OpenCode creates a session when the first message is sent, not when the TUI
starts, so its id cannot be known at spawn and cannot be matched on start time.
It does not need to be matched: the TUI's server on the port Caprock chose
publishes `session.created` on `GET /event` for the session it made (measured:
`server.connected`, then `session.created` with `properties.info.id`). The
daemon follows that stream for the life of the process (`opencode.WaitCreated`),
stores the first top-level id it announces (`parentID` empty) as
`sessions.native_id`, and the importer then files the session's turns, prompts
and tools under Caprock's id. Nothing else can be on that port, so this is a
fact, not a guess. The stream is then kept open to re-read the session on each
change, as the shared live stream does for `opencode serve`.

- A port taken between Caprock choosing it and OpenCode binding it leaves the
  session **unlinked** (shown as its own row, as before this feature), never
  mislinked.
- Subagent sessions keep their own rows, as for every OpenCode session.
- On a machine where OpenCode has never run, the database is created by that
  first session; the reader is started when the link is made.
- Verified end to end on 2026-10-04 on an isolated daemon with a scratch HOME:
  the prompt was linked and stored under Caprock's id with no second row,
  `continue here` started `opencode --session <id>`, and the model call itself
  was refused by OpenCode's free tier for this version, so no cost.

## Where the database is, exactly

This was the part most likely to be wrong, because it is a claim about another
program's layout that only one platform ever exercised. Verified against
OpenCode's source and against `opencode db path` on a real install:

- **The layout is the same everywhere.** OpenCode reads `xdg-basedir`, which
  has no `process.platform` check: `XDG_DATA_HOME` if set, otherwise
  `~/.local/share`. So macOS is *not* Application Support and Windows is *not*
  `%LOCALAPPDATA%` — both are `~/.local/share/opencode`. Searching the
  platform-native locations was the obvious guess and would have found nothing
  on every Windows machine.
- **The filename is not always `opencode.db`.** Released builds — channels
  `latest`, `beta`, `prod` — use it, but any other build appends its channel: a
  locally-built binary writes `opencode-local.db`, a preview build writes its
  git branch, sanitised. The set is open-ended, so the search matches
  `opencode-*.db` and prefers the plain name; with several suffixed files the
  most recently written wins, because that is the one being used.
- **A relative `OPENCODE_DB` resolves inside the data directory**, not against
  the working directory. Resolving it our way would have looked for the file
  beside wherever the daemon started, which for a service is nowhere the user
  had in mind.
- **WAL is on**, so `opencode.db-wal` and `-shm` sit beside the database and a
  reader that cannot attach to the log silently sees a stale snapshot. A live
  test asserts the reader sees current data, not just that it opens.

`internal/opencode/paths_test.go` runs the search order for macOS, Linux and
Windows regardless of the machine the test is on, so the Windows expectations
fail on a Mac when the logic is wrong. That is how the Windows mistake above
was caught before anyone ran it there.
