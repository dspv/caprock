# Caprock — Architecture

How the system is built: the daemon, its two data planes, cross-platform rules, data sources with their degradation ladder, and the single normalized event model. Wire-level contracts (HTTP API, WebSocket frames, SQLite DDL, hook shim protocol) live in [03-contracts.md](03-contracts.md); orchestration internals in [05-orchestration.md](05-orchestration.md); the reasoning behind the stack in [08-decisions.md](08-decisions.md).

## System overview

```
┌─────────────────────────────────────────────────────────┐
│  Web UI (localhost:PORT, React + Vite, served by core)  │
│  Now · Tasks · Cost · Session Detail · Lifetime         │
└────────────▲───────────────────────────▲────────────────┘
             │ WebSocket (live events)   │ REST (queries)
┌────────────┴───────────────────────────┴────────────────┐
│                    Core daemon (Go)                      │
│  ptyman   │ hookd     │ ingest    │ router  │ orchestr. │
│  spawn /  │ HTTP hook │ transcript│ mailbox │ GOD agent │
│  stdin /  │ receiver  │ JSONL     │ deliver │ + verify  │
│  kill     │           │ tailer    │         │           │
│                     SQLite (events, stats, tasks)        │
└──────────────▲──────────────────▲───────────────────────┘
               │ hook POSTs       │ stdout/stdin
        ┌──────┴──────┐    ┌──────┴──────┐
        │ hook shim   │    │ claude PTY  │  × N agents
        └─────────────┘    └─────────────┘
```

Two data planes, mirroring what works in Munder Difflin, but in Go:

- **Terminal plane** — `ptyman` spawns each agent as a `claude` process in a PTY, streams bytes to the UI (xterm.js in browser), accepts stdin writes. Shipped in Control (v0.2.0); see [ADR-006](08-decisions.md#adr-006--pty-backend-conpty-capable-wrapper-behind-our-own-ptyman-interface) for the backend choice. The PTY is not held by the daemon: each owned session runs under its own `caprock pty-host` process, which outlives the daemon, so a restart or an upgrade leaves the session running and the next daemon reattaches it ([ADR-033](08-decisions.md#adr-033--an-owned-session-outlives-the-daemon-its-terminal-lives-in-a-pty-host)). The holder is the separate `caprock-pty-host` binary when it sits beside `caprock` (releases ship both), so a terminal does not pay for the whole daemon's package initialisation; without it, `caprock pty-host` runs the same code.
- **Event plane** — `hookd` is a local HTTP server; a tiny shim registered in each agent's `.claude/settings.json` POSTs hook payloads (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, PreCompact, …). **This is the source of truth for "what is the agent doing."**

**Why not Electron:** the only thing Electron buys is bundling Chromium. A Go daemon + browser tab gives the same UI with zero ABI pain, one `go build` per platform, and the option of a TUI later. Desktop wrapper (Tauri/Wails) is a packaging decision for later, not an architecture decision now ([ADR-003](08-decisions.md#adr-003--ui-stack-react--vite-embedded-in-the-go-binary-via-goembed)).

## Six agents, each by its own route

Caprock reads [OpenCode](https://github.com/anomalyco/opencode),
[Gemini CLI](https://github.com/google-gemini/gemini-cli), OpenAI Codex,
DeepSeek Harness and [Hermes Agent](https://github.com/NousResearch/hermes-agent)
as well as Claude Code. Each arrives by a different route, and the asymmetry is the
point — each is read the way that agent already keeps its own records, rather
than by asking it to keep ours:

- **Claude Code** needs a shim in `~/.claude/settings.json` and its JSONL
  transcripts tailed, because it publishes events and prose but no totals —
  Caprock joins turns to tool calls and prices them itself.
- **OpenCode** keeps one SQLite database in which cost, the four token counts,
  the working directory and the model are already columns. It is opened
  read-only and polled; nothing is installed, and its own cost figures are
  carried across rather than recomputed.
- **Gemini CLI** emits OpenTelemetry. Caprock starts it with
  `GEMINI_TELEMETRY_OUTFILE` pointing at a file per session and tails that,
  mapping `user_prompt`, `api_response` and `tool_call` records onto the same
  event kinds ([ADR-026](08-decisions.md), [ADR-027](08-decisions.md)). The file name is the session id,
  which is what joins the telemetry to the session Caprock spawned.
- **Codex** writes one append-only JSONL rollout per session under
  `$CODEX_HOME/sessions` (default `~/.codex`), moved to
  `archived_sessions/` when archived; both are read as files, a growing one
  from where the last poll stopped, nothing installed, and priced from
  Caprock's table because Codex reports tokens but no cost
  ([19-codex.md](19-codex.md)).
- **DeepSeek Harness** is read the same way from its own transcripts
  ([20-deepseek.md](20-deepseek.md)).
- **Hermes Agent** keeps one SQLite database (`<hermes home>/state.db`) with
  per-session token counters and its own cost, opened read-only and polled
  like OpenCode's. Its usage lives on the session row, not on messages, so the
  importer records the difference between Hermes's counters and Caprock's on
  each pass; Hermes's figure is carried across, never recomputed, and its
  cron and gateway runs are marked background ([24-hermes.md](24-hermes.md),
  [ADR-069](08-decisions.md)).

All six land in the same `events` and `sessions` tables, distinguished by
`events.source` and `sessions.agent`. Everything downstream — loop detection,
narration, work-kind classification, per-directory attribution — works on all of
them without knowing there is more than one, because each ingester shapes its
payloads like a Claude Code hook payload rather than like its own rows.

One difference reaches further than ingestion: **Caprock starts Claude Code and
Gemini, and does not start OpenCode, Codex or DeepSeek Harness.** A session it
started has a pid, so its end is a fact rather than an inference; the others'
are not, which is why
`ownsItsProcess()` gives it a clock where the others get process liveness
([ADR-028](08-decisions.md)).

Hermes Agent is both: Caprock reads every Hermes session, and starts one in a
terminal tab when asked; an observed one goes by the clock, one it started by
its process.

Full detail, including what is not supported, is in
[16-opencode.md](16-opencode.md), [19-codex.md](19-codex.md),
[20-deepseek.md](20-deepseek.md) and [24-hermes.md](24-hermes.md).

## Components

| Component  | Role                                                               | Phase |
| ---------- | ------------------------------------------------------------------ | ----- |
| `hookd`    | HTTP receiver for shim POSTs (`/v1/hook`), bearer-token gated      | 0     |
| `shim`     | `caprock-hook` binary: stdin JSON → POST, silent, `exit 0`         | 0     |
| `ingest`   | Discovers + tails transcript JSONL, parses per-turn usage          | 0     |
| `store`    | SQLite (pure Go), embedded migrations                              | 0     |
| `rollup`   | Event → `session_stats` / `daily_stats`; cost via pricing table    | 0     |
| `api`      | REST + WebSocket fan-out, serves the embedded UI                   | 0     |
| `ui`       | React + Vite SPA, `go:embed`-ded                                   | 0     |
| `ptyman`   | Spawn / stream / write / resize / kill PTY sessions                | 1     |
| `ptyhost`  | Per-session terminal holder that outlives the daemon (ADR-033)     | 1     |
| `hive`     | Hive dir layout, atomic file ops, single-committer git, ledger     | 2     |
| `router`   | Mailbox delivery outbox → inbox, ledger append, `mail.*` events    | 2     |
| `orchestr` | Orchestrator lifecycle, Stop-loop, verification runner, approvals  | 2     |
| `service`  | Autostart: launchd agent / systemd user unit / Startup script      | —     |
| `userenv`  | The login-shell environment spawned processes start with           | 1     |
| `logcap`   | Keeps the daemon's log file bounded (rotate at 64MB, keep one)     | —     |
| `remote`   | The relay channel: host for phones and computers, client to others | 1     |
| `peers`    | The other computers this one reaches, and a channel to each        | 1     |

**A process Caprock starts gets the user's environment, not the daemon's.** A
daemon started at login by launchd holds ten variables and
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`; one started from a terminal is a snapshot
of that terminal, frozen for as long as it runs. A session started with either
cannot find `gcloud`, Homebrew or anything the profile exports, and the user
sees "Caprock can't reach BigQuery" where plain `claude` can (FB-033).
`internal/userenv` runs the user's `$SHELL` as a login, interactive shell —
what a terminal tab reads — and captures its `env -0`, the way VS Code
resolves its shell environment. It is warmed at daemon start, served from a
cache and refreshed in the background after a minute, and bounded by a 30s
timeout. One shell runs at a time. A failed refresh keeps the previous copy.
A failed first resolution retries on its own (10s, 30s, 2m, then every 10m),
and a session started before any resolution has succeeded waits up to 15s
for the running one before falling back to the daemon's own environment. The
bound was 5s until 2026-09-30, when the warm-up at daemon start — beside
every importer's first pass, at load 11 — was killed at 5s, leaving the cache
empty until a session start tried again. `caprock status` (and
`shell_env` in `/v1/status`) says which environment sessions get. The
profile sees `CAPROCK_RESOLVING_ENVIRONMENT=1` and can skip interactive-only
work. `CAPROCK_DATA_DIR` stays pinned to the daemon's value. Spawned sessions
(`internal/agents`) and verification commands (`internal/board`) both use it;
Windows keeps the daemon's environment, which the registry already built.
Every process Caprock starts with no locale of its own (none of `LC_ALL`,
`LC_CTYPE`, `LANG` set) is given `LANG=en_US.UTF-8` on macOS and
`LANG=C.UTF-8` on Linux (`userenv.WithUTF8Locale`, applied by `Environ`;
`userenv.EnsureProcessLocale` sets it on the daemon itself at start, so a
child built from `os.Environ()` inherits it too), as Terminal.app and iTerm2 do before they
start a shell: launchd sets none, a profile seldom does, and in the C locale
bash showed a pasted "καλημέρα" as `\316\272…` while its bytes arrived
intact (user report, 2026-10-11, a Russian paste), and an agent's `pbcopy`
put a Russian line on the clipboard as Mac Roman garble (user report,
2026-10-15). A locale the user set is
left alone; Windows gets nothing, ConPTY being UTF-8 already.

### Imported Obsidian vaults

`internal/obsidian` parses and refreshes user-chosen Markdown folders into
Second Brain's nodes, source rows and edge claims, through `internal/store`.
It creates no session or event rows and makes no network/model calls. The
daemon runs one periodic scanner; file reads happen before its write
transaction. Rooted reads prevent a replaced file escaping the selected
vault. Management routes are local-only; agent access is a separate per-vault
opt-in, enforced by handoff, extraction topic selection and MCP's filtered
reads. Ownership, limits and refresh semantics are in
[03-contracts.md § Obsidian vaults](03-contracts.md#obsidian-vaults), rationale
in [ADR-079](08-decisions.md).

### Agents reading Caprock over MCP

`caprock mcp` (`cmd/caprock/mcp.go`, `internal/mcp`) is a separate stdio
process started by the user's MCP client, not a listener in the daemon. It
finds the running daemon through `runtime.json` on every tool call and reads
its existing loopback HTTP API using GET only. The tools rebuild responses
from selected fields, bound lists and text, and redact credentials and
payment details (`internal/redact`, Second Brain's privacy filter) before
writing JSON-RPC to stdout. A missing daemon is a tool error
with startup instructions; it does not end the protocol session.

No tool starts, stops or types into an agent, writes a memory, or changes a
setting. Adding this server to an agent makes its answers part of that
agent's conversation, including the model it uses; Settings states this
alongside the copyable setup commands. The `executable` field in status
supplies the stable binary path for installations without `caprock` on PATH.
Registering the server is the agent's own CLI, run by the daemon
(`internal/mcpreg`) only when the user clicks Connect on the machine: status
is read from the agents' config files, `mcp add` / `mcp remove` run with the
login shell's environment through `hidewin`.
The tool list and protocol belong to
[03-contracts.md § MCP server](03-contracts.md#mcp-server); rationale is in
[ADR-078](08-decisions.md), setup in [docs/mcp.md](../docs/mcp.md).

### Other computers

**A daemon speaks for the user's other computers; the dashboard only ever
talks to its own** ([ADR-067](08-decisions.md)). The path of one request:

```
dashboard ── loopback /v1/m/{B}/v1/… ──▶ daemon A (api.handleMachineProxy)
   ── internal/peers ── remote.Client
   ── Noise NK inside one WebSocket ──▶ relay ──▶ daemon B's remote.Host
   ── B's own loopback, Via: 1.1 caprock-remote ──▶ B's API, gated as A's device token
```

B runs nothing for A that it does not run for a phone: A is one more client
of its Host, with a device token. What is new on B is the kind of that
device. A code *for a computer* (`caprock pair --computer`, `POST
/v1/pair/code {kind: "machine"}`) pairs a device stored with `kind:
"machine"` that waits, `pending`, until B's owner allows it by name — the
dashboard's card (`ComputerAsks`), the prompt of `caprock pair --computer`,
or `caprock machines allow` over SSH. Allowed, it passes the gate on
`computerRoutes` (`internal/api/lanauth.go`), a superset of a phone
controller's, and the handlers' phone limits (`phoneLimited`) do not apply
to it; B's settings, pairing, doctor's stop, shutdown and update stay B's.
Every socket a device opens is held by its id (`devsockets.go`) and closed
with 1008 when it is removed or its role changes.

On A, `internal/daemon/machines.go` opens the `peers.Manager` on first use;
`machines.json` (0600) holds the computers A reaches, and a channel to one
is open only while something needs it, closing after 90 s with nothing
open. `/v1/machines` and the `/v1/m/{id}/{path…}` proxy (HTTP through
`httputil.ReverseProxy` on the channel, WebSockets bridged message by
message) are loopback-only and on no device's allowlist, so a phone paired
with A never reaches B through it. The app's side is PR3 of ADR-067's
Phase 1.

### Native terminals

"Open in my terminal" hands a session to the user's own terminal application
instead of the dashboard's xterm (owner request, 2026-10-04: typing in the web
terminal is uncomfortable). Nothing new watches it: a session running in
Ghostty is a session the user started themselves, observed through hooks and
the transcript like any other (Phase 0). `internal/nativeterm` detects what is
installed and builds the argv; `internal/api` decides what is allowed
([03-contracts.md](03-contracts.md)). Each terminal is driven through its own
interface:

- **Terminal.app** — `open -a Terminal <file>.command`. Terminal runs the file
  in a new window through the user's login shell, so the environment is
  theirs; the file deletes itself first and ends with `exec "$SHELL" -l`, so
  the window is a shell in the folder once the agent exits. No AppleScript,
  so no Automation prompt. Verified on the owner's Mac, 2026-10-04, with a
  folder named `w dir $HOME 'q' "dq"`.
- **iTerm2** — `osascript`: `create window with default profile`, then
  `write text` of the line into its shell. Verified the same day (iTerm2
  3.6.6). The first use from the daemon asks for Automation permission
  (System Settings → Privacy & Security → Automation). iTerm2 also opens
  `.command` files, but asks "OK to run …?" every time, so it is not used.
- **Ghostty, WezTerm, kitty** (macOS) — `open -na <App>.app --args …`, with
  their documented flags: Ghostty `--working-directory=<dir> -e <shell> -l -i
  -c <line>`, WezTerm `start --cwd <dir> -- …`, kitty `--directory <dir> …`.
  Written from their documentation; none was installed on the owner's Mac on
  2026-10-04, so none has been run.
- **Warp** — runs commands only from a launch configuration: Caprock writes
  `~/.warp/launch_configurations/caprock-open.yaml` (one file, overwritten)
  and opens `warp://launch/<path>`. Best effort and not yet run: Warp was
  installed on the owner's Mac but never set up.
- **Linux** — `$TERMINAL -e`, `gnome-terminal --`, `konsole -e`, `kitty`,
  `wezterm start --`, `alacritty -e`, `xterm -e`, each running the user's
  shell with the line; looked up on the login-shell PATH, not the daemon's.
- **Windows** — Windows Terminal `wt.exe -w new -d <dir> cmd.exe /k <argv>`
  (a `;` in the folder escaped, or wt reads it as a second tab); otherwise
  PowerShell or cmd started with `CREATE_NEW_CONSOLE` in the folder.

The line is `cd <dir> && <argv>`, every word POSIX-quoted unless plain, and it
is proved by a real `/bin/sh` in the tests against folder names with spaces,
quotes, `$`, backticks and `;`. AppleScript and YAML get their own escaping.
Argv words must match a plain charset, so an id can never carry shell syntax
to Windows, where cmd's quoting is not something to trust. Preferred order
when the user has not chosen: Ghostty, iTerm2, WezTerm, kitty, Terminal, Warp
on macOS; `$TERMINAL` first on Linux; Windows Terminal, PowerShell, cmd.

Phase 0 architecture slice (no `ptyman`; the ConPTY spike ran in T0 to de-risk Control) — historical:

```
claude (user-started) ──hooks──► POST /v1/hook (same server as API/UI, token-auth)
        │                              │
        └── transcript JSONL ──► ingest (fsnotify tail)
                                       │
                                normalize → events (SQLite)
                                       │
                            rollup (session_stats, daily_stats)
                                       │
                    HTTP API + WebSocket ──► React UI (go:embed)
```

Interaction model in Phase 0: the web UI is an observation window; the user keeps talking to Claude in the terminal. The hook shim is registered at the user level (`~/.claude/settings.json`), so **every** `claude` session on the machine is captured, regardless of which terminal or project started it. Spawning and typing into sessions from the UI shipped in Control (v0.2.0).

## Cross-platform: do it right on day one

This is where the incumbent bleeds users, so it is a hard requirement, not a nice-to-have.

- **The PTY trap:** `creack/pty` is POSIX-only — it does **not** cover Windows. Windows needs ConPTY. Pick a PTY layer with ConPTY support (evaluate `aymanbagabas/go-pty` and ConPTY via `golang.org/x/sys/windows`; decide in a spike before Phase 0 code — task T0 in [09-execution-plan.md](09-execution-plan.md#t0--conpty-spike-1-evening)). Abstract behind our own `ptyman` interface so the backend is swappable.
- **Path/shell hygiene:** never assume `sh`; the hook shim must be a compiled helper or platform-correct script (no bash-isms on Windows); all hive paths via `filepath`, no hardcoded `/`.
- **Hook transport:** Unix domain sockets don't exist portably → hookd listens on `127.0.0.1:<port>` with a per-run auth token, same code on all OS.
- **CI gate:** GitHub Actions matrix (ubuntu / macos / windows) runs unit tests **and** a smoke test (spawn a dummy PTY process, receive a hook POST, tail a fixture transcript) on every PR. A release that hasn't passed the Windows smoke test doesn't ship.
- **Observe-only degrades safely everywhere:** transcript tailing and hook receiving have zero platform-specific code, so even if a PTY backend regresses on one OS, Phase-0 value survives.

## Data sources

- **Hooks** (shim → hookd). Gives tool-level lifecycle: tool name + input, `session_id`, `cwd`, `transcript_path`, stop events. ~30 events exist; MVP consumes `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`. Latency: real-time.
- **Transcript JSONL** (`~/.claude/projects/…`). Gives the full message stream incl. per-turn token usage (input / output / cache read / cache write), model, text of assistant turns. Tailed by `ingest`. Latency: ~seconds. The observed on-disk shape (2026-08-18) is recorded in [03-contracts.md § Transcript JSONL](03-contracts.md#transcript-jsonl-observed-shape).
- **Gemini telemetry** (`<data_dir>/gemini/<session_id>.otel.log`). Gemini CLI has no hooks Caprock can install, and Caprock does not read the session history it keeps for itself (its `--resume` takes "latest" or an index, not an id), but it writes OpenTelemetry, and `GEMINI_TELEMETRY_OUTFILE` makes it write to a file Caprock names — the counterpart of Claude Code's transcript. A spawned session gets telemetry switched on with prompts included (`GEMINI_TELEMETRY_LOG_PROMPTS=true`, ADR-027 as amended 2026-10-01); a tailer reads each file from a remembered offset and records `user_prompt` / `api_response` / `tool_call` as `turn.user` / `turn.assistant` / `tool.post`. Latency: ~seconds. Cache *writes* stay zero — Gemini reports reads and has no counterpart figure, and a column meaning "we do not know" is better empty ([ADR-027](08-decisions.md)).
- **DeepSeek Harness transcripts** (`~/.dsh/sessions/<cwd>/<id>/session.v3.jsonl.zstd`). One append-only JSONL transcript per session, Zstandard-compressed, carrying the model, per-turn token usage (fresh input / cache read / output, reported separately), tool calls and prompts. Read by `internal/deepseek` the way Codex's importer read its rollouts before it read a growing one from where the last poll stopped — a poll that re-reads changed files whole, keyed by the record's monotonic `seq`. Latency: poll cadence (5s), sessions are history rather than live. Cache *writes* stay zero — DSH reports reads and no write counterpart ([20-deepseek.md](20-deepseek.md)).
- **Hermes Agent's state database** (`<hermes home>/state.db`: `$HERMES_HOME`, else `~/.hermes`, or `%LOCALAPPDATA%\hermes` on native Windows). SQLite in WAL mode; `sessions` carries cumulative tokens, Hermes's estimated and actual cost with their status and source, `source` (cli, cron, telegram…), `parent_session_id`, `cwd`, `git_branch`; `messages` carries the text and tool calls. Read by `internal/hermes`, `mode=ro`, every five seconds; see [24-hermes.md](24-hermes.md).
- **PTY bytes.** Raw terminal for the detail view; also fallback signal when hooks aren't installed. Latency: real-time. Deliberately not parsed for figures: it is a picture of a redrawing TUI, and token counts guessed from rendered text would break on the agent's next release.

Cost = token usage × pricing table (the spec says "ported from Caprock"; in practice the table is authored from the Anthropic pricing page and the cache-savings *formula* is what ports from Caprock-python — [ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson), [03-contracts.md § Pricing table](03-contracts.md#pricing-table)). Cache hit-rate math also ports from Caprock.

**Degradation ladder:** no hooks installed → transcript tailing still powers stats and activity (delayed); no transcript access → PTY-only mode (terminal + uptime only). Observe-only mode works on sessions the user started outside the harness, as long as hooks or transcripts are readable.

## Event model

Single normalized event type; everything (UI, stats, orchestrator, future avatar skin) consumes the same stream.

```go
type Event struct {
    ID        int64     // monotonic, SQLite rowid
    Ts        time.Time
    AgentID   string    // harness agent id
    SessionID string    // claude session id
    Kind      string    // tool.pre | tool.post | turn.user | turn.assistant |
                        // agent.stop | agent.spawn | mail.sent | mail.delivered |
                        // task.created | task.done | approval.requested | cost.tick
    Tool      string    // for tool.* (Bash, Edit, Read, mcp__…)
    Payload   json.RawMessage
    Tokens    *TokenDelta // for turn.assistant (in/out/cache_r/cache_w)
    CostUSD   *float64
}
```

Append-only `events` table + materialized rollups (`session_stats`, `agent_stats`, `daily_stats`). DDL in [03-contracts.md § SQLite schema](03-contracts.md#sqlite-schema-ddl-v1). Note the DDL v1 `events` row carries `source` (`hook` | `transcript`) in addition to the fields above, because the same session is seen through both planes; the planes are reconciled by shared dedupe keys ([03-contracts.md § Hook shim](03-contracts.md#hook-shim)). Three extra kinds exist in code: `context.compact` (PreCompact hooks), and `context.clear` / `session.continue` for the `SessionEnd` reasons that leave the session running. `SessionStart` maps to `agent.spawn`; `Stop`/`SubagentStop` to `agent.stop` (subagents carry `agent_id`). **A subagent's place is not its session's**: hooks fired inside a subagent, and its transcript lines, carry its own `cwd` and `gitBranch` — a background agent often runs in a git worktree of its own — so a subagent event (`agent_id` set, or a sidechain line) only fills a session's `cwd`, `git_branch`, `transcript_path` and repository when they are empty, and never overwrites the main thread's (`store.SessionPatch.FromSubagent`). A row a subagent moved before this is put back by the main thread's next event. **Claude Code's own `gitBranch` is not trusted for a live line either**: while a background agent worked in a linked worktree, the parent's own lines — no `agentId`, not a sidechain, `cwd` the main checkout on master — reported the worktree's branch (2026-10-09, 0.94.2). A transcript line written in the last ten minutes therefore takes the branch its `cwd`'s checkout has now, read from that checkout's `HEAD` (a linked worktree's through its `gitdir:`), and keeps its own `gitBranch` only when there is no such checkout or it is detached; an older line keeps what it says (`ingest.lineBranch`, `store.BranchAt`). The branch read for a folder answers for it for two seconds, so a burst of lines reads `HEAD` once (`ingest.branchCache`). **`SessionEnd` maps to `session.end` only when its reason is an exit** — `clear` becomes `context.clear` and `prompt_input_exit`/`other` become `session.continue`, because rollup retires a session on `session.end` and those reasons do not end one ([03-contracts.md § Hook shim](03-contracts.md#hook-shim)). Gemini answers are recorded as an ordinary `turn.user` + `turn.assistant` pair with `source = gemini`, so they are priced by the same table, searched by the same index and filtered by the same `agent` column as everything else ([ADR-023](08-decisions.md)).

**The payload is the source's record, with the tool fields bounded.** Hook and transcript copies of a tool call keep their `tool_input` and `tool_response` under one rule, `event.CapToolField`: base64 images and files become a marker naming type and size, text past 32 KiB is clipped with a marker naming what was dropped, and every short field stays. `tool_bytes` keeps the size before the cap. The rule and the marker formats are owned by [03-contracts.md § Hook payload](03-contracts.md#hook-payload-what-the-shim-forwards-verbatim).

**How the database is opened** (`store.Open`). WAL, so the dashboard reads while ingest writes, through a pool of eight connections. Three settings carry weight:

- **Every transaction begins IMMEDIATE** (`_txlock=immediate`). A plain `BEGIN` starts as a reader, and a reader that later writes cannot wait for the lock: SQLite fails the upgrade at once with `SQLITE_BUSY`, or `SQLITE_BUSY_SNAPSHOT` (517) if another writer committed meanwhile, and `busy_timeout` never runs. The recorder reads before it writes (`TurnPaidElsewhere`, then the insert), so from migration 0029 on it lost that race ~400 times an hour on the owner's machine. Every transaction in the daemon writes, so taking the lock up front costs none of them anything.
- **The whole file is memory-mapped** (`mmap_size` at the driver's 2 GB ceiling). Under WAL a connection discards its page cache whenever another connection has committed, which during a working session is several times a second, so every dashboard read started cold. Mapped pages come from the OS page cache, which survives commits and is shared by every connection: `/v1/stats/summary?range=today` went from 587ms to 39ms on a connection's first read after a commit (1 GB database, 2026-10-04).
- **The WAL is cut back after a big transaction** (`journal_size_limit`, 64 MiB). Without it the `-wal` file keeps the size of the largest transaction it ever held.
- **Every statement is timed** (`store/slowlog.go`). The pool's connections are wrapped so a statement — or a result set held open — longer than 300 ms logs one INFO line, `slow query`, with the calling function, the milliseconds, the rows, the statement's first 160 bytes, and how often and how long in all it has been slow since start. It exists because the daemon twice read over a gigabyte within a minute and nothing on record said who; on a copy of the owner's database it named the storage measurement and the startup's Week scans at once (2026-10-13).
- **A write that fails on a busy database is retried, never skipped.** The transcript tailer stops at the line, leaves its offset there, and reads it again on the next pass; keyed dedupe absorbs whatever part of the line did land. It used to log the error and move on, which lost 259 assistant turns ($18.52) on the owner's machine before migration 0034 re-read them.

Every producer writes through one path — `internal/rollup.Recorder.Record` — which stores the event, upserts the session, prices assistant turns, updates `session_stats` / `daily_stats` / `session_files` in one transaction, then publishes `event` + `session` frames on the in-process bus (`internal/bus`) that feeds the WebSocket and the loop detector.

- **History is written in batches; live hooks are not.** The transcript tailer and the Codex importer write through `Recorder.Batch`: the same per-event work, each event under its own savepoint, but one transaction for up to 512 events or 50 ms. The tailer commits a transcript's offset in the same transaction as its lines, so the stored offset never runs ahead of the events; a batch that fails rolls back whole and is read again, and keyed dedupe absorbs what earlier batches committed. Frames are published and `OnPriced` runs only after the commit, with one `session` frame per session per batch. Hook events still go through `Record`, one transaction each; the recorder serializes its writers with an in-process lock, and an open batch commits and steps aside as soon as a `Record` is waiting. Writers outside the recorder (a project added from the dashboard, a meta value) wait in SQLite's busy handler instead, so each batch leaves the lock free for a quarter of the time the previous one held it; back-to-back batches starved such a write past busy_timeout on the measuring stand. The gap is checked again once a batch holds the lock: a backfill runs a batch per transcript, and one already queued on the lock was handed it the moment the last committed, so the gap never opened and a memory kept in the Brain failed with `SQLITE_BUSY` (2026-10-19). A write that still finds the database busy is answered `503` with words, not a bare `500`. A batch's connection runs with `temp_store = MEMORY` while it is open, so the per-event savepoints' statement journal stays in memory rather than spilling to a temporary file.
- **Recorder writes start no goroutines.** `Record` and `Batch.Record` check the caller's context first, then write on `context.WithoutCancel`, in a transaction spelled out as `BEGIN IMMEDIATE` / `COMMIT` on a `*sql.Conn` rather than a `*sql.Tx`. The SQLite driver starts a goroutine per statement whose context can be cancelled, and database/sql one per query inside a `*sql.Tx` (whose context it can always cancel): four or five per event, which cost more CPU than a short write. busy_timeout still bounds the wait for the lock, and long reads keep their cancellable contexts.

## Loop detector

Rule: ≥ K `tool.pre` events with the same tool + normalized-similar input within T minutes → banner + optional auto-pause. Defaults **K=5, T=3**, configurable (`config.json`: `loop_k`, `loop_t_minutes`). **Read-only tools are excluded** — `Read`, `Glob`, `Grep`, `ToolSearch`, `NotebookRead` — because repeating one is ordinary work rather than a loop: measured over 64,733 real tool calls, the detector fired 436 times and 236 of those (54%) were a repeated `Read` of a single file, from re-reading after an edit or while searching. A tool call is billed at $0, so none of those alerts could have been about the budget this feature exists to protect, and an alert that cannot be about the budget is noise competing with the ones that can. Excluding them cut the alert count on that history from 436 to 174. Emits an `alert` frame on the live WebSocket. This is the "session in a loop drains your budget" killer feature. Auto-pause is Phase 1 and applies to owned sessions only — see [09-execution-plan.md § Phase 1](09-execution-plan.md#phase-1--control).

Implementation notes (`internal/loop`): "normalized-similar" = same tool + `tool_input` with numbers, hex hashes, temp paths and whitespace collapsed and free-text bodies (`content`, `old_string`, `new_string`) truncated to their first 200 chars, hashed into a signature; `description`/`timeout` are ignored. One alert per *episode*: after firing, the same signature stays silent while the loop continues and re-arms once it has been quiet for T. Backfilled history never raises alerts (events older than T are skipped). The Now card flips to `looping?` while an alert is younger than T. **Each thread counts apart**: the session's main thread, and each of its subagents (an `agent_id`, or `sidechain: true` without one — `event.Subagent`), keep separate windows. A subagent's calls arrive under the parent's session id, and until 2026-10-15 they shared its window: a parent and two subagents making the same edit, three each, read as nine repeats and flagged the parent. A subagent that repeats itself K times still raises the alert, on the session it works for. The Week card's longest loop replays history by the same lanes (`scanLoopSeries`).

## Session lifecycle

`active` on any event → `idle` after 5 minutes of silence (sweeper every 30 s) → `ended` when the session's **process** exits.

A session is over when its process is gone, not when it goes quiet: Caprock knows the pid of every session it spawns, and the shim reports its parent — the Claude Code that ran it — as `X-Caprock-Ppid`. So a session left alone for a week stays open, and one whose terminal was closed ends on the next sweep. The `SessionEnd` hook still ends a session immediately when it means an exit — and only then, since it also fires on `/clear` and Escape — and Caprock ends the sessions it kills. A `/clear` is the one case liveness cannot judge: it starts a new session id inside the *same* process, so the row it replaces shares a live pid with its replacement and is retired explicitly rather than by the sweep ([ADR-028](08-decisions.md#adr-028--a-session-ends-when-its-process-does)). Three silence thresholds preceded this and every one was wrong for somebody — see [ADR-028](08-decisions.md#adr-028--a-session-ends-when-its-process-does).

A reboot is the exception to trusting a pid: it hands the old numbers to other programs, so a session last heard from before the machine booted is ended whatever its pid answers (`store.BootTime`). A session Caprock starts outlives a restart of Caprock: its terminal is held by a `pty-host` process, and the next daemon reattaches it before its first sweep ([ADR-033](08-decisions.md#adr-033--an-owned-session-outlives-the-daemon-its-terminal-lives-in-a-pty-host)). One that still has its process but no terminal here — started by a release from before pty-hosts, or whose holder died — is marked `detached` and offered continue ([03-contracts.md](03-contracts.md)).

Two carve-outs: agents Caprock only observes (OpenCode) are judged by the clock alone, since their rows come out of another tool's database with no process behind them; and sessions with no pid keep a 24-hour staleness sweep, because there is nothing to ask — except the disk: one whose transcript file (when it was read from one) or whose directory no longer exists ends on the next sweep (`store.goneFromDisk`, 2026-10-14, after nine synthetic transcripts written and deleted by a test script left nine sessions "working" in the sidebar for what would have been a day). Separately, "working" needs a fresh event: one stamped more than two minutes ahead of the clock does not count as fresh (`internal/narrate`).

Ending is reversible: a later event on the same id makes the session active again, so an early end costs nothing. `/v1/sessions?active=true` returns everything not ended — separately, the Now screen hides anything silent for more than two days, because status cannot tell a quiet session from imported history. Narration ([04-ui.md § Narration map](04-ui.md#narration-map-t7)) is computed server-side in `internal/narrate` from the last 60 events.

## Retention and cleanup

What Caprock removes, when, and why. Everything here runs on its own on every
install — nobody is expected to run anything by hand — and touches nothing that
exists nowhere else and is still of use: prose, prompts, costs and stats live in
the database and are kept for as long as `retention_days` says (forever by
default). Each automatic sweep that removes anything logs one INFO line saying
what and how many bytes it freed, and is listed in the footprint's `actions`
(`caprock doctor`).

- **Tool output is bounded as it is written**, not cleaned later: images and
  base64 become markers, long text is clipped ([03-contracts.md § Hook
  payload](03-contracts.md#hook-payload-what-the-shim-forwards-verbatim)). The
  full output is still in the agent's own transcript.
- **The WAL shrinks after a big transaction**: `journal_size_limit` (64 MiB) is
  set on every connection when the database is opened, and a WAL over 256 MiB
  is checkpointed and truncated on its own ([03-contracts.md §
  Footprint](03-contracts.md#footprint)).
- **Events older than `retention_days`**, when the user sets it: deleted at
  start and every six hours (`pruneLoop`). Off by default.
- **The data-directory sweep** runs at most once a day, only after the daemon
  has been idle — nothing recorded — for 30 minutes (`daemon/cleanup.go`,
  checked every 15 minutes):
  - **`paste/` entries older than 30 days**, judged by the newest file inside —
    files pasted or dropped into a terminal (`paste/<stamp>-<random>/`, the
    desktop app's `paste/drop-<n>/`, older flat files). They were handed to a
    session by path to read once; a month later it has read them or never will.
  - **Empty `chats/<stamp>/` directories older than a day that no session ever
    ran in** — a quick chat opened and closed before anything started. One a
    session ran in is kept even when empty, because resuming it starts the
    agent there.
  - **`gemini/<id>.otel.log` of sessions that ended more than 30 days ago.** The
    file is Gemini's telemetry, which Caprock reads into the database as it is
    written, so an ended session's file is a second copy. A file whose session
    the database does not know, or that is still running, is kept.
  - **`launchd.log` once it is 30 days old.** No current version writes it: the
    LaunchAgent's output goes to `service.log`.
- **The storage measurement** (a full read of the database) runs only when the
  Storage panel asks for figures older than a day, and once a day while idle
  ([03-contracts.md § Storage](03-contracts.md#storage)).
- **The database compaction** runs on the same idle check, before the
  measurement, and stands down the moment anything is to be written
  (`daemon/compact.go`; details and measurements in [03-contracts.md § Payload
  compaction and auto-vacuum](03-contracts.md#payload-compaction-and-auto-vacuum-no-migration)):
  - **Base64 in older events** — screenshots and files stored before the write
    path bounded them — becomes the same marker new events get, a few hundred
    rows at a time, resumable, once. Text is kept whole.
  - **One VACUUM**, after that, gives the space back and switches the database
    to incremental auto-vacuum — only with free disk of 2.2 × the database's
    used size, within 10 minutes, and rolled back unchanged if anything wants
    to write meanwhile. Tried again daily until it has run.
  - **Incremental vacuum** from then on returns free pages — from the retention
    prune, from rows that shrank — 4 MiB at a time. A database created since
    2026-10-13 is incremental from the start.

## Repository layout

```
cmd/caprock/          # daemon + CLI (up/down/status/hooks/tasks/statusline/service/version …, hidden `hook` fallback shim)
cmd/caprock-hook/     # the shim binary (thin main over internal/shim)
cmd/caprock-pty-host/ # the terminal holder on its own (thin main over internal/ptyhost; ADR-033)
internal/shim/        # shim logic: stdin → POST, silent, Stop request-response
internal/statusline/  # `caprock statusline`: Claude Code status JSON → one-line render + best-effort rate-limit POST; `--rich` adds the daemon's session counters under a hard budget
internal/codex/       # OpenAI Codex: rollout-transcript parser + poller (read-only, priced by our own table)
internal/service/     # `caprock service`: autostart via launchd / systemd user unit / Startup folder
internal/userenv/     # the user's login-shell environment for processes Caprock starts (not launchd's bare one)
internal/tcc/         # macOS: a daemon with a temporary HOME stays out of the account's Desktop/Documents/Downloads (ADR-040); Guarded = the places background reads skip (ADR-044)
internal/disclaim/    # macOS: sessions and shells start responsible for themselves, so privacy prompts name them, not caprock (ADR-044)
internal/logcap/      # rotates the daemon's log (caprock.log or service.log) at 64MB; trims the one no longer written
internal/version/     # the version string (stamped via -ldflags at build)
internal/export/      # `caprock export`: the record out as TSV/CSV/jsonl, read-only, fixed columns (docs/schema.md)
internal/config/      # data dir, config.json, runtime.json, atomic writes
internal/event/       # the normalized Event type
internal/store/       # sqlite (modernc), migrations, all SQL
internal/cost/        # pricing table lookup, cost + cache-savings math
internal/rollup/      # single write path: store + session + stats + daily + bus
internal/bus/         # in-process fan-out for live frames
internal/hookd/       # hook receiver + payload normalizer
internal/hooks/       # settings.json installer (ordered-JSON merge, backup, uninstall)
internal/ingest/      # transcript discovery + tailer (fsnotify + poll) + parser
internal/loop/        # loop detector
internal/narrate/     # tool event → phrase, health badge, plan progress
internal/eta/         # the Queue view's rough estimates: turn-length quantiles, remaining time, queue positions
internal/relplan/     # the Work board's release column from local git: CHANGELOG [Unreleased] + changes/unreleased/ fragments, tag gaps, commits past the last tag; never fetches (ADR-064)
internal/toolcmd/     # the command a call ran, read out of its input (Codex's exec script) for every one-line description
internal/gitdiff/     # live `git diff` of a session's cwd
internal/api/         # REST + WS + embedded UI (dist/ committed for go install, placeholder/ fallback)
internal/daemon/      # wiring, runtime.json lifecycle, sweeper, auto-pause, Stop-decision
internal/smoke/       # the DoD scenario (build tag `smoke`), runs on the 3-OS matrix
internal/ptyman/      # PTY backend (go-pty; ConPTY on Windows) — Control
internal/agents/      # owned-session manager: spawn/stream/input/signal/exit, per-agent argv, worktree, folder-trust — Control
internal/sessionlink/ # joins a spawned Codex/OpenCode session to the id the agent gives it — Control
internal/wtsetup/     # a new worktree made ready: .worktreeinclude copies, the setup wrapper `caprock worktree-setup` (ADR-050) — Control
internal/relay/       # the brief that carries a session on in a new one, any agent (ADR-032) — Control
internal/slashcmd/    # the slash commands an agent offers in a folder, for the chat field's / picker (ADR-053)
internal/alerts/      # when the phone hears about a session, and the message it reads (ADR-036)
internal/brain/       # Second Brain's automatic extraction: finished sessions read by the user's own `claude -p`, memories kept with provenance (ADR-063); AI;DR's squeeze of one answer through the same runner (ADR-072)
internal/templates/   # new project from a template: the user's own list, their gh or a local copy, the brief committed (ADR-065)
internal/remote/      # access from anywhere (ADR-058): Noise NK, the frame protocol, the Host phones and computers reach, the Client this daemon reaches other computers with (ADR-067); relaysrv/ is `caprock remote relay`
internal/peers/       # the computers this machine reaches (ADR-067): machines.json (0600), pairing by link, requests and sockets carried as the paired device, Leave
internal/telegram/    # the owner's own bot: Bot API client, long-poll reader, paced outbox, the two-way bridge (ADR-047) — Control
internal/ptyhost/     # `caprock pty-host`: one process per owned session holding its PTY, so it outlives the daemon (ADR-033); orphan verdicts — Control
internal/keepawake/   # keeps the computer from idle-sleeping while agents work: modes, keeper, per-OS holders (ADR-049)
internal/procstat/     # the process table and each process's CPU and memory, read-only (the resource meter)
internal/termbuf/     # scrollback ring + terminal-mode tracking, shared by the daemon and the pty-host
internal/hive/        # on-disk orchestration state: agents/tasks/mailboxes/ledger, YAML — Orchestrate
internal/board/       # task board: verification runner, destructive-command policy, approvals — Orchestrate
internal/orchestrator/ # orchestrator + worker lifecycle, the mailbox-router reconciler — Orchestrate
ui/                   # React + Vite app; builds into internal/api/dist (go:embed)
pricing/              # pricing.json (models) + actions.json (GitHub Actions runners) + embed.go, each versioned
testdata/             # hook payloads, transcript fixtures + expected totals, loop fixtures, demo/ (caprock.dev's stand: a sanitised real session, scripts/demo-fixture.py), fakeclaude (a Go line-REPL `claude`; with a permission flag it draws the mode footer and cycles it on Shift+Tab)
```

Tooling, versions, CI, and release mechanics: [10-infrastructure.md](10-infrastructure.md).
