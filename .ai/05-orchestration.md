# Caprock — Orchestration & the trust gap

Phase 2+ ([09-execution-plan.md § Phase 2](09-execution-plan.md#phase-2--orchestrate)). Design decisions are fixed up front so that Phases 0–1 do not paint us into a corner. The hive file formats below are canonical here; the API/DDL additions are in [03-contracts.md](03-contracts.md).

## Design decisions (fixed up front)

- **Orchestrator = a normal `claude` session** with a dedicated system prompt + its own worktree; talks through the same mailbox files. No special API.
- **Mailboxes**: per-agent `inbox/` + `outbox/` dirs of markdown files; the router (harness, single writer) moves files and commits. Agents never run git on the hive repo.
- **The autonomy engine is the Stop hook**: agent stops → hook fires → harness checks inbox → if mail exists, respond with `decision: block` + reason ("process your inbox"), which forces the session to continue. Loop-guard: max N forced continues per task, then escalate to human.
- **The router is a reconciler**, not just a mail mover. Each tick it (1) delivers `outbox → inbox`; (2) **archives a worker's fire-once `assign` message** once its task has moved past `assigned` (the worker has demonstrably picked it up) — the message goes to the agent's `processed/` dir (audit trail, not a delete); (3) spawns a worker session for every task whose `assignee` is set and status is live (`assigned`/`in_progress`) — the orchestrator's `assignee` scribe is the spawn trigger, since a file-tools-only session cannot spawn a process itself; (4) runs a task's `done_criteria` when the orchestrator scribes it to `verifying` (in-flight-guarded so a slow check does not re-fire every tick); and (5) **wakes** an idle session that just received mail. A Claude TUI session does not react to a file appearing in its inbox — the Stop hook only fires when the session itself ends a turn — so a freshly-spawned session gets one initial "kick" (a typed "read your inbox" message + Enter), and any idle session with unread mail is re-kicked (throttled). The kick is declarative, so repeating it is harmless.
- **Why step (2) matters.** The Stop hook forces a worker to continue while its inbox is non-empty. An `assign` is a fire-once instruction: without archival it lingers in the inbox after the worker has acted, pinning `InboxCount > 0` forever, so the Stop-loop never releases and the worker is re-kicked into an endless inbox-poll. Draining is keyed on task status (deterministic), not on the agent deleting its own file. `result`/`question` mail is never archived — only the retired assign. This is a hive invariant, not a nicety: it is what lets a finished worker actually stop.
- **`Start` is idempotent.** Starting the orchestrator when a session is already live does not spawn a second one (which would leak the first and run a second router loop racing the first on the same hive); it re-kicks the existing session so it re-reads its inbox and picks up newly-queued tasks. A dead session is replaced normally.
- **Verification before done (the moat).** A task isn't done because a worker says so. Task frontmatter declares `done_criteria` (commands: tests, typecheck, lint, custom). On worker's "done": harness runs the commands; on failure the task bounces back with the failing output attached. Optionally a reviewer agent reads the diff. Only green checks move a task to `done`.
- **Escalation policy** (approvals queue): spend above per-task budget, destructive commands, scope change, N failed verification rounds.
- **Isolation**: one git worktree per agent by default.

## Hive layout

One dir per registered project workspace:

```
<hive>/
  agents/<agent-id>/{identity.md, memory.md, inbox/, outbox/}
  tasks/<task-id>.md
  approvals/<id>.json
  ledger.jsonl                # append-only task/state transitions
```

Files are the source of truth for hive state; SQLite mirrors them for the UI (rebuildable by rescan). All paths via `filepath`, never hardcoded `/` ([02-architecture.md § Cross-platform](02-architecture.md#cross-platform-do-it-right-on-day-one)).

## Task file

```yaml
---
id: t-2026-0001
title: Add /healthz endpoint
status: inbox | assigned | in_progress | verifying | needs_you | done | failed
assignee: agent-id | null
budget_usd: 3.00
done_criteria:
  - go test ./...
  - go vet ./...
verify_rounds_used: 0
---
Free-form description / acceptance notes.
```

The kanban ([04-ui.md § Tasks](04-ui.md#tasks-kanban)) allows drag only between allowed states.

## Mailbox message

Markdown file, YAML frontmatter `{from, to, ts, task_id?, kind: assign|result|question|escalation}`; body free-form. Router moves `outbox → inbox`, appends to `ledger.jsonl`, commits.

## Stop-hook decision protocol (shim upgrade, T19)

For Stop events only, the shim switches from fire-and-forget to request-response: it waits for the daemon's reply (timeout **5s**) and relays the JSON body (`{"decision":"block","reason":…}` or empty) to stdout, which is how Claude Code consumes hook decisions. All other events remain silent fire-and-forget. Degradation is safe by construction: on timeout or daemon-down the shim prints nothing and exits 0, so the session simply stops normally. Forced-continue counter lives in SQLite per (session, task).

Guards: max **N=10** forced continuations per task (default), then escalate; verification bounces max **R=3** rounds (default), then escalate.

The Stop output shape is `{"hookSpecificOutput":{"hookEventName":"Stop","decision":"block","reason":"…"}}` on stdout with exit 0 (exit 2 also blocks) — the canonical, and only documented, form for Claude Code 2.1.x. `board.StopDecision` emits it, and the live unattended run confirmed Claude 2.1.235 continues on it ([OQ-06](12-risks.md#open-questions) resolved 2026-08-19). The spec's older top-level `{"decision","reason"}` form is undocumented and not used.

## Verification runner

On worker's "done", Caprock executes `done_criteria` commands in the worker's worktree with timeouts and output capture; all green ⇒ task → `done`; any red ⇒ task bounces to the worker with failing output attached (max R rounds, default 3, then escalate). Rows land in `verifications` (`task_id`, `round`, `command`, `exit_code`, `output_path`).

## Approvals

Tasks exceeding budget, matching a destructive-command policy (regex list, configurable), or exhausting guards land in `needs-you`; one-click approve/reject feeds back to the orchestrator via the mailbox. Cut line: the approvals policy can start budget-only.

## Cost attribution per task

Join `events` → task via assignment windows (the interval during which a task is assigned to a session); task cards show spend vs budget. Shipped in v0.3.0: the router opens an assignment window when it spawns a worker for a task, and verification closes it and sums the cost.

## Orchestrator prompt

The system prompt is English, lives at `.ai/07-orchestrator.md` (created in T21; the spec's `.ai/orchestrator.md` renamed to a numbered slot per [ADR-016](08-decisions.md#adr-016--corpus-layout-numbered-ai-files-minimal-root-spec-deleted-after-audit)), and is spawned by `ptyman` with its own worktree; spawn/respawn policy and scribing (status transitions written to task files + ledger) are part of T21.

## Auto-pause ownership rule (Phase 1)

This file owns the rule; Phase 1 DoD item 4 in [09-execution-plan.md](09-execution-plan.md#phase-1--control) quotes the spec's wording of the same rule verbatim.

Auto-pause acts on **owned sessions only** (Caprock has the PID and the PTY): per-setting SIGSTOP/SIGCONT (POSIX) / input-hold + warning (Windows, no SIGSTOP), one click to resume. Externally observed sessions stay alert-only — hooks don't give us process ownership, and we never signal a process we didn't start. Default: alert-only everywhere; auto-pause opt-in.
