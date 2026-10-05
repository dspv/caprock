# Caprock — The desktop app: execution plan

How the app in [21-app.md](21-app.md) gets built: milestones with dates, work
packages with their scope, files, dependencies and acceptance checks, and the
definitions of done for a work package, the MVP release and phone v2. The
stack is [ADR-038](08-decisions.md#adr-038--the-desktop-app-is-a-thin-tauri-v2-shell-around-the-existing-react-ui-and-xtermjs-on-the-go-daemon).
Progress is logged in [14-build-status.md](14-build-status.md); this file says
what "done" means.

**Status (2026-10-05): planned, nothing built.** Durations are estimates,
unmeasured (rule 6); actuals go in the build-status log.

## Milestones

| #  | Milestone                                    | Date       |
| -- | -------------------------------------------- | ---------- |
| M0 | Spike numbers in; scaffold green on 3 OS     | 2026-10-09 |
| M1 | A terminal in the app (protocol v2, tabs)    | 2026-10-23 |
| M2 | Projects, shells, worktrees; live replay     | 2026-11-06 |
| M3 | Native surfaces; phone start work; complete  | 2026-11-20 |
| M4 | MVP release: app on 3 OS + phone v2 Phase A  | 2026-12-01 |
| M5 | Phone Phase B route decided by the owner     | 2026-12-04 |
| M6 | P1 complete (GitHub, panes, update, Phase B) | 2027-01-29 |
| M7 | Go / no-go on the mobile app (F22)           | 2027-03-31 |

- **M0 — week of 2026-10-06.** The Tauri spike's `app/SPIKE.md` is read and its
  numbers are copied into [21-app.md § Performance budgets](21-app.md#performance-budgets)
  (the `SPIKE` slots). If a budget is out of reach on an OS, the budget or the
  plan changes now, in writing, not at M4. WP-01 is green on CI. The owner
  decisions are recorded in [21-app.md](21-app.md#decisions-owner-2026-10-05).
- **M1 — weeks of 2026-10-12 and 2026-10-19.** WP-02, WP-03, WP-04: the app
  finds or starts the daemon and opens agent sessions in tabs that resume
  from their byte offset and never double a keystroke.
- **M2 — weeks of 2026-10-26 and 2026-11-02.** WP-05 to WP-08 and WP-12.
- **M3 — weeks of 2026-11-09 and 2026-11-16.** WP-09 to WP-11, WP-13 to WP-15,
  and WP-16's harness runs against every budget and against the reference app.
- **M4 — week of 2026-11-23, release on 2026-12-01.** WP-17 and WP-18, the MVP
  definition of done, three days of the owner using it as his only terminal.
- **M5–M7.** P1 work packages WP-19 to WP-23; M7 decides F22 on measurements
  of Tauri's mobile targets.

## Lanes

Work runs in four lanes so that packages proceed in parallel; a package names
its lane.

- **Engine (Go):** WP-02 (daemon side), WP-03, WP-05, WP-07, WP-08 (API),
  WP-09 (frame), WP-12, WP-15 (API).
- **Interface (React, `ui/`):** WP-04, WP-06, WP-08 (UI), WP-11, WP-13,
  WP-14, WP-15 (UI).
- **Shell and release (Rust, CI):** WP-01, WP-02 (supervisor), WP-09
  (notifications), WP-10, WP-17.
- **Measurement and docs:** WP-16, WP-18.

## Work packages — P0

### WP-01 — App scaffold and CI

- **Scope.** `app/` with the Tauri v2 project (`app/src-tauri/`), the fallback
  page, capabilities limited to the daemon's origin, a strict CSP, and a CI
  job that builds and tests the app on macOS, Windows and Linux.
- **Files.** `app/src-tauri/{Cargo.toml,tauri.conf.json,capabilities/,src/}`,
  `app/fallback/index.html`, `.github/workflows/` (app job), `Makefile`
  (`app`, `app-test`, `app-bundle`, `app-sidecar`), [10-infrastructure.md](10-infrastructure.md).
- **Depends on.** Open decision 5 (minimum OS versions) for the CI images.
- **Parallel with.** Everything; it is the first package of its lane.
- **Acceptance.** `make app` produces an app on each OS from a clean checkout;
  `cargo clippy -D warnings`, `cargo fmt --check` and `cargo test` pass on
  three OS; a page script calling a command not on the allowlist is refused
  (test); the window opens the fallback page when no daemon runs.

### WP-02 — Daemon discovery, supervisor, api_level

- **Scope.** `api_level` in `GET /v1/status` and `runtime.json`; the shell's
  supervisor (read `runtime.json`, use a running daemon, else start the bundled
  binary detached, never stop one it did not start); the degraded banner and
  automatic reconnect in the UI; the first-run screen (service on by default
  if decision 7 says so).
- **Files.** `internal/api` (status), `internal/daemon` (runtime file),
  `app/src-tauri/src/daemon.rs`, `ui/src/lib/app.ts` (shell detection),
  `ui/src/components/DaemonBanner.tsx`, [03-contracts.md § Runtime file](03-contracts.md#runtime-file).
- **Depends on.** WP-01.
- **Parallel with.** WP-03, WP-05.
- **Acceptance.** With a daemon running, the app uses it (no second process);
  with none, it starts one and quitting the app leaves it and its sessions
  running; a daemon below the app's `api_level` shows the upgrade command;
  killing the daemon shows the banner within 2 s and the app recovers by
  itself when it returns, on three OS.

### WP-03 — Terminal protocol v2 (engine)

- **Scope.** Byte offsets in `internal/termbuf`; `W` and `S` gain offsets;
  the `J` frame (client id, sequence, bytes) with per-client dedupe in the
  pty-host; `caprock.term.v2` on the terminal socket with `since`, offset
  headers, `hello`, `ack`, `ping`/`pong`, `reset`; the 1 MiB per-client queue
  with reset; v1 unchanged.
- **Files.** `internal/termbuf`, `internal/ptyhost`, `internal/ptyman`,
  `internal/api` (term socket), [03-contracts.md](03-contracts.md)
  (terminal socket and § Terminal holders).
- **Depends on.** Nothing.
- **Parallel with.** WP-01, WP-02, WP-05, WP-12.
- **Acceptance.** Tests on three OS: a resume inside the ring sends exactly the
  missing bytes; a resume past it sends `reset` and the snapshot; 10,000
  sequenced inputs across 50 forced disconnects arrive exactly once,
  including across a daemon restart; a client that stops reading is reset and
  never slows another client or the PTY read; a holder of the previous
  `proto` keeps working with the new daemon (ADR-033's rule).

### WP-04 — App layout and terminal tabs (interface)

- **Scope.** The app layout (sidebar slot, tabs, status strip) when the shell
  is detected; the v2 terminal client (offsets, resend unacknowledged input,
  watermarks, liveness, hidden-tab close after 30 s, mode reset); the keyboard
  map; WebGL context-loss and wake handling.
- **Files.** `ui/src/components/Terminal.tsx` (v2 client behind the existing
  component), `ui/src/components/TerminalTabs.tsx`, `ui/src/lib/termv2.ts`,
  `ui/src/screens/AppShell.tsx`, `app/src-tauri/src/menu.rs` (shortcuts),
  [04-ui.md](04-ui.md).
- **Depends on.** WP-03 (a stub server is enough to start), WP-01.
- **Parallel with.** WP-05, WP-06.
- **Acceptance.** The echo, open-session and switch-tab budgets met on the
  bench on three OS; ten sleep–wake cycles repaint every tab without a
  reload; app shortcuts never reach the terminal and the terminal's never
  trigger the app's; the browser dashboard is unchanged (v1 or v2, same look).

### WP-05 — Projects model and API

- **Scope.** Migration `0041_projects`; `/v1/projects` endpoints; the fsnotify
  git watcher with debounce, timeouts and a two-process limit; `project` and
  `op` frames on `/v1/live`; clone with progress and `op_id` idempotency.
- **Files.** `internal/store/migrations/0041_projects.sql`, `internal/store`,
  `internal/projects` (new), `internal/api`, [03-contracts.md](03-contracts.md)
  (DDL and endpoints).
- **Depends on.** Nothing.
- **Parallel with.** WP-03, WP-04.
- **Acceptance.** A commit or checkout made in a terminal outside Caprock
  reaches a `project` frame within 1 s; 50 projects idle cause zero git
  processes over 10 minutes; a git that hangs is killed at 5 s and reported;
  a second `POST` with the same `op_id` returns the first operation; no cost
  total changes on a copy of the owner's database.

### WP-06 — Projects sidebar (interface)

- **Scope.** Sidebar of projects, worktrees, sessions and shells with waiting,
  looping and today's cost; add, create, clone and archive; keyboard
  navigation; the scrolling rule.
- **Files.** `ui/src/components/Sidebar.tsx`, `ui/src/components/ProjectRow.tsx`,
  reuse of `Projects.tsx` and `ProjectTerminal.tsx` logic, [04-ui.md](04-ui.md).
- **Depends on.** WP-05, WP-04.
- **Parallel with.** WP-07, WP-08.
- **Acceptance.** 50 projects and 30 live sessions render with no long task
  over 50 ms; a waiting session's badge appears within 1 s of its prompt;
  verified at 1280×800 and 1920×1080 and the minimum window, nothing clipped.

### WP-07 — Shell tabs

- **Scope.** `POST /v1/shells`; shell kind with `internal = 1`; the login
  shell per OS; held by a pty-host; a **New shell** action in the sidebar and
  the keyboard map.
- **Files.** `internal/agents` or `internal/shells` (new), `internal/api`,
  `ui/src/components/TerminalTabs.tsx`, [03-contracts.md](03-contracts.md).
- **Depends on.** WP-03.
- **Parallel with.** WP-06, WP-08.
- **Acceptance.** A shell survives a daemon restart and an app restart on three
  OS; it appears in no total, Now card or export; the shell gets the user's
  login environment (the `internal/userenv` path).

### WP-08 — Worktrees

- **Scope.** Create a worktree on any branch (existing, new from a base),
  open a session or shell in it, remove a clean one Caprock created; refuse
  others with the reason.
- **Files.** `internal/projects`, `internal/api`, `ui/src/components/NewWorktree.tsx`.
- **Depends on.** WP-05.
- **Parallel with.** WP-06, WP-07.
- **Acceptance.** A worktree for a remote-only branch is created and tracked;
  a dirty worktree is never removed; a branch checked out elsewhere is refused
  with git's own message shown.

### WP-09 — The notify frame and OS notifications

- **Scope.** `notify` frames from `internal/alerts` beside Telegram; OS
  notifications per OS with Approve and Deny where supported, answered with
  the `prompt_id`; quiet for the focused session.
- **Files.** `internal/alerts`, `internal/daemon`, `internal/api` (live),
  `app/src-tauri/src/notify.rs`, `ui/src/lib/notify.ts`,
  [03-contracts.md](03-contracts.md).
- **Depends on.** WP-02; WP-12 for replay.
- **Parallel with.** WP-10, WP-11.
- **Acceptance.** A real Claude Code prompt in an owned session notifies within
  1 s; Approve from the notification types `1` only while that prompt waits
  (a stale one is refused); the Telegram rules and caps hold for both senders
  (test); on an OS without actions the click opens the prompt.

### WP-10 — Menu bar / tray, badge, global hotkey

- **Scope.** Tray or menu bar with limits, today's spend and waiting sessions;
  the badge; one configurable global hotkey.
- **Files.** `app/src-tauri/src/{tray.rs,badge.rs,hotkey.rs}`, Settings in
  `ui/`.
- **Depends on.** WP-02.
- **Parallel with.** WP-09, WP-11.
- **Acceptance.** Values match the dashboard within one live frame; the badge
  clears when nothing waits; the hotkey works with another app focused, on
  three OS (Linux: X11 and Wayland, documented where Wayland refuses).

### WP-11 — The scrolling rule

- **Scope.** One shared hook (`useStickToBottom`) and the "↓ N new" pill,
  applied to terminal scrollback, timeline, chat view and Now.
- **Files.** `ui/src/lib/useStickToBottom.ts`, the components that scroll.
- **Depends on.** Nothing.
- **Parallel with.** Everything in the interface lane.
- **Acceptance.** [21-app.md § The scrolling rule](21-app.md#the-scrolling-rule)
  acceptance as automated browser tests at 1400×900 and 390 px: 200 messages
  streamed while scrolled up, position unchanged ±1 px; older page loaded,
  first visible message ±1 px; following at the bottom with no frame over
  50 ms.

### WP-12 — Live replay

- **Scope.** `seq` on every `/v1/live` frame; a ring of 2,000 frames or 10
  minutes; `?since=`; `reset` when compacted; ping/pong with the 25 s deadline.
- **Files.** `internal/api` (live), `internal/bus`, `ui/src/lib/live.ts`,
  [03-contracts.md](03-contracts.md).
- **Depends on.** Nothing.
- **Parallel with.** WP-03, WP-05.
- **Acceptance.** A client reconnecting inside the ring receives exactly the
  missed frames in order; outside it, a `reset`; a notify missed while
  offline is shown after reconnect.

### WP-13 — Phone resilience client

- **Scope.** Reconnect forever (full jitter, 0.5–15 s, immediate on
  visibility, `online` and network change); honest state indicator; the
  offline queue for keys-bar messages with its rules.
- **Files.** `ui/src/lib/reconnect.ts`, `ui/src/components/ConnectionState.tsx`,
  `ui/src/components/TerminalKeys.tsx`.
- **Depends on.** WP-03, WP-12.
- **Parallel with.** WP-14, WP-15.
- **Acceptance.** Phone v2 definition of done, items 1–5 below.

### WP-14 — Chat view

- **Scope.** The conversation as messages from stored events, tool calls on
  one line, the input typing into the session, the scrolling rule.
- **Files.** `ui/src/components/ChatView.tsx`, `internal/api` if a read
  endpoint is missing.
- **Depends on.** WP-11.
- **Parallel with.** WP-13, WP-15.
- **Acceptance.** A 2,000-message session opens in under 500 ms on a mid-range
  phone; WP-11's acceptance holds in it. Order comes from the server (event
  sequence), never from arrival time on the client: a message delivered late
  or replayed after a reconnect lands in its place, never after newer ones,
  and never twice (messages carry stable ids; the client dedupes). Test:
  deliver 50 messages out of order and 10 duplicates → rendered order equals
  server order, no duplicates. (Owner, 2026-10-05: Orca shows an old message
  as just sent and appends it after newer ones.)

### WP-15 — Start work from the phone; Tailscale by QR

- **Scope.** ADR-034 amendment naming add, create, clone and worktree for a
  controller; the phone's new-project and clone screens with progress;
  Tailscale address detection and its QR in the pairing panel.
- **Files.** [08-decisions.md](08-decisions.md) (ADR-034 amendment),
  `internal/api` (gate allowlist), `internal/lan`, `ui/src/components/Pairing.tsx`,
  `ui/src/components/NewProject.tsx`.
- **Depends on.** WP-05, WP-08; open decision 8.
- **Parallel with.** WP-13, WP-14.
- **Acceptance.** From a real phone over LAN and over Tailscale: clone a URL,
  start a session in it and type, with the connection dropped mid-clone; a
  viewer gets 403 on each; a URL other than `https://` or `git@` is refused.

### WP-16 — Benchmarks, and the reference-app comparison

- **Scope.** Move the spike's `bench/` into the repo; an app harness (echo,
  open, switch, memory per tab count, CPU, cold start, flood isolation,
  long tasks, disk writes); a phone harness with network conditioning; the
  same runs against the reference app (Orca, version recorded) on the same
  machine where it has the capability.
- **Files.** `bench/`, `bench/results-<date>/`, [21-app.md](21-app.md)
  (results), [13-testing.md](13-testing.md).
- **Depends on.** WP-04 for app numbers; nothing to start.
- **Parallel with.** Everything.
- **Acceptance.** One command per OS reproduces every budget row; results are
  committed with the machine, OS and date; the reference-app runs are
  committed beside ours.

### WP-17 — Packaging, signing, install paths

- **Scope.** Release jobs producing `.dmg` (universal), the cask; NSIS or MSI,
  Scoop, winget; AppImage, `.deb`, `.rpm`; the bundled daemon from the same
  tag; signing per the owner's decisions 2 and 3, ad-hoc otherwise; install
  pages.
- **Files.** `.goreleaser.yaml`, `.github/workflows/release.yml`,
  `app/src-tauri/tauri.conf.json` (bundle), `dspv/homebrew-tap`,
  `dspv/scoop-bucket`, [10-infrastructure.md](10-infrastructure.md).
- **Depends on.** WP-01; decisions 2, 3 and 6.
- **Parallel with.** WP-16, WP-18.
- **Acceptance.** MVP definition of done, *Install paths*.

### WP-18 — Docs and site

- **Scope.** README and `docs/` install and use pages; [04-ui.md](04-ui.md)
  for the app layout; this corpus current; the site's download page and
  screenshots in the private site repo, under its rules (no "coming soon").
- **Depends on.** Everything user-visible.
- **Acceptance.** MVP definition of done, *Docs and site*.

## Work packages — P1

Each gets the same fields as P0 when it starts; the scope is fixed here.

- **WP-19 — GitHub (F14).** Auth per decision 4; API client in the daemon with
  conditional requests and rate limits; list, clone, create repository; PR
  from a worktree; checks and reviews; notifications; health line. Every
  error path (401, 403 missing scope, 404, rate limit, network) has a test
  that asserts a visible message.
- **WP-20 — Split panes, search, palette, open in editor (F15–F18).**
- **WP-21 — Opt-in auto-update (F20).** Tauri updater with our signing key;
  off until switched on; never updates a daemon it did not install.
- **WP-22 — Phone Phase B (F19).** After M5; its definition of done is
  written with the decision, at least: paths raced in parallel, the first
  winner kept, ≤ 3 s median reconnect, and for a relay, end to end encryption,
  three regions, no database in the data path and a load test.
- **WP-23 — Themes and fonts (F21).**

## Definition of done

### (a) Every work package

A work package is done when all of these hold, in the PR that closes it:

1. **Green on three OS.** `make check` locally, and CI green on ubuntu, macOS
   and Windows, including the app job: `go vet`, `golangci-lint`, `go test`;
   `tsc --noEmit`, `vitest`, `eslint`, `vite build`; `cargo fmt --check`,
   `cargo clippy -D warnings`, `cargo test`; the docs gates. No red Windows
   job (rule 2).
2. **Tested where it can break.** New behaviour has tests, and each was seen
   to fail against a deliberately broken implementation. Protocol and
   migration changes are tested on all three OS.
3. **Docs and contracts in the same PR.** An endpoint, frame, table or file
   format lands in [03-contracts.md](03-contracts.md) with its migration
   (rule 8); a UI change in [04-ui.md](04-ui.md); a decision as an ADR or an
   amendment; [21-app.md](21-app.md) updated where behaviour differs from the
   spec; a [14-build-status.md](14-build-status.md) log entry.
4. **CHANGELOG** entry for anything a user can see.
5. **Verified in use, not only in tests.** On a preview daemon (temp HOME, a
   copy of the database, the fake `claude`): the app at 1280×800, 1920×1080
   and its minimum window; the browser at 1400×900; the phone at 320 and
   390 px. Nothing clipped, no horizontal scroll, screenshots opened and
   looked at.
6. **No regressions to web or phone.** The browser dashboard in Chrome and
   Safari, and the phone as viewer and as controller (pair, start, type,
   answer a prompt), still work; the smoke test passes.
7. **No budget regressed.** A package touching the terminal, live or render
   path runs WP-16's bench and stays within every budget of
   [21-app.md](21-app.md#performance-budgets).
8. **Rules kept.** English only; no invented numbers; rule 7 (only processes
   Caprock started); rule 4 (no new outbound call that is not opt-in); the
   Rust shell stays within its line budget.

### (b) The MVP release

The release on 2026-12-01 ships when every item is checked and the evidence
is linked from the release PR.

**Features.** F01–F13 each verified by its acceptance in the work packages
above, on macOS, Windows and Linux, by a person using the app, not only by
tests.

**Performance budgets** — every row of
[21-app.md § Budgets](21-app.md#budgets) met on three reference machines,
results committed under `bench/results-<date>/`:

- macOS: Apple Silicon, the current macOS, 60 Hz display.
- Windows: Windows 11 x64, a physical machine (CI runners are too noisy for
  latency).
- Linux: Ubuntu 24.04 x64 under GNOME (Wayland) and one X11 run.

**Reference-app comparison.** The same harness against Orca, on the same Mac,
with the version recorded: echo p50/p95 at three loads, open session, memory
with 1 and 10 tabs, CPU idle, cold start, flood isolation, disk written in the
first two minutes after launch, phone reconnect after a network drop. Caprock
is equal or better on each row, or the release notes say where it is not. Only
measured, dated figures are published (rule 6).

**The reference app's failures, each with a test** (from the competitive
analysis kept in the private site repo):

1. **Janky chat scroll on the phone.** 200 messages streamed while scrolled up
   in the chat view on a real phone: position unchanged ±1 px; an older page
   loaded: the first visible message ±1 px; following at the bottom: no frame
   over 50 ms.
2. **The desktop app freezes.** A 30-minute scripted run with 10 sessions, one
   flooding at the fake's maximum rate, 50 projects watched: no UI long task
   over 250 ms; with the daemon killed, the window stays usable, shows the
   banner within 2 s and recovers by itself.
3. **The phone connection drops and needs a manual reconnect.** 20 network
   events (Wi-Fi off and on, Wi-Fi to cellular over Tailscale, 60 s of
   airplane mode, 5% loss at 300 ms latency): every one recovers with no tap,
   median ≤ 3 s after the network returns; a half-open socket detected within
   25 s; zero keystrokes lost or doubled across the run.
4. **A new project cannot be started from the phone.** From a real phone:
   clone a URL into a new project, start a session and type into it, with the
   connection dropped mid-clone, completed without touching the computer.
5. **GitHub errors are hidden.** P1 (WP-19); for the MVP, every error from git
   during clone and worktree operations is shown with git's message (test per
   failure: auth, network, existing path, branch in use).
6. **The terminal hangs.** While one session floods, echo p95 in another stays
   within budget; Ctrl+C reaches a flooding session within 100 ms; killing
   one pty-host leaves every other session live; 10 sleep–wake cycles repaint
   every tab with no reload.

**Install paths.** On a clean VM or machine per OS, from each artefact
(`.dmg` and cask; installer, Scoop and winget once accepted; AppImage, `.deb`,
`.rpm`): first launch reaches a working terminal with no command typed
beyond what the install page says for an unsigned app; an upgrade from the
previous build keeps sessions running; uninstalling the app leaves the data
directory and a Homebrew or Scoop daemon untouched.

**Docs and site.** README and `docs/` describe installing and using the app;
[04-ui.md](04-ui.md), [03-contracts.md](03-contracts.md) and
[00-index.md](00-index.md) § Current State are current; the CHANGELOG entry is
written; the site has a download page with screenshots taken from the release
build, and no public page calls anything unbuilt (rule 11).

**Security.** A review of the Tauri capabilities, the CSP, the sidecar's
arguments and the new endpoints (projects, shells, live replay, the phone
allowlist), with findings fixed or recorded as accepted.

**Dogfood.** The owner uses the app as his only terminal for three working
days on the release candidate with no freeze, dropped connection or jumping
scroll reported; anything reported is fixed or the release moves.

### (c) Phone v2

**Phase A** ships with the MVP and is done when, on a real iPhone (Safari,
home screen) and a real Android phone (Chrome), over LAN and over Tailscale:

1. **Reconnect** recovers from each of the 20 network events of the MVP list
   with no tap, median ≤ 3 s after the network returns.
2. **Half-open** sockets are detected within 25 s, and the state indicator
   never shows "live" without a round trip in the last 25 s.
3. **Exactly once.** 10,000 sequenced inputs across 50 forced disconnects
   reach the session exactly once (the fake's echo log is the proof).
4. **Resume** inside the ring sends only the missing bytes — no repaint, no
   flash; past the ring, one clean repaint.
5. **The offline queue** sends a held message on reconnect only when the
   session is live and no prompt waits; otherwise it is a draft with
   **Send now**; raw keys and prompt answers are never queued.
6. **Replay.** A notification raised while the phone was offline is shown
   after reconnect; a gap past the ring produces a refetch, not a blank view.
7. **The chat view** meets the scrolling acceptance at 320 and 390 px.
8. **Start work.** Create, clone (dropped mid-clone) and worktree, then a
   session, from the phone; a viewer is refused each.
9. **Tailscale by QR** pairs a phone that is off the Wi-Fi.
10. **No regression** for a phone on the previous release's flow (pairing,
    roles, prompt buttons, photo).

**Phase B** is done against the definition written with the owner's decision
(WP-22).
