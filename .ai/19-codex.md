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
  roots — when it is present at all, which is the catch below.
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

**Most sessions cannot be priced, and say so.** Only 4 of 100 transcripts
carried a `turn_context`, which is the only record naming the model; the other
96 have real token counts and no model at all, and no indirect signal either
(no `model_context_window`, nothing). That is **83% of tokens**. Those turns are
stored with their true tokens and **no cost** rather than a guessed one, per
[rule 6](../CLAUDE.md) — a missing number beats an invented one. `caprock
status` reports the count so a reader knows the total is partial:

```
codex:   100 transcripts read, 218 events stored
         113 turns carried no model id, so they have tokens but no cost
```

Guessing the model from `originator` or `cli_version` was considered and
rejected: it would put a confident dollar figure on the screen this product's
credibility rests on, derived from nothing.

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
