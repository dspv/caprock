# Caprock — Product

What Caprock is, who it is for, what it promises, and what it deliberately is not. The mechanism is in [02-architecture.md](02-architecture.md); the screens are in [04-ui.md](04-ui.md); the plan is in [09-execution-plan.md](09-execution-plan.md); closed decisions are in [08-decisions.md](08-decisions.md).

**Identity:** Caprock · owner Dima · repo `github.com/dspv/caprock` · domain `caprock.dev` · license Apache-2.0. Spec status at hand-off: v1.0, handed off to development 2026-08-18.

## One-liner

A local, open-source **mission control for Claude Code**: spawn and orchestrate multiple real `claude` sessions, watch them work through a live, *useful* dashboard (activity, plan progress, diffs, token burn, cost), intervene with one click, and accumulate statistics across every session you ever run.

Utility first. The fun layer (avatars, office floor) is a skin added later on top of the same event stream.

## The core loop

```
user starts / spawns a claude session
  → hooks + transcript stream events into the daemon (event plane)
  → daemon normalizes → SQLite → rollups (tokens, cost, activity, alerts)
  → browser dashboard shows Now / Session Detail / Cost / History / Tasks
  → user intervenes (message, pause, kill, approve) or lets an orchestrator run
  → verified task results and lifetime stats accumulate locally
```

Everything else is out of scope; the phase gates and cut lines are in [09-execution-plan.md](09-execution-plan.md).

## Prior art: Munder Difflin

- **Repo:** https://github.com/chaitanyagiri/munder-difflin · **Site:** https://munderdiffl.in · MIT (code), pixel-art assets non-commercial (LimeZu).
- **What it is:** Electron desktop app; wraps CLI agents (Claude Code, Codex, Copilot CLI, Grok, Gemini/Antigravity, Qwen, …) as persistent PTY workers with mailboxes, shared memory, and a "GOD" orchestrator clone; visualized as *The Office*-themed simulation.
- **Measured effect (as of 2026-08):** r/ClaudeCode launch post — **1,040 upvotes, 180 comments in 3 days**; Product Hunt launch; author reports **~2,000 users, ~677 GitHub stars, ~40 releases in 2 months** (v0.0.1 → v0.4.x); some directories list 1,200+ stars. Numbers vary by source and move fast — treat as order-of-magnitude, verify before quoting publicly.
- **Why it landed:** the office simulation made agent activity legible to non-engineers and gave the project a story; local-first + free + MIT removed all adoption friction; "runs on the subscription you already pay for" answered the cost objection.
- **Where it already went** (don't underestimate): v0.2.0 added per-agent token budgets, OpenTelemetry observability, a circuit breaker, and SQLite persistence; later versions added Slack driving, GitHub-webhook → task ingestion, voice, and mixed-capability swarms (Opus orchestrator + cheap workers). Our edge is *not* "they have no telemetry" — see § Problem & evidence and § Complaint → feature traceability below.

## Problem & evidence

1. **Dead-air waiting.** You give Claude a task and stare at a scrolling terminal or check your phone. There is nothing useful to watch: no progress, no plan state, no "what is it actually doing right now."
2. **Token anxiety.** Usage limits feel opaque; users report burning daily budgets in minutes when a session loops, and per-task cost is invisible until it's too late.
3. **Trust gap for autonomy.** The #1 question people ask multi-agent harnesses: *how does the orchestrator know a worker is actually done?* Nobody wants to leave agents unattended without verification.
4. **Reliability & platform gap.** Munder Difflin proved demand but its Electron + node-pty stack keeps biting: a Product Hunt reviewer on Windows hit a startup failure that killed his three-agent benchmark and declined to adopt the runtime; the team's own blog documents a release-breaking bug at the CommonJS/ESM boundary. Native-addon rebuilds (`electron-rebuild` against Electron's ABI) are a recurring install-failure class.
5. **Spawn-only visibility.** It only sees agents *it* spawned. Nobody serves the much larger population who just run `claude` in a terminal today and want to see what it's doing and costing — without changing their workflow.

## Target users

- **Power users of Claude Code** running 2–10 sessions/worktrees in parallel (Dima is user zero).
- **Vibe-coders** who don't read raw terminal output and need a human-readable "what's happening" view.
- **Budget-conscious subscribers** ($20/$100/$200 plans) who need burn-rate visibility.

## Complaint → feature traceability

Every MVP feature must trace to a documented user pain. **Rule: a feature with no entry here is a candidate for cutting. New complaints from launch feedback get added as entries first, features second.**

1. **"One session in a loop can drain your daily budget in minutes."**
   - Evidence: Reddit threads on Claude usage limits (widely reported, incl. BBC coverage).
   - Feature: loop detector + auto-pause ([04-ui.md § Now](04-ui.md#now-default-the-useful-waiting-screen)). Phase 0.
2. **"Usage limits hit way faster than expected / consumption is opaque."**
   - Evidence: same wave of complaints; Anthropic acknowledged and investigated.
   - Feature: live burn-rate + limit forecast ([04-ui.md § Cost & Burn](04-ui.md#cost--burn)). Phase 0.
3. **"Isn't that a fortune in tokens?" — first question on every harness launch.**
   - Evidence: Munder Difflin PH thread (author pre-empts it in the pitch).
   - Feature: cost per task/agent/model up front, cheap-worker/expensive-orchestrator presets. Phase 0/2.
4. **"How does the orchestrator decide a worker is finished?" — the blocker before unattended use.**
   - Evidence: Munder Difflin PH review (top substantive comment).
   - Feature: verification runner — `done_criteria` commands must pass before a task closes ([05-orchestration.md](05-orchestration.md)). Phase 2.
5. **"Windows startup failed, I'm not ready to adopt the runtime."**
   - Evidence: Munder Difflin PH review, v0.4.3.
   - Feature: Go static binary, ConPTY-tested, CI on 3 OS from Phase 0 ([02-architecture.md § Cross-platform](02-architecture.md#cross-platform-do-it-right-on-day-one)). Phase 0.
6. **Staring at a blank terminal / checking the phone while Claude works.**
   - Evidence: Dima's own pain; the entire premise of the office-sim's appeal ("makes activity visible without staring at a terminal").
   - Feature: the **Now** screen — narration, plan progress, live diff ([04-ui.md](04-ui.md) § Now, § Session Detail). Phase 0.
7. **"I want to watch the sessions I already run, not adopt a new runtime."**
   - Evidence: implied by #5 — reviewer reused *patterns*, rejected the *runtime*.
   - Feature: observe-only mode on externally started sessions ([02-architecture.md § Data sources](02-architecture.md#data-sources)). Phase 0.

## Product principles

1. **Every pixel earns its place** — each screen answers "what's happening / what does it cost / where do I need to act."
2. **Local-first, zero servers** — all data stays on the machine. Same trust story that made Munder Difflin land.
3. **Read before write** — v0 must be useful even in *observe-only* mode on sessions the user starts themselves. Orchestration is additive.
4. **Single static binary** — Go core, no native-addon build pain, macOS/Linux/Windows from day one.
5. **Plain files over cleverness** — mailboxes and task state are markdown/JSON on disk, inspectable with `cat`.

## What the user gets

- **Phase 0 (observe):** `caprock up` → `localhost:4173` → every `claude` session on the machine appears live with human-readable activity, token/cost totals, an event timeline, a live `git diff`, and a loop banner when a session repeats itself. Works on sessions started in any terminal, without changing the user's workflow.
- **Phase 1 (control):** spawn/kill/type into sessions from the UI (real PTY, xterm.js), auto-pause looping sessions Caprock owns, History screen with lifetime stats.
- **Phase 2 (orchestrate):** a Tasks board, an orchestrator session that decomposes and routes tasks to workers, mailboxes, Stop-loop autonomy, verification-before-done, and an approvals queue.
- **Phase 3 (delight):** avatar/office render mode, packaging, maybe TUI — only if Phase 2 traction justifies it.

Full definitions of done per phase: [09-execution-plan.md](09-execution-plan.md).

## Free tier / limits

Free OSS through Phases 0–1; the open-core (team/cloud tier) decision is deferred until post-Phase-2 traction. **Solo/local mode stays free permanently** ([ADR-005](08-decisions.md#adr-005--monetization-free-oss-through-phases-01-open-core-deferred-solo-mode-free-forever)). There is no cap to enforce: nothing phones home, nothing is metered.

## Trust contract

Promises enforced by code, each with the test that proves it:

- **The hook shim never breaks a user's Claude session** — any error path is silent `exit 0` within a 1s budget; the shim never prints to stdout except the Phase 2 Stop-decision reply. Enforced by the shim's integration test (daemon down → exit 0 in <1s) — see [03-contracts.md § Hook shim](03-contracts.md#hook-shim).
- **All data stays on the machine** — the daemon binds `127.0.0.1` only, and nothing about the user ever leaves. The one outbound call in the codebase is the release check (`internal/update`), which is off unless the user turns it on and asks GitHub for a version tag with no body, credentials, or usage data attached. Enforced by review of any new outbound HTTP client ([06-engineering-rules.md](06-engineering-rules.md)).
- **We never signal a process we did not start** — auto-pause acts on owned sessions only ([05-orchestration.md](05-orchestration.md), [09-execution-plan.md § Phase 1](09-execution-plan.md#phase-1--control)). Externally observed sessions are alert-only.
- **`caprock down` removes nothing from user data**; restart restores history from SQLite. Enforced by the Phase 0 DoD smoke test.
- **Historical cost is never silently recomputed** — costs are computed at write time under `meta.pricing_version` and a pricing bump never rewrites old rows ([03-contracts.md § Pricing table](03-contracts.md#pricing-table)).
- **Forecasts are labeled as estimates** — the limit forecast is learned from observed throttles and never presented as ground truth ([04-ui.md § Cost & Burn](04-ui.md#cost--burn)).
- **Unknown hook events and unknown transcript fields are logged and ignored, never fatal.**

## Relationship to Caprock-python (heritage)

**What Caprock was before this repo:** a free local stats utility for Claude Code (tokens, cache hit-rate, session cost), Python on PyPI, built on top of upstream Headroom (Dima contributes there), Apache-2.0, no monetization by design (resume value).

**Assessment:**

- ✅ Reusable: pricing tables, transcript JSONL parsing knowledge, cache/cost math, the brand + caprock.dev domain, "honest measurement" reputation.
- ⚠️ Not reusable as a base: Python is wrong for a long-running daemon owning PTYs; the Headroom dependency ties the roadmap to an upstream built for a different purpose (compression analysis, not live orchestration). A mission-control daemon must own its ingest path.

**Resolved ([ADR-007](08-decisions.md#adr-007--the-harness-is-caprock-new-go-codebase-in-dspvcaprock-python-measurer-frozen)):** the harness **is** Caprock — new Go codebase, new repo at `dspv/caprock` (personal profile for the launch story and portfolio visibility; transferable to an org later if open-core happens). The Python measurer is frozen: its repo is archived read-only, published PyPI versions keep working, and its `pricing.json` + transcript fixtures are copied into this repo for the T5 parity test (see [OQ-01](12-risks.md#open-questions) — the legacy repo does not actually contain a `pricing.json` file; what it has is documented there).

**Original analysis, kept for the record — "Option B with a brand bridge":**

- **New Go core, new repo.** Port cost/cache math and JSONL schema handling from Caprock (rewrite, not wrap).
- **Caprock stays alive** as the lightweight "just measure" tool; its README points to the new project as "Caprock's big brother". If the new thing takes off, fold Caprock in as `<name> stats` and keep caprock.dev as either the product domain or a redirect.
- This preserves Caprock's resume/OSS value, avoids carrying Headroom, and keeps the option of a Caprock-branded pivot open without betting on it now.
- Rejected: pivoting Caprock in-place (Python lock-in, breaks existing users' expectations of a tiny measurer).

## Out of scope (v0.x — deliberately skipped)

- Pixel-art office, avatars, animations — later, as a render mode of the event stream (and only with cleanly licensed assets; Munder Difflin's LimeZu art is non-commercial).
- Multi-provider engines (codex/gemini/grok) — architecture keeps `command` configurable per agent, but only `claude` is tested/supported in MVP.
- P2P / team features, cloud anything.
- Semantic memory index — plain markdown memory per agent is enough.
- Phase 0 non-goals specifically: spawning agents, typing into sessions, tasks/kanban, mailboxes, approvals, avatars.
