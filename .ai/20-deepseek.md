# DeepSeek Harness support

**Status: the observation half is built.** Sessions, turns, tool calls and cost
are imported from DeepSeek Harness's own session transcripts, tagged with their
agent, and shown on the same screens as Claude Code, OpenCode, Gemini and Codex.
Session control is not built and is scoped below. Everything here was measured
against the real transcripts on the owner's machine, not inferred from
documentation; where a number appears it came from that measurement.

## Why

The owner runs DeepSeek Harness on the same machine as Claude Code, OpenCode and
Codex, and Caprock watched none of it — the spend sat outside the one screen
that is supposed to add every agent up. The strategic point is the same one
that motivated OpenCode and Codex: **one screen over every agent**.

## What DeepSeek Harness gives us

DeepSeek Harness (DSH) is the easiest of the five to read, and the import is a
translation rather than a pipeline.

- **One append-only JSONL transcript per session**, compressed with Zstandard,
  at `<dsh-home>/sessions/<encoded-cwd>/<session-id>/session.v3.jsonl.zstd`.
  The data root follows DSH's own resolution — `$DSH_HOME` wins over `~/.dsh` —
  and the same path on every platform, with no XDG or `%APPDATA%` branching.
- **A `session` header** opens every file with the session id, `cwd`, and
  `createdAt`.
- **`assistant/message`** carries the per-turn model (`source.model`), the
  visible prose, and `usage` — fresh input, cache read, output and reasoning
  tokens. The same record also carries the tool calls it chose, but those are
  recorded again as their own `tool/call` records, which is what the importer
  reads.
- **`tool/call`** and **`user/message`** keep tool invocations and prompts with
  their arguments and text.
- **No shim, no config injection, no process signalled.** Exactly like Codex:
  nothing is written into another tool's config.

## The token split, and why it needed no correction

DSH reports fresh input and cache read **separately**: `usage.inputTokens` is
the uncached part and `usage.cacheReadTokens` sits beside it, verified on real
samples where `inputTokens + cacheReadTokens + outputTokens == totalTokens`
every time. That is the opposite of Codex, whose input total embeds the cached
part and therefore had to have it subtracted on import. Here the delta is taken
straight through, so nothing is billed twice and nothing is credited a discount
it did not earn.

**Cache writes stay zero.** DSH reports a cache-read count and no cache-write
counterpart, the same as Gemini. The pricing table's `cache_write_*` columns are
not applied to a number DSH never measured; a column meaning "we do not know"
is better empty ([rule 6](../CLAUDE.md)).

## Cost

Like Codex and Gemini, DSH reports tokens and never a cost, so Caprock's own
table does the arithmetic. The model it names — `deepseek-v4-pro` — was already
in `pricing/pricing.json` (it arrived with the OpenCode third-party rows), so
no pricing change was needed. A turn that names a model with no table row is
still stored with its real tokens and no cost rather than a guessed one.

## What is not built

- **Session control.** Spawning, steering and stopping a DSH session. The
  obstacle is the same as OpenCode's: `internal/agents` assumes the `claude`
  binary and its flags throughout.
- **Live tailing.** The transcripts are zstd frames, not a text file a tailer
  can follow at an offset, so the importer re-reads a changed file the way
  Codex's does and treats the sessions as history — `ownsItsProcess` excludes
  `deepseek` exactly as it excludes OpenCode and Codex, so an imported session
  never claims to be running.
- **Plan limits and subagent fidelity.** DSH records more than Caprock consumes
  (subagent catalog, plan mode, approval decisions). They are parsed out of the
  transcript's shape and ignored; the importer takes the records it understands
  and skips the rest, so a future field is a missing field, never a broken
  import.

## Where it lives

- `internal/deepseek/deepseek.go` — `Dir`, `List`, `ParseFile` (zstd decode +
  JSONL v3 parse).
- `internal/deepseek/ingest.go` — the poller that writes into the store.
- `internal/deepseek/live_check_test.go` — a smoke check against whatever DSH is
  installed on the machine, skipped where there is none; the fixture is written
  from what real transcripts contain, and this is what keeps that true.
