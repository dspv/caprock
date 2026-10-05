# Caprock — The desktop app

The product spec for Caprock's desktop app: what it is for, who uses it, what it
does at each priority, how fast it must be, how it talks to the daemon, how it
is secured and shipped, and what the owner still has to decide. The stack and
the alternatives it beat are decided in
[ADR-038](08-decisions.md#adr-038--the-desktop-app-is-a-thin-tauri-v2-shell-around-the-existing-react-ui-and-xtermjs-on-the-go-daemon);
the weeks, work packages and definitions of done are in
[22-app-plan.md](22-app-plan.md). Contracts named here are proposals until the
work package that builds them moves them into [03-contracts.md](03-contracts.md)
in the same commit (rule 8).

**Status (2026-10-05): specified, not built.** Nothing in `cmd/`, `internal/`
or `ui/` depends on this file yet.

## Goal

The owner's framing (2026-10-05, translated):

> Caprock is where you work with coding agents: terminal, projects, Claude
> Code/Codex/OpenCode sessions, money and limits, the phone — in one fast app.
> A replacement for the terminal Claude Code lives in today, and for Orca: the
> same capabilities, without freezes, dropped connections or a jumping scroll.

What that means in practice:

- **Terminal-first.** The window opens on terminals, not on charts. A session,
  a shell and a project are one click or one shortcut away.
- **Many projects at once.** A sidebar of projects, each with its branches,
  worktrees, live sessions and the ones waiting on you.
- **The monitoring Caprock already has**, unchanged: cost per repository, plan
  limits, loops, what the agent wrote, permission prompts, the week.
- **A phone that can start work**, not only watch it, and that stays connected
  on a bad network without a manual reconnect.
- **Quality that is measured, not claimed.** Every "without freezes, drops or
  a jumping scroll" has a test with a number, run against the reference app as
  well as ours, before the release ([22-app-plan.md § MVP](22-app-plan.md#b-the-mvp-release)).

The app is free. Teams pay for the manager's web dashboard (Caprock Teams:
spend across the organisation, cost per pull request) — see
[17-teams.md](17-teams.md). The app wins individual developers on quality; it
is not where the money is taken.

## Users

- **The individual developer.** Runs Claude Code, Codex or OpenCode in several
  repositories, lives in a terminal today, pays their own plan. Wants one
  window for all of it, the cost and the limits in view, and the phone when
  away from the desk. The primary user of the app.
- **The developer on a team.** Same app, same features. Their machine may
  report aggregates to the team dashboard when their team enrols
  ([17-teams.md](17-teams.md)); the app never sends prompts, replies or tool
  output anywhere.
- **The manager.** Does not install the app. Uses the Caprock Teams web
  dashboard for spend per person and per repository. Nothing in this spec is
  built for the manager; nothing here may break what the team tier needs.

## Principles

1. **The engine is Go, and there is one.** Sessions, pty-hosts
   ([ADR-033](08-decisions.md#adr-033--an-owned-session-outlives-the-daemon-its-terminal-lives-in-a-pty-host)),
   the store, hooks, pricing, alerts, pairing and the phone's API stay in the
   daemon. The app is a client of the same HTTP and WebSocket API the browser
   and the phone use. A feature that would need logic in the app's Rust is
   built in the daemon instead.
2. **Thin client.** The Rust shell owns only what a browser tab cannot do: the
   window, the tray or menu bar, OS notifications, the global hotkey, the dock
   or taskbar badge, starting the bundled daemon, and the update notice. Target
   size: under 1,500 lines of Rust at the MVP (a budget, checked in review).
3. **Never block the UI.** No disk, network, git or parsing work on the UI
   thread; the daemon does it and sends bounded, coalesced updates. If the
   daemon is unreachable the window stays usable and says so.
4. **Never yank the reader.** Output arriving below never moves what someone
   is reading. Follow the tail only when already at the bottom
   ([§ The scrolling rule](#the-scrolling-rule)).
5. **Local-first.** Rule 4 holds for the app: no telemetry, no account, no
   cloud. Every outbound call is one the user switched on, to a destination
   they chose ([§ Telemetry](#telemetry)).
6. **One code path for every client.** The app, the browser and the phone
   start a session, create a project or answer a prompt through the same
   endpoint. A capability the phone lacks is a decision in an ADR, not an
   omission.
7. **Honest state.** "Connected" is shown only after a successful round trip
   in the last 25 seconds. Every error from the daemon, git or GitHub is shown
   with its context, never swallowed.

## What the user sees

One window, three regions:

- **Sidebar (left).** Projects, each expandable to worktrees and branches,
  then to the sessions and shells in it. Badges: *waiting on you*, *looping*,
  cost today. A **Dashboard** entry opens the existing screens.
- **Tabs (main).** Terminal tabs — an agent session or a shell — with the
  project and branch in the title. The permission prompt card
  ([ADR-035](08-decisions.md#adr-035--a-permission-prompt-is-answered-with-a-button-found-by-its-hook))
  sits under the terminal it belongs to.
- **Status strip (bottom).** Connection state, plan limits (5-hour and 7-day),
  today's spend, the daemon's state.

Outside the window: the menu bar (macOS) or tray (Windows, Linux) with limits
and the number of sessions waiting; OS notifications with **Approve** and
**Deny**; a global hotkey that brings the window up; a badge with the waiting
count.

## Features and priorities

Priorities: **P0** is the MVP and blocks the release; **P1** follows within
about two months of it; **P2** is later and each item needs its own go. IDs
are stable and referenced by [22-app-plan.md](22-app-plan.md).

| ID  | Feature                                     | Priority |
| --- | ------------------------------------------- | -------- |
| F01 | Window, daemon discovery, api_level         | P0       |
| F02 | Projects sidebar with live git state        | P0       |
| F03 | Agent terminal tabs on protocol v2          | P0       |
| F04 | Shell tabs                                  | P0       |
| F05 | New session, new project, clone, worktree   | P0       |
| F06 | Dashboard screens embedded                  | P0       |
| F07 | Notifications with Approve / Deny           | P0       |
| F08 | Menu bar / tray: limits and waiting         | P0       |
| F09 | Global hotkey and app keyboard map          | P0       |
| F10 | Dock / taskbar badge                        | P0       |
| F11 | The scrolling rule, everywhere              | P0       |
| F12 | Install paths and update notice per OS      | P0       |
| F13 | Phone v2 Phase A: resilience and start work | P0       |
| F14 | GitHub integration                          | P1       |
| F15 | Split panes                                 | P1       |
| F16 | Search in terminal scrollback               | P1       |
| F17 | Command palette                             | P1       |
| F18 | Open in editor                              | P1       |
| F19 | Phone v2 Phase B: reach off-network         | P1       |
| F20 | Opt-in auto-update                          | P1       |
| F21 | Terminal themes and fonts                   | P1       |
| F22 | Mobile app (iOS, Android) from the codebase | P2       |
| F23 | Native terminal renderer (libghostty)       | P2       |
| F24 | Push notifications to the phone             | P2       |
| F25 | Team enrolment from the app                 | P2       |

### P0 — the MVP

- **F01 — Window, daemon discovery, api_level.** The app reads
  `<data_dir>/runtime.json`, checks `GET /v1/status` for `api_level`, and loads
  the dashboard from the daemon's loopback URL. A daemon already running (a
  Homebrew or Scoop install, or the service) is used as is. If none runs, the
  app starts the `caprock` binary it bundles, detached, so sessions keep
  running when the window closes. If the daemon's `api_level` is below the
  app's minimum, the window says which command upgrades it (Caprock never
  updates itself). If the daemon stops, the window shows a banner within 2
  seconds, keeps the open terminals' last screen, and reconnects by itself.
- **F02 — Projects sidebar.** Every project the user added, cloned or ran a
  session in, with the current branch, ahead/behind, the number of changed
  files, its worktrees, and the sessions and shells under each. Git state
  changes within a second of a commit or checkout made anywhere (terminal,
  editor, agent), without polling. Removing a project removes it from the
  list, never from disk.
- **F03 — Agent terminal tabs.** xterm.js tabs attached to owned sessions over
  terminal protocol v2. A tab reopened after the app, the daemon or the
  network restarts shows exactly what it missed, from the byte it last saw; a
  keystroke is delivered once, never twice, never lost. Tabs not visible for
  30 seconds drop their socket and catch up when shown. Shortcuts the
  terminal needs (Ctrl+C, Ctrl+W in a shell, Option as Meta) reach it; the
  app's own shortcuts use Cmd on macOS and Ctrl+Shift on Windows and Linux.
- **F04 — Shell tabs.** A plain login shell in a project or worktree, held by
  a pty-host like an agent session, so it survives an app or daemon restart.
  Shells are marked internal and never appear in cost, Now, or any total.
- **F05 — New session, new project, clone, worktree.** From the sidebar: start
  any supported agent in a project (the existing start dialog); create a
  project (an empty folder with `git init`), add an existing folder, or clone
  a URL with progress shown; create a worktree on any branch (existing or new)
  and open a session in it. The phone uses the same endpoints.
- **F06 — Dashboard screens.** Now, Session Detail, Cost, Lifetime, Memory,
  Week, Tasks and Settings are the existing React screens, opened in the same
  window. Switching to them never unmounts a visible terminal.
- **F07 — Notifications.** An OS notification when an owned session shows a
  permission prompt (with **Approve** and **Deny** where the OS supports
  actions), when a session finishes a turn and nothing follows for a minute,
  and when a session loops. Same rules, cooldowns and caps as the Telegram
  alerts ([ADR-036](08-decisions.md#adr-036--a-phone-hears-that-a-session-needs-it-through-the-owners-own-telegram-bot)).
  No notification for the session in the focused tab.
- **F08 — Menu bar / tray.** The 5-hour and 7-day plan usage, today's spend,
  and the sessions waiting on you, each a click from its session.
- **F09 — Global hotkey and keyboard map.** One configurable hotkey shows or
  hides the window from anywhere. New tab, close tab, next/previous tab, tab
  1–9, new session, new shell, dashboard, find.
- **F10 — Badge.** The dock (macOS) or taskbar (Windows) badge is the number
  of sessions waiting on you; Linux shows it where the desktop supports it.
- **F11 — The scrolling rule** in every scrolling surface: terminal
  scrollback, the timeline, the chat view, Now
  ([§ The scrolling rule](#the-scrolling-rule)).
- **F12 — Install paths and update notice.** A `.dmg` and a Homebrew cask on
  macOS, an installer plus Scoop (and winget once accepted) on Windows, an
  AppImage plus `.deb` and `.rpm` on Linux. When a newer release exists and
  the release check is on, the app says so and links the download; it does not
  replace itself before F20.
- **F13 — Phone v2 Phase A.** The phone (the existing web dashboard on the
  home screen) never needs a manual reconnect, resumes a terminal from the
  byte it last saw, queues a message typed while offline, replays the live
  frames it missed, has a chat view of the conversation that obeys the
  scrolling rule, can create or clone a project and start a session in it, and
  pairs over Tailscale by QR ([§ Phone v2](#phone-v2)).

### P1 — within about two months of the MVP

- **F14 — GitHub integration.** Connect GitHub from Settings; list and clone
  your repositories, create a repository, open or update a pull request from a
  worktree, see its CI checks and review comments, get notified when CI fails
  or a review lands. Every API error is shown with what was being done, and a
  health line says when it last worked and with which scopes
  ([§ GitHub](#github)).
- **F15 — Split panes.** Two or more terminals side by side or stacked.
- **F16 — Search in scrollback** of the focused terminal.
- **F17 — Command palette** over projects, sessions, tabs and actions.
- **F18 — Open in editor.** The project or worktree in VS Code, Cursor, Zed or
  the system default.
- **F19 — Phone v2 Phase B.** Reaching the machine when the phone is off its
  network, by the route the owner chooses ([§ Phone v2](#phone-v2)).
- **F20 — Opt-in auto-update** with signed update bundles, per OS.
- **F21 — Themes and fonts** for the terminal; the palette work references
  Otty's colours (owner, 2026-10-04) without copying its branding.

### P2 — later, each with its own go

- **F22 — Mobile app** for iOS and Android from the same codebase (Tauri v2
  mobile), replacing the home-screen web app when it is measurably better.
- **F23 — Native terminal renderer** via libghostty, behind the same tab
  interface, if a revisit trigger in ADR-038 fires.
- **F24 — Push notifications** to the phone without Telegram (APNs, FCM);
  needs a gateway, which is the relay question again.
- **F25 — Team enrolment** from the app, joining the team dashboard with the
  token [17-teams.md](17-teams.md) defines.

## Non-goals

- **An editor or IDE.** No file editing; F18 opens the user's editor.
- **Our own agent or chat model.** The app runs the user's agents.
- **A second engine.** No session, git or pricing logic in the app.
- **Typing into or signalling a process Caprock did not start** (rule 7).
- **Telemetry, crash upload, accounts, cloud sync.**
- **The manager's dashboard.** That is the Teams web product.
- **Electron**, a TUI, or a per-OS native rewrite for the MVP (ADR-038).
- **A hosted relay in the MVP.** Phase B decides it, as its own ADR.

## Platform matrix

| Platform | MVP | Later                             |
| -------- | --- | --------------------------------- |
| macOS    | yes | universal binary (arm64 + x86_64) |
| Windows  | yes | x64 at MVP; arm64 at P1           |
| Linux    | yes | x64 at MVP; arm64 at P1           |
| iOS      | web | native app at P2 (F22)            |
| Android  | web | native app at P2 (F22)            |

"web" means the existing dashboard on the phone's home screen, with Phone v2
Phase A. Minimum OS versions are an open decision; the proposal is macOS 13,
Windows 10 22H2 with WebView2, and Ubuntu 22.04 / Fedora 38 class distributions
with WebKitGTK 4.1 (Tauri v2's floor on Linux).

## Performance budgets

Budgets are targets the release must meet on all three OS, measured with the
benchmark the macOS spike introduced (`bench/` on branch `spike/macos-app`,
PR #180): an isolated daemon, the fake `claude` streaming at 0, 200 and 1000
lines a second, 200 samples per cell, the timing stopped when the frame is
handed to the compositor. "Load" means that stream. Numbers without a source
are budgets, not measurements (rule 6).

### What is measured already

The macOS spike, 2026-10-04, one Apple Silicon machine, macOS 14.6.1, 60 Hz:

| Metric                    | Native (SwiftTerm) | Web (Chrome tab) |
| ------------------------- | ------------------ | ---------------- |
| Echo p50, load 0–1000     | 5.5–5.7 ms         | 11.9–14.3 ms     |
| Echo p95, load 0–1000     | 8.7–10.0 ms        | 20.4–21.7 ms     |
| Open session, load 0–1000 | 97–113 ms          | 434–1119 ms      |
| Memory                    | 34–53 MB           | 278–442 MB (tab) |
| CPU idle, load 0          | 7%                 | 5.5% (tab)       |
| CPU streaming, load 1000  | 14%                | 20% (tab)        |
| Cold start to first echo  | 0.7–1.2 s          | not measured     |

The Tauri spike (branch `spike/tauri-app`, `app/SPIKE.md`) measures the same
cells for the app:

measured on 2026-10-05 on one Apple Silicon Mac (M1 Pro, macOS 27.0.1, 60 Hz),
same harness and fake `claude`; keystrokes injected in-process. The native and
Chrome columns are the 2026-10-04 figures above, not re-run:

| Metric                     | Tauri, lean terminal | Tauri, full dashboard | Chrome tab  | Native     |
| -------------------------- | -------------------- | --------------------- | ----------- | ---------- |
| Echo p50 / p95, load 0     | 9.2 / 17.7 ms        | 13.3 / 25.2 ms        | 11.9 / 21.7 | 5.7 / 10.0 |
| Echo p50 / p95, load 1000  | 10.2 / 18.0 ms       | 16.4 / 26.2 ms        | 14.3 / 21.1 | 5.5 / 9.1  |
| Open session to first echo | ~280 ms (new window) | 143–212 ms (route)    | 434–1119 ms | 97–113 ms  |
| Cold start to usable       | 0.65–0.93 s          | 0.54–0.85 s           | –           | 0.7–1.2 s  |
| CPU, load 0 / 1000         | 6% / 20%             | 8% / 24%              | 5.5% / 20%  | 7% / 14%   |
| Memory, all app processes  | 177–252 MB           | 206–529 MB            | 278–442 MB  | 34–53 MB   |
| Download / installed       | 2.0 MB dmg / 4.5 MB  | same app              | –           | –          |

Orca on the same Mac, observed while idle with the owner's sessions open: 8
processes, 420–541 MB, about 5% CPU, 624 MB installed. Its echo latency and
cold start were not measured, so as not to touch the owner's sessions; the MVP
definition of done measures them on a clean profile.

What it says:

- The lean terminal is faster than a Chrome tab and within a few milliseconds
  of native; the full dashboard route is slower. The app's terminal view must
  stay lean (no dashboard work on the terminal's thread or route).
- Memory is the gap to native and the win over Chrome and Orca. The 150 MB
  one-tab budget was set before measuring and is revised below.
- The existing dashboard renders in WKWebView unchanged (10 routes, no
  console errors, WebGL terminal). It still needs: external links and
  `window.open` sent to the system browser, a download handler, and
  notification actions, which the official plugin lacks.
- Not yet measured: Windows (WebView2) and Linux (WebKitGTK). Linux is the
  risk: blank windows on NVIDIA/Wayland, WebGL lag without DMABUF
  (`preserveDrawingBuffer: true` mitigates), no global shortcuts on Wayland,
  tray clicks not delivered. Tauri ≥ 2.11.1 is required (security advisory).

### Budgets

| Metric                                     | Budget             |
| ------------------------------------------ | ------------------ |
| Echo p50, any load to 1000 lines/s         | ≤ 12 ms            |
| Echo p95, any load to 1000 lines/s         | ≤ 25 ms            |
| Echo p95 in tab A while tab B floods       | ≤ 25 ms            |
| Open a session, click to first echo, p50   | ≤ 200 ms           |
| Switch to an open tab, to first paint      | ≤ 50 ms            |
| Cold start to interactive window           | ≤ 1.5 s            |
| Cold start to first echo in a restored tab | ≤ 2.5 s            |
| Memory, all app processes, 1 tab           | ≤ 250 MB           |
| Memory, all app processes, 10 tabs         | ≤ 450 MB           |
| CPU, window visible, no output             | ≤ 1% of one core   |
| CPU, window hidden                         | ≤ 0.2% of one core |
| CPU, one visible tab at 1000 lines/s       | ≤ 25% of one core  |
| UI long task during the benchmark          | none over 100 ms   |
| Daemon restart to live terminal            | ≤ 2 s              |
| Network back to live terminal (phone)      | ≤ 3 s median       |
| Half-open connection detected              | ≤ 25 s             |
| Disk written by the app, per day           | ≤ 10 MB            |
| Download size, per OS                      | ≤ 60 MB            |

The echo budget is the web figure's p50 with headroom, not the native one: the
app renders with xterm.js like the web, and the spike showed echo latency is
not where native wins (ADR-038). What the app must win is opening, memory,
focus and the absence of stalls. The memory budgets were raised after the Tauri spike measured 177–252 MB for
one lean terminal; they stay below Orca (420–541 MB idle) and a Chrome tab.

## Architecture

```
┌─────────────────────────── Caprock app (per OS) ───────────────────────────┐
│  Rust shell (Tauri v2)              │  WebView (WKWebView / WebView2 /     │
│  window · tray/menu bar · notify    │  WebKitGTK)                          │
│  hotkey · badge · update notice     │  React UI from ui/ + xterm.js        │
│  daemon supervisor (sidecar)        │  loaded from http://127.0.0.1:<port> │
│        ▲ Tauri IPC (allowlisted commands only)  │                          │
└────────┼────────────────────────────────────────┼──────────────────────────┘
         │ reads runtime.json, starts caprock    │ HTTP + WS (loopback)
         ▼                                        ▼
┌──────────────────────────── caprock daemon (Go) ───────────────────────────┐
│  api · live (/v1/live, seq+since) · term v2 · projects · shells · alerts   │
│  hookd · ingest · rollup · pricing · pairing · store (SQLite)              │
└──────▲───────────────────────▲─────────────────────────▲───────────────────┘
       │ loopback TCP + token  │ hook POSTs              │ LAN / Tailscale
┌──────┴──────┐         ┌──────┴──────┐           ┌──────┴──────┐
│ pty-host ×N │         │ hook shim   │           │ phone (web) │
│ agent/shell │         └─────────────┘           └─────────────┘
└─────────────┘
```

- **The UI is served by the daemon.** The WebView loads the dashboard from the
  daemon, exactly as a browser does, so the app's UI and the daemon's API can
  never be from different releases. The shell bundles one small fallback page
  for when no daemon answers. The React code detects the app
  (`window.__TAURI_INTERNALS__`) and turns on the app-only surfaces: tabs
  layout, native notifications instead of in-page ones, the badge.
- **The shell talks to the page through Tauri commands**, allowlisted for the
  daemon's origin only: `notify`, `set_badge`, `set_tray`, `register_hotkey`,
  `open_external` (https and the editors' schemes only), `daemon_status`. No
  shell, filesystem or HTTP plugin is exposed to the page.
- **The daemon supervisor** reads `runtime.json`, starts the bundled binary
  when no daemon answers, and never stops a daemon it did not start. Quitting
  the app leaves the daemon and every session running.
- **api_level.** `GET /v1/status` and `runtime.json` gain `api_level`, an
  integer raised by every change a client must know about. The app declares
  the minimum it needs. A daemon below it is shown as "needs an upgrade" with
  the command. The phone reads the same field. This matters once the UI is
  bundled anywhere (F22).

## Terminal protocol v2

The terminal socket today replays a snapshot on every connect and carries no
positions, so a reconnect repaints the screen and a keystroke sent into a dying
socket is either lost or, on retry, typed twice. Version 2 makes every byte and
every keystroke addressable. Version 1 stays served for older clients.

- **Negotiation.** `WS /v1/agents/{id}/term` with subprotocol `caprock.term.v2`
  (alongside the device-token subprotocol where one is sent). Without it, v1.
- **Byte offsets.** `internal/termbuf` counts every byte the session ever
  output (a `uint64`), and the ring knows the offset of its oldest byte. The
  pty-host reports the current offset in its `W` (welcome) frame and the ring's
  start offset with `S`, as new JSON fields (additive, ADR-033's rule).
- **Resume.** The client connects with `?since=<offset>`. If the ring still
  holds that byte, the server sends exactly the bytes after it. If not, it
  sends a text frame `{"reset":{"offset":N}}`, then the snapshot (mode prefix
  plus ring), and the client clears and repaints. A fresh client sends no
  `since` and gets the snapshot.
- **Output frames.** Server-to-client binary frames start with the 8-byte
  big-endian offset of their first byte. The client keeps `offset + length` as
  its position and ignores any byte it already has.
- **Input, exactly once.** Client-to-server binary frames start with an 8-byte
  big-endian sequence number from a per-tab `client_id` (sent once in a
  `{"hello":{"client_id":…,"last_seq":N}}` text frame). The pty-host keeps the
  highest sequence applied per client id (a new frame type, `J`, carrying
  client id, sequence and bytes; additive) and drops anything at or below it,
  so a retry after a reconnect, or after a daemon restart, is never typed
  twice. The server acknowledges with `{"ack":N}`; the client resends
  everything unacknowledged after a reconnect.
- **Liveness.** Both sides send `{"ping":t}` every 10 seconds and answer
  `{"pong":t}`. Nothing received for 25 seconds means the socket is dead: the
  client closes it and reconnects, and shows "reconnecting" meanwhile.
- **Backpressure.** The pty-host never stops reading its PTY; the ring
  overwrites. The daemon keeps at most 1 MiB queued per client socket; past
  that it drops the queue and sends a `reset` at the current offset, so a slow
  client costs itself a repaint and costs no other client anything. The
  client stops reading the socket while more than 1 MiB is waiting for
  xterm.js to parse, and resumes below 256 KiB (xterm.js's write callbacks).
- **Hidden tabs.** A tab not visible for 30 seconds closes its socket; showing
  it reconnects with `since`. Waiting and permission state come from
  `/v1/live`, never from the terminal socket, so a hidden tab still badges.
- **Input ownership.** No locks. Any client allowed to type may type; the last
  resize wins; a phone can never lock the desktop out (the failure seen in the
  reference app's issue tracker).
- **Modes on exit and restore.** When the child exits, or a snapshot repaints,
  the client resets mouse tracking, bracketed paste and the alternate screen
  before drawing, so a dead TUI's modes never leak into the next one.

## Projects

Today a "project" is a repository derived from sessions' working directories
(migration 0011). The app needs projects a user adds before any session runs
there, and worktrees as first-class places to work.

- **Storage.** Migration `0041_projects`: `projects (id, root UNIQUE, name,
  kind 'repo'|'folder', remote_url, default_branch, added_at, pinned, sort,
  archived_at)`. A row is added explicitly (add, create, clone) or the first
  time a session runs in a folder not yet listed. Archiving hides it; nothing
  is deleted from disk. Cost attribution keeps using the repository key of
  migration 0011, so no total changes.
- **API.** `GET /v1/projects`; `POST /v1/projects` with
  `{"source":"folder"|"new"|"clone", "path"?, "url"?, "name"?, "op_id"}`;
  `PATCH /v1/projects/{id}` (name, pinned, sort, archived);
  `GET /v1/projects/{id}/branches`;
  `POST /v1/projects/{id}/worktrees` with `{"branch", "create"?, "base"?}`;
  `DELETE /v1/projects/{id}/worktrees/{name}` (only a clean worktree Caprock
  created; anything else is refused with the reason).
- **Long operations** (clone, worktree) take a client-generated `op_id`, are
  idempotent on it, and report progress as `op` frames on `/v1/live`
  (`{op_id, state, progress, error}`), so a phone that drops mid-clone sees the
  result when it returns instead of starting a second clone.
- **Git state without polling.** The daemon watches each project's `.git`
  (`HEAD`, `index`, `refs/`, `worktrees/`) with fsnotify, debounces 300 ms,
  then runs `git status --porcelain=v2 --branch` under a 5-second timeout with
  at most two git processes at once. Remotes and branch lists are cached and
  refreshed only when `refs/` or `config` changes. Results go out as `project`
  frames on `/v1/live`: `{id, branch, ahead, behind, changed, worktrees[],
  waiting}`.
- **From the phone.** A controller phone may add, create and clone a project
  under home, and create a worktree; this extends ADR-034's allowlist by name,
  in an amendment landed with the work package. A clone URL must be `https://`
  or `git@host:path`; nothing else runs.

## Shell tabs

- `POST /v1/shells` with `{"project_id"|"cwd", "cols", "rows"}` starts the
  user's login shell (`$SHELL -l` on POSIX; PowerShell 7, else Windows
  PowerShell, else `cmd.exe` on Windows, configurable) under a pty-host. The
  terminal socket and protocol are the agent session's.
- The row is a session of kind `shell` with `internal = 1`, so it is excluded
  from Now, cost, Lifetime and every total, as Codex's review sessions are.
- Rule 7 holds: Caprock started the shell. A shell from a controller phone is
  P1 and needs its own ADR-034 amendment.

## Notifications

- **One source.** `internal/alerts` already decides when the phone hears about
  a session (ADR-036). It gains a second sender: a neutral `notify` frame on
  `/v1/live`, `{id, seq, kind, session_id, project, title, body, prompt_id?,
  actions?}`, with `kind` one of `approval`, `finished`, `loop`, `limit`,
  `error`. Telegram and the app read the same decision; the rules, cooldowns
  and hourly cap are the same.
- **Actions.** For an approval on an owned Claude Code session, `actions` are
  the prompt's buttons. The app shows them as OS notification actions and
  answers through `POST /v1/agents/{id}/permission` with the `prompt_id`, so an
  answer to a prompt that has since changed is refused, as a stale button is
  today.
- **Per OS.** macOS: actionable notifications. Windows: toast buttons. Linux:
  actions where the notification server supports them, else a click that
  opens the session. Where an OS has no actions, the notification opens the
  session with the prompt card in view.
- **Quiet when watched.** No OS notification for the session in the focused
  tab of a focused window.

## The scrolling rule

Every scrolling surface — terminal scrollback, the timeline, the chat view,
Now — obeys one rule: **the content never moves under someone reading it.**

- **Follow only at the bottom.** A view follows new output only while it is
  within 4 px of the bottom. Scrolled up, it stays exactly where it is.
- **Anchor preserved.** Content inserted above (older pages) or growing below
  never shifts the first visible line: record its id and offset before the
  change and restore after, with `overflow-anchor` where the browser supports
  it.
- **A pill, not a jump.** Scrolled up while output arrives, a "↓ N new" pill
  appears; tapping it jumps to the bottom and resumes following.
- **Streaming is cheap.** Token streams are batched to one update per animation
  frame and appended to one node; finished messages are frozen; off-screen
  messages use `content-visibility: auto`. No layout work in a gesture
  handler.
- **Acceptance.** 200 messages streamed while scrolled up leave the scroll
  position unchanged within ±1 px, on desktop and on a phone at 390 px; loading
  an older page leaves the first visible message within ±1 px; at the bottom,
  the view follows with no frame over 50 ms.

## Phone v2

### Phase A — resilience and starting work (P0)

The phone stays the web dashboard on the home screen. What changes is that the
connection and the work survive a bad network.

- **Terminal resume** over protocol v2, with exactly-once input.
- **Reconnect forever.** Exponential backoff with full jitter, from 0.5 s to a
  15 s cap, never giving up; an immediate attempt on `visibilitychange`,
  `online` and network type change; the ping and 25-second dead deadline of
  protocol v2 on `/v1/live` as well.
- **Honest state.** "Live", "catching up", "reconnecting (n)", "offline since
  …" — never "connected" without a round trip in the last 25 seconds.
- **Live replay.** Every `/v1/live` frame carries a `seq`. The daemon keeps a
  ring of the last 2,000 frames or 10 minutes; a client reconnects with
  `?since=<seq>` and gets the gap, or a `reset` frame and refetches its views.
  Notifications are in that ring, so a phone that was offline sees what it
  missed.
- **Offline queue.** A message sent from the keys bar while offline is held,
  shown as "will send", and sent on reconnect — only if the session is still
  live and no permission prompt is pending; otherwise it stays as a draft with
  **Send now**. Raw keys and permission answers are never queued.
- **Chat view.** The conversation as messages (what the agent wrote, tool
  calls collapsed to one line, prompts), built from the events Caprock already
  stores, with the scrolling rule; the input box types into the session.
- **Start work.** New project, clone and worktree from the phone (see
  [§ Projects](#projects)), then a session in it, with the clone's progress
  surviving a drop.
- **Tailscale by QR.** The pairing panel shows the Tailscale address
  (MagicDNS name or `100.x`) as a QR beside the LAN one when Tailscale is up.

### Phase B — off the owner's network (P1, owner decides)

Today a phone reaches the daemon only on the same Wi-Fi or over Tailscale
(ADR-029, ADR-034), and both ADRs rule out a relay of ours. Phase B decides
whether that stays. The options:

- **Tailscale, documented and detected** (status quo). Zero infrastructure,
  end-to-end encrypted, survives network changes; costs the user an install.
- **The user's own tunnel** (cloudflared, ngrok, SSH). Works since the
  ADR-011 amendment of 2026-10-05: a relayed request is a device, token and
  role included. Costs a setup guide and a QR for the tunnel's URL.
- **WebRTC peer-to-peer** with a signalling service and TURN fallback. Fewer
  hops, but a service of ours for signalling, and TURN is a relay anyway.
- **A Caprock relay, end-to-end encrypted and multi-region.** The phone and
  daemon each dial out; the relay splices ciphertext (X25519 key agreement,
  device keys verified by the daemon, never by the relay); no database or
  auth service in the data path; at least three regions; stateless cells.
  Contradicts "no relay of ours" in ADR-029 and ADR-034 and the site's
  local-first copy, so it needs a new ADR and copy changes.

Whatever is chosen, the client **tries every known path at once** (LAN,
Tailscale, relay if any) and keeps the first that answers, rather than trying
them in turn; it keeps probing for a better path while connected. The lessons
from the reference app's relay are recorded in the private competitive
analysis: a single-region relay, a database in the data path, credential
leases expiring in waves, and a LAN probe serialised before the fallback.

## GitHub

The reference app shells out to `gh` and hides its errors; its issue tracker
records integrations that show green while listing nothing. Caprock's
proposal, pending the owner's choice of auth method:

- **The daemon calls the GitHub API directly**, with the user's token from an
  OAuth device flow (a Caprock OAuth app: no client secret on the machine, the
  user approves on github.com) or a pasted fine-grained token. Importing an
  existing `gh auth token` once is offered as a shortcut, not depended on.
- **The token is stored write-only** in the data directory, `0600`, like the
  Telegram bot token ([ADR-025](08-decisions.md#adr-025--keys-go-in-the-interface-stored-write-only-because-a-key-nobody-can-enter-is-a-feature-nobody-uses));
  the OS keychain is a P2 option (pure Go on all three OS, no CGO).
- **Opt-in and revocable** — an outbound call the user switched on (rule 4).
- **Conditional requests** (`ETag`, `If-None-Match`) and the rate-limit headers
  respected; polling backs off when nothing changes.
- **Every error shown** with what was attempted; a health line (last success,
  last error, scopes) in Settings.

## Security model

- **Owner by origin, as today.** The WebView loads the dashboard from
  `127.0.0.1`, so it is the machine's own client under ADR-011. A request a
  proxy or tunnel relays onto loopback is a device (fixed in v0.73.1, #204).
- **The page gets no OS powers beyond the allowlist.** Tauri capabilities
  grant the command list in [§ Architecture](#architecture) to the daemon's
  exact origin and nothing else; no remote origin, no shell plugin, no
  filesystem plugin. A strict CSP; no remote scripts.
- **The sidecar runs one binary** — the bundled `caprock`, with fixed
  arguments.
- **Tokens never in URLs.** The device token stays a header or WebSocket
  subprotocol (ADR-029). Terminal `since` and live `since` carry positions,
  never secrets.
- **Phones** keep the viewer/controller roles and allowlist (ADR-034); new
  phone capabilities are added to the allowlist by name.
- **Updates** (F20) are verified against the app's update signing key before
  install, independent of OS code signing.
- **A relay, if ever,** carries ciphertext only.

## Distribution and signing

- **macOS.** Universal `.dmg` and a Homebrew cask in `dspv/homebrew-tap`.
  Signed with a Developer ID and notarized once the owner has an Apple
  Developer account ($99 a year); until then, ad-hoc signed, and the install
  page says how to open an app from an unidentified developer.
- **Windows.** NSIS or MSI installer from Tauri's bundler, Scoop
  (`dspv/scoop-bucket`) and winget. Without a code-signing certificate,
  SmartScreen warns on first run; which certificate or signing service to buy
  is an open decision. WebView2 is installed by the bootstrapper when missing.
- **Linux.** AppImage, `.deb` and `.rpm`; WebKitGTK 4.1 is a package
  dependency of the `.deb` and `.rpm`.
- **Releases** come from the same tag as the daemon (goreleaser for the
  binaries, Tauri's bundler for the app) and carry the daemon they were built
  with.

## Telemetry

None. No analytics, no crash upload, no usage pings. A crash or a stall the
app detects (a UI long task over 1 second, a WebView reload) is written to a
local log, and Settings has **Copy diagnostics**, which the user may send
themselves. The update check is the release check that exists, off until the
user turns it on.

## Risks and mitigations

- **xterm.js in WebKit is slower than in Chrome.** WKWebView and WebKitGTK
  differ from the Chrome the web numbers were measured in. *Mitigation:* the
  Tauri spike measures all three OS before WP-03 starts; the budgets above are
  the gate; F23 is the fallback.
- **WebKitGTK on Linux** has a history of WebGL and performance gaps.
  *Mitigation:* the DOM or canvas renderer on Linux if WebGL fails the budget;
  Linux measured in CI on every release.
- **Shortcuts swallowed by the WebView** (Cmd+W, Cmd+Q, Ctrl+Tab).
  *Mitigation:* the keyboard map is defined in the shell's menu, tested per OS.
- **IME and dead keys** in xterm.js inside WKWebView and WebView2.
  *Mitigation:* a test matrix for Japanese, Chinese and accented input.
- **GPU context loss on sleep and wake** (the reference app logged 89 atlas
  resets). *Mitigation:* re-create the WebGL addon on context loss and on wake;
  a 10-cycle sleep test in the DoD.
- **Notification actions differ per OS.** *Mitigation:* the fallback is a
  click that opens the prompt; the feature is defined by that floor.
- **Two daemons, or version skew** between the bundled binary and a Homebrew
  one. *Mitigation:* the running daemon wins; api_level gates features; one
  data directory.
- **Rust creep.** *Mitigation:* the line budget and principle 1; review
  rejects logic that belongs in Go.
- **Unsigned installs deter people.** *Mitigation:* the decisions on the
  Apple account and Windows signing; clear install pages meanwhile.
- **Tauri mobile is young.** *Mitigation:* the phone stays web through P1;
  F22 starts only with measurements.
- **A relay would break the local-first promise** as written. *Mitigation:*
  it is an owner decision with its own ADR, not a work package.
- **Speed to market against well-funded apps.** *Mitigation:* the MVP reuses
  every screen that exists; the plan is about seven weeks, with the phone
  track in parallel ([22-app-plan.md](22-app-plan.md)).

## Decisions (owner, 2026-10-05)

The owner said to go ahead with the proposals ("build it to the end"). Taken:

1. **Phone off the home network:** Tailscale for the MVP, with Phase A
   resilience (resume, replay, endless reconnect). A Caprock relay stays a
   later decision with its own ADR (would override the relay clauses of
   ADR-029 and ADR-034). F19 waits for it.
2. **Apple Developer Program:** not yet. The macOS build ships unsigned
   (ad-hoc) with the "Open Anyway" note; signing and notarization when the
   account exists.
3. **Windows code signing:** not yet; unsigned with a SmartScreen note.
4. **GitHub auth:** OAuth device flow with a Caprock OAuth app. Errors are
   always shown, never swallowed.
5. **Minimum OS versions:** macOS 13, Windows 10 22H2, WebKitGTK 4.1
   distributions.
6. **Name and bundle id:** "Caprock", `dev.caprock.app`.
7. **Background service:** installed on first run, with a visible switch.
8. **Phone:** clone and worktrees in P0; shell tabs in P1.
9. **How the app gets its UI:** from the daemon's own URL (as in the Tauri
   spike), so the UI ships with the daemon and no new origin is admitted.
10. **Focus:** macOS first for polish and release; Windows and Linux stay
    green in CI and follow.
