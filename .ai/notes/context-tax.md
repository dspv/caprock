# Context tax — Stage 0

**Date:** 2026-09-07 · **Dataset:** owner's archive, 53 sessions after exclusions, 64 projects
**Reproduce:**
```
go run ./cmd/routing-spike -tax -exclude-project "-Users-ds-dev-caprock,-Users-ds-dev-caprock-web"
go run ./cmd/routing-spike -tax -allow-edits -exclude-project "..."   # upper bound
```

## Verdict first

**The Stage 0 kill criterion as written FAILS: 12.9% against a 25% bar.**

> If Bash series of length >= 5 at context >= 200k account for under 25% of Bash
> token-turns on this archive, the isolation lever is too small; ship the meter
> only, drop the paid tier of this spec. — [spec §3](../../spec/spec-context-tax.md)

That criterion was about **the isolation lever**, not about the product — and the
lever failed twice over: 12.9% coverage on the archive, and 1 compliance in 8 when
the nudge was tried live. Isolation is parked. Read lever by lever, Stage 0
produced three different answers:

| lever                            | Stage 0 result                              | decision                          |
| -------------------------------- | ------------------------------------------- | --------------------------------- |
| the meter (show the tax)         | $801.56 measurable, exact from `usage`      | ships free, Stage 1               |
| compaction (lower the threshold) | $578.46 gross, mechanism confirmed writable | the paid lever, gated on re-reads |
| isolation (delegate the loop)    | 12.9% coverage, 1 of 8 compliance live      | parked                            |

The isolation figure is quoted here because it is what the criterion asked for and
because it is the number a future reader will want before unparking the lever. It
depends on one rule, and the honest form is a bracket:

| eligibility rule                                   | coverage  | saved       |
| -------------------------------------------------- | --------- | ----------- |
| strictest — no Edit/Write anywhere in the series   | 6.2%      | $308.49     |
| **Write→Edit provenance — the spec's actual rule** | **12.9%** | **$487.12** |
| loosest — any edit allowed (`-allow-edits`)        | 34.8%     | $998.71     |

The middle row is the one the spec asks for and the one to quote.

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

### The Write→Edit provenance rule

The spec permits edits "only to files first created inside the series"
([§5.3](../../spec/spec-context-tax.md)). The transcript *can* decide this: `Write`
creates a file, `Edit` changes an existing one, and both carry `file_path`. So a
series is **self-contained** when every Edit targets a path that same series first
passed through Write. An edit whose path was not recorded counts as foreign —
unknown provenance is treated as the worse case, because this rule decides whether
real work gets moved into a subagent.

Series that edit files they did not create are their own category, **edit-loop**.
They are not refused because they are unsuitable — that is unknown — but because a
transcript cannot say whether such a loop needs the conversation's history. Stage 2
settles them by live experiment, not by parsing.

### Sessions excluded, and the orchestrator kept

**Only sessions where the spike itself was developed are excluded**, by exact
project-directory match: `-Users-ds-dev-caprock` (22 transcripts) and
`-Users-ds-dev-caprock-web` (1).

**Orchestrator scratchpad runs are kept** — 21 sessions under
`-private-tmp-…--Users-ds-dev-caprock-<uuid>-scratchpad-…`. These are Caprock being
*exercised*, not written: the orchestrator running agents is the product at work,
and the loops it produces are exactly the workload this spec is about. Excluding
them by substring instead moves the verdict from 12.9% to 13.1%, so this choice
does not decide anything.

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
| 5-7   | 47     | $40.59  | 18       |
| 8-15  | 61     | $129.61 | 35       |
| 16-30 | 58     | $245.81 | 17       |
| 31+   | 35     | $349.25 | 3        |

The money is in long series — 31+ calls hold 44% of the tax — and only 3 of 35 are
eligible. The longer a loop runs, the likelier it touches a file it did not create.

### Series by starting context

| C_start  | series | tax     | eligible |
| -------- | ------ | ------- | -------- |
| <50k     | 85     | $26.07  | 0        |
| 50-100k  | 50     | $22.88  | 0        |
| 100-200k | 54     | $114.48 | 0        |
| 200-300k | 52     | $82.99  | 16       |
| 300-500k | 47     | $153.43 | 18       |
| 500-700k | 35     | $171.99 | 13       |
| 700k+    | 48     | $229.71 | 26       |

**Half the tax — $401.70 of $801.56 — is paid above 500k of starting context.**
That is a number for the meter on its own: it says the expensive thing is not any
particular loop but the habit of running loops in a context that was never
compacted. The spec's 200k threshold is nowhere near the binding constraint.

### Series by class

| class  | series | calls | tax     | eligible | saved   |
| ------ | ------ | ----- | ------- | -------- | ------- |
| run    | 225    | 3,017 | $555.42 | 61       | $415.61 |
| mixed  | 62     | 1,342 | $219.59 | 9        | $57.38  |
| test   | 5      | 74    | $11.71  | 0        | $0.00   |
| search | 71     | 204   | $11.30  | 3        | $14.14  |
| build  | 4      | 22    | $2.45   | 0        | $0.00   |
| vcs    | 4      | 10    | $1.09   | 0        | $0.00   |

**The spec's mental model is test/build loops; the data is `run`.** Test, build and
vcs together are $15 of $802 — not worth a line of product copy. The expensive
loops are ad-hoc "run it, look at it, fix it" cycles, and they hold 85% of both the
tax and the saving.

Everything downstream — the nudge wording, the badge, the Stage 2 prompts — should
be written for that ad-hoc cycle. The classifier stays in the report because it is
how we know this; it is not a feature.

### Why series were refused

| reason                           | series | tax held    |
| -------------------------------- | ------ | ----------- |
| too short (n < 5)                | 170    | $36.29      |
| context below threshold (< 200k) | 82     | $160.22     |
| edits pre-existing files         | **46** | **$328.33** |

The edit-loop category holds 41% of all context tax. Its eligibility is the single
open question worth the most money in this spec, and it is a Stage 2 question.

### Counterfactuals

|                                             | provenance rule | edits allowed |
| ------------------------------------------- | --------------- | ------------- |
| `saved_isolation` (same model)              | $466.35         | $945.69       |
| `saved_isolation` (Haiku subagent)          | $487.12         | $998.71       |
| `saved_compaction` (best point per session) | $578.46         | $578.46       |

**Isolation with the same model captures 96% of what a Haiku subagent captures**
($466 vs $487). The lever is not paying less per token; it is not re-reading the
parent's 380k context on every call. Isolation therefore needs no model choice, no
keys and no user decision — the model is one line in settings, and it stays out of
the product story. This answers [spec open question 3](../../spec/spec-context-tax.md).

**Compaction still beats isolation** — $578 vs $466 — and it needs no subagent, no
nudge and no compliance from the model.

### Sensitivity

Thresholds swept where the money actually is:

| min n | min C_start | eligible | coverage  | saved       |
| ----- | ----------- | -------- | --------- | ----------- |
| 3     | 200k        | 97       | 14.8%     | $599.13     |
| 3     | 350k        | 66       | 10.9%     | $485.71     |
| 3     | 500k        | 51       | 8.7%      | $311.21     |
| 3     | 700k        | 33       | 3.2%      | $175.92     |
| **5** | **200k**    | **73**   | **12.9%** | **$487.12** |
| 5     | 350k        | 52       | 10.2%     | $394.07     |
| 5     | 500k        | 39       | 8.4%      | $288.90     |
| 5     | 700k        | 26       | 3.0%      | $164.04     |
| 8     | 200k        | 55       | 12.2%     | $432.32     |
| 8     | 350k        | 38       | 9.8%      | $351.49     |
| 8     | 500k        | 28       | 8.0%      | $251.10     |
| 8     | 700k        | 18       | 2.8%      | $134.82     |
| 12    | 200k        | 34       | 8.9%      | $325.47     |
| 12    | 350k        | 28       | 8.4%      | $299.48     |
| 12    | 500k        | 20       | 7.3%      | $212.08     |
| 12    | 700k        | 13       | 2.5%      | $111.64     |

No combination reaches 25%; the best cell is 14.8% at the loosest setting, which is
also where delegation overhead is least likely to pay. Coverage is far more
sensitive to `C_start` than to `n` — dropping `n` from 12 to 3 at a fixed 200k adds
6 points, while raising `C_start` from 200k to 700k costs 10. Whatever the nudge
ends up triggering on, context is the signal and length is the tiebreak.

## Mechanism

Verified against the official documentation, against this archive's own subagent
transcripts, and — for the nudge — in a live session.

### Compaction: Caprock can set the threshold, not just nudge

This was the open question behind putting compaction first, and the answer is that
it is a real lever, not a suggestion.

The auto-compact threshold is configurable three ways
([settings](https://code.claude.com/docs/en/settings),
[costs](https://code.claude.com/docs/en/costs)):

- `autoCompactWindow` in `settings.json` — a plain token count, accepted range
  100k–1M.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the environment, which takes precedence.
- `/autocompact` interactively, `--autocompact` on the command line.

Writing the settings key was verified here: it sits beside the existing top-level
keys, needs no nesting, and reads back unchanged. Caprock already owns a hook entry
in that same file, so the write path is one it maintains anyway.

**A live illustration of why this matters.** The session that produced this report
ran at **968,728 tokens** with `autoCompactWindow` unset — Sonnet 5's default
threshold is ~967k, so it was compacting only at the very end of a 1M window. At
that context every single Bash call cost **$0.48** before doing any work. This is
not an argument from the archive; it is the machine this was written on.

The nudge form remains available for users who would rather decide per session, but
the product does not depend on their compliance.

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

**Fallback if compliance is low**, per the spec: `PreToolUse` with
`permissionDecision: "deny"` and `permissionDecisionReason`, which is documented
as reaching the model:

> `permissionDecision: 'deny'` stops the tool call. `permissionDecisionReason`
> tells the model why, so it avoids retrying.
> — [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

### Does Claude act on the nudge mid-loop — one live trial

Documentation says the text arrives; it cannot say the model changes course. So
the nudge was run live in this session: a `PostToolUse:Bash` hook installed
alongside the existing caprock-shim entry, firing on eligible series in soft mode.

**8 nudges fired. Compliance: 1 of 8.** Delivery was confirmed — the nudge is
visible in the transcript as `PostToolUse:Bash hook additional context`, so the
seven non-compliances are real refusals to act, not lost messages. On the one
compliance, the test gate was delegated to a subagent, and the measured saving on
that single delegation was **$1.41 of the $1.45 it would have cost inline — 97%.**

So the mechanism works and the economics per compliance are excellent; the
open variable is entirely the compliance rate. 1-in-8 is far below the Stage 2
bar of >=50% after prompt tuning, but this trial did not tune the prompt at all.

**Two caveats that keep this from being evidence.**

- **I was both experimenter and subject.** The model being nudged is the one that
  wrote the nudge and knew what the trial was measuring. That biases in both
  directions and is not measurable from inside. This number needs to be reproduced
  on someone whose session is not about the experiment.
- **The parent's hook fires for Bash calls made *inside* subagents.** Observed
  directly during the trial: a loop that has already been isolated gets told to
  isolate itself. Any real implementation must suppress the nudge when the calling
  session is a subagent, or it will nudge the very behaviour it asked for.

The hook was removed afterwards and `~/.claude/settings.json` verified
byte-identical to the pre-trial backup.

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

### Subagent model selection — a settings line, not a product decision

There is no `model` field on the Task tool. The model is resolved by a cascade:
the spawn prompt, then the agent definition's `model` frontmatter (`inherit`
selects the lead's), then `CLAUDE_CODE_SUBAGENT_MODEL`, then the lead's model
([subagents](https://code.claude.com/docs/en/sub-agents)).

Since same-model isolation captures 96% of the saving, this is a one-line default
and nothing more. No key, no choice, no copy.

### Capping a subagent's context — not possible

No documented mechanism limits a subagent's context window. Max turns, depth,
concurrency and spend limits exist; context size does not
([subagents](https://code.claude.com/docs/en/sub-agents)).

This matters for the counterfactual: the measured subagent grows from 17.9k to
62.6k during a run. Nothing stops a delegated loop from becoming expensive in
its own right, and the estimator must model that growth rather than assume a
flat small context. This spike does — `IsolateSeries` accumulates `R_j` call by
call — which is part of why the saving is 4% rather than 10x.

## What Stage 0 decided

Not a kill. The criterion tested one lever and that lever came back a bracket;
the other two came back clean.

1. **The meter ships free.** $801.56 of context tax across 53 sessions, exact from
   `usage`, with half of it above 500k of context. It needs no hooks, no keys and
   no compliance from anybody. It is also the thing that makes the rest legible:
   a user who cannot see the tax has no reason to want it lowered.

2. **Compaction is the first paid intervention.** Largest measured saving ($578),
   confirmed writable mechanism (`autoCompactWindow`), and no dependence on the
   model doing what it is told. It is the one lever whose value does not have an
   asterisk.

3. **Isolation is a Stage 2 experiment with a measured compliance gate.** The
   economics per compliance are strong ($1.41 saved of $1.45 on the one live
   delegation) and the ceiling is real ($466–$999 depending on edit-loops). What
   is unproven is the rate: 1 of 8 in an untuned trial where the experimenter was
   the subject. Stage 2 is that number, measured properly, with the nudge written
   for ad-hoc `run` loops and suppressed inside subagents.

What this archive cannot settle: whether it is representative. Every conclusion
here is one person's projects, and the workload the spec was written about is the
session that had to be excluded. Anyone can run the same command on their own
archive:

```
go run github.com/dspv/caprock/cmd/routing-spike@latest -tax -json > my-context-tax.json
```
