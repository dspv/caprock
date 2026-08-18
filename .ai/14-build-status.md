# Caprock — Build Status

The running log: what is done, what is not, what is next. **Update this file and § Current State in [00-index.md](00-index.md) whenever the state of the world changes.** Dates in absolute form, never "last week". What "done" means per task is defined in [09-execution-plan.md](09-execution-plan.md).

**Last updated: 2026-08-18** · Phase **1 — Control, in progress** · Next: **T10/T16 releases (v0.1.0, v0.2.0) once merged and green on the OS matrix**

## Progress by track

Percentages are deliberately coarse — they answer "is this track started, half-built, or done", nothing finer. The same numbers drive the progress bars in [README.md](../README.md); **update both in the same commit.** "90%" means "works, not hardened"; never 100% for anything that has not run in the environment it was built for.

| Track                           | Progress | State                                                        |
| ------------------------------- | -------- | ------------------------------------------------------------ |
| Documentation (`.ai/`)          | 90%      | Corpus built, audit green, kept current with code            |
| Phase 0 — Observe (T0–T10)      | 90%      | Works on macOS + CI (macos/ubuntu/windows); T10 release open |
| Phase 1 — Control (T11–T16)     | 80%      | Spawn/terminal/kill, auto-pause, History work on macOS       |
| Phase 2 — Orchestrate (T17–T25) | 0%       | Not started                                                  |
| Phase 3 — Delight               | 0%       | No plan by design                                            |

## Milestone status

| #       | Milestone                   | Status                                     |
| ------- | --------------------------- | ------------------------------------------ |
| M0      | Spec migration + loss audit | done                                       |
| T0      | ConPTY spike                | not started                                |
| T1      | Repo bootstrap              | done                                       |
| T2      | store + migrations          | done                                       |
| T3      | hookd + shim + installer    | done                                       |
| T4      | ingest                      | done                                       |
| T5      | rollup + pricing            | done (parity vs formula; OQ-01 open)       |
| T6      | api + live WS               | done                                       |
| T7      | UI: Now + Session Detail    | 50% (first cut works; hardening via PR)    |
| T8      | UI: Cost                    | 50% (first cut works; hardening via PR)    |
| T9      | Loop detector               | done                                       |
| T10     | Release hardening → v0.1.0  | 50% (CLI + smoke + CI written; no tag yet) |
| Phase 1 | T11–T16 → v0.2.0            | not started                                |
| Phase 2 | T17–T25 → v0.3.0            | not started                                |

## What is true right now

- **Nothing is built.** There is no Go module and no `ui/`; the CI workflows (`docs.yml`, `ci.yml`, `release.yml`), `Makefile`, `.goreleaser.yaml` and `pricing/pricing.json` are written but have never run against code. Everything in [02-architecture.md](02-architecture.md), [03-contracts.md](03-contracts.md), [04-ui.md](04-ui.md) describes intent, not a running system.
- The Python measurer (`~/dev/caprock-legacy`, PyPI `caprock` 0.3.0) is the only shipped Caprock artifact and is frozen ([ADR-007](08-decisions.md#adr-007--the-harness-is-caprock-new-go-codebase-in-dspvcaprock-python-measurer-frozen)).
- Unverified: `ASSUMPTION-01`…`08`; blocking open questions `OQ-01`, `OQ-07` ([12-risks.md](12-risks.md)).
- Toolchain versions in [10-infrastructure.md](10-infrastructure.md) were checked on 2026-08-18 and not yet exercised in CI.

## Log

### 2026-08-18 — Phase 1 (Control) lands on a branch: spawn, terminal, control, auto-pause, History

Verified end-to-end on macOS: from the dashboard I spawned a real `claude` session into a demo repo, typed a task into its live xterm.js terminal, watched Claude create a file, and controlled it with owned-only pause/resume/kill. `internal/ptyman` (the T0 backend) drives it; `internal/agents` owns spawn/stream/input/signal/exit with `claude --session-id <uuid>` so hooks and transcript land under the id Caprock already knows, and strips inherited Claude/Caprock nesting env so an owned session is a normal top-level session. Two subtle bugs found and fixed while dogfooding: `/v1/status` never populated `claude_available` (spawn worked but the UI showed observe-only), and Spawn used the HTTP request context so the process was killed the instant the response was sent (`signal: killed`) — now `context.WithoutCancel`. Auto-pause is opt-in and owned-only. History (T15) reports lifetime sessions/turns/tool-calls/files/avg-duration/cache-hit/cost plus tool distribution, model mix and top projects. New endpoints: `POST /v1/agents`, `/v1/agents/{id}/input|signal`, `WS /v1/agents/{id}/term`, `GET /v1/history`. Migration 0003 adds `owned`, `worktree`, `throttle_observations` (verbatim) + spawn bookkeeping. Not yet run on the OS matrix for Phase 1.

### 2026-08-18 — Phase 0 backend + first UI cut land on master (T1–T6, T9; T7/T8/T10 half)

One evening from empty repo to a working observe-only mission control: `store` (pure-Go SQLite, DDL v1 verbatim + additive v2), `cost` (versioned pricing, cache-savings formula ported from `_savings.py`), `rollup` (single write path), `hookd` + `internal/shim` + `caprock-hook`, `hooks` installer (ordered-JSON merge — the user's key order survives), `ingest` (fsnotify + poll tailer, schema-versioned parser, golden fixtures), `loop` (episode-based, normalized signatures), `narrate` (phrase/health/plan), `gitdiff`, `api` (REST + WS + embed), `daemon`, the `caprock` CLI (`up` detached, `down` via token-gated shutdown, `status`, `hooks`), the smoke DoD scenario, and a React 19 / Vite 8 / TS 7 dashboard with Now, Session Detail (timeline / live diff / files) and Cost. Two facts learned from real transcripts that the spec could not know: one API response is written as several assistant lines repeating the same usage (dedupe by `message.id`, verified across 16k groups), and `<synthetic>` model lines are not turns. Everything except the OS matrix is green locally: `go test ./...`, `golangci-lint`, `tsc`, `vitest`, `make docs-check docs-links`, `go test -tags smoke`.

### 2026-08-18 — Corpus built from the hand-off spec; repo prepared for development

The template repo (`corpus`) was turned into Caprock's home: `CaprockV2-SPEC.md` decomposed into eleven `.ai/` files with zero information loss, audited by parallel reviewer subagents ([docs/migration-audit.md](../docs/migration-audit.md)), then deleted; MIT license replaced with Apache-2.0; template-only files (`TEMPLATE.md`, `CONTRIBUTING.md`) removed; README, CLAUDE.md, AGENTS.md rewritten. While preparing, three facts surfaced that the spec did not know: (1) Claude Code now ships a native `type: "http"` hook — rejected in favour of the shim because it shows a transcript error when the daemon is down ([ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type)); (2) the legacy repo has no `pricing.json` or transcript fixtures, so the pricing table is authored from the Anthropic pricing page and T5 parity is redefined ([ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson), `OQ-01`); (3) the current Stop-hook output shape differs from the spec's (`OQ-06`). Toolchain pinned to latest stable ([ADR-017](08-decisions.md#adr-017--toolchain-go-126-moderncorgsqlite-coderwebsocket-fsnotify-cobra-react-19--vite-8--typescript-7-native-tailwind-4-vitest)).
