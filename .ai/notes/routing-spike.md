# Routing spike — Stage 0

**Date:** 2026-09-07 · **Dataset:** owner's archive, 439 transcripts, 64 projects
**Reproduce:** `go run ./cmd/routing-spike -bytes`
**Verdict:** estimator **FAIL** (6.2% against a 15% bar) · Bash track **PASS** (24.7% against a 20% bar)

This is Stage 0 of [the routing-savings spec](../../docs/spec-routing-savings.md):
the measurement that decides whether the rest of the feature is built. No feature
code was written.

## Methodology

Per spec §5.1, the unit is **tokens**, taken from each assistant turn's own
`usage` accounting, never bytes on disk. The cost attributed to a tool result is
the growth in context it caused — the delta of
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` between
the assistant turn before it and the one after.

Per spec §5.4, the quantity compared against the kill criteria is **token-turns**:

```
token_turns(event) = T * (1 + turns_left)
share             = sum(token_turns of routable events above threshold)
                    / sum(context token-turns of the same sessions)
```

`turns_left` is the number of assistant turns after the event, stopping at the
next compaction boundary (`system:compact_boundary` in the transcript — 13 found
across the archive). Content discarded by a compaction is not carried by the
turns after it.

The denominator is every context token-turn: system prompt, CLAUDE.md, user
messages and assistant replies included, not only tool results.

### Deviations from the spec, and why

- **Batched results share one delta.** Claude routinely returns several tool
  results in one turn. The usage delta covers all of them at once and cannot be
  split by measurement, so it is apportioned by result size. A test asserts the
  apportionment neither loses nor invents tokens; it changes no total, only the
  division within a turn.
- **Fallback estimation.** An event with no following assistant turn has no delta
  to read. It falls back to ~4 characters per token and is flagged
  `estimated=true`. **95% of Bash events and 98% of MCP-text events are measured,
  not estimated**; Read is 43% estimated, which matters little because Read is
  small either way.
- **MCP split into text and images**, per the instruction. Image results are
  excluded from routable volume for the same reason Read images are: a
  screenshot is opened in order to be looked at, and no worker summary
  substitutes for it.

### Correcting the first pass

The first run of this spike measured **bytes** and concluded routable volume was
0.24%. That was wrong, and the size of the error is worth recording because it
inverted the answer:

| class     | MB   | % of MB | tokens | % of tokens |
| --------- | ---- | ------- | ------ | ----------- |
| bash      | 19.8 | 11.9%   | 21.7M  | 50.3%       |
| other     | 10.3 | 6.2%    | 13.1M  | 30.4%       |
| mcp_image | 57.5 | 34.5%   | 1.5M   | 3.6%        |
| read_img  | 70.2 | 42.1%   | 1.9M   | 4.4%        |
| mcp_text  | 3.2  | 1.9%    | 2.0M   | 4.7%        |
| read      | 4.8  | 2.9%    | 2.5M   | 5.8%        |
| read_tgt  | 0.9  | 0.5%    | 375.2k | 0.9%        |

Images are **77% of bytes and 8% of tokens** — base64 is enormous on disk and
cheap in context. Bash is the reverse: 12% of bytes, 50% of tokens. Measuring
bytes made images look like the whole problem and hid Bash entirely. The first
pass also read one project directory instead of all 64, and 76 transcripts
instead of 439.

## Results

439 transcripts · 439 sessions · 35,972 tool results · **20.0B context token-turns**

### By class

| class     | events | tokens | token-turns | share of context | p50/p90/p99 tokens      | routable         |
| --------- | ------ | ------ | ----------- | ---------------- | ----------------------- | ---------------- |
| bash      | 21,707 | 21.7M  | 10.8B       | 53.81%           | 597 / 1,962 / 7,290     | yes              |
| other     | 10,362 | 13.1M  | 3.4B        | 17.04%           | 711 / 2,297 / 9,086     | no               |
| mcp_image | 745    | 1.5M   | 1.1B        | 5.29%            | 1,658 / 2,143 / 5,746   | no               |
| read_img  | 298    | 1.9M   | 917.3M      | 4.58%            | 2,079 / 4,903 / 125,187 | no               |
| mcp_text  | 1,971  | 2.0M   | 528.7M      | 2.64%            | 390 / 1,715 / 11,865    | yes              |
| read      | 656    | 2.5M   | 317.9M      | 1.59%            | 2,264 / 9,171 / 19,617  | yes              |
| read_tgt  | 233    | 375.2k | 86.5M       | 0.43%            | 775 / 3,231 / 17,574    | excluded by spec |

### Above threshold

| class    | ≥150 lines / 2k tok | ≥350 lines / 4k tok | share of context |
| -------- | ------------------- | ------------------- | ---------------- |
| bash     | 2,125               | 826                 | 6.22%            |
| mcp_text | 182                 | 113                 | 0.50%            |
| read     | 196                 | 57                  | 0.29%            |

**The spec's default Read threshold of 350 lines catches 57 of 656 whole-file
reads.** Read's p90 is 9,171 tokens but its share of context is 1.59%: reads are
occasionally large and always rare.

### How long sessions run

|                             | p50 | p90   | p99   | max    |
| --------------------------- | --- | ----- | ----- | ------ |
| assistant turns per session | 48  | 162   | 1,278 | 19,964 |
| `turns_left` per event      | 206 | 1,421 | 2,007 | 2,240  |

The re-reading effect is real and large: the median event is carried by 206
further turns. This is what makes token-turns the right unit and raw token
counts misleading.

### By project (top 12 by context)

| project   | sessions | context token-turns | routable |
| --------- | -------- | ------------------- | -------- |
| caprock   | 22       | 15.4B               | 5.34%    |
| subagents | 356      | 1.6B                | 18.07%   |
| cupel     | 2        | 898.6M              | 5.74%    |
| newhope3  | 5        | 706.9M              | 8.40%    |
| tree      | 1        | 561.7M              | 18.52%   |
| blockmaze | 8        | 335.3M              | 12.09%   |
| web       | 3        | 260.5M              | 1.46%    |
| fixel     | 1        | 130.8M              | 20.41%   |
| amarketer | 3        | 58.0M               | 0.18%    |
| trader    | 1        | 9.2M                | 18.17%   |

Several projects clear 15% on their own. They are small: the four above 18%
together are under 12% of the archive's context.

### One session is 58% of the denominator

| session               | context token-turns | share |
| --------------------- | ------------------- | ----- |
| caprock, 19,964 turns | 10.70B              | 58.1% |
| caprock, 5,545 turns  | 3.00B               | 16.3% |
| next four combined    | 2.50B               | 13.6% |

This concentration has to be stated, because a verdict drawn from an archive
that is mostly one session is a fact about that session. `-drop-largest`
re-runs without the biggest ones:

| dataset          | read  | bash  | mcp_text | estimator | bash track   |
| ---------------- | ----- | ----- | -------- | --------- | ------------ |
| all 439 sessions | 0.29% | 6.22% | 0.50%    | FAIL      | PASS (24.7%) |
| minus largest 1  | 0.63% | 6.88% | 0.90%    | FAIL      | PASS (31.3%) |
| minus largest 3  | 1.05% | 8.62% | 1.32%    | FAIL      | PASS (36.3%) |

**The verdict is stable in both directions.** Removing the outlier moves the
estimator from 6.2% to 8.6% — still short of 15% — and strengthens the Bash
track from 24.7% to 36.3%.

## Bash: two ways of counting, and why they disagree

The owner's impression is that Bash is ~60% of spend. That impression is
correct about calls and wrong about what routing can fix.

| measure                                 | value                              |
| --------------------------------------- | ---------------------------------- |
| Bash calls                              | 21,711 (**60% of all tool calls**) |
| mean context carried at each call       | 382,620 tokens                     |
| share by per-call attribution           | **41.4%**                          |
| share by size of what Bash returns      | **50.3%** of result tokens         |
| share of context above the 4k threshold | **6.22%**                          |

Read these as three different questions:

- **41.4%** is what per-call attribution says: every Bash call re-sends the whole
  382k-token context, and there are 21,711 of them. This is where "60% on Bash"
  comes from, and it is a real cost.
- **50.3%** is Bash's share of what tool results add to context.
- **6.22%** is the part routing could actually remove: results large enough that
  a summary is cheaper than the original.

The gap between the first and the third is the finding. **The expensive thing
about Bash is the number of calls, not the size of what they return** — the
median Bash result is 597 tokens, and 21,711 calls against a large context cost
far more than the results themselves. Routing summarises results; it does not
reduce the number of turns. It cannot touch the 41.4%.

That is a different product: fewer, larger tool calls, or a cheaper model for
the turns that only run a command. It is not this spec, and it should not be
sold as this spec.

## Kill criteria

### Estimator — FAIL

> If bulk I/O is under 15% of total context token-turns, stop.

| class        | share above threshold |
| ------------ | --------------------- |
| read         | 0.29%                 |
| bash         | 6.22%                 |
| mcp_text     | 0.50%                 |
| **combined** | **7.01%**             |

No single routable class reaches 15%, and neither does their sum. Holds without
the outlier session (8.6% combined), and the free-tier estimator would be
telling most users that routing saves them a few percent.

### Bash track — PASS

> If Bash results above threshold are under 20% of Bash tokens, drop the track.

**24.7%** of Bash tokens are in results above 4k tokens (31.3% excluding the
largest session, 36.3% excluding the largest three). The criterion passes
comfortably.

This is the one place where the mechanism and the data agree: 826 Bash results
carry 24.7% of all Bash tokens, and `PostToolUse` + `updatedToolOutput` can
replace exactly those with a summary while keeping the verbatim tail.

## What this means

The spec's own decision rule stops the estimator, and the spec's own Bash
criterion keeps the Bash track. Two things follow, and they are not the same
decision:

1. **The free-tier savings estimator, as specified, should not ship.** Its
   headline number on this archive would be ~7%, and most of that is a threshold
   away from being nothing. The Spotify result does not transfer: it was measured
   on a Java monorepo, and here the p90 whole-file read is 9k tokens and reads are
   1.6% of context.

2. **The Bash track is the part worth building**, which inverts the spec's
   ordering — it treats Bash as a conditional follow-on to a Read-first
   estimator. On this data Read is 1.59% of context and Bash is 53.81%.

Both conclusions rest on one archive. The same command runs on anyone else's:

```
go run ./cmd/routing-spike -dir /path/to/.claude/projects
```

Vova's archive is the check that matters most, because his projects are not
this one and an API-billed team is the audience the dollar figure is for.

## Open question this spike raises

If 41.4% of context is Bash calls re-sending an average of 382k tokens, the
lever is turn count, not result size. Worth measuring before deciding what to
build: how much of that 382k is stable across a session (system prompt,
CLAUDE.md, file contents already read) versus genuinely new. That is a
different feature and would need its own spike.
