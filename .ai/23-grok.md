# Grok Build support

xAI's terminal coding agent, `grok` ("Grok Build"). Since 2026-10-10 Caprock
starts it from New agent and Quick chat like Claude Code, Codex, OpenCode and
Gemini CLI ([ADR-046](08-decisions.md#adr-046--the-agent-pickers-list-every-agent-with-what-it-lacks-grok-build-is-a-sixth-agent-custom-agents-are-free)).
It is **launch-only**: Caprock does not read its sessions, so a Grok session
has a row, a terminal and a tab, and no turns, tokens or cost.

## Sources

- **Official CLI.** docs.x.ai/build/overview, read 2026-10-10: install
  `curl -fsSL https://x.ai/cli/install.sh | bash` (macOS, Linux) or
  `irm https://x.ai/cli/install.ps1 | iex` (Windows PowerShell); binary
  `grok`; the first launch opens a browser to sign in, or `XAI_API_KEY` is
  used; config in `~/.grok/config.toml`; `-p` runs headless, `-m` picks a
  model, `/model` switches in the TUI.
- **Flags.** The real `grok --help`, grok 0.2.114 (0c785038798), run on
  2026-10-10 with a scratch `HOME` and no sign-in.
- **Files.** The README the installer ships in `~/.grok/README.md`
  ("Session Persistence", "File Locations", "Environment Variables").

A third-party project also called `grok-cli` (superagent-ai) exists and once
installed into the same `~/.grok/bin`. It is not xAI's and is not what Caprock
targets; the flags below are xAI's.

## The command line Caprock builds

`internal/agents/grok.go`, from `grok --help`:

- **New session** — `--session-id <uuid>`: "Use a specific session UUID for a
  new conversation". Caprock's session ids are UUIDs, so Caprock's row and
  Grok's session directory share one id.
- **Resume** — `--resume <id>`; **fork** — `--resume <id> --fork-session
  --session-id <new>` ("With --resume/--continue, only valid together with
  --fork-session"). Built and tested, but not offered: the session screen's
  *Continue* covers Claude Code, Codex and OpenCode only.
- **Model** — `--model <id>`. The pickers list `~/.grok/models_cache.json`
  (`models.<id>.info.{id,name,hidden}`), which Grok writes when it fetches its
  list; hidden models are left out. Empty: Grok's own default.
- **Permissions** — `--permission-mode` accepts Claude Code's names:
  `default, acceptEdits, auto, dontAsk, bypassPermissions, plan`. Caprock's
  choice is passed through when it is one of those; `manual` is left off.
  The bypass consent of ADR-041 is Claude Code's and does not apply.
- **Project instructions** — `--rules <text>`: "Extra rules to append to the
  system prompt", the counterpart of Claude Code's `--append-system-prompt`.
- **First message** — the positional `[PROMPT]`: "Initial prompt for the
  interactive session".
- **Binary** — found on the login shell's PATH or in `~/.grok/bin`, where the
  installer links it.

## Ready or not

The catalog (`internal/agentcat/grok.go`) calls Grok signed in when
`$GROK_HOME/auth.json` (default `~/.grok/auth.json`, "Authentication
credentials (auto-managed)") exists or `XAI_API_KEY` is set. Otherwise it
offers `grok login` (a `grok --help` subcommand). It is a hint, not a block:
the TUI signs in on its first start.

## Not built, and why

- **Observation.** Sessions are written to
  `~/.grok/sessions/<url-encoded cwd>/<session id>/` — `summary.json` (title,
  model, times), `updates.jsonl` (the conversation and tool calls, ACP update
  stream), `signals.json` (turn count, token usage). Readable, and keyed by
  the id Caprock passes. Not read yet: a cost needs Grok's prices in
  `pricing.json` with a source and a date (rule 6), and the token fields'
  shape was not checked against a signed-in session.
- **Folder trust.** Grok keeps a `workspace-trust.json`; its README ties trust
  to running a project's hooks (`/hooks-trust`), not to starting. Whether a
  first start in a new folder asks anything was not seen, because no signed-in
  session was run.
