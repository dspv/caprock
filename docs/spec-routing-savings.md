# Caprock Routing Savings — Implementation Spec

Status: draft for implementation
Owner: Dima (dspv)
Target: next major release of github.com/dspv/caprock
Audience: coding agent implementing the feature end to end
Conventions: github.com/dspv/kit (English only, Conventional Commits, no emoji, outcome-focused tasks, kill criteria)

---

## 0. TL;DR

Most Claude Code spend is I/O, not reasoning: whole-file reads and large Bash outputs enter the frontier model's context and then get re-sent on every subsequent turn. Spotify's `shunt` plugin blocks big reads and hands them to a cheap worker model; Claude receives a short summary instead of the file.

Caprock adds two things on top of that idea:

1. **Free tier — Savings Estimator.** Caprock already parses every session transcript. From that data it computes, retroactively and continuously, how much of the user's spend (dollars for API users, share of quota for subscription users) went into bulk I/O that a worker model could have absorbed, and what routing to each of three reference models would have saved. Nothing is blocked, no keys required. The number appears in the dashboard and on shared cards.
2. **Paid tier — Router.** Caprock installs Claude Code hooks that actually route bulk reads (and, after a research spike, large Bash outputs) to a user-chosen worker model, logs every delegation, and shows measured savings next to the estimate.

The free tier is the funnel; the paid tier is the product. The estimate must be honest enough that the measured number in the paid tier does not embarrass it.

---

## 1. Background and sources

### 1.1 The finding

On 2026-09-03 Spotify Engineering published "Portal by Spotify cut my Claude Code token usage by 90%" (Dimitri Mazmanov):
https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90

Key points from the source:

- Observation: most of what a coding agent does is I/O (reading five files to answer a question about one method, generating a test that mirrors twenty neighbours), not reasoning.
- First attempt was routing rules in CLAUDE.md. It failed: rules were advisory, Claude ignored them, and every project needed its own copy.
- Working version is a Claude Code plugin called `shunt` (Apache-2.0):
  https://github.com/spotify/portal-ai-plugins
  Three layers:
  - **Hooks.** Two `PreToolUse` hooks. `check-file-size` blocks any `Read` above a configurable line threshold (default 350, env `SHUNT_MIN_LINES`) and points Claude to the `/bulk-reader` skill. Targeted reads with offset/limit pass through. `check-bash-read` catches `cat`, `head`, `tail`, `less`, `more` on large files; piped commands pass through.
  - **Scripts.** `bulk-read --question ... --paths ...` wraps files in XML tags and sends them plus the question to the worker. `code-write --spec ... --reference ... --target ...` sends a spec and a reference file, strips markdown fences, writes straight to disk; Claude never sees the generated code.
  - **Skills.** Markdown files that tell Claude when and how to call the scripts. The system degrades gracefully: even if Claude ignores the skill, the hook still blocks the read.
- Worker model in the article: Gemini 2.5 Flash, temperature 0.2, instructions "structured bullets only, lead every bullet with the exact name, type, or line number".
- Benchmark: Java monorepo, four scenarios, tokens Claude would consume reading directly vs consuming the worker's summary. Mean bulk-read savings around 90%. Code-write not measured in tokens.
- Stated limits: cannot delegate editing (worker line numbers are unreliable), cannot delegate reasoning (worker missed a thread-safety bug Claude caught immediately), each delegation adds 10-30 s of latency, so below the line threshold delegation costs more than it saves.

### 1.2 Independent analysis of the finding (for calibration, not for copying)

- https://datapace.ai/blog/claude-code-token-usage-context-routing — frames it as "route tool output out of context before it enters the transcript"; the pattern generalises beyond files.
- https://induwara.lk/blog/2026-09-05-portal-by-spotify-cut-my-claude-code-token-usage-b — points out the 90% is a ceiling measured on a large-file Java monorepo; on repos with 120-line files the threshold rarely fires.
- https://dev.to/jamilxt/spotify-cut-claude-code-token-usage-by-90-percent-the-pattern-works-in-any-ai-agent-2i4b — decomposes the three-layer enforcement pattern as portable to any agent.

### 1.3 Pricing research (as of 2026-09-07, verify before release)

All prices USD per million tokens, standard tier.

| Model                 | Input | Output | Notes                                                                                                                                                                                                                                          |
| --------------------- | ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Haiku 4.5      | 1.00  | 5.00   | ~88 tok/s, TTFT ~0.6 s. Same price on Bedrock. No thinking by default. Source: https://www.anthropic.com/claude/haiku                                                                                                                          |
| Gemini 3.8 Flash      | 0.75  | 3.75   | Introductory; doubles to 1.50/7.50 on 2027-01-01. Thinking on by default, thinking tokens billed as output. TTFT reported ~8 s. Source: https://felloai.com/gemini-pricing/ , https://codersera.com/blog/gemini-3-8-flash-complete-guide-2026/ |
| Gemini 3.5 Flash-Lite | 0.30  | 2.50   | Cheapest usable Google tier. Source: https://benchlm.ai/google/api-pricing                                                                                                                                                                     |
| Gemini 2.5 Flash      | 0.30  | 2.50   | What Spotify used. Deprecated 2026-10-16. Do not ship as default. Source: https://www.cloudzero.com/blog/gemini-pricing/                                                                                                                       |
| DeepSeek V4 Flash     | 0.14  | 0.28   | 1M context, OpenAI-compatible endpoint api.deepseek.com. Cache hit input 0.0028. Data processed by DeepSeek (PRC). Source: https://www.morphllm.com/deepseek-api                                                                               |
| Claude Sonnet 5       | 2.00  | 10.00  | Reference frontier price. Cache write 1.25x input, cache read 0.10x input. Source: https://creditforstartups.com/pricing/claude-api-pricing                                                                                                    |
| Claude Opus 5         | 5.00  | 25.00  | Reference frontier price. Same cache multipliers.                                                                                                                                                                                              |

Consequences for this spec:

- Per delegation (~15k input tokens, ~500 output) Haiku and Gemini 3.8 Flash cost roughly the same (~$0.02); DeepSeek is ~10x cheaper (~$0.002). Cost does not separate Haiku from Gemini; latency and thinking behaviour do.
- Gemini models must be called with the lowest thinking level available, otherwise output cost and latency are unpredictable.
- Worker cost is a rounding error next to frontier cost. The decisive variables are latency and data residency, and the UI must present them as such.

### 1.4 Claude Code hook capabilities (verify against https://docs.claude.com/en/docs/claude-code/hooks before implementation)

- `PreToolUse` can return `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason`, which is shown to Claude. It can also return `updatedInput` to rewrite the tool input.
- `PostToolUse` can return `updatedToolOutput` (replaces the tool result before it enters context) and `additionalContext`.
- Hooks receive the full tool payload on stdin as JSON (`tool_name`, `tool_input`, `tool_response` on PostToolUse, `session_id`, `transcript_path`, `cwd`).
- Config is merged from `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`.

`updatedToolOutput` on `PostToolUse` is what makes the Bash track (section 9) possible without wrapper scripts: the command runs unchanged, the hook replaces an oversized result with a worker summary before Claude sees it.

### 1.5 Prior Caprock learning that constrains this spec

Caprock's first incarnation was a context-compression proxy for Bedrock. Honest measurement showed ~0% savings because prompt caching already made repeated context cheap. The product was killed within ten days. Two rules follow:

1. Any savings figure Caprock shows must model the prompt cache correctly (section 5).
2. Positioning is "Caprock shows whether routing saves anything, and turns it on if it does", never "Caprock saves tokens".

---

## 2. Problem statement

Caprock users fall into two groups with different pain:

- **Subscription users (Pro/Max, the majority of individual users).** They pay a flat monthly fee. Their pain is hitting usage limits. Dollars saved is a meaningless number for them; "share of limit spent on bulk I/O" is the meaningful one, and "buy back N% of your limit for $X/month of worker tokens" is the offer.
- **API / Bedrock users (teams, enterprises, Vova's team, Wematch).** They pay per token. Dollars saved is exactly the number they want, per person and aggregated, because the aggregate is what a manager shows to finance.

Neither group can currently tell how much of their spend is bulk I/O, and nobody in the market shows them.

---

## 3. Goals, non-goals, kill criteria

### Goal

A Caprock user opens the dashboard and sees, without configuring anything, what share of their Claude Code spend went to bulk I/O and what routing it to a worker would have saved for three reference models. A paid user enables routing with one command, picks a worker model with a clear statement of the trade-offs, and sees measured savings and added latency next to the estimate.

### Success metrics

- Estimator runs on every archived and live session with no user action and no external keys.
- Estimate for a session is reproducible: same transcript, same price registry, same result.
- On Dima's own 36-day dataset (~$9.7k list-price usage on a Max plan) the estimator produces a bulk-I/O share and a per-model projection; the number is documented in `/numbers` on caprock.dev.
- Paid router: measured savings per delegation are logged with tokens, dollars, and wall-clock latency; the panel shows measured vs estimated with the delta.
- Hooks fail open. A hook that errors, times out, or cannot reach Caprock never blocks a tool call.
- Share card includes the potential-savings block for free users.

### Non-goals (this release)

- `code-write` delegation. The counterfactual cannot be measured honestly (Spotify's own admission). Revisit after routing data exists.
- Delegating edits or reasoning. Never.
- Quality measurement of worker output. Out of scope; state it in the UI.
- Managed worker keys with markup billing. Decision deferred; ship BYOK first (section 7.4).
- Compaction-avoidance savings. Real but speculative; log the data, do not show a number.

### Kill criteria

- **Estimator stage.** If, on Dima's dataset and on Vova's dataset, bulk I/O (Read results above threshold plus Bash results above threshold) is under 15% of total context token-turns, stop. Ship nothing, write up the negative result on /numbers.
- **Router stage.** If measured savings on two weeks of real use are under 60% of the estimate for the same sessions, the estimator is dishonest; fix the model before shipping routing to anyone else.
- **Bash track.** If Bash results above threshold are under 20% of Bash tokens across both datasets, drop the track.

---

## 4. Architecture

Everything lives in the existing Go binary. No separate scripts, no Python, no plugin marketplace dependency.

```
caprock (Go binary)
  internal/routing/
    estimator/      transcript -> per-event savings model
    registry/       worker model registry (built-in + user)
    hooks/          `caprock hook <event>` entrypoints, fail-open
    worker/         adapters: anthropic, openai-compatible, gemini, bedrock
    delegate/       bulk-read implementation, logging
  ui (React, embedded)
    RoutingPanel    free estimator + paid controls
    ShareCard       potential-savings block
```

Data flow, free tier:

```
session transcript (already parsed by Caprock)
  -> event extractor (Read / Bash tool_results with token counts and turn index)
  -> estimator (formulas in section 5, prices from registry)
  -> per-session, per-project, per-period aggregates
  -> RoutingPanel + ShareCard
```

Data flow, paid tier:

```
Claude Code
  -> PreToolUse(Read)   -> caprock hook pre-read   -> deny + reason  (above threshold)
  -> PreToolUse(Bash)   -> caprock hook pre-bash   -> deny + reason  (cat/head/tail on big file)
  -> Claude calls `caprock bulk-read --question ... --paths ...`
  -> worker adapter -> summary to stdout -> Claude context
  -> delegation log (tokens in/out, latency, model, session_id, files)
  -> PostToolUse(Bash) -> caprock hook post-bash -> updatedToolOutput (Bash track, section 9)
  -> measured savings joined with estimator output for the same events
```

### 4.1 Hook binary contract

`caprock hook pre-read`, `caprock hook pre-bash`, `caprock hook post-bash`:

- Read JSON from stdin, write JSON to stdout, exit 0 always.
- Hard timeout 2 s for pre-hooks (decision only, no network). Post-bash may take up to the delegation timeout because it performs the worker call.
- Any internal error -> emit nothing (allow), log to Caprock's own log, increment a `hook_failopen` counter visible in the panel. Silent failure is a bug; loud fail-open is the design.
- Threshold source of truth is Caprock config, not Claude env, but `SHUNT_MIN_LINES` is honoured if set, for users migrating from shunt.

### 4.2 Installation

`caprock routing enable [--project]`:

- Merges hook entries into `~/.claude/settings.json` (or project settings with `--project`). Never overwrites existing hooks; appends to the matcher's array. Writes a backup first.
- Installs the skill file `~/.claude/skills/caprock-bulk-reader/SKILL.md` (or the project-local equivalent) with the exact invocation syntax.
- Validates the selected worker adapter with a 1-token test call and reports latency.
- `caprock routing disable` removes exactly what `enable` added and nothing else.
- `caprock routing status` prints threshold, worker, adapter health, last 10 delegations.

---

## 5. Measurement model

This is the load-bearing part. Get it right before any UI.

### 5.1 Events

From each session transcript extract:

- `ReadEvent{session, turn_index, path, lines, tokens_result}` for every `Read` tool result. `tokens_result` is the token count of the tool_result content. Prefer the delta of `input_tokens + cache_creation_input_tokens` between the assistant turn before and after the read; fall back to a tokenizer estimate on the content and mark the event `estimated=true`.
- `BashEvent{session, turn_index, command, tokens_result, classification}` for every `Bash` tool result. Classification in section 9.
- `turns_left` = number of assistant turns after this event in the same session before the next compaction boundary (Caprock already detects compaction; if not, detect by a drop in cached tokens).
- Session model and its price row (frontier prices from the registry).

Targeted reads (offset/limit present) are excluded from routable volume: they are what Claude would still do after a delegation.

### 5.2 Counterfactual cost of an event without routing

```
P_in     = frontier input price for the session model
P_cw     = 1.25 * P_in          cache write
P_cr     = 0.10 * P_in          cache read

cost_without = T * P_cw + T * turns_left * P_cr
```

Rationale: new content is written to cache once, then re-read from cache on every remaining turn. This is why the old naive model ("count every re-read at full input price") overstates, and why "count only the first read" understates. Both errors have burned this product before.

### 5.3 Cost of the same event with routing

```
T_sum    = summary tokens that replace the file in context
           (shadow mode: registry default per model, initial 400;
            paid mode: measured per delegation and fed back into the default)
T_ovh    = delegation overhead tokens in Claude's context
           (skill invocation + tool call + hook reason, initial 250)
W_in,W_out = worker prices
W_think  = expected thinking tokens for thinking models (registry, 0 for Haiku/DeepSeek,
           per-model default for Gemini, measured in paid mode)

cost_with = T * W_in
          + (T_sum + W_think) * W_out
          + (T_sum + T_ovh) * P_cw
          + (T_sum + T_ovh) * turns_left * P_cr
```

### 5.4 Savings and share

```
saved_usd        = cost_without - cost_with          (never shown below zero)
context_share    = sum over events of T * (1 + turns_left)
                   / sum over all context token-turns in the same sessions
latency_added_s  = count(events) * registry.median_latency_s[model]
```

Show `saved_usd` to API/Bedrock users. Show `context_share` (as "N% of what you fed Claude") to subscription users, with `saved_usd` as a secondary line labelled "at API list price". Always show `latency_added_s`.

### 5.5 Thresholds

- Line threshold default 350 (shunt parity). Panel slider: 150, 250, 350, 500, 800. Recompute on change; retroactive, instant.
- Below threshold, delegation overhead exceeds savings; the estimator must show savings going negative for small files rather than clamping the slider, so the user sees why the threshold exists.

### 5.6 Calibration loop (paid tier)

Every real delegation logs `T`, `T_sum` actual, `W_think` actual, latency, worker model. A nightly job updates the registry defaults for `T_sum`, `W_think`, and `median_latency_s` per model from the user's own data (local only). The panel shows "estimate calibrated on N of your delegations".

### 5.7 Honesty rules for displayed numbers

- Never display a percentage without the base ("90% of what?" was the whole problem with the source article). Always "saved $X of $Y" or "N% of context token-turns".
- Any figure derived from `estimated=true` events is shown with a tilde prefix.
- Compaction avoidance is logged, not displayed.
- Quality is not measured; the panel carries one sentence saying so.

---

## 6. Worker model registry

### 6.1 Schema

```yaml
id: haiku-4-5
name: Claude Haiku 4.5
adapter: anthropic            # anthropic | openai-compatible | gemini | bedrock
model_id: claude-haiku-4-5
price_in: 1.00
price_out: 5.00
thinking: none                # none | configurable | always
thinking_default_tokens: 0
median_latency_s: 4           # initial guess, overwritten by calibration
summary_tokens_default: 400
context_window: 200000
data_residency: "Anthropic (same vendor as your Claude sessions)"
privacy_flag: none            # none | third-party | prc
price_note: ""
price_checked: 2026-09-07
```

Built-in registry ships with three reference models plus alternates; users add their own (section 6.4).

### 6.2 The three reference models and how the UI must present them

The free tier shows all three side by side so the user understands what the saving depends on. The paid tier lets them pick. Each card carries a plain "if you choose this" statement:

**Claude Haiku 4.5** (default)
- Fastest: no thinking, sub-second TTFT. Lowest added latency.
- Your code stays with the same vendor that already sees it in Claude Code. No new data-processing agreement.
- Mid-priced worker, still ~90% cheaper than Sonnet 5 on input.
- If you choose this: expect the smallest latency hit and no privacy discussion. Cost difference vs Gemini is negligible.

**Gemini 3.8 Flash**
- Thinking on by default; thinking tokens are billed as output. Caprock forces the lowest thinking level, but cost per delegation is less predictable than Haiku.
- Reported TTFT around 8 s, so each delegation feels slower.
- Introductory price doubles on 2027-01-01; the registry carries the date and the panel shows the post-January figure alongside.
- Code goes to Google. Check your DPA.
- If you choose this: similar cost to Haiku, higher latency, a price cliff in January. Pick it only if you already have a Google AI contract you want to consolidate on.

**DeepSeek V4 Flash**
- 5-10x cheaper than the others; 1M context so it never needs chunking.
- Requests are processed by DeepSeek in the PRC. Caprock labels this `prc` and shows a red banner; for regulated employers this is a hard no.
- OpenAI-compatible endpoint, so the same adapter serves any custom model.
- If you choose this: worker cost becomes effectively zero; the only question is whether your code is allowed to leave the jurisdiction.

Alternates in the registry, not shown by default: Gemini 3.5 Flash-Lite (cheaper Google option), Haiku 4.5 on Bedrock (for users whose Claude Code already runs against Bedrock; same price, keeps everything in their AWS account).

### 6.3 Adapters

- `anthropic`: Messages API, `ANTHROPIC_API_KEY` or Caprock-stored key. Single call, no tools, no thinking.
- `openai-compatible`: base URL + key; serves DeepSeek and any custom model. Parse `usage` for tokens.
- `gemini`: Gemini API; set thinking level to minimum; read `usageMetadata` including thoughts tokens.
- `bedrock`: `bedrock-runtime converse`; uses the ambient AWS credential chain; model ID configurable.

Every adapter returns `{text, tokens_in, tokens_out, tokens_thinking, latency_ms}`. Worker prompt is the shunt bulk-reader prompt (section 1.1), stored as a template the user can edit.

### 6.4 Custom models

`caprock routing model add` prompts for the schema fields above. Required: adapter, model_id, price_in, price_out, data_residency. Everything else has defaults. A custom model is immediately available in both the estimator and the router. Registry is a YAML file under Caprock's config dir; built-in entries can be overridden by id.

---

## 7. Free vs paid

### 7.1 Free (all users, no keys, no hooks)

- Routing panel with the estimator: bulk-I/O share of context, projected savings for the three reference models, projected added latency, threshold slider, per-project breakdown, per-period trend.
- "On what" breakdown: Read results vs Bash results vs other, by count and by token-turns.
- Top 20 files and top 20 commands by counterfactual cost, so the user sees which repos and habits drive the number.
- Share card block (section 8).
- One-line CTA: "Routing is available in Premium. Measured, not estimated."

Deliberately generous. The free number is the acquisition hook; a stingy teaser gives nothing to screenshot.

### 7.2 Paid (Premium, individual)

- `caprock routing enable` / `disable` / `status`.
- Worker selection from the registry, custom models.
- Live routing with delegation log.
- Measured savings vs estimate, calibration status.
- Bash track once it passes its kill criterion.

### 7.3 Paid (Teams)

- Everything in Premium plus aggregation across people in the manager view: total measured savings, savings per person, adoption (who has routing enabled), worker spend vs frontier savings, and the same three-model projection for the whole team.
- This is the line a manager shows to finance; it is the reason Vova asked for the manager view in the first place.

### 7.4 Worker keys

Ship BYOK only in this release. The user brings an Anthropic, Google, DeepSeek, or AWS credential; Caprock stores it in the existing secrets location. Managed keys with markup are a business decision with billing implications; a stub interface (`KeyProvider`) is fine, nothing more.

### 7.5 Enforcement

Gate on the existing licence check. The estimator must work with no licence at all. If the licence check fails while routing is enabled, hooks fail open and the panel says routing is paused; do not silently keep routing.

---

## 8. Share card

Caprock already lets users share their numbers. Add a block to the card:

```
Bulk I/O: 31% of everything you fed Claude (Read 22%, Bash 9%)
Routing to Haiku 4.5 would have saved ~$412 of $1,340 this month
                     +11 min of waiting across 68 delegations
```

Rules:

- For subscription users the first line leads and the dollar line is labelled "at API list price".
- Always the base amount next to the saving. Never a bare percentage.
- If the user has routing enabled, replace "would have saved" with "saved" and use measured figures.
- The block is opt-out per share, on by default for free users.

---

## 9. Bash track (research spike, then feature)

Dima's own data suggests Bash results are the majority of his spend, not Read. Spotify's plugin only intercepts `cat`-style reads. The general case is: test runs, build logs, `git diff`, `grep -r`, `ls -R`, package installs, whose entire stdout enters context.

### 9.1 Spike (time-boxed, 2 days, before any feature work)

Goal: know, from real transcripts, whether large Bash results are a routable share of spend.

- Extract all `BashEvent`s from Dima's and Vova's archives.
- Classify by command prefix into: `test` (pytest, go test, npm test, jest, cargo test), `build` (make, go build, npm run build, tsc), `vcs` (git diff, git log, git status), `search` (grep, rg, find, ls), `pkg` (pip, npm install, go mod), `run` (everything else).
- For each class: count, total tokens, tokens in results above 2k / 5k / 10k tokens, and the counterfactual cost per section 5.2.
- Output: a markdown report in `.ai/notes/bash-spike.md` with the class table and a recommendation. Apply the kill criterion from section 3.

### 9.2 Mechanism (only if the spike passes)

Use `PostToolUse` on `Bash` with `updatedToolOutput`. The command runs unchanged; if the result exceeds the Bash token threshold (default 4k tokens, separate from the Read line threshold), the hook:

1. Keeps the last N lines verbatim (default 40) because exit status, failing test names, and error messages live there.
2. Sends the full output to the worker with a class-specific prompt ("summarise test output: list failing tests with file and line, then a one-line total" for `test`; "list changed files with additions/deletions and a one-line description per file" for `vcs`; generic bullets otherwise).
3. Returns `updatedToolOutput` = worker summary + separator + verbatim tail + one line telling Claude the full output is at `~/.caprock/bash/<session>/<turn>.log` and can be read with offset/limit.
4. Logs the delegation exactly like a read delegation.

Fallback if `updatedToolOutput` is unavailable or fails: `PreToolUse` with `updatedInput` appending `2>&1 | tee ~/.caprock/bash/<id>.log | tail -n 40` is a cheaper, dumber alternative that still keeps the full log on disk. Implement it behind a flag; it is what shunt would do if it handled Bash.

Never intercept: commands under a configurable allowlist (`git commit`, `git push`, anything the user marks), commands whose result is below threshold, and interactive commands.

### 9.3 Estimator integration

The free-tier estimator includes Bash events from day one using the same formulas, with `T_sum` default 300 and an extra `T_tail` term for the verbatim tail. The "On what" breakdown shows Bash separately so users see whether their problem is reads or commands.

---

## 10. UI

Keep the existing Caprock visual language. One new panel, one new share block, one new settings section.

**Routing panel, free state**

- Header: "Routing savings (estimated)" with the period selector.
- Big number: for API users `$412 of $1,340`, for subscription users `31% of context`. Subtitle with the other number.
- Three model cards side by side per section 6.2, each with projected saving, projected latency, privacy flag, and the "if you choose this" line.
- Threshold slider; the cards recompute live.
- "On what" bar: Read / Bash / other.
- Top files, top commands tables.
- Footer: quality disclaimer, estimate provenance (`N events, M estimated`), CTA.

**Routing panel, paid state**

- Same layout; big number switches to measured, with "estimate: $X" underneath and the delta.
- Worker selector with the same cards, plus "Add custom model".
- Delegation log: time, session, files or command class, tokens in/out, dollars, latency, status.
- Calibration line.
- Enable/disable, status, fail-open counter.

**Teams manager view**

- Table: person, routing enabled, measured saved, worker spend, net, delegations, mean latency.
- Team total in the header. Same three-model projection for the whole team below.

---

## 11. Release plan

One major release, staged branches, each stage independently mergeable behind flags.

**Stage 0 — Spike (3-4 days).** Event extractor for Read and Bash on existing archives. Run on Dima's and Vova's data. Report to `.ai/notes/routing-spike.md`. Apply kill criteria. This stage decides whether the rest happens.

**Stage 1 — Estimator, free (1.5 weeks).** Registry, formulas, aggregates, panel in free state, share block. Retroactive on the full archive on first run, incremental after. Tests: golden transcripts with known expected numbers.

**Stage 2 — Router, paid, flagged (2 weeks).** Hooks, adapters, `bulk-read`, delegation log, install/uninstall, panel paid state, calibration job. Flag on for Dima (subscription path) and Vova (API path) only. Two weeks of dogfooding; apply the router kill criterion.

**Stage 3 — Bash track (1 week, conditional on the spike).** PostToolUse hook, class prompts, log on disk.

**Stage 4 — Teams aggregation (1 week).** Manager view columns and team projection.

**Release.** Estimator to everyone, router in Premium marked beta, Teams aggregation in Teams. Changelog entry, /numbers page update with Dima's real figures, launch post draft in `.gtm/`.

Total: 5-6 weeks solo, with two decision points where the work can stop cheaply.

---

## 12. Definition of done per stage

- Stage 0: report exists, numbers reproducible from a command, decision recorded.
- Stage 1: panel renders on a fresh install with an existing archive within 5 s for 1k sessions; golden tests pass; share block visible; no network calls.
- Stage 2: `caprock routing enable` on a clean machine results in a working delegation within one Claude Code session; killing the worker endpoint mid-session does not block Claude; delegation log matches provider usage numbers within 2%; measured vs estimated visible.
- Stage 3: a 20k-token `go test` output arrives in Claude's context as under 2k tokens with the failing tests and the tail intact; full log on disk.
- Stage 4: manager view shows the team total and the per-person rows; numbers reconcile with the per-person panels.

---

## 13. Freedom

The implementing agent chooses: internal package layout beyond section 4, storage format for the delegation log (SQLite is already in the binary if present; otherwise JSONL), tokenizer for estimated events, exact React component structure, and prompt wording for class-specific Bash summaries. The formulas in section 5, the fail-open contract in section 4.1, the honesty rules in section 5.7, and the free/paid split in section 7 are fixed.

---

## 14. Open questions (answer before Stage 2, not before Stage 0)

1. Managed worker keys with markup: yes/no, and if yes, which billing provider. Not needed for dogfooding.
2. Whether OpenCode sessions (already supported by Caprock) should get routing. The hook schema is compatible; treat as a fast follow.
3. Whether to publish the hooks as a shunt-compatible plugin for users who want routing without Caprock. Marketing decision.

---

## 15. Source list

- Spotify Engineering, 2026-09-03, "Portal by Spotify cut my Claude Code token usage by 90%": https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90
- Spotify `portal-ai-plugins` (shunt): https://github.com/spotify/portal-ai-plugins
- Claude Code hooks reference: https://docs.claude.com/en/docs/claude-code/hooks
- Claude API pricing: https://www.anthropic.com/claude/haiku , https://creditforstartups.com/pricing/claude-api-pricing
- Gemini pricing: https://felloai.com/gemini-pricing/ , https://www.cloudzero.com/blog/gemini-pricing/ , https://benchlm.ai/google/api-pricing
- DeepSeek pricing: https://www.morphllm.com/deepseek-api
- Analysis: https://datapace.ai/blog/claude-code-token-usage-context-routing , https://induwara.lk/blog/2026-09-05-portal-by-spotify-cut-my-claude-code-token-usage-b
