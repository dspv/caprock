# Brief #4 — `/guides/resume-claude-code-sessions/`

Written 2026-10-01 from the search plan ([07-search.md](../07-search.md)).
Volumes: August 2026, [`../data/2026-10-01-keywords.tsv`](../data/2026-10-01-keywords.tsv);
built-in answer checked against code.claude.com/docs (sessions, cli-reference)
the same day.

## Question and phrases

"How do I get back into a Claude Code session I closed, and see all my
sessions?" The cluster head is `claude code list sessions` (320); the H1 owns
`how to resume claude code session` (260), the phrasing people use for the
task.

- **H1:** How to resume a Claude Code session.
- **## Resume the last session: `claude --continue`** — `claude code resume` 210.
- **## Resume a specific session by name or ID** — `claude code resume session` 170.
- **## List sessions: the session picker** — `claude code list sessions` 320,
  `claude code sessions` 260.
- **## Do you need to save a session?** — `claude code save session` 110.
- **## When resume fails** — deleted transcripts, moved folders.
- **## A session manager for every session** — `claude code session manager` 210.

## Built-in answer

- `claude --continue` reopens the most recent conversation in this directory.
- `claude --resume` opens the picker; `--resume <name|id|path>` goes straight
  to one; `/resume` (alias `/continue`) inside a session. An id is looked up in
  this project first, then all projects.
- Picker keys: `Space` preview, `Ctrl+R` rename, `/` search, `Ctrl+A` all
  projects, `Ctrl+W` worktrees, `Ctrl+B` this branch.
- Sessions save continuously; name one with `claude -n`, `/rename`; `/export`
  writes text. `--fork-session` and `/branch` fork.
- Transcripts are deleted after 30 days (`cleanupPeriodDays`). `-p` and SDK
  sessions are left out of the picker. There is no plain command that prints
  every session — do not write "you cannot list sessions".

## What Caprock adds, with proof

- Ended sessions searchable by title, prompt, project, branch —
  `.ai/04-ui.md` § Ended cards.
- Continue or branch: a second process with `claude --resume <id>`, or
  `--fork-session` while the original is live; never types into a terminal it
  did not start; offers the copyable command too —
  `internal/api/resume.go`, `internal/agents/agents.go`,
  `ui/src/components/ContinueSession.tsx`.
- "Can't continue" with the reason (transcript deleted, folder gone, `claude`
  not found). Measured 2026-09-29: of 116 ended sessions, 44 transcripts
  deleted and 21 folders gone (`.ai/04-ui.md`).
- A banner after a restart lists the sessions it interrupted.
- The prose survives the 30-day cleanup in Memory search.

## Limits

- A session whose transcript is gone cannot be continued — the record and the
  prose stay, the conversation does not.
- Codex and OpenCode get a copy command only; Gemini and DeepSeek none.

## Comparison

- **es6kr/claude-code-sessions** — browse, search, rename, split, clean up
  sessions via MCP, web UI or VS Code.
- JetBrains plugin "Clauditor" (from the `session manager` results) — read
  before writing.

## Claims still to verify

- Continue end to end on Windows.
- Whether sessions from before install appear.
- The current results for the resume phrases (not in the 2026-10-01 pull).
- A screenshot of continue / can't continue — none exists; take one.

## Links

- Out: `/install/`, guide #3 (history), `claude-code-forgets`.
- In: `/docs/` sessions section, guide #3.
