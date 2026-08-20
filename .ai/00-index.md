# Caprock — AI Agent Context

Read this file first. Then read the task-specific file below.

Caprock is a local, open-source **mission control for Claude Code**: a single static Go binary that runs a loopback daemon, captures every `claude` session on the machine through Claude Code hooks (via a tiny shim) and transcript tailing, normalizes everything into one event stream in SQLite, and serves a dense React dashboard (Now · Session Detail · Cost · History · Answers · Tasks) with live activity, per-repo cost, token burn, loop alerts, the prose Claude actually wrote (searchable across sessions), plus spawning/typing into sessions and a verified multi-agent orchestrator. Local-first, zero servers, Apache-2.0, free for solo use. Owner: Dima; repo `dspv/caprock`; domain `caprock.dev`.

| File                                               | Contents                                                        | Read when...                                       |
| -------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| [01-product.md](01-product.md)                     | One-liner, prior art, problem, users, traceability, principles  | Always                                             |
| [02-architecture.md](02-architecture.md)           | Daemon, data planes, cross-platform rules, sources, event model | Touching any Go component                          |
| [03-contracts.md](03-contracts.md)                 | Shim protocol, HTTP API, WS frames, DDL, pricing, runtime file  | Adding/changing an endpoint, table, or file format |
| [04-ui.md](04-ui.md)                               | The screens, visual tokens, narration map                       | Touching `ui/`                                     |
| [05-orchestration.md](05-orchestration.md)         | Hive, mailboxes, Stop-loop, verification, approvals             | Orchestration internals                            |
| [06-engineering-rules.md](06-engineering-rules.md) | Binding rules; definition of green                              | Before writing code                                |
| [07-orchestrator.md](07-orchestrator.md)           | The orchestrator's system prompt (embedded, kept in sync)       | Changing orchestrator behaviour                    |
| [08-decisions.md](08-decisions.md)                 | ADR log                                                         | Before revisiting any decision                     |
| [09-execution-plan.md](09-execution-plan.md)       | Roadmap, phase DoDs, tasks T0–T25 with AC                       | Picking up or finishing a task                     |
| [10-infrastructure.md](10-infrastructure.md)       | Versions, CI, release, local dev                                | Toolchain, CI, releases                            |
| [12-risks.md](12-risks.md)                         | Assumptions, risks, open questions                              | Before expanding scope                             |
| [14-build-status.md](14-build-status.md)           | What is built, what is not, next action, log                    | Checking progress                                  |

These files absorbed the hand-off specification (`CaprockV2-SPEC.md`, deleted after the loss audit recorded in [docs/migration-audit.md](../docs/migration-audit.md)). The spec is not a separate source of truth — **these files are**. (Numbering is non-contiguous by design — 11 and 13 were never used; nothing is missing.)

**This table is the one home for the doc map.** `CLAUDE.md` and `AGENTS.md` point here rather than restating it.

Supporting directories:

| Path                | Contents                                                       |
| ------------------- | -------------------------------------------------------------- |
| `scripts/`          | `align-tables.py`, `check-links.py` — docs tooling             |
| `docs/`             | Human-facing docs; the migration audit record                  |
| `cmd/`, `internal/` | Go daemon, CLI, shim (see 02-architecture § Repository layout) |
| `ui/`               | React + Vite dashboard, embedded into the binary               |
| `pricing/`          | `pricing.json` — versioned model pricing table                 |
| `testdata/`         | Transcript fixtures, hook payloads, fake `claude`              |

## Current State

**Last updated: 2026-08-20** · Owner: Dima · Phase: **Phase 2 — Orchestrate, complete; v0.1.0–v0.9.4 tagged + published**

- **Documentation:** corpus built from the spec on 2026-08-18; loss audit green; spec deleted; kept current with the code.
- **Code:** all three phases built and green on the 3-OS CI matrix. **v0.1.0–v0.9.4 are all tagged and published** (through 2026-08-20; Homebrew formula in `dspv/homebrew-tap` — `brew install dspv/tap/caprock`). Post-Orchestrate releases are polish: v0.4.0 (plan-limit windows, orchestrator-lifecycle fixes, formula), v0.4.1 (formula ships the hook shim), v0.5.0 (statusLine auto-install, honest first-run errors, readable MCP names, release CI-gate, CODE_OF_CONDUCT), v0.5.1 (Windows install via Scoop + README project map), v0.6.0 (light theme, `go install` with a real UI), v0.7.0 (per-project spend on Now, larger numbers, graph out of the nav), v0.8.0 (live activity feed, plan value, attention strip). The Phase 2 tag gate — a live unattended orchestrator run with hooks — passed (a real `claude` orchestrator drove a task to green verification with no human input). See [14-build-status.md](14-build-status.md) for the live per-track state.
- **Unmeasured / undecided:** see [12-risks.md § Open questions](12-risks.md#open-questions); `OQ-01`, `OQ-03`, and `OQ-07` are resolved (all open questions OQ-01–09 are closed); no open question blocks shipping.

## Rules of engagement — non-negotiable

1. **Phase order is the product.** Observe (Phase 0) ships and works on externally started sessions before any control or orchestration code is user-facing. Read before write; orchestration is additive. Skipping ahead produces a harness nobody can adopt without changing their workflow — the incumbent's exact failure.
2. **No task is done with a red Windows CI job. No exceptions.** Cross-platform reliability is the moat ([02-architecture.md](02-architecture.md#cross-platform-do-it-right-on-day-one)).
3. **The shim never breaks a user's Claude session.** Any error path is silent `exit 0` within 1s; no stdout except the Phase 2 Stop decision.
4. **All data stays on the machine.** Loopback listeners only; no telemetry; **no outbound calls except the release check the user explicitly turns on** — off by default, asked for once, revocable, and carrying no body, credentials, or usage data (see [02-architecture.md](02-architecture.md) and `internal/update`). Local-first is the trust story that made the incumbent land.
5. **All code, commits, PR titles, descriptions and docs in English.** Conventional Commits.
6. **No invented numbers anywhere public** — prices, costs, forecasts, performance claims. Measured or sourced with a date, else an open question. Forecasts are labeled estimates.
7. **Every feature traces to a complaint** ([01-product.md § Complaint → feature traceability](01-product.md#complaint--feature-traceability)); a feature with no row is a candidate for cutting.
8. **We never signal or type into a process we did not start.** Auto-pause and input are for owned sessions only.
9. **Contracts, DDL, and pricing change only with their docs and a migration/version bump in the same commit** ([06-engineering-rules.md](06-engineering-rules.md)).
10. **Keep the docs current as you build.** A behaviour change lands with its documentation change — including [14-build-status.md](14-build-status.md) and the README progress bars — in the same commit.

## Documentation rules

- **Tables must be tight-aligned.** Never align by hand — run `make docs-fmt` after editing any file with a table.
- **Tables are for short enumerable values only.** If a cell needs a full sentence, use a bulleted list instead — prose-in-cells tables are unreadable in diffs and terminals.
- **One fact, one home.** Cross-link with a relative link rather than restating. If a fact must live in two files, one of them is the owner and the other links to it.
- **Decisions go in [08-decisions.md](08-decisions.md), not in prose.** If a debate closes, it becomes an ADR. Check the ADR log before reopening anything.
- **Update [14-build-status.md](14-build-status.md) and § Current State above when the state of the world changes** — dates in absolute form, never "last week".
