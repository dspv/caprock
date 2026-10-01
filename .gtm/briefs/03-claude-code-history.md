# Brief #3 — `/guides/claude-code-history/`

Written 2026-10-01 from the search plan ([07-search.md](../07-search.md)).
Volumes: August 2026, [`../data/2026-10-01-keywords.tsv`](../data/2026-10-01-keywords.tsv);
built-in answer checked against code.claude.com/docs (data-usage,
claude-directory, settings, commands) the same day.

## Question and phrases

"Where are my old Claude Code conversations, and how do I find, read or
export one?" Owns `claude code history viewer` (390); head `claude code
history` (260).

- **H1:** Claude Code history: where conversations are stored, how to search
  and keep them.
- **## Where does Claude Code store conversation history** — `where does
  claude code store conversation history` 50, `claude code transcripts` 210.
- **## Resume or export a conversation** — `claude code export conversation`
  70, `claude code session history` 50.
- **## Why old chat history disappears** — `claude code chat history` 70,
  `claude code conversation history` 30.
- **## A history viewer that keeps everything** — `claude code history viewer` 390.
- **## Other history viewers.**

## Built-in answer

- Transcripts: `~/.claude/projects/<project>/<session>.jsonl`, plaintext, kept
  "for 30 days by default to enable session resumption".
- `~/.claude/history.jsonl` keeps every prompt you typed and is not cleaned
  up — your prompts only, not Claude's replies.
- `cleanupPeriodDays`, default 30; cleanup runs daily. **The docs disagree on
  `0`** (settings reference: delete at session end; `.claude` directory page:
  minimum 1, `0` fails validation) — test before stating either.
- `/resume [session]`, `/export [filename]` (plain text of the current
  conversation).

## What Caprock adds, with proof

- Imports the transcripts already on disk on first run (`README.md`).
- Keeps everything by default: `retention_days` 0 = forever
  (`internal/config/config.go`).
- Memory: searches prose across every session — Claude's answer or the
  prompt — each result linked to its moment (`.ai/04-ui.md` § Memory,
  `internal/store/queries.go`).
- Says when Claude Code deleted a transcript (`internal/api/resume.go`).
- Bulk export: `caprock export` (`cmd/caprock/export.go`, `docs/schema.md`).
- **No Memory screenshot exists** (`shot-history.png` is Lifetime) — take one
  before writing.

## Limits

- Nothing from before Caprock first read the transcripts comes back.
- Memory is Claude Code prose only; Codex turns carry no text.
- `caprock export` writes rows, not a readable conversation like `/export`.

## Comparison (read 2026-10-01)

- **jhlee0409/claude-code-history-viewer** (MIT, ~2.2k stars): viewer for many
  assistants, global search, cost, and a one-click full backup so history
  survives the cleanup. **So "keeps history past 30 days" is not unique** —
  our difference is that it is automatic, with no backup step, beside live
  sessions and cost per repo.
- **simonw/claude-code-transcripts**: converts sessions to HTML pages.
- **VS Code "Claude Code and Codex Assist"** (agsoft.claude-history-viewer):
  browse, search, diff, resume; free tier limited to recent sessions — check
  the version on the day.

## Claims

- Verified: path, 30-day default, `/resume`, `/export`, Caprock keeps forever.
- Rejected: "only Caprock keeps history".
- Needs verification: `cleanupPeriodDays: 0`; the extension's version.

## Links

- In: home strip ("kept past the 30-day cleanup"), `claude-code-forgets`,
  `/docs/` history section.
- Out: `/install/`, `claude-code-forgets`, guide #4.
