package hive

import (
	"os"
	"path/filepath"
)

// Seed writes a README and one example task into a *fresh* hive, so the
// directory documents itself.
//
// A new hive used to be three empty directories with no clue what belonged in
// them: the one place a user looks after running `caprock up --hive` explained
// nothing. Both files are written only if absent, and Seed is silent about an
// existing hive — it never overwrites a user's work, and it never re-seeds a
// hive whose example task was deliberately deleted (the marker for that is the
// README, which a seeded hive always has).
func (h *Hive) Seed() error {
	if _, err := os.Stat(filepath.Join(h.Root, "README.md")); err == nil {
		return nil
	}
	if err := writeIfAbsent(filepath.Join(h.Root, "README.md"), seedREADME); err != nil {
		return err
	}
	return writeIfAbsent(h.taskPath(exampleTaskID), exampleTask)
}

// exampleTaskID is deliberately not in the `t-<millis>-<n>` shape the board
// generates, so an example is never mistaken for something Caprock created.
const exampleTaskID = "example-task"

// exampleTask sits in `inbox` with the runner's own two checks as criteria, so
// copying it is a working starting point rather than a template to fill in.
const exampleTask = `---
id: example-task
title: Example — delete this or edit it into a real task
status: inbox
assignee: null
budget_usd: 3
done_criteria:
  - go test ./...
  - go vet ./...
verify_rounds_used: 0
---
This is an example. Nothing runs until you start the orchestrator, and nothing
is assigned until the orchestrator assigns it.

Replace this text with what you want done. Be specific about the acceptance
condition — the worker reads this body, and ` + "`done_criteria`" + ` above is what
Caprock actually runs to decide whether the work is finished.
`

// seedREADME explains the directory in the terms a user needs before they trust
// it with an unattended run: where the work happens, who runs the checks, and
// what each file here is.
const seedREADME = `# Caprock hive

This directory is a task queue for unattended Claude Code runs. Caprock created
it because you started the daemon with ` + "`--hive`" + ` pointing here.

## What runs here

Nothing, by itself. Starting the orchestrator (the dashboard's Tasks screen, or
` + "`POST /v1/orchestrator/start`" + `) spawns a Claude session that reads the tasks
below, assigns each one to a worker, and waits for results.

Each worker gets **its own git worktree** of your repository, at
` + "`<repo>/.caprock-worktrees/<worker-id>`" + `, on a branch named
` + "`caprock/<worker-id>`" + `. Your own working tree is not touched. Workers run
with permission prompts skipped, so treat a task body as something that will be
acted on without a further confirmation from you.

When a worker says it is finished, **Caprock** — not the worker — runs the
task's ` + "`done_criteria`" + `: plain shell commands, run in that worker's worktree.
All exit 0, the task moves to ` + "`done`" + `. Any fail, the output bounces back to
the worker and it tries again (three rounds, then it asks you).

This works for **independent** tasks. Nothing here merges branches or notices
two workers editing the same file, so give concurrent tasks separate ground.

## What is in here

| Path             | What it is                                             |
| ---------------- | ------------------------------------------------------ |
| ` + "`tasks/<id>.md`" + `  | One task: YAML front matter plus a free-form brief     |
| ` + "`agents/<id>/`" + `   | One agent: its identity, memory, and inbox/outbox mail |
| ` + "`approvals/`" + `     | Decisions waiting on you                               |
| ` + "`verifications/`" + ` | Captured output of every ` + "`done_criteria`" + ` command run   |
| ` + "`ledger.jsonl`" + `   | Append-only log of every state change                  |

Files are the source of truth. Editing a task file by hand is a supported way to
work; the dashboard mirrors these files, not the other way round.

See ` + "`tasks/example-task.md`" + ` for the format.
`
