# Caprock — Execution plan

The roadmap, the phase gates, and the task-by-task plans for Phases 0–2 with their definitions of done and acceptance criteria. Progress against this plan is tracked in [14-build-status.md](14-build-status.md) — this file says what "done" means, that file says what is done. Contracts referenced by tasks live in [03-contracts.md](03-contracts.md); orchestration formats in [05-orchestration.md](05-orchestration.md).

> **Status (2026-08-19): this plan is complete.** All of T0–T25 shipped; Phases 0–2 are released as v0.1.0 / v0.2.0 / v0.3.0. Phase 3 (Delight) has no plan by design. The task bodies below are kept as the record of what "done" meant for each; live per-track state is in [14-build-status.md](14-build-status.md).

## Roadmap

- **Phase 0 — Observe (2–3 weeks of evenings).** Go daemon: hookd + shim installer + transcript ingest + SQLite + web UI with **Now**, **Session Detail** (terminal read-only + diff — in Phase 0 that is the event timeline + live diff, because PTY bytes exist only for sessions Caprock spawns; the terminal tab arrives with `ptyman` in Phase 1), **Cost**. Works on sessions the user starts manually. *Ship this publicly — it's already a standalone product ("see what your Claude Code is really doing/costing").*
- **Phase 1 — Control.** ptyman: spawn/kill/type-back from UI; loop detector with auto-pause; History screen.
- **Phase 2 — Orchestrate.** Mailboxes + router + Stop-loop + orchestrator agent + Tasks board + verification runner + approvals.
- **Phase 3 — Delight.** Avatar/office render mode, packaging (Tauri/Wails or plain binary + `open localhost`), maybe TUI. Remains a one-paragraph roadmap item by design — it gets its own plan only if Phase 2 traction justifies it.

Each phase is independently useful and independently launchable (Reddit/PH posts per phase). **Phase gates:** Phase 0 ships publicly on its own (README, Reddit post) even if development continues straight into Phase 1 — it is a free launch artifact and an early feedback channel, not a stopping decision. "Properly working" for a solo dev = end of Phase 2.

### Cumulative picture

| Milestone | Version | Evenings (cum.) | You can honestly say                                                                                        |
| --------- | ------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| Phase 0   | v0.1.0  | ~15–20          | "See what every Claude Code session really does and costs; catches loops"                                   |
| Phase 1   | v0.2.0  | ~26–36          | "Run and control your sessions from mission control"                                                        |
| Phase 2   | v0.3.0  | ~43–58          | "A verified multi-agent team on your subscription" — the Munder Difflin use case, with the trust gap closed |

Estimates assume evening work with Claude Code doing the typing. They are the spec's estimates, unmeasured; actuals go in the build-status log.

### Bootstrap task M0 — spec migration (done 2026-08-18)

Decompose the hand-off spec into `.ai/` with zero information loss, run the loss audit with parallel reviewer subagents (each walks its part section by section: every table row, code/DDL block, numeric default present or explicitly noted as moved), fix every MISSING/CHANGED finding, re-audit until green, commit the checklists, delete the spec. Record: [docs/migration-audit.md](../docs/migration-audit.md); layout decision: [ADR-016](08-decisions.md#adr-016--corpus-layout-numbered-ai-files-minimal-root-spec-deleted-after-audit).

---

## Phase 0 — Observe

**Scope:** observe-only mission control. No agent spawning, no orchestration.
**Outcome:** a user runs `caprock up`, opens `localhost:4173`, starts `claude` in any terminal as usual — and sees live activity, cost, and loop alerts.
**Interaction model:** the web UI is an observation window; the user keeps talking to Claude in the terminal; the shim is registered at user level so every session on the machine is captured ([02-architecture.md](02-architecture.md#components)).
**Architecture slice and components:** [02-architecture.md § Components](02-architecture.md#components) (`hookd`, `shim`, `ingest`, `store`, `rollup`, `api`, `ui`; no `ptyman`).

### Definition of Done (release gate)

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

### Tasks

Order matters; each task ends green (`go vet`, tests, CI). Total: ~15–20 evenings ≈ 3–4 calendar weeks (the spec's rounded figure; the per-task ranges below sum to 15–23). **Cut line if it drags:** T9 ships in v0.1.1; T8 ships minimal (totals only).

#### T0 — ConPTY spike (1 evening)

Prove the chosen PTY wrapper (`aymanbagabas/go-pty` first candidate) spawns a process, streams output, and kills cleanly on macOS/Linux/Windows CI. *AC: spike branch with a passing matrix job; written go/no-go note in the PR. No production code depends on it yet.*

#### T1 — Repo bootstrap (1 evening)

Go module, `cmd/caprock`, CI matrix (test + lint + build on 3 OS), Apache-2.0, embedded React app skeleton served at `/`. *AC: `go build` yields one binary per OS in CI artifacts; opening `localhost:4173` shows a placeholder page.*

#### T2 — store + migrations (1 evening)

SQLite via `modernc.org/sqlite` (pure Go — keeps CGO off and cross-compile trivial), DDL v1, migration runner. *AC: unit tests for migrate-from-empty and idempotent re-run.*

#### T3 — hookd + shim + installer (2–3 evenings)

HTTP receiver, bearer token, `caprock-hook` binary, settings.json merge/uninstall with backup. *AC: integration test posts fixture payloads for all 8 events → correct rows in `events`; installer test on a fixture settings.json proves non-destructive merge and clean revert; shim exits 0 in <1s even with daemon down.*

#### T4 — ingest (2–3 evenings)

Discover `~/.claude/projects/**` transcripts, tail JSONL (fsnotify + poll fallback), parse per-turn usage, dedupe against hook events by session_id, tolerate unknown fields/lines. *AC: golden-file tests on fixture transcripts (normal, compacted, malformed line, unknown schema field); usage totals match fixture expectations; parser is schema-versioned.*

#### T5 — rollup + pricing (1–2 evenings)

Event → session_stats/daily_stats updates; cost calc from pricing.json (ported from Caprock-python, cross-checked against its output on the same fixture). *AC: cost is computed from the versioned `pricing.json` (Anthropic list prices); a golden-file test checks per-turn cost to within $0.001 on `testdata/transcripts` fixtures, and the cache-savings formula (ported from Caprock-python `_savings.py`) is unit-tested on its own numbers.* — Parity with Caprock-python was never a project goal, only spec AC phrasing; resolved in [OQ-01](12-risks.md#open-questions) / [ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson).

#### T6 — api + live WS (1–2 evenings)

Endpoints from [03-contracts.md § HTTP API](03-contracts.md#http-api-daemon-1270014173), WS fan-out of new events/alerts. *AC: httptest coverage per endpoint; WS delivers an event end-to-end in an integration test.*

#### T7 — UI: Now + Session Detail (3–4 evenings)

Session cards with narration (tool-event → human phrase map), health badges, live updates; detail view with timeline + diff tab (`git diff` via API). *AC: demo scenario steps 3 and 5 pass manually; narration map covered by unit tests.*

#### T8 — UI: Cost (1–2 evenings)

Burn now, today totals, model mix, per-project. Limit *forecast* explicitly deferred to Phase 1 (needs observed-throttle data model). *AC: demo step 4 passes.*

#### T9 — Loop detector (1–2 evenings)

Rule: ≥K tool.pre events with same tool + normalized-similar input within T minutes (defaults K=5, T=3, configurable). Emits `alert` frame + banner. *AC: fixture replay triggers exactly one alert; non-looping fixture triggers none.*

#### T10 — Release hardening (1–2 evenings)

`caprock up/down/status/hooks install|uninstall`, three-OS smoke test in CI = the Definition-of-Done scenario scripted with a fake `claude` (fixture process emitting hook calls + transcript), README quickstart, v0.1.0 tag + goreleaser binaries.

### Phase 0 launch checklist (when T10 is green)

- README with a 20-second GIF of the Now screen catching a loop.
- Post drafts: r/ClaudeCode ("I built a mission control that catches Claude Code burning your budget in a loop"), HN Show, PH later with Phase 1.
- caprock.dev: harness becomes the front page; python measurer moves to /stats with a banner.

---

## Phase 1 — Control

**Outcome:** Caprock is no longer read-only. You spawn Claude Code sessions from the UI, type into them, and Caprock protects your budget automatically.

### Definition of Done

Quoted from the spec verbatim; the mechanisms and defaults are owned by [05-orchestration.md](05-orchestration.md) and [02-architecture.md](02-architecture.md).

1. From the UI: "New session" → pick directory (and optionally a git worktree Caprock creates), pick model/permission-mode flags → a real `claude` process starts in a PTY and appears on **Now**.
2. Session Detail shows the live terminal (xterm.js over WS) and accepts typed input, including answering Claude's interactive prompts.
3. Kill/restart from the UI works; a killed session is marked `ended`, history preserved.
4. Loop detector gains **auto-pause** for **owned sessions only** (Caprock has the PID and the PTY): per-setting SIGSTOP (POSIX) / input-hold (Windows), one click to resume. Externally observed sessions stay alert-only — hooks don't give us process ownership, and we never signal a process we didn't start. Default: alert-only everywhere; auto-pause opt-in.
5. **History** screen works: per-project/day/model cost, tool distribution, session durations — the Caprock-python feature set, now live.
6. Externally started sessions remain fully supported (observe-only for them — we never write into a PTY we don't own).
7. Three-OS CI smoke: spawn fixture process via ptyman, stream, type, kill — green on macOS/Linux/Windows (this is where the T0 spike pays off).

### Contract additions

API endpoints and DDL: [03-contracts.md § Phase 1 additions](03-contracts.md#phase-1-additions) and [§ Phase 1 DDL additions](03-contracts.md#phase-1-ddl-additions) (`owned`, `worktree`, `throttle_observations`).

### Tasks (T11–T16) — estimate ~11–16 evenings

- **T11 — ptyman (3–4 evenings).** Interface + ConPTY/POSIX backends per T0 decision; spawn/stream/write/resize/kill; reconnect-safe WS bridge. *AC: three-OS CI smoke of DoD item 7.*
- **T12 — spawn flow UI (2 evenings).** New-session dialog, worktree creation (`git worktree add`), flag presets. *AC: DoD 1.*
- **T13 — terminal in UI (2–3 evenings).** xterm.js tab wired to `/term`, input, resize, scrollback. *AC: DoD 2–3.*
- **T14 — auto-pause (1–2 evenings).** Settingized loop response; safe on POSIX (SIGSTOP/SIGCONT) and Windows (input-hold + warning, no SIGSTOP). *AC: DoD 4 incl. Windows path.*
- **T15 — History screen (2–3 evenings).** Queries + UI; parity check vs Caprock-python reports. *AC: DoD 5.*
- **T16 — hardening + v0.2.0 (1–2 evenings).** Smoke script extension, docs, release.

---

## Phase 2 — Orchestrate

**Outcome:** the trust-gap answer. You give Caprock a task; an orchestrator decomposes and routes it to worker sessions; nothing is "done" until verification commands pass; only critical items interrupt you.

### Definition of Done

Quoted from the spec verbatim; hive formats, guards (N=10, R=3) and policies are owned by [05-orchestration.md](05-orchestration.md).

1. **Tasks board** works: create a task in UI (title, description, `done_criteria` commands, budget); it appears as `tasks/<id>.md` on disk and in the kanban.
2. Orchestrator (a normal `claude` session with Caprock's system prompt, spawned by ptyman) picks up inbox tasks, assigns to a worker (spawning one if needed, in its own worktree), and scribes status transitions.
3. **Mailbox round-trip:** worker finishes → writes result to `outbox/` → router delivers → orchestrator reads. Agents never run git on the hive repo; the router is the single committer.
4. **Stop-loop autonomy:** worker's Stop hook → hookd checks its inbox → non-empty ⇒ respond `{"decision":"block","reason":"process your inbox"}` forcing continuation; empty ⇒ allow stop. Hard guard: max N forced continuations per task (default 10), then escalate.
5. **Verification runner:** on worker's "done", Caprock executes `done_criteria` commands in the worker's worktree; all green ⇒ task → `done`; any red ⇒ task bounces to the worker with failing output attached (max R rounds, default 3, then escalate).
6. **Approvals queue:** tasks exceeding budget, matching a destructive-command policy, or exhausting guards land in `needs-you`; one-click approve/reject feeds back to the orchestrator.
7. End-to-end demo on a fixture repo: "add endpoint + tests" task → orchestrator → worker → failing verification once → bounce → green → done, with correct cost attribution per task. Scripted in CI with a fake agent; run manually with real `claude` before release.

### Contracts

Hive layout, task file, mailbox message, Stop-hook decision protocol: [05-orchestration.md](05-orchestration.md). API/DDL additions: [03-contracts.md § Phase 2 additions](03-contracts.md#phase-2-additions) and [§ Phase 2 DDL additions](03-contracts.md#phase-2-ddl-additions).

### Tasks (T17–T25) — estimate ~17–22 evenings

- **T17 — hive layer (2–3 evenings).** Dir layout, atomic file ops, single-committer git, ledger. *AC: unit tests for atomicity and rescan-rebuild.*
- **T18 — router (2 evenings).** outbox→inbox delivery, ledger append, WS `mail.*` events. *AC: DoD 3 with fixture agents.*
- **T19 — Stop-loop (2 evenings).** Decision protocol + forced-continue guard. *AC: DoD 4 incl. guard escalation, replayed in tests.*
- **T20 — task model + board UI (2–3 evenings).** Task files ⇄ SQLite mirror, kanban with drag between allowed states. *AC: DoD 1.*
- **T21 — orchestrator prompt + lifecycle (3–4 evenings).** System prompt (English, in `.ai/orchestrator.md` — now `.ai/07-orchestrator.md`, see [05-orchestration.md § Orchestrator prompt](05-orchestration.md#orchestrator-prompt)), spawn/respawn policy, scribing. *AC: DoD 2 on fixture repo with real `claude`.*
- **T22 — verification runner (2 evenings).** Command exec in worktree, timeouts, output capture, bounce flow. *AC: DoD 5.*
- **T23 — approvals (1–2 evenings).** Policy config (budget, destructive-command regex list), queue UI, feedback into mailbox. *AC: DoD 6.*
- **T24 — cost attribution per task (1–2 evenings).** Join events→task via assignment windows; task cards show spend vs budget. *AC: DoD 7 cost check.*
- **T25 — e2e + v0.3.0 (2 evenings).** Scripted fake-agent e2e in CI, manual real-run checklist, docs, release. *AC: DoD 7.*

**Cut line:** T24 can slip to v0.3.1; approvals policy can start budget-only.

---

## Phase 3 — Delight

Avatar/office render mode (only with cleanly licensed assets), packaging (Tauri/Wails or plain binary + `open localhost`), maybe TUI. No plan until Phase 2 traction justifies one.

---

## Backlog — post-v0.6.0

Candidate work, ordered by the value it adds for a solo user. Nothing here is
committed to a release yet; each item still needs its own DoD before it starts.

- **B1 — Projects on Now (in progress).** Per-repo spend is the first thing a
  user recognises as their own money, and today it is buried in History. Surface
  a compact per-project cost roll-up on the landing screen. Data already exists
  (`ProjectShare` in `/v1/stats/summary`); the gap is placement plus "who is in
  this repo right now".
- **B0 — Claude's own words are captured but hidden (data layer fixed 2026-08-20; UI still to build).** Reported by an early user, and confirmed against the data: `turn.assistant` events already carry the assistant's prose in `payload.text`, the store keeps it, and `/v1/sessions/{id}/events` returns it — but the Session timeline renders only the event label (`turn.assistant → Bash`), so the reasoning, the summaries, and the "what changed / what I still need from you" paragraphs are invisible. This is a presentation defect, not a missing feature.

  Why it matters more than it looks: for a large share of sessions the *code* is not the deliverable — the conclusion is ("this is done, but I could not verify X; ask the team and then we finish it"). Today that paragraph survives only in the terminal scrollback, so people copy it into a notepad or lose it and re-derive it in a fresh session. Caprock already stores it and is the natural place to find it again.

  Scope to settle before building: render assistant prose in the timeline (with a toggle, since some turns are long); make it searchable across sessions, because "which session was it where Claude explained the SSO thing?" is the actual question; and decide what a session-level summary view looks like. Content is per-session and never leaves the machine.

  **Audited 2026-08-20 against 12k events across 20 sessions and 16 projects.** Verdict: the data supports the feature, but four things must be handled, in order.

  - **The text is truncated far more aggressively than intended, and corrupts on the way** — `internal/ingest/parser.go` caps at 2000 **bytes** (`len(joined) > 2000`, `joined[:2000]`), not runes. Cyrillic is 2 bytes per character, so Russian prose is clipped at roughly 1000–1350 characters; one measured summary went from 1856 characters to 1349. Slicing mid-rune leaves a `U+FFFD` at the end of **22% of clipped rows** (confirmed independently: 15 of 53 in one session). Worst of all, the cap lands disproportionately on the **closing summary** — 8 of 12 sampled sessions had their final summary clipped, which is exactly the content this feature exists to show. Fix the cap on runes and raise it; note that payload shape is a contract, so this lands with `.ai/03-contracts.md` (rule 8), and historical rows stay clipped unless re-derived from the on-disk transcripts (`SchemaVersion` in the parser exists for that).
  - **`GET /v1/sessions/{id}/events` silently returns 500 rows** when `limit > 5000` (`internal/store/queries.go`). A consumer that does not paginate reads the *start* of a session and mistakes an early fragment for the ending. A dedicated "last assistant text" query is probably better than paginating 12k events client-side.
  - **45% of `turn.assistant` events are subagent sidechains**, so "the last thing Claude said" returns a subagent's words about half the time. `payload.sidechain` and `agent_id` agree perfectly across 12,111 events, so filtering is reliable — but it is mandatory.
  - **Roughly a quarter to a third of sessions end on a fragment**, not a summary (interrupted or still running). The feature must detect that rather than present "Let me check that" as the conclusion.

  **All four were fixed on 2026-08-20** (the UI is what remains). The parser now clips on runes at 16000 (`ingest.MaxAssistantText`), `SchemaVersion` is 2, and a daemon started against a v1 database re-derives the damaged rows once from the transcripts on disk — on the author's database that took 452 corrupted rows to 28, the remainder being sessions whose transcript is gone. `ListEvents` clamps to `MaxEventPage` instead of silently falling back to 500. `SessionNotes`/`SearchNotes` (and `GET /v1/sessions/{id}/notes`, `GET /v1/notes?q=`) exclude sidechains in SQL and flag short mid-thought notes as `fragment`, so no caller can get those two wrong by omission.

  Building the repair surfaced two things the audit could not have known: a session's recorded `transcript_path` is frequently **not** where its messages live — Claude Code records whichever file the last line arrived on, so main-thread turns end up under a subagent path and vice versa, and the sweep has to search the project directory in both directions. And `ParseLine` returns a `Line` whose `Message` pointer is nil for system lines; dereferencing it panicked the daemon on startup, which would have hit every user with a v1 database on upgrade.

  Two findings that make this cheaper than expected: the text comes **only from transcript tailing**, never from hooks, so it works identically for users who declined hooks (53 of 56 local sessions have no hooks and full prose); and **extended thinking is never stored at all** — only `type: "text"` blocks are read — so displaying captured prose cannot leak Claude's reasoning.

- **B2 — Update notifications.** Tell the user in the UI when a newer version is
  published, with the exact upgrade command for their install method (`brew
  upgrade`, `scoop update`, `go install`). **Open decision:** any version check
  is an outbound call, which Rule 4 (all data stays on the machine) forbids by
  default. Options: opt-in check with a visible toggle, or a purely local hint
  derived from the installed package manager. Resolve the principle before
  building — see [12-risks.md](12-risks.md).
- **B3 — Claude desktop app usage.** Requested by an early user who also uses
  the Claude desktop app for non-repo work. Feasibility check done: only
  `~/Library/Application Support/Claude/plan-usage-history.json` is readable —
  numeric plan-usage samples (roughly 5-minute granularity), **no tokens, no
  cost, no conversation content** (content lives in LevelDB and is out of
  scope). Any surface must be labelled as plan-usage level, never presented as
  tokens or dollars, or it breaks Rule 6.
