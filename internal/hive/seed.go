package hive

import (
	"path/filepath"
)

// Seed writes a README into a *fresh* hive, so the directory documents itself.
//
// A new hive used to be three empty directories with no clue what belonged in
// them. The README says what the directory is and shows the task file format.
// It is written only if absent, so Seed never overwrites a user's work.
//
// It used to write an example task too, into tasks/ in the inbox. A sample in
// the queue is work: the board showed it as waiting and the orchestrator
// assigned it, with checks (go test, go vet) guessed for a repository the seed
// had never looked at. The format now lives in the README, and the dashboard's
// templates (with checks detected from the repo) are the starting points.
func (h *Hive) Seed() error {
	return writeIfAbsent(filepath.Join(h.Root, "README.md"), seedREADME)
}

// exampleTask is the task file format, shown in the README. Its id is
// deliberately not in the `t-<millis>-<n>` shape the board generates.
const exampleTask = `---
id: example-task
title: Add a /healthz endpoint
status: inbox
assignee: null
budget_usd: 5
done_criteria:
  - make test
verify_rounds_used: 0
---
What to change, where, and what to leave alone. The worker reads this body;
` + "`done_criteria`" + ` above is what Caprock actually runs to decide whether the work
is finished — use the commands this repository really has.
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

A task file looks like this (save it as ` + "`tasks/<id>.md`" + `, or create it from
the dashboard's Tasks screen):

` + "```markdown" + `
` + exampleTask + "```" + `
`
