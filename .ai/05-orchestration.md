# Caprock — Orchestration & the trust gap

Phase 2+ ([09-execution-plan.md § Phase 2](09-execution-plan.md#phase-2--orchestrate)). Design decisions are fixed up front so that Phases 0–1 do not paint us into a corner. The hive file formats below are canonical here; the API/DDL additions are in [03-contracts.md](03-contracts.md).

## Design decisions (fixed up front)

- **Orchestrator = a normal `claude` session** with a dedicated system prompt + its own worktree; talks through the same mailbox files. No special API.
- **Mailboxes**: per-agent `inbox/` + `outbox/` dirs of markdown files; the router (harness, single writer) moves files and commits. Agents never run git on the hive repo.
- **The autonomy engine is the Stop hook**: agent stops → hook fires → harness checks inbox → if mail exists, respond with `decision: block` + reason ("process your inbox"), which forces the session to continue. Loop-guard: max N forced continues per task, then escalate to human.
- **The router is a reconciler**, not just a mail mover. Each tick it (1) delivers `outbox → inbox`; (2) **archives a worker's fire-once `assign` message** once its task has moved past `assigned` (the worker has demonstrably picked it up) — the message goes to the agent's `processed/` dir (audit trail, not a delete); (3) spawns a worker session for every task whose `assignee` is set and status is live (`assigned`/`in_progress`) — the orchestrator's `assignee` scribe is the spawn trigger, since a file-tools-only session cannot spawn a process itself; (4) runs a task's `done_criteria` when the orchestrator scribes it to `verifying` (in-flight-guarded so a slow check does not re-fire every tick); and (5) **wakes** an idle session that just received mail. A Claude TUI session does not react to a file appearing in its inbox — the Stop hook only fires when the session itself ends a turn — so a freshly-spawned session gets one initial "kick" (a typed "read your inbox" message + Enter), and any idle session with unread mail is re-kicked (throttled). The kick is declarative, so repeating it is harmless.
- **Why step (2) matters.** The Stop hook forces a worker to continue while its inbox is non-empty. A consumed message that lingers pins `InboxCount > 0` forever, so the Stop-loop never releases and the worker is re-kicked into an endless inbox-poll. Two message kinds are fire-once and must be retired once acted on: an **`assign`** (consumed once the task moves off inbox/assigned) and a **verify-bounce `result`** from the verifier (consumed once the task moves off in_progress — the worker fixed it and it went to verifying/done/needs_you/failed). A peer `result`, a `question`, and an un-acted bounce are always kept. Draining is keyed on task status (deterministic), not on the agent deleting its own file, and runs before the wake step so a just-emptied inbox is not needlessly re-kicked. This is a hive invariant, not a nicety: it is what lets a finished worker actually stop.
- **`Start` is idempotent.** Starting the orchestrator when a session is already live does not spawn a second one (which would leak the first and run a second router loop racing the first on the same hive); it re-kicks the existing session so it re-reads its inbox and picks up newly-queued tasks. A dead session is replaced normally.
- **Verification before done (the moat).** A task isn't done because a worker says so. Task frontmatter declares `done_criteria` (commands: tests, typecheck, lint, custom). On worker's "done": harness runs the commands; on failure the task bounces back with the failing output attached. Optionally a reviewer agent reads the diff. Only green checks move a task to `done`.
- **Unverifiable is never verified.** The claim above holds only if there is no path where a task reaches `done` without its criteria having run, so both holes are closed. `done_criteria` is **required at creation** (`POST /v1/tasks` rejects an empty or all-blank list) — an empty list was previously an unconditional pass with the comment "trust the worker", which made the headline claim false for the easiest task to create. And a task that reaches verification with no criteria, or whose worktree is missing, escalates to `needs_you` with the reason mailed to the orchestrator; it never passes. Verification commands run **only** in a directory that exists: a `cwd` that does not stat as a directory used to leave `cmd.Dir` empty, so the checks ran in the daemon's own working directory. An **assigned** task is verified in its worker's worktree or not at all — `VerifyTask` used to fall back to `RepoCwd` when the worktree was missing, and because `RepoCwd` does exist nothing downstream could tell: the criteria ran against a clean main repo and the task passed for work nobody had inspected. A task with **no** assignee still verifies in the repo, which is the only directory it could mean.
- **Escalation policy** (approvals queue): spend above per-task budget, destructive commands, scope change, N failed verification rounds, an agent that exhausted its wake budget.
- **Isolation**: one git worktree per agent by default, at `<repo>/.caprock-worktrees/<worker>` on branch `caprock/<worker>`.

**A worker's branch is never force-reset, and worktrees are never auto-removed.** Creation uses `git worktree add -b` (not `-B`): if the branch already exists, Caprock refuses with an error naming the branch and the fix, rather than resetting it — `-B` silently dropped a user's commits to the reflog, and worker names are predictable enough (`worker-1`) that a second run hit this in ordinary use. A worktree Caprock already created at the path it would choose is reused, so a respawn picks its work back up. Nothing removes worktrees or branches when a task finishes: unmerged commits would go with them, and the visible-output rule below requires a `done` card to say where the work is and how to take it, with landing left to the user. See [ADR-020](08-decisions.md).

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

**A fresh hive is seeded so it explains itself.** `hive.Seed` writes a `README.md` (what the directory is, where the work happens, who runs the checks, and that this only suits independent tasks) and one `tasks/example-task.md` in the `inbox` column. A new hive was otherwise three empty directories: the one place a user looks after running `caprock up --hive` explained nothing. Seed is a no-op when the README already exists, so it never overwrites a user's work and never restores an example they deleted. The example id is deliberately not in the generated `t-<millis>-<n>` shape, so it can never be mistaken for something Caprock created.

**Only independent tasks.** Nothing merges branches, and nothing detects two workers editing the same file — each worker gets a worktree and a branch and that is the whole of the isolation story. This is a real limit of the design, not an omission to be discovered by a user, so the README, the off-state and the seeded hive all say it.

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

**`from` and `to` are validated on delivery, not only on send.** The author of an outbox file is a worker session running with permissions skipped, so these fields are untrusted input: unvalidated, `to: ../../../x` made the router's `MkdirAll` + write land anywhere on the machine. Both are checked against the same id rule `Send` uses, and the resolved destination is confirmed to sit inside the hive root. A message failing either check is moved to the sender's `rejected/` and ledgered as `mail.rejected` — never delivered, never silently dropped (the evidence matters), and never fatal to the pass, so one poisoned file cannot wedge every other agent's mail. The same rule governs **task ids**: `GetTask`/`UpdateTask` validate, because `ListTasks` reads the id from *inside* a task file, which would otherwise make a hand-written file a write primitive. See [ADR-020](08-decisions.md).

## Stop-hook decision protocol (shim upgrade, T19)

For Stop events only, the shim switches from fire-and-forget to request-response: it waits for the daemon's reply (timeout **5s**) and relays the JSON body (`{"decision":"block","reason":…}` or empty) to stdout, which is how Claude Code consumes hook decisions. All other events remain silent fire-and-forget. Degradation is safe by construction: on timeout or daemon-down the shim prints nothing and exits 0, so the session simply stops normally. Forced-continue counter lives in SQLite per (session, task).

Guards: max **N=10** forced continuations per task (default), then escalate; verification bounces max **R=3** rounds (default), then escalate.

The forced-continue counter is keyed per (session, task), and a session with **no** task — the orchestrator, which is never assigned one — is counted under the reserved key `/no-task` so the same limit applies to it. Without that key its counter stayed at 1 and the guard could never trip: one escalation it could not clear pinned an unattended `--dangerously-skip-permissions` session in an unbounded forced-continue loop. When the guard trips, the task is walked to `needs_you` along a legal route (`board.moveTo`); guarding the single hop with `CanTransition` and skipping it when illegal silently dropped the escalation, left the task live, and kept the router waking the worker — see § Status transitions, which owns that rule.

The Stop output shape is `{"hookSpecificOutput":{"hookEventName":"Stop","decision":"block","reason":"…"}}` on stdout with exit 0 (exit 2 also blocks) — the canonical, and only documented, form for Claude Code 2.1.x. `board.StopDecision` emits it, and the live unattended run confirmed Claude 2.1.235 continues on it ([OQ-06](12-risks.md#open-questions) resolved 2026-08-19). The spec's older top-level `{"decision","reason"}` form is undocumented and not used.

## Verification runner

On worker's "done", Caprock executes `done_criteria` commands in the worker's worktree with timeouts and output capture; all green ⇒ task → `done`; any red ⇒ task bounces to the worker with failing output attached (max R rounds, default 3, then escalate). Rows land in `verifications` (`task_id`, `round`, `command`, `exit_code`, `output_path`).

`output_path` is a real file, not a placeholder. Each command's full output is written to `<hive>/verifications/<task-id>/round-<n>-cmd-<i>.log` and that path is stored on the row. It was recorded as `""` before, which left a green task with no evidence behind it — a pass that ran and a pass that never ran looked identical, which defeats the point of verifying at all. The `VerifyResult` a caller gets back carries the same path per command in `output_path`, alongside the tail-capped `output` the UI renders.

## Approvals

Tasks exceeding budget, matching a destructive-command policy (regex list, configurable), or exhausting guards land in `needs-you`; one-click approve/reject feeds back to the orchestrator via the mailbox. Cut line: the approvals policy can start budget-only.

**Budget enforcement** runs on the reconciler tick, not only at verification: the router re-attributes cost for every live task (`assigned`, `in_progress`, `verifying`) and, when spend passes `budget_usd`, **kills the worker session** and then parks the task in `needs_you`, appending the reason to the task body so the approvals column can explain the pause. Attributing on the tick is what makes the number live — it otherwise only ran when a task finished, so a runaway worker was invisible until it was done.

The kill is the enforcement; the file is the record. Parking the task alone only rewrote markdown — a Claude session mid-turn does not read the file it is being parked in, so it kept its turn and kept spending, and "budget" was an annotation rather than a limit. The kill goes through the same owned-session path as `POST /v1/agents/{id}/signal`, so rule 7 still holds: only sessions Caprock spawned are ever signalled.

**A task created without a budget is not unlimited.** `POST /v1/tasks` applies `board.DefaultBudgetUSD` ($5) when `budget_usd` is `0` or absent. Unattended sessions run with `--dangerously-skip-permissions`, so "no budget stated" defaulting to "no ceiling at all" made the safe default the unsafe one. The figure is a stop Caprock enforces, not a claim about what a task costs (rule 6); a user who wants more states it. `budget_usd: 0` written directly into a hive task file still means no limit — the file is the source of truth and Caprock does not rewrite a user's hand-authored task.

**Wake ceiling.** `WakeThrottle` bounds how *often* an idle agent with mail is re-kicked; `MaxConsecutiveWakes` (default 10) bounds how *many times in a row*. Rate alone was not a bound: a message the agent never cleared cost one typed kick — one Claude turn — every 20 seconds, indefinitely. Past the ceiling the router stops waking that agent, marks it stalled, parks its live task in `needs_you`, and mails the escalation. Clearing the inbox resets both the count and the stalled mark, so the ceiling bounds a stuck agent and never a productive one.

## Stop everything

`POST /v1/orchestrator/stop` kills the orchestrator session and every worker it spawned, in one call, and latches the router so the next tick does not respawn a worker for each still-assigned task — without the latch the emergency stop would last one tick (two seconds). It stops **processes**, never rewriting task files: the board is left exactly as it was, and `POST /v1/orchestrator/start` clears the latch and resumes from the files.

This is the control that was missing. `POST /v1/agents/{id}/signal` is per-agent and needs a session id the user has no list of, so an unattended fleet running with `--dangerously-skip-permissions` had no single way to be halted. Only sessions Caprock spawned are signalled (rule 7).

## Cost attribution per task

Join `events` → task via assignment windows (the interval during which a task is assigned to a session); task cards show spend vs budget. Shipped in v0.3.0: the router opens an assignment window when it spawns a worker for a task, and verification closes it and sums the cost.

`task_assignments.session_id` is a **Caprock session id**, never a hive agent id — `AttributeTaskCost` joins it against `events.session_id`. The router opens a window keyed on the session it spawned for the worker; the board, which finishes the task and knows only the agent id, closes **every open window on the task**. Closing by task is also correct when a task was worked by more than one session (a reassignment, or a worker respawned after a crash). An unclosed window is not a missing number but a growing one: the join has no upper bound, so a finished task keeps absorbing everything that session spends next.

## Status transitions

`hive.CanTransition` validates a single hop and `Hive.UpdateTask` validates start-vs-end only, so a caller needing to move a task several columns must apply the steps one at a time. `hive.TransitionRoute` returns the shortest legal path and `board.moveTo` walks it. Guarding one hop with `CanTransition` and skipping it when illegal is what stranded tasks — verification called from a status the orchestrator never advanced silently no-opped, and the next verify then hard-errored on the illegal jump. An unreachable target is a returned error, never a silent no-op.

## How we describe it to users

**"An unattended task runner with a test gate", not "a multi-agent hive".** The owner's own verdict after months of shipping it was "I still don't understand what it is or what it's for", and a five-person panel traced that to the wording as much as to the missing output. The closest thing a user already knows is a git worktree plus a shell loop; what this adds is that a worker cannot stop early, a failing check bounces back with its output attached, spend is attributed per task against a budget, and there is a board showing state. That is the sentence the README, the CLI help and the off-state all use. The internal vocabulary — "hive", "Phase 2" — stays internal; `--hive` survives only as the flag name, and its help text now describes a queue directory.

**It stays an advanced opt-in.** The product's headline is cost observability. This is the one part of Caprock that starts sessions by itself, so it is off unless asked for, it is not promoted above the fold, and the README section leads with what it will do to the user's machine before what it can do for them.

**The visible-output rule.** A task that reached `done` must be able to answer four questions from its card: what changed (the diff), what proved it (the commands that ran and their exit codes), where the work is (branch and worktree, named plainly), and how to take it (the git command, copyable). All four were recorded and none were shown; `GET /v1/sessions/{id}/diff` had existed for months with nothing in the UI referencing it. Landing the work stays the user's action — Caprock prints the merge command and never runs git on a user's branches.

## CLI surface

- `caprock up --hive <dir> [--repo <dir>]` — turn the runner on. Prints `task runner is on   (hive: <abs path>)` on both the foreground and detached paths, and logs `task runner enabled` with the hive and repo. Starting with `--hive` used to print exactly the same line as starting without it.
- `caprock status` — always carries a `hive:` line: the path and repo when on, and `off — \`caprock up --hive <dir>\`` when not.
- `caprock tasks` — the board. Takes **no** arguments (`cobra.NoArgs`): `caprock tasks create` used to ignore its argument and print the list, a fake success for a command that did not exist. The id column is measured against the widest id rather than a hard-coded `%-14s`, which misaligned every row of a real board (generated ids are 17 characters).
- `caprock task create --title … --done-criteria … [--budget] [--body]` — fill the queue from a terminal or a script. `--done-criteria` is repeatable and required; refusing at the flag is cheaper than a task parked in `needs_you` an hour later. Its `--help` explains that these are shell commands Caprock runs in the worker's worktree.

## Orchestrator prompt

The system prompt is English, lives at `.ai/07-orchestrator.md` (created in T21; the spec's `.ai/orchestrator.md` renamed to a numbered slot per [ADR-016](08-decisions.md#adr-016--corpus-layout-numbered-ai-files-minimal-root-spec-deleted-after-audit)), and is spawned by `ptyman` with its own worktree; spawn/respawn policy and scribing (status transitions written to task files + ledger) are part of T21.

## Auto-pause ownership rule (Phase 1)

This file owns the rule; Phase 1 DoD item 4 in [09-execution-plan.md](09-execution-plan.md#phase-1--control) quotes the spec's wording of the same rule verbatim.

Auto-pause acts on **owned sessions only** (Caprock has the PID and the PTY): per-setting SIGSTOP/SIGCONT (POSIX) / input-hold + warning (Windows, no SIGSTOP), one click to resume. Externally observed sessions stay alert-only — hooks don't give us process ownership, and we never signal a process we didn't start. Default: alert-only everywhere; auto-pause opt-in.
