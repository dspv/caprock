# Codex support

**Status: observation and starting sessions are built.** Sessions, turns, tool
calls and cost are imported from OpenAI Codex's own rollout transcripts, tagged
with their agent, and shown on the same screens as Claude Code and OpenCode.
Caprock can also start, type into, continue and stop a Codex TUI (§ Starting a
Codex session). Everything here was measured against
100 real transcripts on a machine that runs Codex, not inferred from
documentation; where a number appears it came from that measurement.

## Why

The owner asked, after seeing that Codex was the third agent on his own
machine. The strategic point is the one that motivated OpenCode: **one screen
over every agent**. A machine running Claude Code, OpenCode and Codex has its
spend split three ways, each tool knowing only its own share. Nothing else adds
them up.

## What Codex gives us

Codex is the easiest of the three to observe, and the import is a translation
rather than a pipeline.

- **One append-only JSONL transcript per session**, at
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`, with
  `CODEX_HOME` defaulting to `~/.codex`; archiving a thread moves the file to
  `$CODEX_HOME/archived_sessions/` (§ Where the transcripts are). The same path
  on every platform — Codex uses the home directory directly, with no XDG or
  `%APPDATA%` branching to mirror.
- **`session_meta`** opens every file with the session id, `cwd`,
  `cli_version`, and `originator` (`Codex Desktop` or `codex_cli_rs`).
- **`turn_context`** carries the model, the effort level and the workspace
  roots — when it is present at all, which is only 4 transcripts in 100. The
  model of the other 96 is in `session_meta.base_instructions.provenance`.
- **`token_count`** carries input, cached input, cache-write, output and
  reasoning tokens, plus **the plan-limit windows** — each with
  `window_minutes`, `used_percent` and `resets_at`. Which window sits in
  `primary` depends on the plan (§ Plan limits). Codex writes them into the
  transcript instead of only handing them to a status-line command.
- **Tool calls keep full fidelity** as `custom_tool_call` (a JS string) or
  `function_call` (a JSON string holding an object), with the name, arguments
  and working directory, and a `call_id` their output record repeats (§ Chat).
- **No shim, no config injection, no process signalled.** Claude Code needs the
  first two; Codex needs none of them.

## The three things that would have been wrong

Each was found by measuring, and each would have produced a plausible, wrong
number rather than an error.

- **Duplicated token samples.** `token_count` reports both a cumulative
  `total_token_usage` and a per-turn `last_token_usage`, and Codex frequently
  emits the same values twice in a row. Summing the per-turn field
  double-counts: on one real session it gave 261,111 tokens against a true
  137,739. Deltas are taken from the **cumulative** field instead, which is
  monotonic in all 100 transcripts and reproduces the final total **exactly** on
  all 92 that carry one.

- **Cached tokens are inside the input total.** Codex's `input_tokens` is the
  whole prompt and `cached_input_tokens` is a subset of it — verified on all 239
  token samples, where `input + output == total` every time. Caprock's
  `TokenDelta.In` means *fresh* input, billed separately from `CacheRead`, so
  the cached part is subtracted on import. Passing Codex's figure straight
  through would bill every cached token twice, once at full price.

- **Imported sessions are history, not live.** They are read out of files with
  no process to ask about, so `ownsItsProcess` excludes them exactly as it
  excludes OpenCode. Without that, importing a hundred transcripts would fill
  the Now screen with sessions permanently claiming to be running — which is
  what happened the first time this was tried for OpenCode.

## Cost, and what is deliberately missing

Codex Desktop can also emit a separate `codex-auto-review` transcript for its
automatic approval reviewer. Caprock treats this exact id as internal product
machinery, not as a user session: it is excluded from user turns, costs,
projects, and unpriced warnings. Its measured tokens remain in the separate
`background` summary/history field so the data is visible without inventing a
public price. This is an exact allow-list, not a prefix rule; a new similar id
stays visible as an ordinary unknown model until investigated. See migration
0024 and [03-contracts.md](03-contracts.md#phase-2-ddl-additions).

Codex reports tokens but **never a cost**. That makes it unlike OpenCode, whose
own figure Caprock carries through unchanged, and like Gemini, which our own
table prices. So `pricing/pricing.json` grew OpenAI rows, read from
`developers.openai.com` on 2026-09-06 and dated there: `gpt-5-codex`,
`gpt-5.3-codex`, and the `gpt-5.6` family (sol, terra, luna); `gpt-6-sol` and
`gpt-6-luna` were added from the same source on 2026-09-29, `gpt-6-astra` and
`gpt-6.1-sol` on 2026-09-30, and the Codex turns
stored unpriced before then are priced on start (`Recorder.PriceUnpriced`, see
[03-contracts.md § Pricing table](03-contracts.md#pricing-table)). OpenAI did
not bill for cache writes on the gpt-5 models, so those columns are `0` —
meaning "not charged", the same as the Gemini rows. The gpt-6 family bills them
at 1.25x input and its rows say so, but Codex reports no cache-write tokens for
it, so the rate has nothing to apply to yet.

**The model is recorded twice, and reading only the obvious one left 83% of
tokens unpriced.** `turn_context` is the natural place to look and appears in
**4 of 100** transcripts. The other 96 record it as
`session_meta.base_instructions.provenance` — `{"type":"model","model":"…"}`,
an explicit model id rather than an inference. Together they name a model for
**every session that carries any tokens**; the two that still name none have no
tokens either, so nothing is lost.

The two sources agreed in every transcript carrying both, and no model changed
mid-session in any of the 100. `turn_context` still wins where both exist:
provenance describes the prompt the session was built with, `turn_context` the
turn actually running, and if they ever diverge the per-turn value is the
truthful one.

A turn that names no model anywhere is still stored with its true tokens and
**no cost** rather than a guessed one, per [rule 6](../CLAUDE.md), and `caprock
status` reports the count so a partial total reads as partial. That path is now
rare rather than the common case.

Guessing the model from `originator` or `cli_version` was considered and
rejected before the second source was found: it would have put a confident
dollar figure on the screen this product's credibility rests on, derived from
nothing. Finding a recorded id was the difference between a guess and a fact.

## A total with no breakdown

Roughly **half** of the token samples measured (114 of 233) fill in
`total_tokens` and leave every component — input, cached, output — at zero. One
of them is 4.4M tokens. Reading only the components stored those turns as
having used nothing, which is how $23 of real usage on the owner's machine
showed as $0.53.

The total is carried as **input**. That is the honest reading of a number which
says only "this much was used": input is the unqualified rate, so nothing is
credited a cache discount it was not reported to have earned. Splitting the
total across kinds by any ratio would be inventing the split ([rule
6](../CLAUDE.md)); leaving the turn empty would be discarding real usage.

The consequence, and it is worth stating plainly: **for those turns the cost is
an upper bound.** Any part of that total which was really a cached read was
billed at a tenth of what is shown. The event's payload carries
`tokens_total_only: true` so the figure can be traced back rather than having to
be re-derived.

## The reviewer Codex runs in the background

Codex describes one of its own models, `codex-auto-review`, as its "Automatic
approval review model" in the local catalog — and writes a perfectly ordinary
rollout transcript for it. On the owner's machine that held **190,419 tokens
over 8 turns**. Treated as user work, those tokens rendered as ordinary turns
and raised an unpriced-cost warning nobody could resolve, because OpenAI
publishes **no price and no base-model mapping** for the id — it is product
machinery, not a model a user chose.

The trap, and the reason this took a second pass: **the review reuses the
session id of the session it reviews.** A transcript of `codex-auto-review`
turns arrived inside the same Caprock session as the `gpt-5.6-sol` turns being
reviewed — 8.1 million tokens of real work sat beside the review turns. So the
classification is **per-event, not per-session**: a session-level flag would
have hidden the real work to get rid of the review.

It is now classified as **internal** rather than unpriced. The raw events stay
in the store for auditability, but a per-event flag keeps the reviewer out of
every user-work total — turns, tokens, cost, the model mix, the projects
roll-up, the daily cap and the weekly report — and a quiet "background usage"
line reports its measured token volume beside those totals, with no dollar value
rather than a guessed one ([rule 6](../CLAUDE.md)). Classification lives in
`internal/modelclass` as an explicit allow-list, not a `codex-auto-*` prefix
match: a future id must be investigated before Caprock hides it, which is the
difference between a deliberate exclusion and a silent one. See
[03-contracts.md](03-contracts.md) for the `background` field and migration 0024.

## What is not covered by the measurement

The 100 transcripts this was built against are **96% Codex Desktop / VS Code**
and 4 sessions from the plain CLI, across CLI versions 0.39.0–0.150.0. That is
one machine's habits, not the population — and the two bugs shipped in v0.54.0
and v0.54.1 both came from generalising a field's presence from the newest file
rather than counting it across all of them.

The CLI sessions are reassuring in the way that matters: they carry the model
in `turn_context` and no provenance, which is the *opposite* of Desktop. Reading
both sources is what makes the importer work across them, so the design is
validated by the split rather than by luck.

What protects the rest is refusing to lose data to a shape we did not expect.
`session_meta` is decoded field by field, not as one struct: a single
unexpected type used to fail the whole unmarshal, and losing that record loses
the session id, which discards **the entire transcript**. Every field is taken
if it is the shape we expect and skipped if it is not, and `robustness_test.go`
pins that for unknown record kinds, non-object payloads, a `base_instructions`
that is a string, a `turn_context` whose model is not one, missing timestamps
and missing `token_count.info`. The worst case for an unforeseen shape is a
missing field, never a missing session.

## Names

Codex keeps an index of its threads beside the transcripts,
`$CODEX_HOME/state_<N>.sqlite`, and it is read for one thing: telling sessions
apart on the screen (FB-035). `threads.name` is the short title Codex
generates ("Check the dates without two articles", in the user's language) and becomes the session's title;
`threads.first_user_message` is kept for sessions it has not named yet. The
transcript cannot supply either — of 60 rollouts checked, every user message
it opens with is injected AGENTS.md, environment or auto-review text. The index
is opened read-only, only the newest schema generation is read, and it is
re-read only when it (or its WAL) changes. On the owner's machine this named
88 of 110 ended Codex sessions and quoted a first message for 11 more.

## Where the transcripts are

Codex keeps everything under `CODEX_HOME`, which its configuration docs
(learn.chatgpt.com, read 2026-10-01) give as defaulting to `~/.codex`. Caprock
read only `~/.codex/sessions` until 2026-10-01, which missed two things that
ccusage already read:

- **A `CODEX_HOME` set elsewhere.** Every one of that user's sessions was
  invisible. `codex.Home()` now honours it; `CAPROCK_CODEX_DIR` still overrides
  both roots with one directory, for tests.
- **`archived_sessions/`.** Archiving a thread renames its rollout (and any
  spawned descendants') from `sessions/YYYY/MM/DD/` into a flat
  `archived_sessions/`, the file unchanged — read from the codex-rs source,
  `thread-store/src/local/archive_thread.rs`, on 2026-10-01. A session archived
  before Caprock was installed was never counted.
- **Compressed rollouts, `<name>.jsonl.zst`.** Codex runs a background job
  that compresses every local rollout untouched for seven days and deletes the
  plain file (`codex-rs/rollout/src/compression.rs`, read 2026-10-03); resuming
  one decompresses it back. Listing only `.jsonl` kept a week of history: a
  fresh install or a rebuilt database lost everything older, with no symptom.
  `List` takes both suffixes and `ParseFile` decodes zstd. The compressed file
  has a different name and size, so it is re-read once; its events are all
  duplicates by key and store nothing new.

**A moved file is not counted twice.** Event keys are `codex:{turn,tool}:<line>`
(`codex:sub:<thread>:{turn,tool}:<line>` for a subagent, § Imported threads and
subagents) scoped to the session id inside the file; the path is in none of
them, and a rename changes none of them, so a re-read stores nothing new. It is not even re-read: a
file that vanishes from the listing is dropped from the read set, and one that
appears elsewhere with the same name, modification time and size — which a
rename preserves — inherits its "already read" state (`forgetMoved`). On the
owner's machine (2026-10-01, CLI 0.156.1) there is no `archived_sessions/`
and no `CODEX_HOME`: 176 rollouts, all under `~/.codex/sessions`, no two
sharing a session id.

**Compressed rollouts are not read.** Current codex-rs
(`rollout/src/compression.rs`) can rewrite a rollout older than seven days as
`rollout-….jsonl.zst`, behind a `compression_enabled` setting; the 0.156.1
binary on the owner's machine contains that code, but **no `.zst` rollout
exists on it**, so none was built for. A session compressed before Caprock
first read it would be missed; one already read keeps its events. The DeepSeek
importer already reads zstd JSONL, so this is a small change once a real
compressed rollout exists to test against.

## Plan limits

Measured on the owner's machine on 2026-10-01: **72 of 176** transcripts carry
`rate_limits` in their `token_count` records, in four shapes:

- **`plus`** — `primary` 300 minutes, `secondary` 10080 (1,477 samples).
- **`prolite`** — `primary` **10080**, `secondary` null: no five-hour window at
  all (15,031 samples). Reading `primary` as "the 5-hour window" would have put
  the weekly figure under the wrong label.
- **CLI 0.4x** — no `limit_id`, windows of 299 and 10079 minutes, `resets_at`
  null (30 samples).
- **`limit_id: "premium"`** — both windows null (6 samples), plus 186 samples
  where `rate_limits` itself is null.

So a window is named by its **length**, never its slot — 290–310 minutes is
`five_hour`, 10000–10160 is `seven_day`, anything else is skipped rather than
labelled — and only `limit_id` `codex` (or absent) is read. The latest sample
in each transcript is kept; across transcripts the one Codex wrote last wins,
and it **replaces the whole set**, because the account above moved from `plus`
to `prolite` and an upsert would have kept showing the old plan's five-hour
figure. Stored in `rate_limit_latest` as `codex_five_hour` / `codex_seven_day`
with no history, and served as `codex_rate_limits` with the time Codex wrote
it ([03-contracts.md](03-contracts.md#rate-limit-snapshots-ddl-migration-0005)).
The Cost screen shows them under a Codex heading with "as of"; nothing is
forecast from them ([04-ui.md](04-ui.md#cost--burn)). On the first pass after
an upgrade the newest transcripts are opened once to fill the panel, because
transcripts read by an earlier version are not parsed again until they change.

## Prose

What Codex wrote back is stored as `payload.text` on `turn.assistant`, the
same key Claude Code's replies carry, so the Memory screen, its search, a
session's Answers tab and the handoff read it with no Codex-specific code. The
text is the `output_text` blocks of `response_item` messages with role
`assistant`; reasoning is a separate item and is never read. Each message is
also written twice more (`event_msg` `item_completed`/`AgentMessage`, and on
some versions `agent_message`); only the `response_item` is read, or every
reply would be stored three times.

- **Which turn a message belongs to.** Codex writes a message *before* the
  `token_count` of the request that produced it, so the text goes onto the next
  turn. A message written after a request's last `token_count` (a closing line
  after the last tool call) joins that request's last turn when
  `task_complete` or `turn_aborted` arrives. Measured on the owner's machine on
  2026-10-01, on the 60 rollouts a person started: 1,786 turns carry text, and
  none of their prose is left without a turn.
- **Same cap as Claude Code.** Joined with `\n` and clipped to
  `ingest.MaxAssistantText` runes on a rune boundary
  (`ingest.ClipAssistantText`).
- **No filter on short messages.** Claude Code's ingest keeps every reply,
  and the screens decide what to show (`fragment`, under 240 runes). Codex is
  held to the same rule: 471 of its 1,785 stored replies are under 240 runes,
  against 22,251 of 31,513 for Claude Code on the same database.
- **Imported threads keep no prose.** Codex Desktop can import Claude Code
  sessions. The result is a rollout whose turn ids are all
  `external-import-turn-N`, ending on an `<EXTERNAL SESSION IMPORTED>` message,
  that replays the other agent's prose and its tool calls as assistant
  messages (`[external_agent_tool_call: Bash] …`). On the owner's machine those
  100 threads hold 134,377 of the 136,497 assistant messages. Caprock already
  has that prose from the original transcript, so storing it again would show
  every answer twice and bury Codex's own under a hundred-fold flood of
  replayed tool calls. Nothing else of such a thread is stored either (§
  Imported threads and subagents).
- **Subagent threads keep no prose.** A thread Codex spawned
  (`session_meta.source.subagent`, including its guardian reviewer) is left out
  for the reason Claude Code's sidechains are: it is a worker's chatter, not the
  answer. Its turns and their cost are kept (§ Imported threads and subagents).
- **Rows are matched on key and timestamp.** Event keys are idempotent, so a
  re-read never rewrites a stored row; `syncText` is the one place a Codex
  turn's payload changes afterwards, and it rewrites only `payload.text`, only
  on the row whose key *and* timestamp match the record.
- **Turns imported earlier get their text once.** The ordinary pass skips
  files it has already read (§ Restarts), so a one-time backfill parses every
  rollout the first pass did not, runs `syncText` on it and records
  `meta.codex_text_backfilled`. It runs in the importer's goroutine after its
  first pass, never at daemon start, and an interrupted run starts over on the
  next start. On a copy of the owner's database (2026-10-01, 176 rollouts,
  1.2GB) it took 17.5s, almost all of it parsing, filled 1,785 turns and grew
  the file by 2.6MB (858.0MB → 860.8MB).

## Chat

A Codex session's Chat shows what the person typed, what Codex wrote (§
Prose), and each tool call on one line that reads as done once its output
arrived — the same rows, in the same shapes, as a Claude Code session's.
Until 2026-10-09 it showed only the replies, every call as its raw input and
as "running" forever: no prompt and no output was stored at all.

- **Prompts are `turn.user`**, key `codex:user:<line>`, payload
  `{prompt, cwd}`. The prompt is the `event_msg` `item_completed` item of
  type `UserMessage` — its `text` parts, joined and clipped like prose. The
  `response_item` message with role `user` is not read: Codex writes its own
  environment block, AGENTS.md and plugin hints the same way, and only
  metadata newer versions add tells them apart. A file without the item reads
  the older `user_message` event instead, never both. Measured on the owner's
  machine (2026-10-09): every rollout a person started that holds a prompt
  carries the item; `user_message` appears only in imported threads. Imported
  and subagent threads store no prompt — a subagent's file replays its
  parent's prompts.
- **Tool results are `tool.post`**, key `codex:result:<line>`, payload
  `{tool_name, tool_use_id, tool_response, is_error, exit_code?, cwd}`, read
  from `custom_tool_call_output` and `function_call_output`. `tool_use_id` is
  Codex's `call_id`, which every `tool.pre` now carries too, so the chat pairs
  them as it pairs Claude Code's. The output is a string, a list of
  `input_text` blocks, or (`shell` only) a string holding
  `{"output", "metadata": {"exit_code"}}`; `is_error` is set for an `exec`
  script that reports "Script failed", a non-zero exit code, or a call Codex
  refused ("failed …"). Only `shell` records an exit code: an `exec` script
  reports whether the script completed, not the exit code of what it ran. The
  output is clipped to 8,000 runes (`MaxToolOutput`): on the owner's 16,152
  outputs that is 47MB of JSON against 107MB at Claude Code's 32KiB.
- **A call's input is an object.** Every `function_call` carries its
  arguments as a JSON string holding an object; it used to be stored as
  `{"command": "<that JSON>"}`, which is what the chat showed. It is now the
  object itself, and `shell`'s argv `command` becomes the line it runs (the
  script of `<shell> -lc <script>`, else the words joined), the argv kept as
  `argv`. An `exec` call stays the JavaScript it sends under `command`; the
  chat reads the shell command out of its `tools.exec_command({cmd: …})` call,
  or names the tool it called (`apply_patch` with the file it patches) —
  the way the tool drill-down already did. Every other place that describes
  a call reads it the same way (2026-10-09): the Timeline, the activity feed
  and the cockpit's tool list through the chat's `toolCommand`, and the Now
  phrase ("running `git status`", "editing chat.ts", "using web__run"), the
  subagent list, notifications and loop alerts through `internal/toolcmd`,
  which ports the chat's reading and is tested against the same scripts.
  Memory searches what the agent wrote, never its calls.
- **A call its request ended without answering is interrupted, not
  running.** Codex brackets a request with `task_started` and
  `task_complete` or `turn_aborted`; a call still without an output when the
  request ends, or when the next one starts, gets a `tool.post` of its own:
  key `codex:interrupted:<call line>`, at the closing record's time,
  `tool_response` empty, `is_error` false, `interrupted: true` — written by
  the agent's own record of the turn ending, not guessed from a clock. An
  output that arrives later replaces it on a re-read, and the chat prefers a
  real output to the mark whichever it holds first. On the owner's machine
  (2026-10-09, 207 rollouts) all 16,152 calls have their output and none of
  the 11 `turn_aborted` records cut a call off mid-flight, so nothing is
  backfilled; the rule is for the call that is cut off before its output is
  written. The chat adds what no record says: a Codex call with no result is
  interrupted once a prompt the person typed, a Stop or the session's end
  comes after it — which also ends the 60 calls a duplicated 2025 import
  left unpaired. For every other agent only the Stop or the session's end
  does: a prompt typed into Claude Code while a long tool runs is queued and
  the tool runs on, so a later prompt says nothing about it. Only a call
  still inside its turn says "running".
- **History gets both once.** A one-time pass after the importer's first
  (`meta.codex_chat_backfilled`) parses every rollout that pass did not read,
  records its prompts and results under their keys, and gives each stored
  call its `tool_use_id` and normalised `tool_input` (`syncTools`, matched on
  key and timestamp, rewriting only those two keys). The chat also reads the
  old input shapes itself, so a row whose rollout is gone still shows its
  command. On a copy of the owner's database (2026-10-09, 87 rollouts to
  read) it took 54s in the importer's goroutine, stored 517 prompts and
  16,152 results, paired 16,152 calls, and grew the file by 65MB (1,571MB →
  1,635MB). 60 calls stay unpaired: two 2025 sessions an earlier importer
  stored twice under keys one line apart, so one copy of each call matches no
  record.

## Imported threads and subagents

Two kinds of rollout are not a session a person ran in Codex, and both were
stored wrongly until 2026-10-01. Measured that day on a copy of the owner's
database against the 176 rollouts on his machine.

- **A thread imported from another agent is not Codex's work.** Codex Desktop
  can import a Claude Code session (§ Prose for how one is recognised; the
  turn-id prefix is on every turn of all 100 imports listed in
  `~/.codex/external_agent_session_imports.json`, and on no other rollout).
  The replay carries `token_count` records too — totals only, no breakdown —
  so the importer stored 138 turns in 95 threads, 21.5M tokens, and priced
  them as Codex at **$26.70**: work Claude Code did, already counted from
  Claude Code's own transcript, counted a second time at another vendor's
  price. Such a thread is now not recorded at all — no events and no session
  — the same rule its prose already followed. Two caveats, measured. All 100
  replays were checked for a turn a person ran in Codex after the import, and
  none has one: the two non-import turn ids (`rollout-624`, `rollout-745`) sit
  inside the replay, milliseconds apart. If one ever appears, it is skipped
  with the thread. And 8 of the 100 source sessions are not in Caprock's
  store (their transcripts are gone and predate its first event), so their
  2.7M tokens are now counted nowhere; they were counted under the wrong
  agent at the wrong price before, which is not a figure worth keeping.
- **A subagent's turns collided with its parent's.** A file Codex spawned
  (`session_meta.source.subagent`: a `thread_spawn` worker, or the
  `guardian` reviewer) carries the parent's id as `session_id` and its own as
  `id`, and its records were keyed `codex:{turn,tool}:<line>` like the
  parent's. Line numbers are small integers in both files, so each subagent
  record collided with the parent's on the same line, and the file read
  second lost it as a duplicate — silently, as in migration 0022. Of 1,864
  subagent turns in 52 files, **885 were missing**, and 6 of the parents'
  own turns; one parent session held 21,011 events. Subagent records are
  now keyed `codex:sub:<thread>:{turn,tool}:<line>`. Only subagent files
  changed key: re-keying every file would have stored each of the 30k events
  already imported a second time.
- **A subagent's work stays in its parent's session**, as a Claude Code
  subagent's does: `agent_id` is the subagent's thread id and the payload
  carries `sidechain: true`, so it counts toward the session's turns and cost
  and stays out of Memory. The forked file's second `session_meta` is a copy
  of the parent's and is no longer read: its cwd and model are the parent's.
  The copied history before the subagent's own work holds no `token_count`
  and no tool call in any of the 36 forked files, so nothing is counted twice.
- **Rows already stored are repaired once from the rollouts**
  (`meta.codex_split_repaired`), because the rows cannot say which file wrote
  them — a migration has nothing to go on. In the importer's goroutine after
  its first pass, every rollout is parsed again: an imported thread's events
  are deleted and, when nothing is left, its session; a subagent's rows under
  the old line keys are deleted where the key **and** timestamp match the
  subagent's record and not the parent's; then each subagent and each of
  their parents is recorded again, which stores the subagent's turns under
  their own keys and the parent's turns their rows had blocked. Every
  deletion takes the same tokens, cost, turn and tool-call counts out of
  `session_stats` and `daily_stats` (and the day's session count, for a
  deleted session) in its transaction.
- **Measured result.** In a test daemon on the copy the repair took 21.3s.
  Codex user turns went from 15,608 to 16,348 and Codex cost from $630.37 to
  $644.83: $26.70 of imported replay out, $41.17 of subagent and parent work
  back in. All 1,864 subagent turns and 1,710 subagent tool calls are stored,
  every parent turn is, and `session_stats` and `daily_stats` add up to the
  events for every Codex session.

## Restarts

The files already read are remembered in the store (`meta.codex_seen`: path,
modification time, size, session id), so a restart reads only transcripts that
changed. It used to re-read all of them: on the owner's machine 161 files and
1.1GB, 30k events each written again only to be found a duplicate, at the
moment the daemon was busiest — while it ran, the dashboard's reads queued and
hook writes waited on the lock. A remembered file is trusted only while the
store still holds that session's Codex events, so a migration that deletes them
to import again (0022 and 0023 did) finds the file unread. An imported
thread stores no events by design, so it is remembered with a flag (`x`) and
trusted without that check; otherwise every start would parse all of them
again.

## Starting a Codex session

Since 2026-10-04 the New session dialog starts Codex next to Claude Code: the
TUI in a PTY, the same terminal tab, directory picker and pause/kill controls
([ADR-031](08-decisions.md)). The argv was built from the real binary's help,
not from memory — `codex --help` and `codex resume --help`, **codex-cli
0.160.0**, read on 2026-10-04 — and every flag below was then exercised by
starting the TUI with it:

- **`--no-daemon`** — "Run without the shared background server". Without it
  the TUI may hand the work to a shared app-server Caprock did not start, and
  pause or kill would act on an empty client.
- **`-c projects={"<cwd>"={trust_level="trusted"}}`** — answers the "Trust this
  folder?" prompt for this run only. Measured: the dotted form
  `-c 'projects."<cwd>".trust_level="trusted"'` does **not** suppress the
  prompt; the inline table does, and `~/.codex/config.toml` is unchanged
  afterwards. The path is written as a TOML string (quotes and backslashes
  escaped), and both the given and the symlink-resolved path are listed,
  because Codex looks the folder up by the path it resolved (`/tmp` is
  `/private/tmp` on macOS). Same consent as Gemini's `--skip-trust`: the user
  picked the folder.
- **`-m <model>`** — the dialog offers the models Codex itself lists, read from
  `$CODEX_HOME/models_cache.json` (`visibility: "list"`, in `priority` order;
  `codex-auto-review` and other hidden entries are not offered), with the
  top-level `model` of `config.toml` as the default. "Default" sends no `-m`.
- **Permissions**, mapped from Claude's words onto Codex's two axes:
  `acceptEdits` → `--sandbox workspace-write --ask-for-approval on-request`;
  `plan` → `--sandbox read-only --ask-for-approval on-request`;
  `bypassPermissions` → `--dangerously-bypass-approvals-and-sandbox`. Anything
  else sends nothing and `config.toml` decides. 0.160.0's `-a` lists only
  `on-request` and `never`.
- **Resume** is `codex resume <thread id>` with the same flags after it. Codex
  has no flag that names a *new* thread, so there is nothing like
  `--session-id` to pass on a fresh start.
- **A first message** is the positional `[PROMPT]` (`Usage: codex [OPTIONS]
  [PROMPT]`), last on the line; a relay's brief goes there
  ([ADR-032](08-decisions.md)). Measured on 0.160.0: a multi-line prompt
  arrives intact and is sent as the TUI opens.
- **Fork is refused.** `codex fork` copies the thread's history into a new
  rollout, and Caprock would count its tokens again. A Codex session that is
  still running is offered nothing; it can be continued once it has ended.
- **Newlines.** ESC CR (what the terminal sends for Shift/Option+Enter and
  Ctrl+J, see `Terminal.tsx`) inserts a line in Codex's composer with text
  already in it, measured on 0.160.0 — the same bytes as Claude Code, so the
  terminal needs no per-agent key map.

### Linking the rollout to the session (heuristic)

Caprock records the session under an id of its own, and Codex names its thread
itself, so the two have to be joined (`internal/sessionlink`). **This is a
match, not a fact**, and it is stated as one:

- The importer takes a rollout for a waiting spawn when its `session_meta` says
  it was written by the TUI (`originator` `codex-tui`, or the older
  `codex_cli_rs`; not the desktop app, not a subagent, not an imported
  thread), in the same folder, by a thread that **started** between 5 seconds
  before and 2 minutes after the spawn. Two spawns in one folder each take the
  thread that started closest after them.
- The window can be that tight because Codex stamps a thread with the moment
  the TUI started, not the moment its file is first written. Measured on the
  14 CLI rollouts on the owner's machine (2026-10-04): `session_meta.timestamp`
  precedes the first record by up to 4m40s — the time before the user typed.
  The rollout itself appears only when the first message is sent; a session
  nobody typed into has nothing to link and nothing to resume.
- A thread the store already holds under its own id is never taken.
- Once linked, the link is stored (`sessions.native_id`, migration 0032) and
  the importer files the thread's events — and its subagents', which carry the
  parent's id — under Caprock's session, so cost, turns and Answers appear on
  the page with the terminal. Rollouts are read in name (start-time) order
  while a link is pending, so a parent is linked before its subagents' events
  need to know where to go. `codex resume` is given the thread id, not
  Caprock's.
- What would mislink: a second Codex TUI the user starts **by hand**, in the
  same folder, within the window, while Caprock's spawn has not been typed
  into. What would miss: a Codex release that renames its `originator` — the
  thread is then shown as its own session, as before this feature, not lost.
- Verified end to end on 2026-10-04 on an isolated daemon with Codex pointed
  at a closed local port (no model call, no cost): the spawn's rollout was
  linked 0.87s after the spawn by thread start, stored under Caprock's id with
  no second row, and "continue here" resumed it with its history.

## Not built

- **The `notify` hook.** Codex supports one, but it is a **single slot** in
  `~/.codex/config.toml` — on the owner's machine it was already occupied by
  Codex Computer Use. Taking it would break whatever is there, so Codex is read
  the way OpenCode is: files only, nothing written into another tool's config.
- **Codex limits on Now.** The compact Plan limits cell on Now stays Claude
  Code's; Codex's are on the Cost screen only.
- **`.jsonl.zst` rollouts** (§ Where the transcripts are).

## Where it lives

- `internal/codex/codex.go` — the transcript parser, `List`, `ListAll`,
  `Home`, `Dirs`.
- `internal/codex/ingest.go` — the poller that writes into the store.
- `internal/codex/repair.go` — the one-time repair of imported threads and
  subagent rows stored by earlier versions (§ Imported threads and subagents).
- `internal/codex/limits.go` — plan-limit windows into `rate_limit_latest`
  (§ Plan limits).
- `internal/codex/models.go` — the model list Codex itself offers
  (`models_cache.json`) and the configured default, for the dialog.
- `internal/agents/argv.go` — the Codex argv (`codexLaunch`); the link is
  `internal/sessionlink` (§ Linking the rollout to the session).
- `internal/codex/names.go` — thread names and first messages from
  `$CODEX_HOME/state_<N>.sqlite` (§ Names).
- `internal/codex/live_check_test.go` — a smoke check against whatever Codex is
  installed on the machine, skipped where there is none. The fixture was written
  from what real transcripts contain, and this is what keeps that true.
- `testdata/codex/rollout-basic.jsonl` — a fixture reproducing every measured
  shape, including the duplicated samples and a truncated final line.
- `testdata/codex/rollout-prose.jsonl` — assistant messages with their
  `item_completed` copies, a closing message after the last `token_count`, and
  a turn that only called tools (§ Prose).
- `testdata/codex/rollout-chat.jsonl` — a Codex 0.161 rollout's shapes:
  the environment block and the prompt as user messages, `UserMessage` items,
  `exec` scripts, a `js` and a `shell` function call with their outputs, a
  failed script, a non-zero exit code, and a call cut off by `turn_aborted`
  (§ Chat).
- `testdata/codex/rollout-subagent-parent.jsonl`, `rollout-subagent-child.jsonl`
  — a parent and a forked subagent whose records share line numbers, the
  child carrying a copy of the parent's `session_meta`.
- `testdata/codex/rollout-imported.jsonl` — a thread imported from Claude Code:
  `external-import-turn-N` ids, a replayed tool call, total-only token counts.
