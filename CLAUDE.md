# Caprock — Context for AI Agents

## What this is

Caprock is a local, open-source mission control for Claude Code: a single static Go binary runs a loopback daemon that captures every `claude` session on the machine (Claude Code hooks via a tiny shim + transcript tailing), normalizes it into one event stream in SQLite, and serves a dense React dashboard — live activity, token burn, cost, loop alerts, spawning/typing into sessions, and a verified multi-agent orchestrator. Local-first, zero servers, Apache-2.0, free for solo use.

**Status: Phase 2 — Orchestrate, complete; v0.1.0 / v0.2.0 / v0.3.0 all tagged + published (2026-08-19).** All three phases green on the 3-OS CI matrix. Orchestrate = hive, tasks board, Stop-loop, orchestrator agent, verification-before-done, approvals. The Phase 2 tag gate — a real-`claude` unattended run with hooks — passed. See `.ai/14-build-status.md`.

## Repository structure

- `.ai/` — full documentation, **source of truth**. Read before any task.
- `cmd/`, `internal/` — Go daemon, CLI, hook shim (layout in `.ai/02-architecture.md`).
- `ui/` — React + Vite dashboard, embedded into the binary via `go:embed`.
- `pricing/` — versioned model pricing table. `testdata/` — fixtures, fake `claude`.
- `scripts/` — `align-tables.py`, `check-links.py` (docs tooling).
- `docs/` — human-facing docs; the spec-migration audit record.

## How to get context

Read `.ai/00-index.md` first — its table maps every doc to when you'd read it
(the one home for that map). Then read the one file your task needs, not the
whole corpus. Contributing? See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Non-negotiable rules

1. **Phase order is the product: Observe → Control → Orchestrate.** Phase 0 must be useful on sessions the user starts themselves; control and orchestration are additive. Skipping ahead builds a runtime nobody adopts.

2. **No task is done with a red Windows CI job. No exceptions.** Cross-platform reliability is the moat.

3. **The shim never breaks a user's Claude session.** Every error path is silent `exit 0` within 1s.

4. **All data stays on the machine.** Loopback listeners only, no outbound calls, no telemetry.

5. **All code, commits, PR titles, descriptions and docs in English.** Conventional Commits with scope.

6. **No invented numbers anywhere public** — prices, costs, forecasts, performance claims. Measured or sourced with a date; otherwise an open question in `.ai/12-risks.md`. Forecasts are labeled estimates.

7. **We never signal or type into a process we did not start.**

8. **Contracts, DDL, and pricing change only together with `.ai/03-contracts.md`, a migration, or a `pricing_version` bump — in the same commit.**

9. **Keep the docs current as you build.** A change to behaviour lands with its documentation change in the same commit — including `.ai/14-build-status.md` and the README progress bars.

10. **Every task ends green** (`go vet`, `go test`, lint, UI typecheck/tests, `make check`) locally before push and in CI on three OS. Ongoing changes are focused PRs to master (the T0–T25 build is complete; see [ADR-014](.ai/08-decisions.md)).

## Dev commands

```bash
make help        # list targets
make dev         # daemon on :4173 + vite dev server on :5173
make test lint   # go + ui tests and linters
make smoke       # the Phase 0 DoD scenario with the fake claude
make docs-fmt    # tight-align all markdown tables (run after editing any table)
make check       # docs + lint + tests + smoke (the CI gate, minus the OS matrix)
```

## Tables

All markdown tables must be tight-aligned (each column padded to its longest value, separator exactly that width, no trailing whitespace). **Never align manually** — run after editing:

```bash
make docs-fmt
```

**Tables are for short enumerable values only.** If a cell needs a full sentence or more, do not use a table — rewrite it as a bulleted list with a bold lead-in per item. Wide prose-in-cells tables are unreadable in diffs and terminals.
