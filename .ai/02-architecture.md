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

- **Terminal plane** — `ptyman` spawns each agent as a `claude` process in a PTY, streams bytes to the UI (xterm.js in browser), accepts stdin writes. Shipped in Control (v0.2.0); see [ADR-006](08-decisions.md#adr-006--pty-backend-conpty-capable-wrapper-behind-our-own-ptyman-interface) for the backend choice.
- **Event plane** — `hookd` is a local HTTP server; a tiny shim registered in each agent's `.claude/settings.json` POSTs hook payloads (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, PreCompact, …). **This is the source of truth for "what is the agent doing."**

**Why not Electron:** the only thing Electron buys is bundling Chromium. A Go daemon + browser tab gives the same UI with zero ABI pain, one `go build` per platform, and the option of a TUI later. Desktop wrapper (Tauri/Wails) is a packaging decision for later, not an architecture decision now ([ADR-003](08-decisions.md#adr-003--ui-stack-react--vite-embedded-in-the-go-binary-via-goembed)).

## Three agents, three routes in

Caprock reads [OpenCode](https://github.com/sst/opencode) and
[Gemini CLI](https://github.com/google-gemini/gemini-cli) as well as Claude
Code. All three arrive by completely different routes, and the asymmetry is the
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

All three land in the same `events` and `sessions` tables, distinguished by
`events.source` and `sessions.agent`. Everything downstream — loop detection,
narration, work-kind classification, per-directory attribution — works on all of
them without knowing there is more than one, because each ingester shapes its
payloads like a Claude Code hook payload rather than like its own rows.

One difference reaches further than ingestion: **Caprock starts Claude Code and
Gemini, and does not start OpenCode.** A session it started has a pid, so its
end is a fact rather than an inference; OpenCode's is not, which is why
`ownsItsProcess()` gives it a clock where the others get process liveness
([ADR-028](08-decisions.md)).

Full detail, including what is not supported, is in
[16-opencode.md](16-opencode.md).

## Components

| Component  | Role                                                              | Phase |
| ---------- | ----------------------------------------------------------------- | ----- |
| `hookd`    | HTTP receiver for shim POSTs (`/v1/hook`), bearer-token gated     | 0     |
| `shim`     | `caprock-hook` binary: stdin JSON → POST, silent, `exit 0`        | 0     |
| `ingest`   | Discovers + tails transcript JSONL, parses per-turn usage         | 0     |
| `store`    | SQLite (pure Go), embedded migrations                             | 0     |
| `rollup`   | Event → `session_stats` / `daily_stats`; cost via pricing table   | 0     |
| `api`      | REST + WebSocket fan-out, serves the embedded UI                  | 0     |
| `ui`       | React + Vite SPA, `go:embed`-ded                                  | 0     |
| `ptyman`   | Spawn / stream / write / resize / kill PTY sessions               | 1     |
| `hive`     | Hive dir layout, atomic file ops, single-committer git, ledger    | 2     |
| `router`   | Mailbox delivery outbox → inbox, ledger append, `mail.*` events   | 2     |
| `orchestr` | Orchestrator lifecycle, Stop-loop, verification runner, approvals | 2     |
| `service`  | Autostart: launchd agent / systemd user unit / Startup script     | —     |

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
- **Gemini telemetry** (`<data_dir>/gemini/<session_id>.otel.log`). Gemini CLI has no hooks Caprock can install and writes no transcript, but it writes OpenTelemetry, and `GEMINI_TELEMETRY_OUTFILE` makes it write to a file Caprock names — the counterpart of Claude Code's transcript. A spawned session gets telemetry switched on and prompts switched off; a tailer reads each file from a remembered offset and records `user_prompt` / `api_response` / `tool_call` as `turn.user` / `turn.assistant` / `tool.post`. Latency: ~seconds. Cache *writes* stay zero — Gemini reports reads and has no counterpart figure, and a column meaning "we do not know" is better empty ([ADR-027](08-decisions.md)).
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

Append-only `events` table + materialized rollups (`session_stats`, `agent_stats`, `daily_stats`). DDL in [03-contracts.md § SQLite schema](03-contracts.md#sqlite-schema-ddl-v1). Note the DDL v1 `events` row carries `source` (`hook` | `transcript`) in addition to the fields above, because the same session is seen through both planes; the planes are reconciled by shared dedupe keys ([03-contracts.md § Hook shim](03-contracts.md#hook-shim)). One extra kind exists in code: `context.compact` (PreCompact hooks). `SessionStart` maps to `agent.spawn`, `SessionEnd` to `session.end`, `Stop`/`SubagentStop` to `agent.stop` (subagents carry `agent_id`). Gemini answers are recorded as an ordinary `turn.user` + `turn.assistant` pair with `source = gemini`, so they are priced by the same table, searched by the same index and filtered by the same `agent` column as everything else ([ADR-023](08-decisions.md)).

Every producer writes through one path — `internal/rollup.Recorder.Record` — which stores the event, upserts the session, prices assistant turns, updates `session_stats` / `daily_stats` / `session_files` in one transaction, then publishes `event` + `session` frames on the in-process bus (`internal/bus`) that feeds the WebSocket and the loop detector.

## Loop detector

Rule: ≥ K `tool.pre` events with the same tool + normalized-similar input within T minutes → banner + optional auto-pause. Defaults **K=5, T=3**, configurable (`config.json`: `loop_k`, `loop_t_minutes`). **Read-only tools are excluded** — `Read`, `Glob`, `Grep`, `ToolSearch`, `NotebookRead` — because repeating one is ordinary work rather than a loop: measured over 64,733 real tool calls, the detector fired 436 times and 236 of those (54%) were a repeated `Read` of a single file, from re-reading after an edit or while searching. A tool call is billed at $0, so none of those alerts could have been about the budget this feature exists to protect, and an alert that cannot be about the budget is noise competing with the ones that can. Excluding them cut the alert count on that history from 436 to 174. Emits an `alert` frame on the live WebSocket. This is the "session in a loop drains your budget" killer feature. Auto-pause is Phase 1 and applies to owned sessions only — see [09-execution-plan.md § Phase 1](09-execution-plan.md#phase-1--control).

Implementation notes (`internal/loop`): "normalized-similar" = same tool + `tool_input` with numbers, hex hashes, temp paths and whitespace collapsed and free-text bodies (`content`, `old_string`, `new_string`) truncated to their first 200 chars, hashed into a signature; `description`/`timeout` are ignored. One alert per *episode*: after firing, the same signature stays silent while the loop continues and re-arms once it has been quiet for T. Backfilled history never raises alerts (events older than T are skipped). The Now card flips to `looping?` while an alert is younger than T.

## Session lifecycle

`active` on any event → `idle` after 5 minutes of silence (sweeper every 30 s) → `ended` when the session's **process** exits.

A session is over when its process is gone, not when it goes quiet: Caprock knows the pid of every session it spawns, and the shim reports its parent — the Claude Code that ran it — as `X-Caprock-Ppid`. So a session left alone for a week stays open, and one whose terminal was closed ends on the next sweep. The `SessionEnd` hook still ends a session immediately when it means an exit, and Caprock ends the sessions it kills. Three silence thresholds preceded this and every one was wrong for somebody — see [ADR-028](08-decisions.md#adr-028--a-session-ends-when-its-process-does).

Two carve-outs: agents Caprock only observes (OpenCode) are judged by the clock alone, since their rows come out of another tool's database with no process behind them; and sessions with no pid keep a 24-hour staleness sweep, because there is nothing to ask.

Ending is reversible: a later event on the same id makes the session active again, so an early end costs nothing. `/v1/sessions?active=true` returns everything not ended — separately, the Now screen hides anything silent for more than two days, because status cannot tell a quiet session from imported history. Narration ([04-ui.md § Narration map](04-ui.md#narration-map-t7)) is computed server-side in `internal/narrate` from the last 60 events.

## Repository layout

```
cmd/caprock/          # daemon + CLI (up/down/status/hooks/tasks/statusline/service/version …, hidden `hook` fallback shim)
cmd/caprock-hook/     # the shim binary (thin main over internal/shim)
internal/shim/        # shim logic: stdin → POST, silent, Stop request-response
internal/statusline/  # `caprock statusline`: Claude Code status JSON → one-line render + best-effort rate-limit POST
internal/service/     # `caprock service`: autostart via launchd / systemd user unit / Startup folder
internal/version/     # the version string (stamped via -ldflags at build)
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
internal/gitdiff/     # live `git diff` of a session's cwd
internal/api/         # REST + WS + embedded UI (dist/ committed for go install, placeholder/ fallback)
internal/daemon/      # wiring, runtime.json lifecycle, sweeper, auto-pause, Stop-decision
internal/smoke/       # the DoD scenario (build tag `smoke`), runs on the 3-OS matrix
internal/ptyman/      # PTY backend (go-pty; ConPTY on Windows) — Control
internal/agents/      # owned-session manager: spawn/stream/input/signal/exit, worktree, folder-trust — Control
internal/hive/        # on-disk orchestration state: agents/tasks/mailboxes/ledger, YAML — Orchestrate
internal/board/       # task board: verification runner, destructive-command policy, approvals — Orchestrate
internal/orchestrator/ # orchestrator + worker lifecycle, the mailbox-router reconciler — Orchestrate
ui/                   # React + Vite app; builds into internal/api/dist (go:embed)
pricing/              # pricing.json + embed.go (versioned pricing table)
testdata/             # hook payloads, transcript fixtures + expected totals, loop fixtures
```

Tooling, versions, CI, and release mechanics: [10-infrastructure.md](10-infrastructure.md).
