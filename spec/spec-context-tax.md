# Caprock Context Tax — Implementation Spec

Status: supersedes `spec-routing-savings.md` (kept in repo as background; its Read-routing hypothesis is dead, its measurement model and free/paid structure carry over)
Owner: Dima (dspv)
Target: next major release of github.com/dspv/caprock
Audience: coding agent implementing the feature end to end
Conventions: github.com/dspv/kit (English only, Conventional Commits, no emoji, outcome-focused tasks, kill criteria)

---

## 0. TL;DR

The routing spike (`.ai/notes/routing-spike.md`, 439 sessions, token-based) showed where Claude Code money actually goes on this archive:

- Read results: 1.6% of context token-turns. File routing is dead.
- Bash: 54% of context token-turns, 60% of all tool calls, median result 597 tokens, mean context at call time 382k tokens.
- Bash results above 4k tokens: 6% of context. Summarising outputs is a minor lever.

The cost driver is not what a tool returns. It is how many calls run inside a large context: every call re-sends the whole context as a cache read. At 382k context on Opus 5 a single Bash call costs about $0.19 before it does anything. 21,711 calls is roughly half of the archive's list-price spend.

Spotify's 90% came from moving a heavy payload out of the frontier context. The equivalent move here is to shrink the context the loop runs in. Two levers can do that — isolating the loop in a subagent, or compacting the context sooner — and Stage 0 measured both.

**Isolation is worth 12x per series and the model will not take it.** In a live trial Claude acted on 1 delegation nudge out of 8, with delivery confirmed. It is parked with its evidence in section 6.4; the meter keeps the counterfactual as an informational line and nothing acts on it.

**Compaction saves more and needs nobody's consent** — $578 against isolation's $466 on the same archive — because the auto-compact threshold is a setting Caprock can compute and write, not a suggestion the model may decline.

Caprock ships two things:

1. **Free — these numbers inside the screens Caprock already has.** Not a new panel: the cost of the next call on the session card, a context-tax row in the existing Breakdown, and the price of a series on the loop detector's alert. Live and retroactive, no keys, no hooks, computed from transcripts Caprock already parses. The recommended `autoCompactWindow` and its expected saving are shown for free.
2. **Paid — Compaction threshold management, the first Premium feature that acts.** Caprock computes the optimal `autoCompactWindow` per project from the user's own data, writes it into settings, and keeps it current as the workload changes. Every write is logged; measured savings sit next to the estimate.

This spec is the source of the formulas behind those numbers. It is not a feature with a surface of its own.

---

## 1. Background and evidence

### 1.1 Source finding

Spotify Engineering, 2026-09-03, "Portal by Spotify cut my Claude Code token usage by 90%": https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90 . Mechanism: PreToolUse hooks block whole-file reads above a line threshold; a cheap worker reads the files and returns bullets; Claude never sees the payload. Measured ~90% per bulk-read event on a Java monorepo. Their own limits: cannot delegate editing or reasoning, 10-30 s latency per delegation.

### 1.2 What the spike found on this archive

Reproducible via `go run ./cmd/routing-spike -dir ~/.claude/projects`. Full report in `.ai/notes/routing-spike.md`. Numbers that drive this spec:

| Metric                                             | Value                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Sessions                                           | 439                                                               |
| Read share of context token-turns                  | 1.59%                                                             |
| Bash share of context token-turns                  | 53.81%                                                            |
| Bash calls                                         | 21,711 (60% of all tool calls)                                    |
| Mean context at Bash call                          | 382,620 tokens                                                    |
| Bash median result                                 | 597 tokens                                                        |
| Bash results above 4k tokens, share of Bash tokens | 24.7%                                                             |
| Bash results above 4k tokens, share of all context | 6.22%                                                             |
| Images                                             | 77% of bytes, 8% of tokens                                        |
| Largest single session share of denominator        | 58% (the spike's own dev session; verdicts hold with it excluded) |

Read-routing kill criterion (15% of context) failed at 7% including MCP text. The Bash-output summarisation criterion (20% of Bash tokens above threshold) passed at 24.7% but represents only 6% of total context.

### 1.3 Why the loop, not the payload

Per-call cost in a session is `context_at_call * P_cache_read + result_tokens * P_cache_write`. On this archive the first term dominates by more than two orders of magnitude for a typical Bash call. Reducing `result_tokens` (Spotify's lever) barely moves it. Reducing `context_at_call` for the calls that do not need the full conversation moves it 10x or more.

There are two ways to reduce `context_at_call`: run the loop somewhere smaller (a subagent), or make the context itself smaller sooner (compaction). Stage 0 measured both. Isolation has the larger per-series effect and cannot be made to happen — the model declined the nudge 7 times in 8. Compaction has the larger total effect and happens by setting a number. The product is therefore the second lever, with the first kept as a measurement that explains it.

### 1.4 Prior Caprock learning

The compression-proxy failure and the Read-routing spike are both in the repo history. Two rules survive: model the prompt cache correctly in every number shown, and position Caprock as the thing that measures whether an intervention pays, not as the thing that "saves tokens".

---

## 2. Problem statement

A user running Claude Code agentically accumulates a large context, then runs hundreds of small commands inside it. Each command is cheap to produce and expensive to send. Neither Claude Code nor any tool in the market shows the user that their 300th call in a session costs $0.19 of context before it runs, or that the last twelve calls were a test-fix loop that could have run in a 30k context.

Subscription users experience this as hitting limits. API users experience it as the bill. Both are the same mechanism.

---

## 3. Goals, non-goals, kill criteria

### Goal

A Caprock user sees, live and in the archive, what their context costs per call, which call series drive the cost, and how much of that cost a sooner compaction would remove. A paid user has Caprock compute and maintain the `autoCompactWindow` for each project and sees measured savings next to the estimate.

### Success metrics

- Meter runs on every archived and live session with no configuration, no keys, no hooks.
- Live view updates within one turn of the current session: context now, cost of next call, current series length and cost.
- Estimate for a session is reproducible from the transcript and the price registry.
- Every threshold write is logged with the value, the project, the data it was computed from, and the measured effect afterwards.
- Measured savings on two weeks of dogfooding are at least 60% of the estimate for the same sessions.
- Hooks fail open. No hook ever blocks a tool call on error, timeout, or licence failure.
- Meter figures appear on the share card.

### Non-goals

- Routing whole-file reads. Dead on the data.
- Delegation nudges and isolation hooks. Parked on measured compliance of 1 in 8 (section 6.4). The meter still shows the isolation counterfactual; nothing acts on it.
- External worker models. No new keys anywhere in this spec. An external worker is only considered for the optional output-summarisation lever (section 6.3).
- Quality measurement of compacted sessions. Log the re-read cost; do not claim anything about output quality.

### Kill criteria

- **Stage 0 — decided 2026-09-07, see `.ai/notes/context-tax.md`.** The isolation criterion (25% of Bash token-turns) failed at 12.9%, and a live nudge trial returned 1 compliance in 8. Isolation is parked (section 6.4). The meter and compaction both passed on their own terms and carry the release.
- **Stage 2 — compaction.** Compaction is not free: after a boundary the model re-reads what the summary dropped. Measure that cost before shipping the intervention — tokens re-read after the boundary (Read/Grep of paths that were in context before the summary) and Bash commands repeated from before it. **If re-reads consume more than 50% of the estimated saving, the intervention does not ship**; raise the threshold and re-measure rather than shipping blind. If measured savings are under 60% of the estimate after that, stop and report.
- **Output summarisation (6.3).** Opt-in only; if it delivers under 3% of total context in dogfooding, remove it.

---

## 4. Architecture

Everything in the existing Go binary. No plugin marketplace dependency.

```
internal/contexttax/
  events/       transcript -> per-call events with context_at_call, result tokens, tool, class
  series/       consecutive-call series detection and classification
  estimator/    counterfactuals (isolation, compaction, summarisation)
  live/         current-session meter fed from the live transcript tail
  hooks/        `caprock hook <event>` entrypoints, fail-open
  compaction/   optimal autoCompactWindow per project; settings read/write with backup
  log/          intervention log + measured outcomes
ui
  existing screens  session card line, Breakdown row, loop alert price
  Premium settings  paid compaction controls
  LiveBadge         "this call: $0.19 / context 382k / series 12" on the session view
  ShareCard         context-tax block
```

Data flow, free:

```
transcript (archive or live tail)
  -> events: for each tool call, context_at_call from usage of the preceding assistant turn,
             result tokens from usage delta (fallback tokenizer, flagged estimated=true)
  -> series: runs of consecutive tool calls with no user turn between, split on compaction
  -> classifier: series class from command prefixes (test | build | vcs | search | pkg | run | mixed)
  -> estimator: cost_actual, cost_if_isolated, cost_if_compacted_at_k
  -> aggregates -> session card line, Breakdown row, loop alert, share card
```

Data flow, paid:

```
archive per project
  -> estimator: saved_compaction over a grid of candidate thresholds
  -> optimal autoCompactWindow, net of measured re-read cost (section 6.1)
  -> settings.json write, with backup and a logged before/after value
  -> subsequent sessions: measured tax per call vs the pre-write baseline
  -> re-read audit after every boundary feeds back into the threshold
  -> measured vs estimated in the Premium compaction view
```

No hook is required for the paid lever. The threshold is a settings value, so the intervention happens between sessions rather than inside one.

### 4.1 Hook contract

This release ships no new hook — the compaction lever writes a setting instead. The contract below binds any hook a later stage adds.

- JSON in on stdin, JSON out on stdout, exit 0 always. 2 s hard timeout. No network in hooks.
- Any error -> emit nothing, log locally, increment `hook_failopen` shown with the compaction controls.
- Licence failure -> hooks emit nothing; the compaction controls say "interventions paused"; never silent.
- **A hook must not fire inside a subagent.** The parent session's `PostToolUse` also fires for tool calls made within subagents — observed directly in the Stage 0 trial, where an already-isolated loop was told to isolate itself. Detect the subagent case from the transcript path (`<session-id>/subagents/agent-<id>.jsonl`) or the agent id and return without acting. This is mandatory for every future Caprock hook, not advice.

### 4.2 Installation

`caprock contexttax enable [--project]` starts managing `autoCompactWindow` for that project: it writes the computed value into the relevant `settings.json` with a backup, touching no other key. `disable` restores exactly the value that was there before, or removes the key if it was absent. `status` prints the current value, the value Caprock would choose, the data behind it, and the last 10 writes with their measured effect.

---

## 5. Measurement model

### 5.1 Events

For every tool call `i` in a session:

- `C_i` = context at call time = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the assistant turn that issued the call. This is exact from `usage`, no estimation.
- `R_i` = result tokens = usage delta on the next assistant turn (as in the spike); fallback tokenizer with `estimated=true`.
- `tool_i`, `command_i`, `class_i`.
- `turns_left_i` = assistant turns until the next compaction boundary or session end.

### 5.2 Per-call cost, actual

```
P_in  = session model input price
P_cw  = 1.25 * P_in
P_cr  = 0.10 * P_in

cost_call_i = C_i * P_cr + R_i * P_cw + R_i * turns_left_i * P_cr
```

The first term is the context tax. It surfaces as the Breakdown row and the session card's next-call figure.

### 5.3 Series

A series is a maximal run of consecutive tool calls with no user message between them and no compaction boundary inside. Attributes: length `n`, start context `C_start`, total tax `sum(C_i * P_cr)`, class, whether it contains Edit/Write calls.

Eligible for isolation (used to compute the informational counterfactual, not to trigger anything):

- `n >= 5`
- `C_start >= 200k` (the Stage 0 grid is 200k / 350k / 500k / 700k, chosen because coverage is far more sensitive to context than to length; 500k is the reported default and the grid stays a computation parameter, not a user-facing control in Stage 1)
- class in {test, build, search, pkg, vcs, run} and no Edit/Write inside the series, or Edit/Write only to files first created inside the series
- not the first series after a user message that contains a question (heuristic: Claude is still understanding the task)

### 5.4 Counterfactual: isolation (informational only)

This number is displayed, never acted on. It is what tells a user their loop was
expensive; the intervention that follows is compaction, not delegation. See
section 6.4 for why.

```
C_sub0   = subagent starting context: measured 17.9k (median first turn over 364 real
           subagent transcripts, Stage 0), growing to a 62.6k median peak over a run.
           The growth is not a second constant -- the sum_{j<i} R_j term below is it.
S        = summary returned to parent: measured 10.9k median (Stage 0), not the 1k
           first guessed; it is cache-written once and re-read for every remaining turn,
           so it is a material part of the cost, not a rounding error.
P_sub_*  = prices of the subagent model. Same-model isolation captures 96% of the saving
           (Stage 0: $466 of $487), so the default is the lead's own model and the
           cheaper-worker case is a settings line, not a product decision.

cost_isolated = sum over i in series of (C_sub0 + sum_{j<i} R_j) * P_sub_cr + R_i * P_sub_cw
              + S * P_cw + S * turns_left_end * P_cr
              + brief_tokens * P_cw                      (the task description Claude writes)

saved_isolation = cost_series_actual - cost_isolated     (floored at 0 for display)
```

### 5.5 Counterfactual: compaction

For each candidate point `k` (initial rule: any point where `C_k >= 250k` and at least 20 calls remain before the next boundary):

```
saved_compaction_k = sum over i > k of (C_i - C_compacted) * P_cr
                   - compaction_cost (summary write, initial default 8k * P_cw)
                   - reread_cost_k                      (section 6.1, measured in Stage 2)
where C_compacted = C_k * compaction_ratio (initial 0.25, measured from existing boundaries)
```

`reread_cost_k` is what the model spends re-acquiring what the summary dropped. Stage 0 did not measure it and the $578.46 figure does not include it; Stage 2 must, because it is the difference between a real saving and a shuffled one.

Show the best `k` per session, and per project the threshold that would have produced the best `k` across sessions — that value is what the paid lever writes (section 6.1).

### 5.6 Counterfactual: output summarisation (optional lever)

Same formula as the old spec section 5.3, applied only to Bash results with `R_i >= 4k`. Displayed as a separate, smaller line so it is never confused with the isolation number.

### 5.7 Aggregates and display

- Per session: total tax, tax share of cost, series table, best compaction point, saved_isolation total (informational).
- Per project and per period: same, plus per-class breakdown, plus **the share of tax paid above 500k of starting context** — on the Stage 0 archive that was half of it, and it is the figure that explains the compaction recommendation.
- Per project: recommended `autoCompactWindow` and the saving expected from it. Free shows the number; paid writes it.
- Live: `C_now`, **`cost_next_call = C_now * P_cr` shown as a live dollar figure**, current series length and tax so far. The next-call cost is the meter's sharpest number — on a 968k-context session it reads $0.48 before the call does anything — so it leads the badge.
- Subscription users: lead with "N% of your context token-turns is tax"; dollars as a secondary line "at API list price". API users: lead with dollars.
- Always show the base next to any percentage. Estimated events carry a tilde. Compaction and summarisation figures are labelled as separate levers.

---

## 6. Interventions (paid)

The only intervention in this release is compaction threshold management. It was chosen over isolation on measurement, not preference: it saves more ($578 vs $466 on the Stage 0 archive) and, unlike a nudge, it does not depend on the model agreeing to anything.

### 6.1 Compaction threshold management

Claude Code's auto-compact threshold is configurable, and Caprock can set it:

- `autoCompactWindow` in `settings.json` — a plain token count, accepted range 100k-1M ([settings](https://code.claude.com/docs/en/settings)).
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the environment, which takes precedence.
- `/autocompact` interactively, `--autocompact` on the command line.

Verified in Stage 0: the settings key sits beside the existing top-level keys, needs no nesting, and reads back unchanged. Left unset, the default sits near the top of the model's window — the session that produced the Stage 0 report ran at 968,728 tokens, paying $0.48 per Bash call before any work.

**Free.** Per project, show the recommended threshold and the saving it would have produced on that project's own history. Nothing is written.

**Paid.** Caprock writes the value into `settings.json` (backup first, no other key touched) and keeps it current as the workload changes. Every write is logged with the old value, the new value, the data behind it, and the measured effect on the sessions that follow.

The threshold is computed per project rather than globally: a project whose sessions peak at 200k and one that runs to 900k do not want the same number.

**Re-read cost, and the gate on it.** Compaction is not free. After a boundary the model re-reads what the summary dropped, and that cost is not in the $578.46 estimate. Stage 2 measures it directly from transcripts: tokens spent on Read/Grep of paths that were in context before the boundary, plus Bash commands repeated from before it. Per the Stage 2 kill criterion, if re-reads consume more than half the estimated saving, the intervention does not ship at that threshold — raise it and re-measure. A lower threshold is not automatically better, and shipping one blind would move cost rather than remove it.

### 6.2 Compaction nudge (secondary)

For users who prefer to decide per session rather than have a threshold managed: when the live estimator finds `saved_compaction_k` above a dollar threshold (initial $2), suggest `/compact` with the estimated saving, at most once per 50 calls. This is a convenience on top of 6.1, not the mechanism — the product does not depend on the user or the model complying.

### 6.3 Output summariser (opt-in)

The old Bash track, reduced: `PostToolUse` with `updatedToolOutput` for Bash results above 4k tokens, keeping the last 40 lines verbatim and the full output on disk. Worker = Haiku via an Anthropic API key, so this is the only lever that needs a key; keep it off by default.

### 6.4 Delegation nudge — parked, with evidence

The delegation nudge was the centrepiece of this spec when it was written. Stage 0 parked it. The evidence, so a later reader does not have to rediscover it:

- **The mechanism works.** `additionalContext` from a `PostToolUse` hook does reach the model ([Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)), and delivery was confirmed live — the nudge appears in the transcript as `PostToolUse:Bash hook additional context`.
- **The model does not act on it.** 8 nudges fired on eligible series in a live session; Claude complied once. Because delivery was confirmed, the other seven were refusals, not lost messages. That is 1 in 8 against a Stage 2 bar of 50%.
- **The economics per compliance are excellent.** On the one delegation, $1.41 was saved of the $1.45 the loop would have cost inline — 97%. The lever is real; the take-up is not.
- **The coverage is a bracket, not a number**: 6.2% of Bash token-turns under the strictest edit rule, 12.9% under this spec's Write-then-Edit provenance rule, 34.8% if edits to pre-existing files are allowed.
- **The trial has a caveat that must not be lost.** The model being nudged was the one that wrote the nudge and knew what was being measured. Any attempt to revive this lever needs a compliance number from a session that is not about the experiment.

To unpark it, the thing to change is the compliance rate, and the only honest way to learn it is another live trial with a tuned prompt on someone else's work. Nothing in the meter should wait on that.

---

## 7. Free vs paid

The meter is not a feature with a screen of its own. Caprock already has the
screens people look at; Stage 0 produced numbers those screens were missing.
The free half is those numbers appearing where the user already is, and the
paid half is the one thing the numbers argue for. Nothing new is introduced —
no Context Tax panel, no sliders, no separate route. This spec is the source of
the formulas, not a feature with its own surface.

### Free — the numbers, in the screens that already exist

Three placements, all of them additions to existing components:

- **Session card** — one line: context now, and what the next call costs at that
  context. The figure that makes the tax legible is the marginal one, and the
  session view is where a running session is already being watched.
- **Breakdown** (`ui/src/components/Breakdown.tsx`) — one row in the existing
  lifetime table: context tax as a share of spend, with its absolute dollars,
  in the same shape as the model and tool rows around it. The panel's own rule
  applies — the row carries its dollars, not only its percentage.
- **Loop detector** (`internal/loop/`) — when a series fires an alert, the alert
  carries what the series has cost so far and what it would have cost isolated.
  The detector already finds the repeated-tool series this spec calls a series;
  it just never priced one.

Recommended `autoCompactWindow` per project, with the saving it would have
produced, is shown with the compaction figures. The number is free; writing it
is the paid part.

The share block stays a `ShareCard` variant, not a new screen:

```
Context tax: 54% of your Claude Code spend (Bash, 21,711 calls at 382k avg context)
Half of it was paid above 500k of context. A lower compact threshold would have saved ~$578 of $9,700 in 36 days
```

- CTA: "Caprock can set and maintain that threshold for you. Measured, not estimated."

### Paid (Premium)

Compaction management is the first Premium feature that does something rather
than describing something. It replaces a placeholder, and it is the only
intervention in this release.

- `caprock contexttax enable/disable/status`.
- Managed `autoCompactWindow` per project: computed, written with backup, kept current.
- Write log with old and new value, measured effect on subsequent sessions, re-read audit, measured vs estimated.
- Optional summariser (6.3).

### Paid (Teams)

- Aggregation across people: tax share, share above 500k context, managed thresholds and their measured savings, per person and total. This is the manager view column set.

### Enforcement

Meter works with no licence. Threshold management gates on the existing licence check; on licence failure Caprock stops managing the value and leaves the last written one in place, saying so where the controls live. It never silently reverts a user's settings.

---

## 8. Stages

**Stage 0 — Counterfactual and mechanism. DONE 2026-09-07** (`.ai/notes/context-tax.md`, spike in `cmd/routing-spike/`). Isolation failed its criterion at 12.9% and 1-in-8 live compliance, and is parked; the meter and compaction carry the release. Original scope:
- Extend `cmd/routing-spike` (or a new `cmd/contexttax-spike`) with series detection, classification, and the section 5.4 / 5.5 counterfactuals. Run on the full archive with the dev session excluded by project name, not by size.
- Output `.ai/notes/context-tax.md`: series distribution (n, C_start, class), share of Bash token-turns covered by eligible series, isolation and compaction counterfactual totals, sensitivity to the thresholds.
- Mechanism check against the official Claude Code docs (https://docs.claude.com/en/docs/claude-code/hooks and the subagents page), verified in a live session: does `additionalContext` from PostToolUse reach the model; how does a subagent's usage appear in the transcript (separate file, nested records, or absent); how to set the subagent model and cap its context. Record findings with links; if measurement of subagent cost is impossible from transcripts, say so and propose the fallback (estimate from brief + results).
- Apply the Stage 0 kill criterion.

**Stage 1 — the numbers into the existing screens, free. DONE.** `internal/contexttax/` holds the formulas; the three placements are the session card's Context caption (`$0.07/call` beside the fill), the `CONTEXT TAX` row under Breakdown's token strip, and the loop alert's `· $2.34 in context` in its evidence line. No new panel, route or slider was added. Two things the spec did not anticipate, both recorded because they change what the numbers mean:

- **Cache-read rates come from the pricing table, never from `0.10 * input`.** Fable 5.1 and Mythos 5.1 read at 0.025x, so the multiplier the Stage 0 prototype used overcharges them fourfold. Lifetime figures are summed per model for the same reason. The lifetime row uses `Lookup`, not `LookupAt`, so a model whose rate moved inside the range is charged at today's rate for its whole volume — bounded, and noted in the code.
- **13% of tool calls cannot be priced at all.** A call is attached to the turn that paid for it by `msg_id`, which the hook plane does not carry: measured on the owner's archive, transcript and OpenCode calls link at 100% and hook-plane calls at 39%. A loop whose calls are partly unlinked reports "at least $X", never a flat figure, and the Breakdown row states the unpriced volume it excludes.

Original scope: Events, series and estimator in the daemon; then three placements and nothing more: the next-call cost line on the session card, a context-tax row in `Breakdown`, and the cost-so-far / cost-if-isolated figures on the loop detector's alert. Per-project recommended threshold shown with the compaction figures, share block as a `ShareCard` variant. **No new panel, no new route, no sliders** — if a number needs a home that does not exist yet, it waits. Retroactive on first run, incremental after. Golden-transcript tests for `C_i`, series boundaries, and counterfactuals. **The meter then runs on Dima's own sessions for a week before Stage 2 begins** — the recommendation has to survive contact with real use before anything writes it.

**Stage 2 — Compaction management: the first real Premium feature, flagged (2 weeks). BLOCKED on a measurement that cannot be made passively.** The re-read audit is built (`go run ./cmd/routing-spike -reread`) and has been run: 14 measurable boundaries across the archive re-read 0.5% of what followed them. That figure does not answer the gate, because **every one of those boundaries fired between 830k and 998k of context** — the default compacting at the ceiling. The lever compacts early, an early boundary discards more, and so it must re-read more; 0 of 14 measurable boundaries fired below 500k. Evidence in `.ai/notes/context-tax.md`.

To unblock, in order: set a lower `autoCompactWindow` on a real machine, accumulate boundaries that fired at the threshold the lever would actually set, re-run the audit on those, and only then apply the kill criterion. Only after it passes: threshold computation, the settings writer with backup and restore, the write log, and the Premium controls. Two weeks of dogfooding on Dima's sessions.

**Stage 3 — Summariser (3 days, optional).** Only if the user wants it after Stage 2 numbers.

**Stage 4 — Teams aggregation (1 week).**

**Release.** Meter for everyone, threshold management in Premium marked beta, aggregation in Teams. `/numbers` post per the Stage 0 findings: reads are 1.6%, the money is context times calls, isolation is worth 12x per series but the model takes it 1 time in 8, and compaction saves more without needing the model's consent.

---

## 9. Definition of done

- Stage 0: DONE. Note exists with reproducible numbers and a mechanism section with doc links and live-session evidence; kill criterion applied and the result acted on.
- Stage 1: DONE, except the per-project recommended `autoCompactWindow`, which is Stage 2's own input and ships with the lever that acts on it. The three placements render from the existing archive with no new query on the session path and no network calls; the session card figure updates within one turn; **no new panel, route or slider was added**. Verified against the owner's real database, not only fixtures: 79.9% of $13,910 of lifetime spend is context tax, and a 993k-token context prices at $0.50 a call.
- Stage 2: re-read cost measured **at the thresholds the lever would set**, not only at the ceiling the default fires at, and reported before any writer is built; `enable` writes the threshold with a backup and `disable` restores the exact prior state (including absence of the key); a week of subsequent sessions shows measured tax against the pre-write baseline.
- Stage 4: team totals reconcile with the per-person figures.

---

## 10. Freedom

Package layout beyond section 4, storage for the intervention log, tokenizer for estimated events, classifier implementation (prefix rules are the floor; anything better is welcome if it stays explainable in the UI), nudge wording (must be tuned on real compliance data, not taste), and React structure. Fixed: formulas in section 5, fail-open contract, the free/paid split, and the rule that every displayed percentage carries its base.

---

## 11. Open questions (answer during Stage 0)

Answered in Stage 0 (`.ai/notes/context-tax.md`):

1. **Does Claude act on `additionalContext` mid-loop?** It receives it and mostly ignores it: 1 of 8. This parked the isolation lever (section 6.4).
2. **Subagent usage visibility.** Measured, not estimated. Claude Code writes each subagent to `<session-id>/subagents/agent-<id>.jsonl` with a `.meta.json` carrying `toolUseId`, which links it back to the spawning `Task` call; 362 of 364 archived subagent transcripts carry full `usage`.
3. **Does same-model isolation capture most of the saving?** Yes — $466 of $487, so 96%. The cheap-worker choice is a settings footnote, not a mechanism.

Still open:

4. Whether OpenCode sessions get the meter in the same release (hook schema is compatible).
5. What compaction actually costs in re-reads. Gates the paid lever; Stage 2 answers it.
6. Whether this archive is representative at all. Every Stage 0 number is one person's projects, and the workload the spec was written about is the session that had to be excluded. The spike runs on anyone's archive:
   `go run github.com/dspv/caprock/cmd/routing-spike@latest -tax -json > my-context-tax.json`
