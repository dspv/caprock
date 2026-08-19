# Caprock — Build Status

The running log: what is done, what is not, what is next. **Update this file and § Current State in [00-index.md](00-index.md) whenever the state of the world changes.** Dates in absolute form, never "last week". What "done" means per task is defined in [09-execution-plan.md](09-execution-plan.md).

**Last updated: 2026-08-19** · Phase **2 — Orchestrate, complete** · **v0.1.0 tagged and published** (Observe; cask in `dspv/homebrew-tap`). The live unattended orchestrator run (the Phase 2 tag gate) is done — a real `claude` orchestrator autonomously assigned a task, spawned a worker, and drove it to green verification. Next: **v0.2.0 (Control) / v0.3.0 (Orchestrate) tags** as each is signed off on the OS matrix.

## Progress by track

Percentages are deliberately coarse — they answer "is this track started, half-built, or done", nothing finer. The same numbers drive the progress bars in [README.md](../README.md); **update both in the same commit.** "90%" means "works, not hardened"; never 100% for anything that has not run in the environment it was built for.

| Track                           | Progress | State                                                                 |
| ------------------------------- | -------- | --------------------------------------------------------------------- |
| Documentation (`.ai/`)          | 90%      | Corpus built, audit green, kept current with code                     |
| Phase 0 — Observe (T0–T10)      | 100%     | Works on macOS + CI (macos/ubuntu/windows); v0.1.0 tagged + published |
| Phase 1 — Control (T11–T16)     | 90%      | Merged to master, green on the 3-OS CI matrix                         |
| Phase 2 — Orchestrate (T17–T25) | 100%     | All tasks done; live unattended run with hooks passed (tag gate met)  |
| Phase 3 — Delight               | 0%       | No plan by design                                                     |

## Milestone status

| #       | Milestone                    | Status                                                                 |
| ------- | ---------------------------- | ---------------------------------------------------------------------- |
| M0      | Spec migration + loss audit  | done                                                                   |
| T0      | ConPTY spike                 | done (informational; ptyspike job)                                     |
| T1      | Repo bootstrap               | done                                                                   |
| T2      | store + migrations           | done                                                                   |
| T3      | hookd + shim + installer     | done                                                                   |
| T4      | ingest                       | done                                                                   |
| T5      | rollup + pricing             | done (parity vs formula; OQ-01 resolved)                               |
| T6      | api + live WS                | done                                                                   |
| T7      | UI: Now + Session Detail     | done                                                                   |
| T8      | UI: Cost                     | done (limit forecast deferred, OQ-03)                                  |
| T9      | Loop detector                | done                                                                   |
| T10     | Release hardening → v0.1.0   | done (v0.1.0 tagged + published 2026-08-19; cask in dspv/homebrew-tap) |
| T11–T16 | Phase 1 (Control) → v0.2.0   | done                                                                   |
| T17–T25 | Phase 2 (Orchestrate)→v0.3.0 | done                                                                   |

## What is true right now

- **All three phases are built and green.** The Go module + `ui/` exist and are exercised by `make check` (Go tests, `go vet`, `golangci-lint`, docs gates, and the UI typecheck/vitest/build) on the 3-OS CI matrix. Phase 2's orchestration loop has been driven end to end by a real `claude` orchestrator (see the Phase 2 log entry). **v0.1.0 (Observe) is tagged and published** (Homebrew cask in `dspv/homebrew-tap`); Control and Orchestrate ship at v0.2.0 / v0.3.0.
- The Python measurer (`~/dev/caprock-legacy`, PyPI `caprock` 0.3.0) is frozen ([ADR-007](08-decisions.md#adr-007--the-harness-is-caprock-new-go-codebase-in-dspvcaprock-python-measurer-frozen)); the Go binary shipped its first release as **v0.1.0** on 2026-08-19.
- Toolchain versions in [10-infrastructure.md](10-infrastructure.md) were checked on 2026-08-18 and are now exercised in CI.

## Log

### 2026-08-18 — Phase 2 complete: orchestrator, verification runner, cost attribution, e2e (T21–T25)

The trust gap is closed end to end. `internal/orchestrator` spawns the orchestrator as a real `claude` session with a hive-aware system prompt (`.ai/07-orchestrator.md`, embedded + kept in sync by a test), spawns workers into per-worker git worktrees, and runs the mailbox router; the daemon maps a session id back to its hive agent so the Stop-loop checks the right inbox. `internal/board`'s verification runner runs a task's `done_criteria` in the assigned worker's worktree — all green ⇒ `done` (and cost is attributed to the task via the assignment windows), any red ⇒ bounce the failing output to the worker, escalate to `needs_you` after R=3 rounds. Verified two ways at the time: live on macOS (`caprock up --hive` → `POST /v1/orchestrator/start` spawns a real orchestrator that registers in the hive and gets its prompt), and a scripted `-tags smoke` e2e on a fixture repo (task → assign → failing build → verify fails → bounce → worker fixes → verify passes → done, cost attributed). New endpoints: `POST /v1/orchestrator/start`, `POST /v1/tasks/{id}/verify`; `--hive`/`--repo` flags. The full unattended run followed the next day (see below).

### 2026-08-19 — Tag gate met: real orchestrator drives a task to green, autonomously

The unattended run is done. With hooks installed in a real `~/.claude/settings.json`, `POST /v1/orchestrator/start` spawned a real `claude` orchestrator that read the task board, set `assignee`+`status: assigned`, and wrote an `assign` message; the router materialized that intent — spawned `worker-1` into its worktree, the worker wrote the missing function, reported a `result`, and the orchestrator moved the task to `verifying`; the router ran `go build`/`go vet`, both passed, and the task reached `done` — start to finish with no human input. Getting there closed three real gaps the earlier "complete" hid: (1) the router ran under the per-request context and died the instant `/orchestrator/start` returned — now it runs under the daemon-lifetime `BaseCtx`; (2) a freshly-spawned interactive `claude` waits for a first message and does not react to inbox files landing, so `SpawnWorker` was never triggered and verification was never driven — the router is now a reconciler that spawns a worker per assigned task, runs verification for each `verifying` task (in-flight-guarded), and re-kicks (throttled) any idle session with unread mail; the orchestrator/worker each get one initial typed "kick" to start their first turn; (3) the folder-trust dialog (which `--dangerously-skip-permissions` does not suppress) is pre-accepted in `~/.claude.json` (`hasTrustDialogAccepted`) before spawn, so a session starts in its main loop instead of blocking. Design was decided by an agent council per `.ai/06-engineering-rules.md § Council quorum`. See `.ai/05-orchestration.md § the router is a reconciler`.

### 2026-08-18 — Phase 2 (Orchestrate) foundation: hive, board, Stop-loop, approvals (T17–T20)

The trust-gap machinery's base is in and tested. `internal/hive` is the on-disk source of truth (agents/tasks/mailboxes/ledger, single writer, atomic writes, a dependency-free YAML reader/writer for the fixed task schema, validated kanban transitions). `internal/board` bridges it to the SQLite mirror and the API and answers the worker's Stop hook — forcing continuation while the inbox is non-empty, with the N=10 guard escalating to `needs_you`. Approve/reject move the task and notify the orchestrator by mailbox. `caprock up --hive <dir>` turns it on; the task endpoints return 501 otherwise. Verified live on macOS: tasks created via the API become `tasks/*.md` files and render on the kanban. A costly lesson this session: an accidental `git add -A` while Phase 2 files sat in the tree leaked them onto the Phase 1 branch and broke its CI on all three OS; the fix was to reset the branch to its last clean commit and re-apply only the intended changes — a reminder to stage explicitly when multiple phases share a working tree. Phase 1 merged to master green on the matrix (PR #2); Phase 0's T7/T8 merged as PR #1.

### 2026-08-18 — Phase 1 (Control) lands on a branch: spawn, terminal, control, auto-pause, History

Verified end-to-end on macOS: from the dashboard I spawned a real `claude` session into a demo repo, typed a task into its live xterm.js terminal, watched Claude create a file, and controlled it with owned-only pause/resume/kill. `internal/ptyman` (the T0 backend) drives it; `internal/agents` owns spawn/stream/input/signal/exit with `claude --session-id <uuid>` so hooks and transcript land under the id Caprock already knows, and strips inherited Claude/Caprock nesting env so an owned session is a normal top-level session. Two subtle bugs found and fixed while dogfooding: `/v1/status` never populated `claude_available` (spawn worked but the UI showed observe-only), and Spawn used the HTTP request context so the process was killed the instant the response was sent (`signal: killed`) — now `context.WithoutCancel`. Auto-pause is opt-in and owned-only. History (T15) reports lifetime sessions/turns/tool-calls/files/avg-duration/cache-hit/cost plus tool distribution, model mix and top projects. New endpoints: `POST /v1/agents`, `/v1/agents/{id}/input|signal`, `WS /v1/agents/{id}/term`, `GET /v1/history`. Migration 0003 adds `owned`, `worktree`, `throttle_observations` (verbatim) + spawn bookkeeping.

### 2026-08-18 — Phase 0 backend + first UI cut land on master (T1–T6, T9; T7/T8/T10 half)

One evening from empty repo to a working observe-only mission control: `store` (pure-Go SQLite, DDL v1 verbatim + additive v2), `cost` (versioned pricing, cache-savings formula ported from `_savings.py`), `rollup` (single write path), `hookd` + `internal/shim` + `caprock-hook`, `hooks` installer (ordered-JSON merge — the user's key order survives), `ingest` (fsnotify + poll tailer, schema-versioned parser, golden fixtures), `loop` (episode-based, normalized signatures), `narrate` (phrase/health/plan), `gitdiff`, `api` (REST + WS + embed), `daemon`, the `caprock` CLI (`up` detached, `down` via token-gated shutdown, `status`, `hooks`), the smoke DoD scenario, and a React 19 / Vite 8 / TS 7 dashboard with Now, Session Detail (timeline / live diff / files) and Cost. Two facts learned from real transcripts that the spec could not know: one API response is written as several assistant lines repeating the same usage (dedupe by `message.id`, verified across 16k groups), and `<synthetic>` model lines are not turns. Everything except the OS matrix is green locally: `go test ./...`, `golangci-lint`, `tsc`, `vitest`, `make docs-check docs-links`, `go test -tags smoke`.

### 2026-08-18 — Corpus built from the hand-off spec; repo prepared for development

The template repo (`corpus`) was turned into Caprock's home: `CaprockV2-SPEC.md` decomposed into eleven `.ai/` files with zero information loss, audited by parallel reviewer subagents ([docs/migration-audit.md](../docs/migration-audit.md)), then deleted; MIT license replaced with Apache-2.0; template-only files (`TEMPLATE.md`, `CONTRIBUTING.md`) removed; README, CLAUDE.md, AGENTS.md rewritten. While preparing, three facts surfaced that the spec did not know: (1) Claude Code now ships a native `type: "http"` hook — rejected in favour of the shim because it shows a transcript error when the daemon is down ([ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type)); (2) the legacy repo has no `pricing.json` or transcript fixtures, so the pricing table is authored from the Anthropic pricing page and T5 parity is redefined ([ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson), `OQ-01`); (3) the current Stop-hook output shape differs from the spec's (`OQ-06`). Toolchain pinned to latest stable ([ADR-017](08-decisions.md#adr-017--toolchain-go-126-moderncorgsqlite-coderwebsocket-fsnotify-cobra-react-19--vite-8--typescript-7-native-tailwind-4-vitest)).
