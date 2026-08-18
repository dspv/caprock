# Caprock — Architecture

How the system is built: the daemon, its two data planes, cross-platform rules, data sources with their degradation ladder, and the single normalized event model. Wire-level contracts (HTTP API, WebSocket frames, SQLite DDL, hook shim protocol) live in [03-contracts.md](03-contracts.md); orchestration internals in [05-orchestration.md](05-orchestration.md); the reasoning behind the stack in [08-decisions.md](08-decisions.md).

## System overview

```
┌─────────────────────────────────────────────────────────┐
│  Web UI (localhost:PORT, React + Vite, served by core)  │
│  Now · Tasks · Cost · Session Detail · History          │
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

- **Terminal plane** — `ptyman` spawns each agent as a `claude` process in a PTY, streams bytes to the UI (xterm.js in browser), accepts stdin writes. Lands in Phase 1; see [ADR-006](08-decisions.md#adr-006--pty-backend-conpty-capable-wrapper-behind-our-own-ptyman-interface) for the backend choice.
- **Event plane** — `hookd` is a local HTTP server; a tiny shim registered in each agent's `.claude/settings.json` POSTs hook payloads (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, PreCompact, …). **This is the source of truth for "what is the agent doing."**

**Why not Electron:** the only thing Electron buys is bundling Chromium. A Go daemon + browser tab gives the same UI with zero ABI pain, one `go build` per platform, and the option of a TUI later. Desktop wrapper (Tauri/Wails) is a packaging decision for later, not an architecture decision now ([ADR-003](08-decisions.md#adr-003--ui-stack-react--vite-embedded-in-the-go-binary-via-goembed)).

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

Phase 0 architecture slice (no `ptyman`; the ConPTY spike still happens in T0 to de-risk Phase 1):

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

Interaction model in Phase 0: the web UI is an observation window; the user keeps talking to Claude in the terminal. The hook shim is registered at the user level (`~/.claude/settings.json`), so **every** `claude` session on the machine is captured, regardless of which terminal or project started it. Spawning and typing into sessions from the UI arrive in Phase 1.

## Cross-platform: do it right on day one

This is where the incumbent bleeds users, so it is a hard requirement, not a nice-to-have.

- **The PTY trap:** `creack/pty` is POSIX-only — it does **not** cover Windows. Windows needs ConPTY. Pick a PTY layer with ConPTY support (evaluate `aymanbagabas/go-pty` and ConPTY via `golang.org/x/sys/windows`; decide in a spike before Phase 0 code — task T0 in [09-execution-plan.md](09-execution-plan.md#t0--conpty-spike-1-evening)). Abstract behind our own `ptyman` interface so the backend is swappable.
- **Path/shell hygiene:** never assume `sh`; the hook shim must be a compiled helper or platform-correct script (no bash-isms on Windows); all hive paths via `filepath`, no hardcoded `/`.
- **Hook transport:** Unix domain sockets don't exist portably → hookd listens on `127.0.0.1:<port>` with a per-run auth token, same code on all OS.
- **CI gate:** GitHub Actions matrix (ubuntu / macos / windows) runs unit tests **and** a smoke test (spawn a dummy PTY process, receive a hook POST, tail a fixture transcript) on every PR. A release that hasn't passed the Windows smoke test doesn't ship.
- **Observe-only degrades safely everywhere:** transcript tailing and hook receiving have zero platform-specific code, so even if a PTY backend regresses on one OS, Phase-0 value survives.

## Data sources

- **Hooks** (shim → hookd). Gives tool-level lifecycle: tool name + input, `session_id`, `cwd`, `transcript_path`, stop events. ~30 events exist; MVP consumes `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `PreCompact`. Latency: real-time.
- **Transcript JSONL** (`~/.claude/projects/…`). Gives the full message stream incl. per-turn token usage (input / output / cache read / cache write), model, text of assistant turns. Tailed by `ingest`. Latency: ~seconds. The observed on-disk shape (2026-08-18) is recorded in [03-contracts.md § Transcript JSONL](03-contracts.md#transcript-jsonl-observed-shape).
- **PTY bytes.** Raw terminal for the detail view; also fallback signal when hooks aren't installed. Latency: real-time.

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

Append-only `events` table + materialized rollups (`session_stats`, `agent_stats`, `daily_stats`). DDL in [03-contracts.md § SQLite schema](03-contracts.md#sqlite-schema-ddl-v1). Note the DDL v1 `events` row carries `source` (`hook` | `transcript`) in addition to the fields above, because the same session is seen through both planes and `ingest` dedupes against hook events by `session_id`.

## Loop detector

Rule: ≥ K `tool.pre` events with the same tool + normalized-similar input within T minutes → banner + optional auto-pause. Defaults **K=5, T=3**, configurable. Emits an `alert` frame on the live WebSocket. This is the "session in a loop drains your budget" killer feature. Auto-pause is Phase 1 and applies to owned sessions only — see [09-execution-plan.md § Phase 1](09-execution-plan.md#phase-1--control).

## Repository layout (target)

```
cmd/caprock/          # daemon + CLI (up/down/status/hooks …)
cmd/caprock-hook/     # the shim
internal/hookd/       # hook receiver
internal/ingest/      # transcript discovery + tailer + parser
internal/store/       # sqlite, migrations, queries
internal/rollup/      # stats + pricing
internal/api/         # REST + WS + embedded UI handler
internal/loop/        # loop detector
internal/ptyman/      # Phase 1
internal/hive/ internal/router/ internal/orchestrator/   # Phase 2
ui/                   # React + Vite app; builds into internal/api/dist (go:embed)
pricing/pricing.json  # embedded pricing table (versioned)
testdata/             # fixture transcripts, hook payloads, fake claude
```

Tooling, versions, CI, and release mechanics: [10-infrastructure.md](10-infrastructure.md).
