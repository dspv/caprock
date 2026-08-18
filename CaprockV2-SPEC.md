# Caprock — Mission Control for Claude Code

**Status:** v1.0 (handed off to development) · **Owner:** Dima · **Repo:** github.com/dspv/caprock · **Domain:** caprock.dev · **License:** Apache-2.0

---

## 1. One-liner

A local, open-source **mission control for Claude Code**: spawn and orchestrate multiple real `claude` sessions, watch them work through a live, *useful* dashboard (activity, plan progress, diffs, token burn, cost), intervene with one click, and accumulate statistics across every session you ever run.

Utility first. The fun layer (avatars, office floor) is a skin added later on top of the same event stream.

## 2. Prior art: Munder Difflin

- **Repo:** https://github.com/chaitanyagiri/munder-difflin · **Site:** https://munderdiffl.in · MIT (code), pixel-art assets non-commercial (LimeZu).
- **What it is:** Electron desktop app; wraps CLI agents (Claude Code, Codex, Copilot CLI, Grok, Gemini/Antigravity, Qwen, …) as persistent PTY workers with mailboxes, shared memory, and a "GOD" orchestrator clone; visualized as *The Office*-themed simulation.
- **Measured effect (as of Aug 2026):** r/ClaudeCode launch post — **1,040 upvotes, 180 comments in 3 days**; Product Hunt launch; author reports **~2,000 users, ~677 GitHub stars, ~40 releases in 2 months** (v0.0.1 → v0.4.x); some directories list 1,200+ stars. Numbers vary by source and move fast — treat as order-of-magnitude, verify before quoting publicly.
- **Why it landed:** the office simulation made agent activity legible to non-engineers and gave the project a story; local-first + free + MIT removed all adoption friction; "runs on the subscription you already pay for" answered the cost objection.
- **Where it already went** (don't underestimate): v0.2.0 added per-agent token budgets, OpenTelemetry observability, a circuit breaker, and SQLite persistence; later versions added Slack driving, GitHub-webhook → task ingestion, voice, and mixed-capability swarms (Opus orchestrator + cheap workers). Our edge is *not* "they have no telemetry" — see §2.1 and §3.1.

## 2.1 Problem & evidence

1. **Dead-air waiting.** You give Claude a task and stare at a scrolling terminal or check your phone. There is nothing useful to watch: no progress, no plan state, no "what is it actually doing right now."
2. **Token anxiety.** Usage limits feel opaque; users report burning daily budgets in minutes when a session loops, and per-task cost is invisible until it's too late.
3. **Trust gap for autonomy.** The #1 question people ask multi-agent harnesses: *how does the orchestrator know a worker is actually done?* Nobody wants to leave agents unattended without verification.
4. **Reliability & platform gap.** Munder Difflin proved demand but its Electron + node-pty stack keeps biting: a Product Hunt reviewer on Windows hit a startup failure that killed his three-agent benchmark and declined to adopt the runtime; the team's own blog documents a release-breaking bug at the CommonJS/ESM boundary. Native-addon rebuilds (`electron-rebuild` against Electron's ABI) are a recurring install-failure class.
5. **Spawn-only visibility.** It only sees agents *it* spawned. Nobody serves the much larger population who just run `claude` in a terminal today and want to see what it's doing and costing — without changing their workflow.

## 3. Target users

- **Power users of Claude Code** running 2–10 sessions/worktrees in parallel (Dima is user zero).
- **Vibe-coders** who don't read raw terminal output and need a human-readable "what's happening" view.
- **Budget-conscious subscribers** ($20/$100/$200 plans) who need burn-rate visibility.

## 3.1 Complaint → feature traceability

Every MVP feature must trace to a documented user pain. Current map:

| # | What users actually say | Evidence | Our feature | Phase |
|---|---|---|---|---|
| 1 | "One session in a loop can drain your daily budget in minutes" | Reddit threads on Claude usage limits (widely reported, incl. BBC coverage) | Loop detector + auto-pause (§8.1) | 0 |
| 2 | "Usage limits hit way faster than expected / consumption is opaque" | Same wave of complaints; Anthropic acknowledged and investigated | Live burn-rate + limit forecast (§8.4) | 0 |
| 3 | "Isn't that a fortune in tokens?" — first question on every harness launch | Munder Difflin PH thread (author pre-empts it in the pitch) | Cost per task/agent/model up front, cheap-worker/expensive-orchestrator presets | 0/2 |
| 4 | "How does the orchestrator decide a worker is finished?" — the blocker before unattended use | Munder Difflin PH review (top substantive comment) | Verification runner: `done_criteria` commands must pass before a task closes (§9) | 2 |
| 5 | "Windows startup failed, I'm not ready to adopt the runtime" | Munder Difflin PH review, v0.4.3 | Go static binary, ConPTY-tested, CI on 3 OS from Phase 0 (§5.1) | 0 |
| 6 | Staring at a blank terminal / checking the phone while Claude works | Dima's own pain; the entire premise of the office-sim's appeal ("makes activity visible without staring at a terminal") | The **Now** screen: narration, plan progress, live diff (§8.1–8.2) | 0 |
| 7 | "I want to watch the sessions I already run, not adopt a new runtime" | Implied by #5 — reviewer reused *patterns*, rejected the *runtime* | Observe-only mode on externally started sessions (§6) | 0 |

Rule: a feature with no row here is a candidate for cutting. New complaints from launch feedback get added as rows first, features second.

## 4. Product principles

1. **Every pixel earns its place** — each screen answers "what's happening / what does it cost / where do I need to act."
2. **Local-first, zero servers** — all data stays on the machine. Same trust story that made Munder Difflin land.
3. **Read before write** — v0 must be useful even in *observe-only* mode on sessions the user starts themselves. Orchestration is additive.
4. **Single static binary** — Go core, no native-addon build pain, macOS/Linux/Windows from day one.
5. **Plain files over cleverness** — mailboxes and task state are markdown/JSON on disk, inspectable with `cat`.

## 5. Architecture

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

- **Terminal plane** — `ptyman` spawns each agent as a `claude` process in a PTY (`creack/pty`), streams bytes to the UI (xterm.js in browser), accepts stdin writes.
- **Event plane** — `hookd` is a local HTTP server; a tiny shim registered in each agent's `.claude/settings.json` POSTs hook payloads (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, PreCompact, …). This is the source of truth for "what is the agent doing."

**Why not Electron:** the only thing Electron buys is bundling Chromium. A Go daemon + browser tab gives the same UI with zero ABI pain, one `go build` per platform, and the option of a TUI later. Desktop wrapper (Tauri/Wails) is a packaging decision for later, not an architecture decision now.

### 5.1 Cross-platform: do it right on day one

This is where the incumbent bleeds users, so it's a hard requirement, not a nice-to-have.

- **The PTY trap:** `creack/pty` is POSIX-only — it does **not** cover Windows. Windows needs ConPTY. Pick a PTY layer with ConPTY support (evaluate `aymanbagabas/go-pty` and ConPTY via `golang.org/x/sys/windows`; decide in a spike before Phase 0 code). Abstract behind our own `ptyman` interface so the backend is swappable.
- **Path/shell hygiene:** never assume `sh`; hook shim must be a compiled helper or platform-correct script (no bash-isms on Windows); all hive paths via `filepath`, no hardcoded `/`.
- **Hook transport:** Unix domain sockets don't exist portably → hookd listens on `127.0.0.1:<port>` with a per-run auth token, same code on all OS.
- **CI gate:** GitHub Actions matrix (ubuntu / macos / windows) runs unit tests **and** a smoke test (spawn a dummy PTY process, receive a hook POST, tail a fixture transcript) on every PR. A release that hasn't passed the Windows smoke test doesn't ship.
- **Observe-only degrades safely everywhere:** transcript tailing and hook receiving have zero platform-specific code, so even if a PTY backend regresses on one OS, Phase-0 value survives.

## 6. Data sources

| Source | What it gives | Latency |
|---|---|---|
| **Hooks** (shim → hookd) | Tool-level lifecycle: tool name + input, session_id, cwd, transcript_path, stop events. ~30 events exist; MVP consumes PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart, PreCompact. | Real-time |
| **Transcript JSONL** (`~/.claude/projects/…`) | Full message stream incl. per-turn token usage (input/output/cache read/cache write), model, text of assistant turns. Tailed by `ingest`. | ~seconds |
| **PTY bytes** | Raw terminal for the detail view; also fallback signal when hooks aren't installed. | Real-time |

Cost = token usage × pricing table (ported from Caprock — see §11). Cache hit-rate math also ports from Caprock.

**Degradation ladder:** no hooks installed → transcript tailing still powers stats and activity (delayed); no transcript access → PTY-only mode (terminal + uptime only). Observe-only mode works on sessions the user started outside the harness, as long as hooks or transcripts are readable.

## 7. Event model

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

Append-only `events` table + materialized rollups (`session_stats`, `agent_stats`, `daily_stats`).

## 8. UI — five screens

### 8.1 Now (default, "the useful waiting screen")
The screen you leave open while Claude works. Per agent card:
- **Human-readable narration** of current activity ("editing `auth/middleware.go`", "running tests — 2nd attempt"), derived from tool events, not raw logs.
- **Plan progress** — parsed from TodoWrite/task-list tool events when present; else "N tool calls, M files touched".
- **Live burn**: tokens + $ this task, session context fill %, time since last event.
- **Health badges**: `working / idle / waiting-on-you / looping? / error`.
- One-click actions: open detail, send message, pause/kill.
- **Loop detector**: same tool + similar input ≥ K times in T minutes → banner + optional auto-pause. This is the "session in a loop drains your budget" killer feature.

### 8.2 Session Detail
- Live terminal (xterm.js) + input bar to type back.
- **Live diff tab** — `git diff` of the agent's worktree, auto-refreshed on Edit/Write events.
- Timeline of tool events; token/cost sparkline for this session.

### 8.3 Tasks (kanban)
- Columns: inbox → assigned → in-progress → verifying → done / needs-you.
- Tasks are files on disk (`tasks/<id>.md` with YAML frontmatter); the board renders them.
- "needs-you" = approvals queue (spend thresholds, destructive ops, scope changes).

### 8.4 Cost & Burn
- Burn-rate now ($/hr equivalent, tokens/min) per agent and total.
- **Limit forecast**: "at current pace you hit the 5-hour window limit in ~40 min" (learned empirically from observed throttle events; clearly labeled as estimate).
- Cache hit-rate, model mix, per-project and per-task cost. This whole screen is Caprock's DNA.

### 8.5 History (Caprock heritage)
- Cross-session stats: cost per project/day/model, tool usage distribution, avg task duration, success rate (tasks passing verification).
- Exportable; the "wow" screen for blog posts and screenshots.

### 8.6 Visual direction (v0 tokens)

Utility-first "mission control" aesthetic — the opposite pole from Munder Difflin's toy-office charm; the personality comes from density and precision, not decoration.

- **Theme:** dark by default (ops-room), light theme deferred. Background near-black (#0B0E14-ish), panels one step lighter, 1px borders, no shadows/gradients.
- **Color is semantic only:** green = working/verified, amber = idle/waiting, red = loop/error/over-budget, blue = info/links, neutral gray for everything else. Brand accent (single hue, pick once at T7) used only for interactive elements. No decorative color anywhere — if a color doesn't encode state, it's gray.
- **Type:** UI in a neutral sans (Inter or system stack); **all numbers, costs, IDs, and terminal content in monospace with tabular numerals** — columns of costs must align.
- **Density:** compact rows, generous data-per-screen; sparklines over big charts on Now; big charts live on Cost/History only.
- **Motion:** none except live-data updates (value ticks, new-event flash ≤150ms). No spinners longer than 300ms — show last-known data with a staleness dot instead.

These tokens live in `ui/src/design/tokens.css` as the single source of truth; every component derives from them (same discipline Munder Difflin's DESIGN.md enforces, different taste).

## 9. Orchestration & the trust gap

Phase 2+ (see roadmap). Design decisions up front:

- **Orchestrator = a normal `claude` session** with a dedicated system prompt + its own worktree; talks through the same mailbox files. No special API.
- **Mailboxes**: per-agent `inbox/` + `outbox/` dirs of markdown files; the router (harness, single writer) moves files and commits. Agents never run git on the hive repo.
- **The autonomy engine is the Stop hook**: agent stops → hook fires → harness checks inbox → if mail exists, respond with `decision: block` + reason ("process your inbox"), which forces the session to continue. Loop-guard: max N forced continues per task, then escalate to human.
- **Verification before done (the moat).** A task isn't done because a worker says so. Task frontmatter declares `done_criteria` (commands: tests, typecheck, lint, custom). On worker's "done": harness runs the commands; on failure the task bounces back with the failing output attached. Optionally a reviewer agent reads the diff. Only green checks move a task to `done`.
- **Escalation policy** (approvals queue): spend above per-task budget, destructive commands, scope change, N failed verification rounds.
- **Isolation**: one git worktree per agent by default.

## 10. What we deliberately skip (v0.x)

- Pixel-art office, avatars, animations — later, as a render mode of the event stream (and only with cleanly licensed assets; Munder Difflin's LimeZu art is non-commercial).
- Multi-provider engines (codex/gemini/grok) — architecture keeps `command` configurable per agent, but only `claude` is tested/supported in MVP.
- P2P / team features, cloud anything.
- Semantic memory index — plain markdown memory per agent is enough.

## 11. Caprock: assessment & relationship

**What Caprock is today:** free local stats utility for Claude Code (tokens, cache hit-rate, session cost), Python on PyPI, built on top of upstream Headroom (Dima contributes there), Apache-2.0, no monetization by design (resume value).

**Assessment:**
- ✅ Reusable: pricing tables, transcript JSONL parsing knowledge, cache/cost math, the brand + caprock.dev domain, "honest measurement" reputation.
- ⚠️ Not reusable as a base: Python is wrong for a long-running daemon owning PTYs; the Headroom dependency ties the roadmap to an upstream built for a different purpose (compression analysis, not live orchestration). A mission-control daemon must own its ingest path.

**RESOLVED:** the harness **is** Caprock — new Go codebase, new repo at `dspv/caprock` (personal profile for the launch story and portfolio visibility; transferable to an org later if open-core happens). The Python measurer is frozen: its repo is archived read-only, published PyPI versions keep working, and its `pricing.json` + transcript fixtures are copied into this repo for the T5 parity test. Original analysis kept below for the record.

**Recommendation — Option B with a brand bridge:**
- **New Go core, new repo.** Port cost/cache math and JSONL schema handling from Caprock (rewrite, not wrap).
- **Caprock stays alive** as the lightweight "just measure" tool; its README points to the new project as "Caprock's big brother". If the new thing takes off, fold Caprock in as `<name> stats` and keep caprock.dev as either the product domain or a redirect.
- This preserves Caprock's resume/OSS value, avoids carrying Headroom, and keeps the option of a Caprock-branded pivot open without betting on it now.

Rejected: pivoting Caprock in-place (Python lock-in, breaks existing users' expectations of a tiny measurer).

## 12. Roadmap

**Phase 0 — Observe (2–3 weeks of evenings).** Go daemon: hookd + shim installer + transcript ingest + SQLite + web UI with **Now**, **Session Detail** (terminal read-only + diff), **Cost**. Works on sessions the user starts manually. *Ship this publicly — it's already a standalone product ("see what your Claude Code is really doing/costing").*

**Phase 1 — Control.** ptyman: spawn/kill/type-back from UI; loop detector with auto-pause; History screen.

**Phase 2 — Orchestrate.** Mailboxes + router + Stop-loop + orchestrator agent + Tasks board + verification runner + approvals.

**Phase 3 — Delight.** Avatar/office render mode, packaging (Tauri/Wails or plain binary + `open localhost`), maybe TUI.

Each phase is independently useful and independently launchable (Reddit/PH posts per phase).

## 13. Risks

- **Hooks API churn** — ~30 events and growing; pin to the stable core set, tolerate unknown events, verify against official hooks reference each release.
- **Transcript format is not a public contract** — schema-version the parser, degrade gracefully (hooks-only mode).
- **Limit forecasting accuracy** — Anthropic doesn't expose limit state; label forecasts as estimates, learn from observed throttles.
- **Anthropic ships it themselves** — mitigations: multi-agent orchestration + verification layer are further from their core; move fast on Phase 0.
- **Attention** — Munder Difflin won on story. Phase 0 needs its own hook: "I watched my Claude burn $X in a loop — this tool catches it."

## 14. Decisions (resolved 2026-08-18)

1. **Name:** Caprock, hosted at caprock.dev. fortem.dev rejected (off-topic SEO authority, brand mixing with the ECS product).
2. **License:** Apache-2.0 (consistent with existing Caprock, patent grant).
3. **UI stack:** React + Vite, embedded into the Go binary via `go:embed`. Single-binary distribution preserved.
4. **Observe-only for externally started sessions:** yes — it is the Phase 0 wedge.
5. **Monetization:** free OSS through Phases 0–1; open-core (team/cloud tier) decision deferred until post-Phase-2 traction. Solo/local mode stays free permanently.
6. **PTY backend:** ConPTY-capable wrapper (first candidate `aymanbagabas/go-pty`, delegating to `creack/pty` on POSIX) behind our own `ptyman` interface; one-day spike to confirm it builds and passes a smoke test on all three OS. See PHASE0.md.

---

# Part II — Phase 0 Development Plan

**Scope:** Observe-only mission control. No agent spawning, no orchestration.
**Outcome:** a user runs `caprock up`, opens `localhost:4173`, starts `claude` in any terminal as usual — and sees live activity, cost, and loop alerts.
**Interaction model in Phase 0:** the web UI is an observation window; the user keeps talking to Claude in the terminal. The hook shim is registered at the user level (`~/.claude/settings.json`), so **every** `claude` session on the machine is captured, regardless of which terminal or project started it. Spawning and typing into sessions from the UI arrive in Phase 1.

## 1. Definition of Done (release gate)

Demo scenario that must work end-to-end on macOS, Linux, and Windows:

1. `caprock up` starts the daemon, installs/verifies the hook shim in `~/.claude/settings.json` (with user consent prompt), opens the dashboard.
2. User starts `claude` manually in any project and gives it a task.
3. Within 2s, the **Now** screen shows the session with human-readable activity ("editing `src/auth.go`", "running `go test ./...`").
4. Within 15s of each assistant turn, token usage and cost for the session update on **Now** and **Cost**.
5. Opening **Session Detail** shows the event timeline and a live `git diff` of the session's cwd (if it is a git repo).
6. A synthetic looping session (fixture: same Bash command 6× in 3 min) raises a loop banner on **Now**.
7. `caprock down` removes nothing from user data; restart restores history from SQLite.
8. All of the above passes in CI smoke tests on the three-OS matrix.

Non-goals for Phase 0: spawning agents, typing into sessions, tasks/kanban, mailboxes, approvals, avatars.

## 2. Architecture slice (Phase 0 only)

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

Components: `hookd`, `shim`, `ingest`, `store`, `rollup`, `api`, `ui`. No `ptyman` in Phase 0 (it lands in Phase 1); the one-day ConPTY spike still happens now to de-risk Phase 1.

## 3. Contracts

### 3.1 Hook shim

- Single Go binary `caprock-hook` (same repo, tiny), installed to Caprock's data dir.
- Registered in `~/.claude/settings.json` under events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`. Installer merges JSON non-destructively; `caprock hooks uninstall` reverts; back up the settings file before first write.
- Behavior (Phase 0–1: fire-and-forget): read stdin JSON → POST to `http://127.0.0.1:<port>/v1/hook` with `Authorization: Bearer <run-token>` → always exit 0 within 1s budget. Never print to stdout (a broken shim must not affect the user's Claude session). If the daemon is down, drop silently.
- One server, one port: `/v1/hook` lives on the same listener as the API and UI (default 4173); `<data_dir>/runtime.json` holds `{port, token}`, written by the daemon, read by the shim per invocation.
- Phase 2 extends this protocol for **Stop events only** — see Part III §2.2.

### 3.2 API (daemon, `127.0.0.1:4173`)

```
GET  /v1/sessions?active=true          → SessionSummary[]
GET  /v1/sessions/{id}                 → SessionDetail (stats + last N events)
GET  /v1/sessions/{id}/events?after=…  → Event[] (paginated)
GET  /v1/sessions/{id}/diff            → { files: FileDiff[] } | 409 not-a-git-repo
GET  /v1/stats/summary?range=today     → totals: tokens, cost, sessions, models
GET  /v1/stats/daily?days=30           → DailyStat[]
POST /v1/hook                          → 204 (shim only, bearer-token gated)
WS   /v1/live                          → server-push frames: {type:"event"|"session"|"alert", data:…}
```

JSON casing: snake_case. All money in USD float, all tokens int64. Versioned under `/v1` from day one.

### 3.3 SQLite schema (DDL v1)

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,          -- rowid, monotonic
  ts          INTEGER NOT NULL,             -- unix ms
  session_id  TEXT NOT NULL,
  source      TEXT NOT NULL,                -- 'hook' | 'transcript'
  kind        TEXT NOT NULL,                -- see SPEC §7
  tool        TEXT,
  payload     TEXT NOT NULL,                -- raw JSON
  tokens_in   INTEGER, tokens_out INTEGER,
  cache_read  INTEGER, cache_write INTEGER,
  cost_usd    REAL
);
CREATE INDEX idx_events_session_ts ON events(session_id, ts);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  cwd          TEXT, project TEXT, model TEXT,
  started_at   INTEGER, last_event_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'active',  -- active|idle|ended
  transcript_path TEXT
);

CREATE TABLE session_stats (       -- rollup, updated on write
  session_id  TEXT PRIMARY KEY REFERENCES sessions(session_id),
  turns INTEGER, tool_calls INTEGER, files_touched INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_usd REAL
);

CREATE TABLE daily_stats (
  day TEXT, project TEXT, model TEXT,
  tokens_total INTEGER, cost_usd REAL, sessions INTEGER,
  PRIMARY KEY (day, project, model)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- schema_version, pricing_version
```

Migrations: embedded, sequential, `meta.schema_version` gated. Pricing table: embedded JSON `pricing.json` ported from Caprock-python; overridable by a user file; `pricing_version` recorded so historical cost is never silently recomputed.

## 4. Task breakdown

Estimates assume evening work with Claude Code doing the typing. Order matters; each task ends green (`go vet`, tests, CI).

**T0 — ConPTY spike (1 evening).** Prove the chosen PTY wrapper (`aymanbagabas/go-pty` first candidate) spawns a process, streams output, and kills cleanly on macOS/Linux/Windows CI. *AC: spike branch with a passing matrix job; written go/no-go note in the PR. No production code depends on it yet.*

**T1 — Repo bootstrap (1 evening).** Go module, cmd/caprock, CI matrix (test + lint + build on 3 OS), Apache-2.0, embedded React app skeleton served at `/`. *AC: `go build` yields one binary per OS in CI artifacts; opening `localhost:4173` shows a placeholder page.*

**T2 — store + migrations (1 evening).** SQLite via `modernc.org/sqlite` (pure Go — keeps CGO off and cross-compile trivial), DDL v1, migration runner. *AC: unit tests for migrate-from-empty and idempotent re-run.*

**T3 — hookd + shim + installer (2–3 evenings).** HTTP receiver, bearer token, `caprock-hook` binary, settings.json merge/uninstall with backup. *AC: integration test posts fixture payloads for all 7 events → correct rows in `events`; installer test on a fixture settings.json proves non-destructive merge and clean revert; shim exits 0 in <1s even with daemon down.*

**T4 — ingest (2–3 evenings).** Discover `~/.claude/projects/**` transcripts, tail JSONL (fsnotify + poll fallback), parse per-turn usage, dedupe against hook events by session_id, tolerate unknown fields/lines. *AC: golden-file tests on fixture transcripts (normal, compacted, malformed line, unknown schema field); usage totals match fixture expectations; parser is schema-versioned.*

**T5 — rollup + pricing (1–2 evenings).** Event → session_stats/daily_stats updates; cost calc from pricing.json (ported from Caprock-python, cross-checked against its output on the same fixture). *AC: parity test vs Caprock-python within $0.001 on shared fixtures.*

**T6 — api + live WS (1–2 evenings).** Endpoints from §3.2, WS fan-out of new events/alerts. *AC: httptest coverage per endpoint; WS delivers an event end-to-end in an integration test.*

**T7 — UI: Now + Session Detail (3–4 evenings).** Session cards with narration (tool-event → human phrase map), health badges, live updates; detail view with timeline + diff tab (`git diff` via API). *AC: demo scenario steps 3 and 5 pass manually; narration map covered by unit tests.*

**T8 — UI: Cost (1–2 evenings).** Burn now, today totals, model mix, per-project. Limit *forecast* explicitly deferred to Phase 1 (needs observed-throttle data model). *AC: demo step 4 passes.*

**T9 — Loop detector (1–2 evenings).** Rule: ≥K tool.pre events with same tool + normalized-similar input within T minutes (defaults K=5, T=3, configurable). Emits `alert` frame + banner. *AC: fixture replay triggers exactly one alert; non-looping fixture triggers none.*

**T10 — Release hardening (1–2 evenings).** `caprock up/down/status/hooks install|uninstall`, three-OS smoke test in CI = the Definition-of-Done scenario scripted with a fake `claude` (fixture process emitting hook calls + transcript), README quickstart, v0.1.0 tag + goreleaser binaries.

Total: ~15–20 evenings ≈ 3–4 calendar weeks. Cut line if it drags: T9 ships in v0.1.1; T8 ships minimal (totals only).

## 5. Engineering rules (binding for this repo)

- English everywhere: code, comments, commits (Conventional Commits), PRs, docs.
- Agent docs live in `.ai/` per kit conventions; SPEC.md and PHASE0.md are the source of truth — Claude Code reads them before any task.
- Every task above = one PR; PR description references its task ID and pastes its AC as a checklist.
- No task is done with a red Windows job. No exceptions — this is the moat (SPEC §5.1).
- Unknown hook events and unknown transcript fields are logged and ignored, never fatal (SPEC §13).
- The shim must never break a user's Claude session: any error path = silent exit 0.

## 6. Phase 0 launch checklist (when T10 is green)

- README with a 20-second GIF of the Now screen catching a loop.
- Post drafts: r/ClaudeCode ("I built a mission control that catches Claude Code burning your budget in a loop"), HN Show, PH later with Phase 1.
- caprock.dev: harness becomes the front page; python measurer moves to /stats with a banner.

---

# Part III — Phase 1 & Phase 2 Development Plans

Phase gates still apply: Phase 0 ships publicly on its own (README, Reddit post) even if development continues straight into Phase 1 — it is a free launch artifact and an early feedback channel, not a stopping decision. "Properly working" for a solo dev = end of Phase 2.

## Phase 1 — Control

**Outcome:** Caprock is no longer read-only. You spawn Claude Code sessions from the UI, type into them, and Caprock protects your budget automatically.

### 1.1 Definition of Done

1. From the UI: "New session" → pick directory (and optionally a git worktree Caprock creates), pick model/permission-mode flags → a real `claude` process starts in a PTY and appears on **Now**.
2. Session Detail shows the live terminal (xterm.js over WS) and accepts typed input, including answering Claude's interactive prompts.
3. Kill/restart from the UI works; a killed session is marked `ended`, history preserved.
4. Loop detector gains **auto-pause** for **owned sessions only** (Caprock has the PID and the PTY): per-setting SIGSTOP (POSIX) / input-hold (Windows), one click to resume. Externally observed sessions stay alert-only — hooks don't give us process ownership, and we never signal a process we didn't start. Default: alert-only everywhere; auto-pause opt-in.
5. **History** screen works: per-project/day/model cost, tool distribution, session durations — the Caprock-python feature set, now live.
6. Externally started sessions remain fully supported (observe-only for them — we never write into a PTY we don't own).
7. Three-OS CI smoke: spawn fixture process via ptyman, stream, type, kill — green on macOS/Linux/Windows (this is where the T0 spike pays off).

### 1.2 Contract additions

```
POST   /v1/agents                    {cwd, worktree?, command?, args?} → AgentSummary
POST   /v1/agents/{id}/input         {data}            → 204   (owned PTYs only)
POST   /v1/agents/{id}/signal        {action: pause|resume|kill} → 204
WS     /v1/agents/{id}/term          bidirectional byte stream (xterm.js)
GET    /v1/history/…                 rollup queries for the History screen
```

```sql
ALTER TABLE sessions ADD COLUMN owned INTEGER NOT NULL DEFAULT 0;  -- spawned by Caprock
ALTER TABLE sessions ADD COLUMN worktree TEXT;
CREATE TABLE throttle_observations (ts INTEGER, session_id TEXT, kind TEXT, payload TEXT);
```

`throttle_observations` starts collecting data for the Phase-2+ limit forecast (SPEC §8.4) — capture now, model later.

### 1.3 Tasks (T11–T16)

- **T11 — ptyman (3–4 evenings).** Interface + ConPTY/POSIX backends per T0 decision; spawn/stream/write/resize/kill; reconnect-safe WS bridge. *AC: three-OS CI smoke of §1.1 item 7.*
- **T12 — spawn flow UI (2 evenings).** New-session dialog, worktree creation (`git worktree add`), flag presets. *AC: DoD 1.*
- **T13 — terminal in UI (2–3 evenings).** xterm.js tab wired to `/term`, input, resize, scrollback. *AC: DoD 2–3.*
- **T14 — auto-pause (1–2 evenings).** Settingized loop response; safe on POSIX (SIGSTOP/SIGCONT) and Windows (input-hold + warning, no SIGSTOP). *AC: DoD 4 incl. Windows path.*
- **T15 — History screen (2–3 evenings).** Queries + UI; parity check vs Caprock-python reports. *AC: DoD 5.*
- **T16 — hardening + v0.2.0 (1–2 evenings).** Smoke script extension, docs, release.

Estimate: ~11–16 evenings.

## Phase 2 — Orchestrate

**Outcome:** the trust-gap answer. You give Caprock a task; an orchestrator decomposes and routes it to worker sessions; nothing is "done" until verification commands pass; only critical items interrupt you.

### 2.1 Definition of Done

1. **Tasks board** works: create a task in UI (title, description, `done_criteria` commands, budget); it appears as `tasks/<id>.md` on disk and in the kanban.
2. Orchestrator (a normal `claude` session with Caprock's system prompt, spawned by ptyman) picks up inbox tasks, assigns to a worker (spawning one if needed, in its own worktree), and scribes status transitions.
3. **Mailbox round-trip:** worker finishes → writes result to `outbox/` → router delivers → orchestrator reads. Agents never run git on the hive repo; the router is the single committer.
4. **Stop-loop autonomy:** worker's Stop hook → hookd checks its inbox → non-empty ⇒ respond `{"decision":"block","reason":"process your inbox"}` forcing continuation; empty ⇒ allow stop. Hard guard: max N forced continuations per task (default 10), then escalate.
5. **Verification runner:** on worker's "done", Caprock executes `done_criteria` commands in the worker's worktree; all green ⇒ task → `done`; any red ⇒ task bounces to the worker with failing output attached (max R rounds, default 3, then escalate).
6. **Approvals queue:** tasks exceeding budget, matching a destructive-command policy, or exhausting guards land in `needs-you`; one-click approve/reject feeds back to the orchestrator.
7. End-to-end demo on a fixture repo: "add endpoint + tests" task → orchestrator → worker → failing verification once → bounce → green → done, with correct cost attribution per task. Scripted in CI with a fake agent; run manually with real `claude` before release.

### 2.2 Contracts

**Hive layout** (one dir per registered project workspace):

```
<hive>/
  agents/<agent-id>/{identity.md, memory.md, inbox/, outbox/}
  tasks/<task-id>.md
  approvals/<id>.json
  ledger.jsonl                # append-only task/state transitions
```

**Task file:**

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

**Mailbox message:** markdown file, YAML frontmatter `{from, to, ts, task_id?, kind: assign|result|question|escalation}`; body free-form. Router moves `outbox → inbox`, appends to `ledger.jsonl`, commits.

**Stop-hook decision protocol (shim upgrade, T19):** for Stop events only, the shim switches from fire-and-forget to request-response: it waits for the daemon's reply (timeout 5s) and relays the JSON body (`{"decision":"block","reason":…}` or empty) to stdout, which is how Claude Code consumes hook decisions. All other events remain silent fire-and-forget. Degradation is safe by construction: on timeout or daemon-down the shim prints nothing and exits 0, so the session simply stops normally. Forced-continue counter lives in SQLite per (session, task).

**API/DDL additions:** `GET/POST /v1/tasks`, `POST /v1/tasks/{id}/approve|reject`, `GET /v1/approvals`; tables `tasks` (mirror of file state for querying), `verifications` (task_id, round, command, exit_code, output_path).

Files are the source of truth for hive state; SQLite mirrors them for the UI (rebuildable by rescan).

### 2.3 Tasks (T17–T25)

- **T17 — hive layer (2–3 evenings).** Dir layout, atomic file ops, single-committer git, ledger. *AC: unit tests for atomicity and rescan-rebuild.*
- **T18 — router (2 evenings).** outbox→inbox delivery, ledger append, WS `mail.*` events. *AC: DoD 3 with fixture agents.*
- **T19 — Stop-loop (2 evenings).** Decision protocol + forced-continue guard. *AC: DoD 4 incl. guard escalation, replayed in tests.*
- **T20 — task model + board UI (2–3 evenings).** Task files ⇄ SQLite mirror, kanban with drag between allowed states. *AC: DoD 1.*
- **T21 — orchestrator prompt + lifecycle (3–4 evenings).** System prompt (English, in `.ai/orchestrator.md`), spawn/respawn policy, scribing. *AC: DoD 2 on fixture repo with real `claude`.*
- **T22 — verification runner (2 evenings).** Command exec in worktree, timeouts, output capture, bounce flow. *AC: DoD 5.*
- **T23 — approvals (1–2 evenings).** Policy config (budget, destructive-command regex list), queue UI, feedback into mailbox. *AC: DoD 6.*
- **T24 — cost attribution per task (1–2 evenings).** Join events→task via assignment windows; task cards show spend vs budget. *AC: DoD 7 cost check.*
- **T25 — e2e + v0.3.0 (2 evenings).** Scripted fake-agent e2e in CI, manual real-run checklist, docs, release. *AC: DoD 7.*

Estimate: ~17–22 evenings. Cut line: T24 can slip to v0.3.1; approvals policy can start budget-only.

## Cumulative picture

| Milestone | Version | Evenings (cum.) | You can honestly say |
|---|---|---|---|
| Phase 0 | v0.1.0 | ~15–20 | "See what every Claude Code session really does and costs; catches loops" |
| Phase 1 | v0.2.0 | ~26–36 | "Run and control your sessions from mission control" |
| Phase 2 | v0.3.0 | ~43–58 | "A verified multi-agent team on your subscription" — the Munder Difflin use case, with the trust gap closed |

Phase 3 (avatars/packaging/TUI) remains a one-paragraph roadmap item in §12 by design — it gets its own plan only if Phase 2 traction justifies it.


---

# Part IV — Repository Integration & Kickoff

## 1. Target repository convention

The repo is pre-created from Dima's standard template (github.com/dspv/kit conventions): the **root holds only README.md, LICENSE, CLAUDE.md** (plus one optional extra file when the template has it); **all product and engineering documentation lives in `.ai/`**. This SPEC.md is a hand-off document, not a permanent resident of the root: its content must be migrated into `.ai/` and then SPEC.md is deleted.

## 2. Task M0 — Spec migration (runs before T0)

Decompose this document into the `.ai/` structure. Proposed mapping (adjust file names to the template's existing conventions, never the other way around):

```
.ai/product.md            ← Part I §1–4   (one-liner, prior art, problems, users, traceability, principles)
.ai/architecture.md       ← Part I §5–7   (architecture, platform rules, data sources, event model)
.ai/ui.md                 ← Part I §8     (five screens + §8.6 visual direction)
.ai/orchestration.md      ← Part I §9     (+ Part III §2.2 contracts: hive layout, task/mailbox formats, Stop protocol)
.ai/decisions.md          ← Part I §10–14 (non-goals, Caprock history, roadmap, risks, resolved decisions)
.ai/phase-0.md            ← Part II       (DoD, contracts §3.1–3.3, tasks T1–T10; T0 spike note)
.ai/phase-1.md            ← Part III Phase 1
.ai/phase-2.md            ← Part III Phase 2 (minus contracts moved to orchestration.md — leave a link)
.ai/engineering-rules.md  ← Part II §5    (binding rules; referenced from CLAUDE.md)
```

Rules:
- **Zero information loss.** Every sentence, table row, code block, DDL statement, AC item, default value, and number from SPEC.md must land in exactly one `.ai/` file. Rewording for flow is allowed; dropping or summarizing content is not.
- Cross-references replace duplication: where two parts covered the same contract, keep one canonical copy and link the other.
- CLAUDE.md gets a short index: what lives where in `.ai/`, and the instruction to read the relevant file(s) before any task.

## 3. M0 verification protocol (mandatory)

After migration, before deleting SPEC.md, run a loss audit with subagents:

1. Spawn **3 reviewer subagents in parallel**, splitting SPEC.md between them (Part I / Part II / Part III+IV).
2. Each reviewer walks its part **section by section** and, for every section, locates the content in `.ai/` and verifies nothing is missing or silently altered: every table row, every code/DDL block byte-comparable or explicitly noted as moved, every numeric default (ports, timeouts, K/T/N/R values, prices, estimates) present.
3. Each reviewer outputs a checklist: `section → target file → OK | MISSING: <what> | CHANGED: <what>`.
4. Any MISSING/CHANGED item is fixed and the affected part re-audited. Only a fully green audit allows `git rm SPEC.md`.
5. The three checklists are committed as `.ai/migration-audit.md` for the record, then the file may be pruned after Phase 0 ships.

## 4. Kickoff prompt (paste as the first message to Claude Code)

```
Read SPEC.md in full. Execute task M0 from Part IV: migrate the entire
document into the existing .ai/ structure per the mapping in Part IV §2,
with zero information loss. Then run the verification protocol from
Part IV §3 with 3 parallel reviewer subagents; fix every finding and
re-audit until fully green. Commit .ai/migration-audit.md, delete
SPEC.md, and stop for my review.

After I approve M0, proceed to task T0 (Part II §4 / .ai/phase-0.md):
the ConPTY spike — a spike branch with a GitHub Actions matrix
(ubuntu/macos/windows) proving the candidate PTY wrapper can spawn a
process, stream output, and kill cleanly on all three OS, plus a
go/no-go note in the PR description.

Binding for everything: .ai/engineering-rules.md — English only,
Conventional Commits, no task is done with a red Windows CI job.
```
