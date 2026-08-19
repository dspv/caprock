# Changelog

All notable changes to Caprock. Format: [Keep a Changelog](https://keepachangelog.com/).
Versions map to the roadmap phases in `.ai/09-execution-plan.md`: **v0.1.0** = Observe,
**v0.2.0** = Control, **v0.3.0** = Orchestrate — all tagged and published 2026-08-19.

## [Unreleased]

- **Plan-limit windows** — `caprock statusline` (register as Claude Code's
  `statusLine.command`) reads Claude Code's `rate_limits` and shows your 5-hour /
  7-day window usage and reset time on the Cost screen, with an honest "at current
  pace" forecast shown only when your measured usage would reach the limit before
  the window resets. Pro/Max only; absent otherwise. The command also prints a
  compact one-line status (model · context% · cost · limits) and can never break
  or slow the session.

Phase 3 (Delight) has no plan by design.

## [0.3.0] - 2026-08-19

**Phase 2, Orchestrate**: a verified multi-agent team. Driven end to end by a real
`claude` orchestrator, unattended, with hooks.

### Phase 2 — Orchestrate

- On-disk hive (agents / tasks / mailboxes / append-only ledger), single writer,
  atomic writes, dependency-free YAML.
- **Tasks board** (kanban over `tasks/*.md`), New-task dialog, approvals.
- **Orchestrator agent** — a real `claude` session with a hive-aware system prompt
  that spawns and coordinates workers via mailboxes; the router is a reconciler
  that spawns a worker per assigned task, runs verification, and wakes idle
  sessions with unread mail.
- **Stop-loop autonomy** — a worker's Stop hook is answered to force it to keep
  going while its inbox is non-empty, with a hard guard (N=10) that escalates.
- **Verification before done** — a task's `done_criteria` run in the worker's
  worktree; only green checks reach `done`; red bounces the failing output back
  (R=3 rounds, then escalate). Destructive commands never run unattended (they
  escalate to `needs_you`). Cost is attributed to the task.
- New endpoints: `POST /v1/orchestrator/start`, `POST /v1/tasks/{id}/verify`;
  `--hive` / `--repo` flags.

## [0.2.0] - 2026-08-19

**Phase 1, Control**: spawn and drive `claude` sessions from the dashboard.

### Phase 1 — Control

- Spawn real `claude` sessions from the UI into an optional git worktree, with a
  live xterm.js terminal (bidirectional) in **Session Detail**.
- Owned-session controls: pause / resume / kill — **only** for sessions Caprock
  spawned; externally started sessions stay observe-only.
- Opt-in auto-pause of a looping owned session.
- **History** screen — lifetime stats: cost per project / day / model, tool
  distribution, model mix, top projects.
- New endpoints: `POST /v1/agents`, `/v1/agents/{id}/input|signal`,
  `WS /v1/agents/{id}/term`, `GET /v1/history`.

## [0.1.0] - 2026-08-19

First tagged release — **Phase 0, Observe**: watch every `claude` session on the
machine, live, with token burn and cost, entirely on-device.

### Phase 0 — Observe

- Single static Go binary: a loopback daemon (`127.0.0.1:4173`) that serves the
  REST API, a `/v1/live` WebSocket, the hook receiver, and the embedded dashboard.
- **Hook plane** — a tiny `caprock-hook` shim registered in `~/.claude/settings.json`
  (non-destructive, backed up, cleanly removable) forwards the core Claude Code
  hook events; a broken or absent daemon never affects the user's session.
- **Transcript plane** — tails `~/.claude/projects/**`, schema-versioned parser,
  tolerant of malformed lines and unknown fields; usage counted once per response.
- Normalized event stream in SQLite (pure-Go, no CGO); cost from a versioned
  pricing table (Anthropic list prices, dated) and cache-savings math.
- **Loop detector** — flags a session repeating the same tool with similar input
  (K=5 in T=3 min), with an alert banner.
- Dashboard: **Now** (per-session narration, health, plan progress, live burn),
  **Session Detail** (event timeline, live `git diff`), **Cost** (burn, model mix,
  per-project, 30-day), **History** (lifetime stats, tool distribution).
- CLI: `caprock up | down | status | hooks install|uninstall|status | tasks`.
- Event retention (`retention_days`, default off) caps database growth.

## Notes (all releases)

- Local-first: loopback only, no telemetry, no outbound calls from the daemon.
- Prices and context-window sizes live in `pricing/pricing.json` (dated, sourced
  from the Anthropic pricing page). No invented numbers.
