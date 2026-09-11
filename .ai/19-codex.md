# Codex support

**Status: the observation half is built.** Sessions, turns, tool calls and cost
are imported from OpenAI Codex's own rollout transcripts, tagged with their
agent, and shown on the same screens as Claude Code and OpenCode. Session
control is not built and is scoped below. Everything here was measured against
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
  `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`. The same path
  on every platform — Codex uses the home directory directly, with no XDG or
  `%APPDATA%` branching to mirror.
- **`session_meta`** opens every file with the session id, `cwd`,
  `cli_version`, and `originator` (`Codex Desktop` or `codex_cli_rs`).
- **`turn_context`** carries the model, the effort level and the workspace
  roots — when it is present at all, which is only 4 transcripts in 100. The
  model of the other 96 is in `session_meta.base_instructions.provenance`.
- **`token_count`** carries input, cached input, cache-write, output and
  reasoning tokens, plus **the plan-limit windows**: `primary` (300 minutes)
  and `secondary` (10080 minutes), each with `used_percent` and `resets_at`.
  That is the same 5h/7d pair Claude Code exposes, except Codex writes it into
  the transcript instead of only handing it to a status-line command.
- **Tool calls keep full fidelity** as `custom_tool_call` (a JS string) or
  `function_call` (an object), with the name, arguments and working directory.
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

Codex reports tokens but **never a cost**. That makes it unlike OpenCode, whose
own figure Caprock carries through unchanged, and like Gemini, which our own
table prices. So `pricing/pricing.json` grew OpenAI rows, read from
`developers.openai.com` on 2026-09-06 and dated there: `gpt-5-codex`,
`gpt-5.3-codex`, and the `gpt-5.6` family (sol, terra, luna). OpenAI does not
bill for cache writes, so those columns are `0` — meaning "not charged", the
same as the Gemini rows.

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

## Not built

- **Session control.** Spawning, typing into, and killing a Codex session.
  `codex exec`, `codex resume` and `codex proto` (a stdin/stdout protocol) all
  exist, so it is feasible; `internal/agents` assumes the `claude` binary and
  its flags throughout, which is the same obstacle OpenCode control has.
- **The `notify` hook.** Codex supports one, but it is a **single slot** in
  `~/.codex/config.toml` — on the owner's machine it was already occupied by
  Codex Computer Use. Taking it would break whatever is there, so Codex is read
  the way OpenCode is: files only, nothing written into another tool's config.
- **Plan limits on the Cost screen.** The data is parsed (`codex.Limits`) but
  not yet stored: `rate_limit_latest` is keyed by window name and would need to
  distinguish two agents' windows before it can hold both.

## Where it lives

- `internal/codex/codex.go` — the transcript parser, `List`, `Dir`.
- `internal/codex/ingest.go` — the poller that writes into the store.
- `internal/codex/live_check_test.go` — a smoke check against whatever Codex is
  installed on the machine, skipped where there is none. The fixture was written
  from what real transcripts contain, and this is what keeps that true.
- `testdata/codex/rollout-basic.jsonl` — a fixture reproducing every measured
  shape, including the duplicated samples and a truncated final line.
