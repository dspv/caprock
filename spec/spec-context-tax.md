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

Spotify's 90% came from moving a heavy payload out of the frontier context. The same 90% is available here by moving a **heavy loop** out of it: a series of Bash calls (test, build, grep, run-and-look) executed in a subagent with a fresh 30k context costs an order of magnitude less per call than the same series in the main 382k context, and only the outcome returns.

Caprock ships two things:

1. **Free — Context Tax meter.** Live and retroactive: context at call time, dollar cost of the next call, consecutive-call series and what they cost, per-tool share by token-turns, and the counterfactual "if this series had run isolated". No keys, no hooks, computed from transcripts Caprock already parses.
2. **Paid — Context Tax reduction.** Hooks and prompts that push Bash loops into isolated subagents at the right moment, nudge compaction where it pays, and optionally summarise oversized outputs. Every intervention is logged; measured savings sit next to the estimate.

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

Claude Code already has the primitive: subagents run in their own context and return a result to the parent. The product is deciding **when** a loop should move there, making it happen, and measuring whether it paid.

### 1.4 Prior Caprock learning

The compression-proxy failure and the Read-routing spike are both in the repo history. Two rules survive: model the prompt cache correctly in every number shown, and position Caprock as the thing that measures whether an intervention pays, not as the thing that "saves tokens".

---

## 2. Problem statement

A user running Claude Code agentically accumulates a large context, then runs hundreds of small commands inside it. Each command is cheap to produce and expensive to send. Neither Claude Code nor any tool in the market shows the user that their 300th call in a session costs $0.19 of context before it runs, or that the last twelve calls were a test-fix loop that could have run in a 30k context.

Subscription users experience this as hitting limits. API users experience it as the bill. Both are the same mechanism.

---

## 3. Goals, non-goals, kill criteria

### Goal

A Caprock user sees, live and in the archive, what their context costs per call, which call series drive the cost, and what isolating those series would have saved. A paid user turns on interventions that move eligible loops into isolated subagents and sees measured savings next to the estimate.

### Success metrics

- Meter runs on every archived and live session with no configuration, no keys, no hooks.
- Live view updates within one turn of the current session: context now, cost of next call, current series length and cost.
- Estimate for a session is reproducible from the transcript and the price registry.
- Paid interventions are logged per event with tokens, dollars, and whether Claude complied.
- Measured savings on two weeks of dogfooding are at least 60% of the estimate for the same sessions.
- Hooks fail open. No hook ever blocks a tool call on error, timeout, or licence failure.
- Meter figures appear on the share card.

### Non-goals

- Routing whole-file reads. Dead on the data.
- Delegating reasoning or editing loops. A debug loop that needs the conversation's history stays in the main context; the classifier must be conservative.
- External worker models for isolation. The subagent is Claude's own (Haiku selectable); no new keys. An external worker is only considered for the optional output-summarisation lever (section 6.3).
- Quality measurement of subagent outcomes. Log compliance and re-runs; do not claim quality.

### Kill criteria

- **Stage 0.** If Bash series of length >= 5 at context >= 200k account for under 25% of Bash token-turns on this archive, the isolation lever is too small; ship the meter only, drop the paid tier of this spec.
- **Stage 2.** If Claude complies with the delegation nudge in under 50% of eligible series after prompt tuning, or if measured savings are under 60% of estimate, the intervention does not work as designed; stop and report.
- **Output summarisation (6.3).** Only if the isolation lever ships and the user opts in; if it delivers under 3% of total context in dogfooding, remove it.

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
  interventions/ delegation nudge, compaction nudge, output summariser
  log/          intervention log + measured outcomes
ui
  ContextTaxPanel   free meter + paid controls
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
  -> aggregates -> panel, live badge, share card
```

Data flow, paid:

```
Claude Code
  -> PostToolUse(Bash) -> caprock hook post-bash
       -> updates series state for the session
       -> if series eligible: returns additionalContext with the delegation nudge (section 6.1)
  -> Claude spawns a subagent (Task) for the remaining loop, or ignores the nudge
  -> transcript shows subagent usage (mechanism check in Stage 0 decides how it is read)
  -> intervention log: nudge issued, complied?, series cost before/after, subagent cost
  -> measured vs estimated in the panel
```

### 4.1 Hook contract

`caprock hook post-bash`, `caprock hook pre-bash` (only if Stage 0 finds PreToolUse necessary):

- JSON in on stdin, JSON out on stdout, exit 0 always. 2 s hard timeout. No network in hooks.
- Any error -> emit nothing, log locally, increment `hook_failopen` shown in the panel.
- Licence failure -> hooks emit nothing; panel says "interventions paused"; never silent.
- Series state is kept by the running Caprock process, keyed by `session_id`; the hook reads it over the local socket Caprock already uses, with a 200 ms budget, falling back to "no nudge".

### 4.2 Installation

`caprock contexttax enable [--project]` merges hooks into the relevant `settings.json` with a backup, never overwriting existing hooks; installs a skill file describing the delegation pattern (section 6.1); `disable` removes exactly what `enable` added; `status` prints thresholds, compliance rate, last 10 interventions.

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

The first term is the context tax. The panel shows it as its own number.

### 5.3 Series

A series is a maximal run of consecutive tool calls with no user message between them and no compaction boundary inside. Attributes: length `n`, start context `C_start`, total tax `sum(C_i * P_cr)`, class, whether it contains Edit/Write calls.

Eligible for isolation (initial rule, tuned in Stage 2):

- `n >= 5`
- `C_start >= 200k` (configurable; the panel slider offers 100k / 200k / 300k)
- class in {test, build, search, pkg, vcs, run} and no Edit/Write inside the series, or Edit/Write only to files first created inside the series
- not the first series after a user message that contains a question (heuristic: Claude is still understanding the task)

### 5.4 Counterfactual: isolation

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
where C_compacted = C_k * compaction_ratio (initial 0.25, measured from existing boundaries)
```

Show the best `k` per session. This is a nudge, not an enforcement.

### 5.6 Counterfactual: output summarisation (optional lever)

Same formula as the old spec section 5.3, applied only to Bash results with `R_i >= 4k`. Displayed as a separate, smaller line so it is never confused with the isolation number.

### 5.7 Aggregates and display

- Per session: total tax, tax share of cost, series table, best compaction point, saved_isolation total.
- Per project and per period: same, plus per-class breakdown.
- Live: `C_now`, `cost_next_call = C_now * P_cr`, current series length and tax so far, eligibility flag.
- Subscription users: lead with "N% of your context token-turns is tax" and "series X would have cost 12x less isolated"; dollars as a secondary line "at API list price". API users: lead with dollars.
- Always show the base next to any percentage. Estimated events carry a tilde. Compaction and summarisation figures are labelled as separate levers.

---

## 6. Interventions (paid)

### 6.1 Delegation nudge

Trigger: `post-bash` hook detects the current series has just become eligible (section 5.3). Action: return `additionalContext`:

```
Context tax notice (Caprock): this session's context is 382k tokens; the last 6 Bash calls cost
$1.14 of context re-reads before doing anything. This looks like a <class> loop. Run the rest
of it in a subagent (Task tool, model haiku) with a self-contained brief and return only the
outcome; do not continue the loop in this context. Skill: caprock-isolate-loop.
```

One nudge per series; do not repeat on every call. Log: series id, nudge text, next tool call (Task = complied, Bash = ignored), cost of the series after the nudge, subagent cost if visible.

If Stage 0 finds that `additionalContext` is not delivered to the model reliably, fall back to PreToolUse `deny` with `permissionDecisionReason` carrying the same text, gated to the first Bash call after eligibility, and only when the user has opted into hard mode. Soft mode is the default.

Skill `caprock-isolate-loop` (markdown, installed by `enable`): how to write the brief (goal, commands allowed, what to return, stop conditions), which model to use, what not to delegate.

### 6.2 Compaction nudge

Trigger: live estimator finds `saved_compaction_k` above a dollar threshold (initial $2) at the current point. Action: `additionalContext` suggesting `/compact` with the estimated saving, once per 50 calls at most. Log the same way.

### 6.3 Output summariser (opt-in)

The old Bash track, reduced: `PostToolUse` with `updatedToolOutput` for Bash results above 4k tokens, keeping the last 40 lines verbatim and the full output on disk. Worker = Haiku via the Anthropic API key already needed for nothing else, so this is the only lever that needs a key; keep it off by default.

---

## 7. Free vs paid

### Free

- Context Tax panel: totals, per-tool share by token-turns, series table with counterfactuals, best compaction point, per-project and per-period views, sliders for series length and context threshold.
- Live badge on the session view: context now, cost of next call, series so far.
- Share card block:

```
Context tax: 54% of your Claude Code spend (Bash, 21,711 calls at 382k avg context)
Isolating 143 eligible loops would have saved ~$2,900 of $9,700 in 36 days
```

- CTA: "Interventions are in Premium. Measured, not estimated."

### Paid (Premium)

- `caprock contexttax enable/disable/status`.
- Delegation nudge, compaction nudge, optional summariser.
- Intervention log, compliance rate, measured vs estimated, calibration state.

### Paid (Teams)

- Aggregation across people: tax share, eligible-series count, measured savings, compliance, per person and total. This is the manager view column set.

### Enforcement

Meter works with no licence. Interventions gate on the existing licence check and fail open.

---

## 8. Stages

**Stage 0 — Counterfactual and mechanism (3-4 days).**
- Extend `cmd/routing-spike` (or a new `cmd/contexttax-spike`) with series detection, classification, and the section 5.4 / 5.5 counterfactuals. Run on the full archive with the dev session excluded by project name, not by size.
- Output `.ai/notes/context-tax.md`: series distribution (n, C_start, class), share of Bash token-turns covered by eligible series, isolation and compaction counterfactual totals, sensitivity to the thresholds.
- Mechanism check against the official Claude Code docs (https://docs.claude.com/en/docs/claude-code/hooks and the subagents page), verified in a live session: does `additionalContext` from PostToolUse reach the model; how does a subagent's usage appear in the transcript (separate file, nested records, or absent); how to set the subagent model and cap its context. Record findings with links; if measurement of subagent cost is impossible from transcripts, say so and propose the fallback (estimate from brief + results).
- Apply the Stage 0 kill criterion.

**Stage 1 — Meter, free (1.5 weeks).** Events, series, estimator, panel, live badge, share block. Retroactive on first run, incremental after. Golden-transcript tests for `C_i`, series boundaries, and counterfactuals.

**Stage 2 — Interventions, paid, flagged (2 weeks).** Hooks, skill, delegation nudge, compaction nudge, log, panel paid state, recalibration of `C_sub0` and `S` against live delegated runs (Stage 0 measured both from the archive). Two weeks of dogfooding on Dima's sessions. Apply the Stage 2 kill criterion.

**Stage 3 — Summariser (3 days, optional).** Only if the user wants it after Stage 2 numbers.

**Stage 4 — Teams aggregation (1 week).**

**Release.** Meter for everyone, interventions in Premium marked beta, aggregation in Teams. `/numbers` post: "We checked Spotify's 90% on 439 real sessions: reads are 1.6%, the money is context times calls, here is what isolating loops saves."

---

## 9. Definition of done

- Stage 0: note exists with reproducible numbers and a mechanism section with doc links and live-session evidence; kill criterion decided.
- Stage 1: panel renders from an existing archive within 5 s for 1k sessions; live badge updates within one turn; golden tests pass; no network calls.
- Stage 2: on a clean machine `enable` leads to a logged nudge within one eligible session; killing Caprock mid-session never blocks a tool call; compliance and measured savings visible; calibration line shows N subagent runs.
- Stage 4: team totals reconcile with per-person panels.

---

## 10. Freedom

Package layout beyond section 4, storage for the intervention log, tokenizer for estimated events, classifier implementation (prefix rules are the floor; anything better is welcome if it stays explainable in the UI), nudge wording (must be tuned on real compliance data, not taste), and React structure. Fixed: formulas in section 5, fail-open contract, the free/paid split, and the rule that every displayed percentage carries its base.

---

## 11. Open questions (answer during Stage 0)

1. Does Claude reliably act on `additionalContext` mid-loop, or does it need the hard-mode deny? Decides the default.
2. Subagent usage visibility in transcripts. Decides whether "measured" is truly measured for the subagent side.
3. Does isolating with the same model (Opus subagent) already capture most of the saving, making the Haiku choice a secondary knob? The counterfactual should show both.
4. Whether OpenCode sessions get the meter in the same release (hook schema is compatible).
