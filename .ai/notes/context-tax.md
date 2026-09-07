# Context tax — Stage 0

**Date:** 2026-09-07 · **Dataset:** owner's archive, 53 sessions after exclusions, 64 projects
**Reproduce:**
```
go run ./cmd/routing-spike -tax -exclude-project "-Users-ds-dev-caprock,-Users-ds-dev-caprock-web"
go run ./cmd/routing-spike -tax -allow-edits -exclude-project "..."   # upper bound
```

## Verdict first

**The Stage 0 kill criterion FAILS as written: 6.2% against a 25% bar.**

> If Bash series of length >= 5 at context >= 200k account for under 25% of Bash
> token-turns on this archive, the isolation lever is too small; ship the meter
> only, drop the paid tier of this spec. — [spec §3](../../spec/spec-context-tax.md)

It fails on a knife edge, and the reader should know which edge:

| eligibility rule                               | coverage  | verdict |
| ---------------------------------------------- | --------- | ------- |
| as specified (no Edit/Write inside the series) | **6.2%**  | FAIL    |
| Edit/Write allowed (`-allow-edits`)            | **34.8%** | PASS    |
| dev session left in (not excluded)             | 36.0%     | PASS    |

One rule and one session move the answer across the bar in both directions.
That is the finding, not a footnote to it — see [What decides the verdict](#what-decides-the-verdict).

## Methodology

Per [spec §5.1](../../spec/spec-context-tax.md), `C_i` is the context the issuing
assistant turn carried — `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens` — taken from the transcript's own `usage`, never
estimated. `R_i` is the usage delta on the following turn, with a ~4-chars-per-token
fallback flagged `estimated=true` (5% of Bash events).

A **series** is a maximal run of consecutive tool calls with no user message
between them and no compaction boundary inside ([§5.3](../../spec/spec-context-tax.md)).
Both boundaries are detected from the transcript: a `user` message carrying no
`tool_result`, and `system` / `compact_boundary`.

Prices: Opus 5 at $5.00/1M input, cache write 1.25x, cache read 0.10x. A session
whose model is unrecognised is priced as Opus — the direction that makes the tax
look larger, so the kill decision is not an artefact of underpricing.

**The dev session is excluded by exact project-directory match**, per the spec's
instruction to exclude by name rather than by size. `-Users-ds-dev-caprock` (22
transcripts) and `-Users-ds-dev-caprock-web` (1). Matching it as a substring
instead also catches 21 orchestrator scratchpad runs
(`-private-tmp-…--Users-ds-dev-caprock-<uuid>-scratchpad-…`), which are Caprock
being *exercised* rather than written; those are kept. The verdict is 6.2% with
the exact rule and 6.3% with the substring rule, so this choice does not decide it.

### Measured, not assumed

Two spec defaults were replaced with measurements from the 364 real subagent
transcripts in the archive:

| quantity                             | spec default | measured                       | effect                                                            |
| ------------------------------------ | ------------ | ------------------------------ | ----------------------------------------------------------------- |
| `C_sub0` (subagent starting context) | 25,000       | **17,888** (median first-turn) | makes isolation look *better*                                     |
| subagent peak context                | —            | 62,568 (median)                | a subagent grows 3.5x during a run                                |
| subagent output                      | —            | 10,883 tokens (median)         | the `S` returned to the parent is larger than the spec's 1k guess |

`C_sub0` uses the **first** turn's context, not the peak: the growth after that is
the subagent's own accumulating results, which the counterfactual already adds
call by call. Using the peak would charge that growth twice.

## Results

53 sessions · 371 series · **$801.56 of context tax** (the `C_i * P_cr` term alone)

### Series by length

| n     | series | tax     | eligible |
| ----- | ------ | ------- | -------- |
| 1     | 86     | $7.72   | 0        |
| 2     | 32     | $5.57   | 0        |
| 3-4   | 52     | $23.00  | 0        |
| 5-7   | 47     | $40.59  | 17       |
| 8-15  | 61     | $129.61 | 25       |
| 16-30 | 58     | $245.81 | 9        |
| 31+   | 35     | $349.25 | 1        |

The money is in long series — 31+ calls hold 44% of the tax — and almost none of
them are eligible. That is the Edit/Write rule, not the length rule.

### Series by starting context

| C_start  | series | tax     | eligible |
| -------- | ------ | ------- | -------- |
| <50k     | 85     | $26.07  | 0        |
| 50-100k  | 50     | $22.88  | 0        |
| 100-200k | 54     | $114.48 | 0        |
| 200-300k | 52     | $82.99  | 12       |
| 300-500k | 47     | $153.43 | 12       |
| 500k+    | 83     | $401.70 | 28       |

Half the tax sits above 500k of starting context. The spec's 200k threshold is
not the binding constraint.

### Series by class

| class  | series | calls | tax     | eligible | saved (Haiku) |
| ------ | ------ | ----- | ------- | -------- | ------------- |
| run    | 225    | 3,017 | $555.42 | 46       | $286.08       |
| mixed  | 62     | 1,342 | $219.59 | 3        | $8.27         |
| test   | 5      | 74    | $11.71  | 0        | $0.00         |
| search | 71     | 204   | $11.30  | 3        | $14.14        |
| build  | 4      | 22    | $2.45   | 0        | $0.00         |
| vcs    | 4      | 10    | $1.09   | 0        | $0.00         |

**The spec's mental model is test/build loops; the data is `run`.** Test, build
and vcs together are $15 of $802. The expensive loops are ad-hoc commands —
which is also why the Edit/Write rule bites: they interleave with edits.

### Why series were refused

| reason                           | series | tax held    |
| -------------------------------- | ------ | ----------- |
| too short (n < 5)                | 170    | $36.29      |
| context below threshold (< 200k) | 82     | $160.22     |
| contains Edit/Write              | **67** | **$436.80** |

The Edit/Write rule alone refuses **55% of all context tax**. This is the single
most consequential line in the report.

### Counterfactuals

|                                             | strict rule | edits allowed |
| ------------------------------------------- | ----------- | ------------- |
| `saved_isolation` (Haiku subagent)          | $308.49     | $998.71       |
| `saved_isolation` (same model)              | $295.82     | $945.69       |
| `saved_compaction` (best point per session) | $578.46     | $578.46       |

Three things follow:

1. **The model choice barely matters.** Haiku saves 4% more than isolating with
   the same model ($308 vs $296). This answers [spec open question 3](../../spec/spec-context-tax.md):
   isolation alone captures ~96% of the saving; Haiku is a secondary knob, not
   the mechanism. The lever is not sending the 380k context, not paying less per
   token.
2. **Compaction beats isolation under the strict rule** — $578 vs $308 — and it
   needs no subagent, no nudge, and no compliance from the model. The spec
   treats it as a secondary nudge (§6.2).
3. Isolation only overtakes compaction if editing series are delegated, which
   the spec forbids ([§3 non-goals](../../spec/spec-context-tax.md)).

### Sensitivity

| min n | min C_start | eligible | coverage | saved       |
| ----- | ----------- | -------- | -------- | ----------- |
| 3     | 100k        | 93       | 15.5%    | $467.75     |
| 3     | 200k        | 73       | 8.1%     | $414.60     |
| 3     | 300k        | 54       | 5.5%     | $345.57     |
| 5     | 100k        | 70       | 13.5%    | $357.43     |
| **5** | **200k**    | **52**   | **6.2%** | **$308.49** |
| 5     | 300k        | 40       | 4.5%     | $257.89     |
| 8     | 100k        | 47       | 11.6%    | $295.99     |
| 8     | 200k        | 35       | 5.5%     | $257.93     |
| 8     | 300k        | 26       | 4.2%     | $219.02     |
| 12    | 100k        | 22       | 6.1%     | $191.71     |
| 12    | 200k        | 17       | 3.3%     | $171.09     |
| 12    | 300k        | 15       | 3.1%     | $166.67     |

**No combination of the spec's thresholds reaches 25%.** The best cell is 15.5%
at the loosest setting (n>=3, 100k), which is also the setting where delegation
overhead is least likely to pay. Loosening `n` and `C_start` cannot rescue the
criterion; only the Edit/Write rule can.

## What decides the verdict

Two choices move the answer across the bar, and neither is a measurement:

**1. The Edit/Write rule (6.2% vs 34.8%).** The spec permits edits "only to files
first created inside the series" ([§5.3](../../spec/spec-context-tax.md)). The
transcript does not reliably record which files those are, so this spike takes
the conservative reading and refuses any series containing an edit. That is the
safe direction for a kill decision — it cannot manufacture a pass — but it
refuses $437 of $802.

The honest statement is a bracket, not a point: **the isolation lever is worth
between 6% and 35% of Bash token-turns**, and where it falls inside that range
depends on a question this data cannot answer — how many of those edits touch
files the loop itself created.

**2. The dev session (6.2% vs 36.0%).** The excluded session is our own
development of this feature: 19,964 turns, and it was 58% of the archive's
context in the previous spike. It is exactly the workload the spec describes —
a long agentic loop at 380k context — which is why excluding it was the right
instruction and why the remaining archive looks different.

## Mechanism

Verified against the official documentation and against this archive's own
subagent transcripts.

### `additionalContext` from PostToolUse reaches the model — confirmed

> For `PostToolUse` hooks, you can set `additionalContext` to append information
> to the tool result. To replace the tool's output before Claude sees it, set
> `updatedToolOutput`, which works for any tool in both SDKs. The older
> `updatedMCPToolOutput` field replaces MCP tool output only and is deprecated.
> — [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

And on how it differs from a user-facing message:

> The `systemMessage` field shows a message to the user, not the model. […] To
> pass context to the model instead, return `additionalContext`.
> — [same page](https://code.claude.com/docs/en/agent-sdk/hooks)

So the delegation nudge in [spec §6.1](../../spec/spec-context-tax.md) has a
supported mechanism, and the `updatedToolOutput` the summariser needs
([§6.3](../../spec/spec-context-tax.md)) is supported for any tool, not only MCP.

**Caveat on how this was verified.** The main [hooks page](https://code.claude.com/docs/en/hooks)
truncates when fetched, and a first pass over it concluded PostToolUse supports
*neither* field. The Agent SDK hooks page states both explicitly. Anyone
re-checking should read the SDK page, not the summary page.

**Not verified: whether Claude acts on it mid-loop.** The docs say the text
reaches the model; they do not say the model changes course because of it.
That is a compliance question and it is exactly what the Stage 2 kill criterion
measures (">= 50% compliance after prompt tuning"). It cannot be answered from
documentation, and it was not answered here.

**Fallback if compliance is low**, per the spec: `PreToolUse` with
`permissionDecision: "deny"` and `permissionDecisionReason`, which is documented
as reaching the model:

> `permissionDecision: 'deny'` stops the tool call. `permissionDecisionReason`
> tells the model why, so it avoids retrying.
> — [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

### Subagent usage is measurable — confirmed on this archive

Claude Code writes each subagent to its own transcript beside the parent:

```
~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl
~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.meta.json
```

Verified live during this spike. A subagent spawned to check these very
questions produced:

```json
{"agentType":"claude-code-guide","description":"Verify hook output fields",
 "toolUseId":"toolu_01VZjeu26C8tBSbNWKz1TCau","spawnDepth":1}
```

`toolUseId` links the subagent back to the `Task` call in the parent transcript,
so **subagent cost is measurable and attributable to the series that spawned
it** — not estimated. 362 of 364 subagent transcripts in the archive carry full
`usage`. This answers [spec open question 2](../../spec/spec-context-tax.md)
affirmatively; no fallback estimate is needed.

The SDK documents the same thing for programmatic consumers, with a warning
worth carrying into Stage 2:

> When the agent spawns subagents, use `modelUsage` for whole-tree token
> accounting; the `usage` field undercounts as soon as nesting occurs.
> — [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

### Subagent model selection — documented, and already happening

There is no `model` field on the Task tool. The model is resolved by a cascade:
the spawn prompt, then the agent definition's `model` frontmatter (`inherit`
selects the lead's), then `CLAUDE_CODE_SUBAGENT_MODEL`, then the lead's model
([subagents](https://code.claude.com/docs/en/sub-agents)).

This archive already shows subagents on five different models, including
`claude-haiku-4-5` (218 assistant turns), so selecting a cheap worker is
mechanically possible today. Given that the model choice is worth 4% of the
saving, it should be a knob, not the headline.

### Capping a subagent's context — not possible

No documented mechanism limits a subagent's context window. Max turns, depth,
concurrency and spend limits exist; context size does not
([subagents](https://code.claude.com/docs/en/sub-agents)).

This matters for the counterfactual: the measured subagent grows from 17.9k to
62.6k during a run. Nothing stops a delegated loop from becoming expensive in
its own right, and the estimator must model that growth rather than assume a
flat small context. This spike does — `IsolateSeries` accumulates `R_j` call by
call — which is part of why the saving is 4% rather than 10x.

## Reading of the result

The kill criterion, taken literally, says: ship the meter, drop the paid
isolation tier. Three things temper that, and none of them is a reason to
override the criterion without a decision:

1. **The bracket is wide** (6%–35%) and its width is one unanswerable question
   about edits inside loops. A narrower answer needs either transcript data that
   records file provenance, or a Stage 2 experiment.
2. **Compaction outperforms isolation** under the strict rule, $578 to $308, and
   is far simpler: no subagent, no brief, no compliance. The spec has it as a
   secondary nudge; the data says it is the primary one.
3. **The meter passes on its own terms.** $802 of measurable context tax across
   53 sessions, with the per-call cost exact from `usage`, is a real number to
   show — and showing it needs no hooks, no keys and no model compliance.

What this archive cannot settle: whether it is representative. Every conclusion
here is one person's projects, and the workload the spec was written about is
the session that had to be excluded. The same command runs on anyone else's
archive.
