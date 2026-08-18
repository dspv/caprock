# Caprock

**Mission control for Claude Code.** A local, open-source daemon + dashboard that shows what every `claude` session on your machine is really doing and costing — live activity, plan progress, diffs, token burn, cost, loop alerts — and, in later phases, lets you spawn, control, and orchestrate sessions with verification before anything is called "done".

[![docs](https://github.com/dspv/caprock/actions/workflows/docs.yml/badge.svg)](https://github.com/dspv/caprock/actions/workflows/docs.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Status: Phase 1 — Control, in progress (2026-08-18).** Observe (Phase 0) is green on the macOS/Linux/Windows CI matrix. Control (Phase 1) — spawn/type/kill a real `claude` from the UI, auto-pause loops, History — works on macOS; on a branch pending the OS matrix. No tagged release yet. Progress is tracked honestly in [`.ai/14-build-status.md`](.ai/14-build-status.md).

---

## Why

- **Dead-air waiting.** You give Claude a task and stare at a scrolling terminal. There is nothing useful to watch.
- **Token anxiety.** One looping session can drain a daily budget in minutes, and per-task cost is invisible until it's too late.
- **Trust gap.** How does an orchestrator know a worker is *actually* done? Nobody leaves agents unattended without verification.
- **Platform gap.** The incumbent (an Electron + node-pty app) breaks on Windows and only sees agents *it* spawned.

Caprock answers each of these with a single static Go binary — macOS / Linux / Windows from day one — that works in **observe-only mode on sessions you start yourself**, before it ever asks you to change your workflow. Full reasoning: [`.ai/01-product.md`](.ai/01-product.md).

## What it does

```
caprock up            # starts the loopback daemon, installs the hook shim (with consent), opens localhost:4173
claude                # in any terminal, any project — Caprock sees it
caprock status        # daemon, hooks, ingest, pricing table in force
caprock down          # stops the daemon; keeps every byte of your data
```

Build from source (Go 1.26, Node 22): `make ui && make build` → `./bin/caprock`, `./bin/caprock-hook`.

| Screen         | Shows                                                                | Phase |
| -------------- | -------------------------------------------------------------------- | ----- |
| Now            | Per-session narration, plan progress, live burn, health, loop banner | 0     |
| Session Detail | Event timeline, live `git diff` (Phase 0); live terminal (Phase 1)   | 0 → 1 |
| Cost & Burn    | $/hr now, today totals, model mix, cache hit-rate, per-project       | 0     |
| History        | Lifetime stats: cost per project/day/model, tool distribution        | 1     |
| Tasks          | Kanban over `tasks/*.md`; verification-before-done; approvals queue  | 2     |

Local-first: loopback only, no servers, no telemetry, all data in SQLite on your disk. Free for solo use, permanently.

## Progress

Coarse on purpose. Same numbers as [`.ai/14-build-status.md`](.ai/14-build-status.md).

| Track                           | Progress         |
| ------------------------------- | ---------------- |
| Documentation (`.ai/`)          | `█████████░` 90% |
| Phase 0 — Observe (T0–T10)      | `█████░░░░░` 50% |
| Phase 1 — Control (T11–T16)     | `░░░░░░░░░░` 0%  |
| Phase 2 — Orchestrate (T17–T25) | `░░░░░░░░░░` 0%  |

## Repository

```
.ai/           source of truth for humans and agents — read 00-index.md first
cmd/ internal/ Go daemon, CLI, hook shim              (Phase 0+)
ui/            React + Vite dashboard, embedded via go:embed
pricing/       versioned model pricing table
testdata/      transcript fixtures, hook payloads, fake claude
scripts/       docs tooling (table aligner, link checker)
docs/          human-facing docs, spec-migration audit
```

Developing with an AI agent? Start at [`CLAUDE.md`](CLAUDE.md). Toolchain, CI, and release mechanics: [`.ai/10-infrastructure.md`](.ai/10-infrastructure.md).

## Contributing

Issues and PRs welcome once Phase 0 lands. Rules that apply to every change are in [`.ai/06-engineering-rules.md`](.ai/06-engineering-rules.md): English everywhere, Conventional Commits, one task per PR with its acceptance criteria as a checklist, and **no task is done with a red Windows CI job**. Run `make check` before pushing.

## Heritage

Caprock started as a free Python stats utility for Claude Code (`pip install caprock`, still on PyPI, now frozen). This repo is its successor — same name, same honesty about numbers, new Go core. See [`.ai/01-product.md § Relationship to Caprock-python`](.ai/01-product.md#relationship-to-caprock-python-heritage).

## License

Apache-2.0 — see [LICENSE](LICENSE).
