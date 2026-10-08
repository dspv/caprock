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

**Status (2026-10-05): built so far:** the shell in `app/` (WP-01, WP-02:
window, fallback page, per-origin commands, daemon supervisor, `api_level`;
behaviour in [`app/README.md`](../app/README.md)), the engine side of
projects, shell tabs and worktrees (WP-05, WP-07, WP-08 API; contract in
[03-contracts.md § Projects and shells](03-contracts.md#projects-and-shells-desktop-app-wp-05-wp-07-wp-08)),
terminal protocol v2 (WP-03), and the app workspace (WP-04 layout and tabs,
WP-06 sidebar, WP-11 scrolling rule) that uses them at `#/app`
([04-ui.md § The app workspace](04-ui.md#the-app-workspace)), falling back to
sessions-derived projects on an older daemon. Packaging (WP-17): a universal
`.dmg` and the `caprock-app` cask, NSIS, AppImage, `.deb` and `.rpm` from the
release tag ([docs/RELEASING.md § The desktop app](../docs/RELEASING.md#the-desktop-app),
[docs/install-app.md](../docs/install-app.md)).
Since (2026-10-06): notifications with Approve and Deny on macOS (WP-09), menu
bar, badge and global hotkey (WP-10), live replay (WP-12), the phone's
reconnect and offline queue (WP-13), the chat view (WP-14), start work and
Tailscale pairing (WP-15), and the repo side of the docs (WP-18: README,
[docs/app.md](../docs/app.md)); the site's download page is in the private
site repo.
Also 2026-10-06: a worktree's Changes view — review, stage, discard,
commit, push and pull without a terminal, in the app and on the phone — the
git half of F14 that WP-19's pull requests build on
([03-contracts.md § Changes](03-contracts.md#changes-a-worktrees-status-diff-commit-and-push)).
Then (2026-10-06): GitHub connect, clone picker, create repository, pull
requests from a worktree with checks and reviews (WP-19, ADR-039); split
panes, ⌘J, the palette's new-task entry and the macOS menu bar popover;
find in scrollback, open in editor, terminal themes and fonts and the update
notice (F16, F18, F21, F12); and the benchmark harness with its first results
and two perf fixes (WP-16, § Budgets). Released as 0.78.0. Then (2026-10-06):
WP-21, one-click signed app updates (F20, ADR-042, § Updates).

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

- **Sidebar (left).** A primary *New agent* button (accent, full width,
  ⇧⌘N) with *Add project* (⌘O) under it — the app's main action, not a
  hover icon (owner, 2026-10-08: "no big button to create something new",
  translated). Then projects, each expandable to worktrees and branches,
  then to the sessions and shells in it. Badges: *waiting on you*, *looping*,
  cost today. A **Dashboard** entry opens the existing screens.
- **Keeping the project list short** (owner, 2026-10-08: "a ton of stuff
  hanging in it and it's unclear how to hide things", translated). Projects
  with no live session and no activity for 7 days (`QUIET_MS`, from the
  model's `lastActive`: last session event, `last_activity`, `added_at`)
  fold under *Quiet · N* at the bottom; a project hidden by hand from its
  row's hover action goes under *Hidden · N*, where the same action shows it
  again. `groupProjects` in `ui/src/lib/sidebar.ts` decides: a live or
  waiting session, a session open in a tab, being the project in front, or
  *Other folders* always keeps a row in the list; pinned never goes quiet.
  Hidden ids live in the page's storage (`caprock.app.hidden-projects`),
  not the daemon: the projects API has no hide flag, and unlisting
  (`DELETE /v1/projects/{id}`) takes the project out of every list, phone
  and palette included, which is not what hiding means. Which folds are open is
  `caprock.app.project-folds`; both start closed.
- **Tabs (main).** Terminal tabs — an agent session or a shell — with the
  project and branch in the title. The permission prompt card
  ([ADR-035](08-decisions.md#adr-035--a-permission-prompt-is-answered-with-a-button-found-by-its-hook))
  is drawn for the focused agent whether or not its terminal is in front
  (owner, 2026-10-07, reversing 2026-10-06): it names the call in full, and
  its keys work from that terminal — `Y`, `A` (the "don't ask again" option)
  and `N` answer the card and never reach the terminal, which shows a menu,
  not a prompt, while the question waits. Enter and Esc there stay with
  Claude Code's own menu, where they mean the same Yes and No; with focus
  off the terminal they press the card's buttons ([04-ui.md](04-ui.md),
  permission prompt buttons). It never takes focus. Whichever surface answers — card, notification, phone — the
  daemon reads the menu on the session's screen first and types nothing when
  the option is not on it. Sessions in other tabs or behind the
  window are reached through their badge, the Inbox, the menu bar popover,
  the notification and the phone, which keep their buttons.
- **Agent cockpit (right).** The inspector, open by default (⌘I closes it,
  and closed is remembered per machine), becomes the agent cockpit beside an
  agent's terminal: the agent's character in its state (working, waiting on
  you, looping, idle, ended), what the session has cost with the cost of each
  of its last model calls, the context bar and what the next call pays to
  re-read it, what it is doing this second (the open tool call and how long
  it has run, or *Thinking* since the last one finished; while a permission
  prompt waits, who asks and what — "Subagent (general-purpose) wants to run
  Bash" over the command's first real step, the full text on hover, or "2
  approvals waiting"), a *Subagents · N* section while any works (one row
  each, five at most: its type and the task the parent gave it, its current
  call with how long it has run, how many calls it has made, *waiting on you*
  while it has a prompt outstanding; "3 finished" for those that stopped in
  the last 30 minutes), its last seven tool calls with their durations, the
  uncommitted changes, the plan windows of its agent, and a loop warning only
  while an alert is live. It is the screen that shows what only Caprock
  knows, so it is built from figures Caprock already holds and nothing else:
  the session row the sidebar polls, the main thread's newest 400 calls and
  turns (`events?newest=1&main=1&kind=tool.pre,tool.post,turn.assistant`;
  an unfiltered 400 held none of a busy parent's own calls, whose subagents
  logged 635 tool calls in an hour, and the list read *No tool calls yet*),
  fetched once and then followed on the live socket; the daemon's summary of
  the subagents (`/v1/sessions/{id}/subagents`), read again at most every two
  seconds while their events arrive and every twenty regardless, so their
  thousands of events never reach the page; the session's permission prompt;
  and the day's summary for the plan windows, which are account-wide and
  labelled so. A figure an agent does not report is left
  out, never drawn as zero — no context bar without `context` (its
  `context_note` instead), no plan windows for an agent with none. A shell
  tab keeps the plain inspector (folder, changes, actions). Code:
  `components/Cockpit.tsx`, derivations in `lib/cockpit.ts`.
- **Empty project (main, no tab open).** New agent, New shell, Add a
  project, then the project's six most recent agent sessions (ended ones
  nobody wrote in left out) with cost, age and one button: *Continue* resumes
  an ended one in a new tab, *Open* a running one. The sidebar is for what
  runs; this is the way back to what ended.
- **Status strip (bottom).** Connection state, plan limits (5-hour and 7-day),
  today's spend, the daemon's state and version — read again on every
  reconnect of the live link and on window focus, since the app can swap its
  daemon under a page that stays loaded.

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
  Homebrew or Scoop install, or the service) is used as is — except on
  macOS, where a Homebrew formula's daemon is moved onto the app's own once
  (ADR-040). If none runs, the app starts the `caprock` binary it bundles,
  detached, so sessions keep running when the window closes. If the daemon's `api_level` is below the
  app's minimum, the window says which command upgrades it (the app updates
  itself and its own daemon, F20, but never a daemon a package manager owns). If the daemon stops, the window shows a banner within 2
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
  and the sessions waiting on you, each a click from its session. On macOS a
  left click opens a popover with the same figures plus the running sessions
  and Approve/Deny ([app/README.md](../app/README.md) § Menu bar popover); a
  right click keeps the menu.
- **F09 — Global hotkey and keyboard map.** One configurable hotkey shows or
  hides the window from anywhere. New tab, close tab, next/previous tab, tab
  1–9, new session, new shell, dashboard, find.
- **F10 — Badge.** The dock (macOS) or taskbar (Windows) badge is the number
  of sessions waiting on you — the sidebar's inbox: a permission prompt or
  your turn (`waitingOnYou`, `ui/src/lib/tray.ts`); Linux shows it where the
  desktop supports it. Until 2026-10-07 it counted prompts only, so a
  session done and waiting left the dock bare. The macOS menu bar title is
  the same count in words (*2 waiting*), plus a plan window named once it
  is 80% full; a bare 5-hour percentage read as nothing, and a bare count
  no better.
- **F11 — The scrolling rule** in every scrolling surface: terminal
  scrollback, the timeline, the chat view, Now
  ([§ The scrolling rule](#the-scrolling-rule)).
- **F12 — Install paths and update notice.** A `.dmg` and a Homebrew cask on
  macOS, an installer plus Scoop (and winget once accepted) on Windows, an
  AppImage plus `.deb` and `.rpm` on Linux. When a newer release exists and
  the release check is on, the app says so and links the download; since F20
  an install that can replace itself offers the update as one click instead.
  The notice was built on 2026-10-06: the status
  strip names the release and the command for each part Homebrew installed
  (the `caprock-app` cask, the `caprock` formula), dismissed per version; the
  check runs at most every 6 hours, conditionally
  ([04-ui.md § Update notice](04-ui.md#update-notice)).
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
  Built ahead of P1 on 2026-10-06, up to four per tab
  ([04-ui.md](04-ui.md#the-app-workspace)).
- **F16 — Search in scrollback** of the focused terminal. Built ahead of P1
  on 2026-10-06 on `@xterm/addon-search`: ⌘F, next/previous, count, case and
  regex ([04-ui.md](04-ui.md#the-app-workspace)).
- **F17 — Command palette** over projects, sessions, tabs and actions.
  Built with the workspace; ranking, the waiting group and "new agent on
  this text" added 2026-10-06.
- **F18 — Open in editor.** The project or worktree in VS Code, Cursor, Zed or
  the system default. Built ahead of P1 on 2026-10-06, daemon-side
  (`internal/editor`, local requests only): VS Code, Cursor, Zed and the
  JetBrains IDEs on macOS and Linux, a file at a line from the inspector; no
  "system default" (a folder's default app is Finder) and no Windows yet
  ([03-contracts.md](03-contracts.md)).
- **F19 — Phone v2 Phase B.** Reaching the machine when the phone is off its
  network, by the route the owner chooses ([§ Phone v2](#phone-v2)).
- **F20 — Opt-in auto-update** with signed update bundles, per OS. Built
  2026-10-06 (WP-21, [ADR-042](08-decisions.md#adr-042--the-app-updates-itself-in-one-click-a-minisign-signed-bundle-one-channel-checked-only-when-the-release-check-is-on-or-the-user-asks)):
  **Update to vX.Y.Z — Restart** in the status strip, [§ Updates](#updates).
- **F21 — Themes and fonts** for the terminal; the palette work references
  Otty's colours (owner, 2026-10-04) without copying its branding. Built
  ahead of P1 on 2026-10-06: five palettes (two ours, three MIT-licensed),
  installed monospace faces, size, line height, cursor, live in every pane
  ([04-ui.md § Settings](04-ui.md#settings)).

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

Budgets are targets the release must meet on all three OS, measured with
`bench/` (WP-16), which grew from the benchmark the macOS spike introduced
(`bench/` on branch `spike/macos-app`, PR #180): an isolated daemon, the fake `claude` streaming at 0, 200 and 1000
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

The scaffold (WP-01/WP-02, 2026-10-05, same Mac): launch to the dashboard's
`load` event with a running daemon, 0.44–0.59 s over five runs (1.48 s on the
first launch after a rebuild, Gatekeeper's scan); a 4.3 MB app binary and a
19.2 MB `.app` with the 15.7 MB daemon inside.

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

Measured with `bench/` (WP-16, [bench/README.md](../bench/README.md)) on
2026-10-06: Apple M1 Pro, 16 GB, macOS 27.0.1, one 1920×1080 display at
100 Hz, three runs of `bench/run-macos.sh` at master `440c599` plus this
package's fixes; raw JSON and the per-run table in
`bench/results-2026-10-06-fixes/` (before the fixes:
`bench/results-2026-10-06/`). Other agents were working on the machine: the
1-minute load average before each phase was 2.3–6.8 (10 cores). A result is
"pass" only when every run met the budget. Windows and Linux are scripted
(`run-windows.ps1`, `run-linux.sh`) and not yet run.

Memory is the physical footprint summed over the app's processes (what
Activity Monitor shows as "Memory"), not summed resident memory: RSS counts
the WebKit and AppKit pages every process shares once per process (the app
binary alone is 93–99 MB RSS against 30 MB footprint). RSS is kept in its own
column for transparency.

| Metric                                     | Budget             | macOS, 3 runs                  | Before fixes         | Result            |
| ------------------------------------------ | ------------------ | ------------------------------ | -------------------- | ----------------- |
| Echo p50, any load to 1000 lines/s         | ≤ 12 ms            | 12 / 12 / 13 ms                | 13 / 11 / 15 ms      | mixed (see below) |
| Echo p95, any load to 1000 lines/s         | ≤ 25 ms            | 19 / 19 / 19 ms                | 25 / 19 / 27 ms      | pass              |
| Echo p95 in tab A while tab B floods       | ≤ 25 ms            | 16 / 17 / 19 ms                | 17 / 18 / 17 ms      | pass              |
| Open a session, click to first echo, p50   | ≤ 200 ms           | 113 / 112 / 114 ms             | 114 / 113 / 115 ms   | pass              |
| Switch to an open tab, to first paint      | ≤ 50 ms            | 38 / 38 / 38 ms (p50)          | 39 / 38 / 40 ms      | pass              |
| Cold start to interactive window           | ≤ 1.5 s            | 1.07 / 1.09 / 1.38 s (p50)     | 1.09 / 1.07 / 1.12 s | pass              |
| Cold start to first echo in a restored tab | ≤ 2.5 s            | 1.46 / 1.50 / 1.48 s (p50)     | 1.41 / 1.43 / 1.43 s | pass              |
| Memory, 1 tab, footprint                   | ≤ 250 MB           | 179 / 180 / 184 MB             | 197–199 MB           | pass              |
| Memory, 10 tabs, footprint                 | ≤ 450 MB           | 290 / 289 / 284 MB             | 303–315 MB           | pass              |
| Memory, 1 / 10 tabs, RSS (no budget)       | –                  | 308–333 / 348–382 MB           | 288–347 / 255–409 MB | –                 |
| CPU, window visible, no output             | ≤ 1% of one core   | 0.85 / 0.79 / 0.70 %           | 1.1 / 0.93 / 0.95 %  | pass              |
| CPU, window hidden                         | ≤ 0.2% of one core | 0.30 / 0.34 / 0.31 %           | 1.0 / 0.96 / 1.3 %   | **fail**          |
| CPU, one visible tab at 1000 lines/s       | ≤ 25% of one core  | 17.7 / 18.2 / 18.3 %           | 17.7 / 17.5 / 18.4 % | pass              |
| UI long task during the benchmark          | none over 100 ms   | 134 / 122 / 69 ms longest      | 154 / 71 / 146 ms    | **fail** (2 of 3) |
| Daemon restart to live terminal            | ≤ 2 s              | 429 / 455 / 431 ms             | 476 / 413 / 452 ms   | pass              |
| Network back to live terminal (phone)      | ≤ 3 s median       | 59 / 64 / 64 ms                | 60 / 59 / 58 ms      | pass              |
| Half-open connection detected              | ≤ 25 s             | 21.9–23.1 s                    | 24.4–25.0 s          | pass              |
| Disk written by the app, per day           | ≤ 10 MB            | 0 MB idle; 1.3–1.7 MB at start | 0 MB; 1.3 MB         | pass              |
| Download size, per OS                      | ≤ 60 MB            | 17.4 MB (universal .dmg)       | same                 | pass (macOS)      |

Fixed in this package:

- **CPU.** While the window is hidden the shell's supervisor asks the daemon
  every 5 s (was twice a second), and only its health between full checks
  every 10 s; the page stops its API polling and clocks
  (`ui/src/lib/visible.ts`) and keeps the live socket. Visible and silent,
  the tray summary polls every 30 s (was 5 s), the connection title redraws
  every 5 s while live, and an unchanged shells list no longer re-renders.
- **First-tab stall.** An off-screen terminal is built once 300 ms after
  start (`termwarm.ts`), and output goes to xterm in 16 KB slices
  (`termwrite.ts`); in-page probes show tasks of 16–48 ms where a whole
  386 KB replay took one.
- **Half-open:** after 20 s of silence the page pings and redials if no
  answer comes in 2 s, so detection is about 22 s against the 25 s budget
  (was 24–25 s, no margin).

What still fails or is close, and what to try next:

- **CPU, hidden:** 0.30–0.34% against 0.2%, about a third of before. It is
  spread thin: the page 0.1%, WebKit's network process 0.07–0.1% (the live
  socket's pings in the main and popover webviews), the shell 0.07% and the
  GPU process 0.03–0.07%. The benchmark build adds a 1 s file watch the
  release build has not. Next: let the hidden page's live socket ping less
  often (or let the shell own the hidden-state notifications), and measure
  the release build's hidden CPU with an external sampler.
- **Long task:** 69–134 ms, only in the second after the first tab of a
  launch opens; every later open stays under 50 ms. Warming and slicing took
  it from 71–154 ms to this, not under 100 ms in every run. What remains is
  the React commit of the workspace's terminal view on a cold page. Next:
  mount the terminal pane's shell during the warm-up too, or split the
  first commit from the xterm creation.
- **Echo p50** is 12 ms in two runs and 13 ms in the third (load 5.6–6.8);
  p95 is 19 ms in every run. The socket leg is 2 ms; the rest is the page's
  frame. No fix proposed until a quiet run misses.

The phone's chat view opens in 46–47 ms p50 at a 10 ms round trip and
147–162 ms at 120 ms (no budget row). The reference-app runs against Orca
1.4.220 (its Info.plist) are scripted (`bench/reference-orca.mjs`) and not
run: Orca held the owner's live sessions; the script refuses unless he allows
it and Orca is quit.

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
  daemon's origin only: `notify`, `set_badge`, `set_tray`, `register_hotkey`
  (with `hotkey_status`; built in WP-10, app/README.md),
  `open_external` (https and the editors' schemes only), `daemon_status`, and
  the updater's `app_update_status`, `app_update_check`,
  `app_update_install` and `app_update_asked` (F20). No
  shell, filesystem or HTTP plugin is exposed to the page. The bundled
  fallback page, on the app's own origin, alone gets `start_daemon`,
  `update_daemon` and `set_background` (built in WP-02; the others arrive
  with their work packages).
- **The daemon supervisor** reads `runtime.json`, starts the bundled binary
  when no daemon answers, and never stops a daemon it did not start — save
  one case on macOS: a Homebrew formula's daemon, moved onto the app's own
  once when that is not older (ADR-040). On macOS it also replaces its own
  daemon once per launch when the bundle carries a different one (ADR-040,
  amended), so the daemon follows the app up, down and to a local build.
  A launch decides that replacement before the window loads anything, and
  the window waits on the fallback page ("Updating the daemon") until the
  new daemon answers (§ Updating the daemon).
  Quitting
  the app leaves the daemon and every session running. It runs its copy from
  `<data_dir>/bin/caprock`, never from inside the app bundle: an unsigned app
  can run translocated from a read-only path, and a login service must
  survive the app moving. The first-run choice is kept in
  `<data_dir>/app.json` ([03-contracts.md § Runtime file](03-contracts.md#runtime-file)).
- **api_level.** `GET /v1/status` and `runtime.json` gain `api_level`, an
  integer raised by every change a client must know about. The app declares
  the minimum it needs. A daemon below it is shown as "needs an upgrade" with
  the command. The phone reads the same field. This matters once the UI is
  bundled anywhere (F22).

## Updating the daemon

The UI is served by the daemon, so a page is exactly as new as the daemon
that served it. When the daemon changes under a page that stays loaded, the
page must follow it: a page never runs a UI older (or newer) than the daemon
it talks to. The 0.78.2 bug that set this rule (owner's `service.log`,
2026-10-07): after `brew upgrade --cask`, the app launched while its 0.78.1
daemon still listened, loaded the window from it, then replaced the daemon
with the bundled 0.78.2 two seconds later and never reloaded. The owner ran
0.78.1's UI, and the status strip said 0.78.1, until he quit the app; the
app had no reload command.

- **The shell decides first, then loads.** On macOS the launch's first look
  at the daemon also decides whether the app replaces it (ADR-040); when it
  does, the window starts on the fallback page ("Updating the daemon") and
  the monitor takes it to the dashboard once the new daemon answers. No page
  is ever loaded from the daemon that is about to stop.
- **A late swap reloads.** A daemon that came up after launch is replaced
  when the window may already show its page: the monitor follows the swap's
  state rather than the old daemon, and once the new one answers on the same
  port it reloads the main window and the popover (the URL, hash route
  included, is kept). On another port the page moves there on the same
  route.
- **Every page checks for itself.** The daemon writes its version into the
  page it serves (`<meta name="caprock-version">`, `internal/api/ui.go`), and
  every time the live link opens again the page asks `/v1/status` which
  daemon answers (`ui/src/lib/staleui.ts`). This covers what the shell does
  not see: a browser tab or a phone across `brew upgrade`, a login service
  restarted on Linux or Windows. A different version reloads the page, once.
- **Reload, or offer.** A reload loses nothing typed into a terminal — that
  lives in the pty-host — so it is the default. It would lose text typed into
  an open modal sheet (`[role=dialog]` holding a non-empty field), and then
  the page shows *Reload — Caprock was updated* in the status strip (the
  dashboard's header in a browser) instead. A page reloaded once for a
  version that still reads stale offers rather than reloading again: it
  never loops.
- **Reload by hand.** View → Reload (⌘R) in the macOS menu. Windows and Linux
  have no menu; F5 reloads there, unless a focused terminal took the key for
  its program. Ctrl+R is not used: it is the shell's history search.

## Terminal protocol v2

The terminal socket today replays a snapshot on every connect and carries no
positions, so a reconnect repaints the screen and a keystroke sent into a dying
socket is either lost or, on retry, typed twice. Version 2 makes every byte and
every keystroke addressable. Version 1 stays served for older clients.
Built in WP-03 (2026-10-05); the wire contract is in
[03-contracts.md § Terminal socket, protocol v2](03-contracts.md#terminal-socket-protocol-v2),
and the points below say where the build settled what this plan left open.

- **Negotiation.** `WS /v1/agents/{id}/term` with subprotocol `caprock.term.v2`
  (alongside the device-token subprotocol where one is sent). Without it, v1.
- **Byte offsets.** `internal/termbuf` counts every byte the session ever
  output (a `uint64`), and the ring knows the offset of its oldest byte. The
  pty-host reports the current offset in its `W` (welcome) frame and the ring's
  start offset with `S`, as new JSON fields (additive, ADR-033's rule).
- **Resume.** The client connects with `?since=<offset>`. The first frame is
  `{"hello":{"v":2,"offset":N,"reset":bool,"ack":S}}`. If the ring still
  holds that byte, `reset` is false and the server sends exactly the bytes
  after it. If not, `reset` is true and the snapshot (mode prefix plus ring)
  follows, and the client clears and repaints; a client that falls behind
  the ring mid-stream gets `{"reset":{"offset":N}}` and a snapshot. A fresh
  client sends no `since` and gets the snapshot.
- **Output frames.** Server-to-client binary frames start with the 8-byte
  big-endian offset of their first byte. The client keeps `offset + length` as
  its position and ignores any byte it already has.
- **Input, exactly once.** Client-to-server binary frames start with a 4-byte
  big-endian sequence number from a per-tab client id, which travels as
  `?client=` (the server's hello answers with the last sequence it applied
  for it). The pty-host keeps the highest sequence applied per client id for
  120 s after the client was last heard from (a new frame type, `J`,
  carrying client id, sequence and bytes, answered by `K`; additive) and
  drops anything at or below it, so a retry after a reconnect, or after a
  daemon restart, is never typed twice. The server acknowledges with
  `{"ack":N}` within 100 ms; the client resends everything unacknowledged
  after a reconnect, and keeps at most 4 KiB typed while offline.
- **Liveness.** Both sides send `{"ping":t}` every 10 seconds and answer
  `{"pong":t}`. Nothing received for 25 seconds means the socket is dead: the
  client closes it and reconnects, and shows "reconnecting" meanwhile.
- **Backpressure.** The pty-host never stops reading its PTY; the ring
  overwrites. The daemon keeps no queue per client socket: each socket reads
  the session's ring from its own position, so the output never waits for a
  client, and one that falls behind the ring gets a `reset` at the current
  offset — a slow client costs itself a repaint and costs no other client
  anything. A browser cannot stop reading a WebSocket, so the client closes
  it while more than 1 MiB is waiting for xterm.js to parse, and reconnects
  with `since` below 256 KiB (xterm.js's write callbacks).
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
- **API.** `GET /v1/projects`; `POST /v1/projects` with `{"path"}`,
  `{"create": {parent, name, git_init}}` or `{"clone": {url, parent}, "op_id"}`;
  `PATCH /v1/projects/{id}` (name, pinned, sort, defaults);
  `DELETE /v1/projects/{id}` (unlists; never touches files);
  `GET /v1/projects/{id}/worktrees`;
  `POST /v1/projects/{id}/worktrees` with `{"branch", "create"?, "base"?}`;
  `DELETE /v1/projects/{id}/worktrees/{name}` (only a clean worktree Caprock
  created; anything else is refused with the reason). As built, a project
  also records how it came to the list (`source`) and its start-form
  `defaults`; `GET /v1/projects/{id}/branches` is not built yet.
- **Long operations** (clone) take a client-generated `op_id`, are
  idempotent on it, and report progress as `op` frames on `/v1/live`
  (`{op_id, state, progress, error}`), so a phone that drops mid-clone sees the
  result when it returns instead of starting a second clone; `GET
  /v1/projects/ops` lists them for a client that missed the frames. Creating
  or removing a worktree is quick and answers in the request.
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
- A shell is kind `shell` and `internal` in the API, and as built it writes
  **no session row at all**: it is excluded from Now, cost, Lifetime and every
  total because there is nothing for a query to count, rather than because
  every query remembers a filter (the reasoning of ADR-037). Its pty-host
  registry entry (`meta.kind = "shell"`) is what brings it back after a
  restart.
- Rule 7 holds: Caprock started the shell. A shell from a controller phone is
  P1 and needs its own ADR-034 amendment.

## Dropping a file

A file dragged from Finder, Explorer or a file manager onto a terminal in the
app types the file's **real path**, quoted, at the prompt — what a terminal
does. In a browser tab the same drop still uploads the bytes to
`POST /v1/paste` and types the path of the copy, because a browser never
tells a page where a file lives.

- **How.** Tauri's native drag-and-drop handler stays on (its default) in
  the main window. `shell.rs` hears `WindowEvent::DragDrop(Drop)` with the
  paths and the point, and dispatches `caprock:drop-paths` into the page
  (`{paths, x, y}` in CSS pixels; wry reports device pixels on Windows only,
  so only Windows is divided by the scale factor; a non-UTF-8 path is left
  out). Every terminal listens (`ui/src/lib/xtermInput.ts`); the one whose
  box holds the point types each path with `quotePath` (double quotes, an
  inner `"` escaped, Windows backslashes kept), queued behind any upload so
  the order holds.
- **A file from a temporary place is copied first.** The screenshot
  thumbnail (`…/TemporaryItems/NSIRD_screencaptureui_…/`) and an image
  dragged out of another app live in a folder only the app the drop landed on
  may read, and only until they move; the session under the daemon got
  "operation not permitted". `keep_transient` copies any file with a
  `TemporaryItems` component into the paste directory (which sessions get
  through `--add-dir`) and types the copy's path; a folder, any other path,
  or a failed copy is typed as it is.
- **Why not turn the handler off.** With it off the page gets an HTML5 drop
  and the upload path works unchanged, which is the smaller fix. It was the
  worse behaviour: the upload copies the bytes into the data directory, so
  Claude reads and edits a copy rather than the file the user meant; the
  daemon refuses types outside its allowlist (an `.exe`, a `.zip`) and every
  folder; large files travel through base64. A terminal types the path, and
  the app is terminal-first.
- **The cost.** With the native handler on, the page sees no HTML5 drag
  events on any OS — the macOS handler answers every drag without calling
  WebKit, and on Windows the handler replaces WebView2's own drop target.
  Nothing in the app may rely on `draggable`/`dragover`/`drop`: the tab
  strip reorders by pointer events (`TerminalTabs.tsx`). A drop outside a
  terminal does nothing, and the window never navigates to a dropped file.
- **The popover** shows no terminal and keeps the default handler, so a
  drop there does nothing.
- **Verified** by unit tests on both halves (`shell.rs` script, the
  terminal's routing and quoting). A real Finder drag needs a person: OS
  automation is not used from tests.

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
  today. Only while the session has exactly one prompt outstanding: with
  subagents asking in parallel, which dialog the terminal shows is unknown,
  so the notification carries no actions and the popover drops Approve and
  Deny for *Open terminal* (ADR-035, amended 2026-10-09).
- **Per OS.** macOS: actionable notifications. Windows: toast buttons. Linux:
  actions where the notification server supports them, else a click that
  opens the session. Where an OS has no actions, the notification opens the
  session with the prompt card in view.
- **Quiet when watched.** No OS notification for the session in the focused
  tab of a focused window.
- **As built (WP-09, 2026-10-06).** The frame and its contract are in
  [03-contracts.md § Notify frame](03-contracts.md#notify-frame). The app's
  switches are apart from Telegram's: approval on by default, finished off
  (owner to confirm); Telegram stays off unless switched on. The official
  `tauri-plugin-notification` shows only a title and body on desktop and
  reports no click or action, so every OS gets the floor: the click brings
  the app forward and the app opens the session, whose terminal shows the
  prompt to answer with Enter (the card's buttons, with the `prompt_id`,
  where the chat covers it). Buttons inside the notification need a
  crate beyond the official plugins (UNUserNotificationCenter on macOS, toast
  activation on Windows, D-Bus actions on Linux); macOS has them now (below).
  On Linux a click and Approve/Deny go through the notification server's
  D-Bus actions (`notify_linux.rs`, 2026-10-07); a server without actions
  still shows the text. The window's background throttling is off (macOS 14+): WKWebView
  suspends a hidden or covered page, and a test with the window behind
  others got no notification in 30 s with it on, against 0.03–0.12 s off.
- **Buttons on macOS (2026-10-06).** The owner left the design to us ("do
  what is most convenient for users"; translated). macOS gets
  UNUserNotificationCenter through `objc2-user-notifications`
  (`app/src-tauri/src/notify_macos.rs`); Windows and Linux keep the floor.
  - **Unsigned works.** Measured on macOS 27.0.1 with the ad-hoc-signed
    bundle `make app-bundle` builds: the app connects as a modern client,
    registers its categories, and its first request shows the system's
    "would like to send notifications" prompt. The system refuses
    (`UNErrorDomain` 1, "Notifications are not allowed for this
    application") a bundle LaunchServices cannot match to its path — one
    under a temporary directory, or a binary started directly from a bundle
    never opened — and, it appears, while an earlier request of the same
    bundle id still awaits the user. In the first case the shell falls back
    to the plugin's plain notification; a process that has used the modern
    center cannot (macOS refuses to mix the two). Every Apple-silicon binary
    is at least ad-hoc signed, so "unsigned" means ad-hoc here.
  - **What signing would add.** Developer ID and notarization remove the
    "Open Anyway" step; a provisioning profile, which needs the Apple
    Developer account, unlocks Time Sensitive notifications (through Focus)
    and push (F24). Neither is needed for buttons. NSUserNotification, the
    plugin's API, is deprecated since macOS 11 and shows buttons only in the
    Alerts style, so it was not the route.
  - **Approve** answers allow for that `prompt_id` from Rust, without
    bringing the window forward (the page may be throttled or closed), on
    the daemon the supervisor is connected to over loopback. **Deny**
    answers deny. A click on the body opens the session. A 409 shows
    "Already answered"; any other failure "Could not answer" with the
    reason; success shows nothing, since the badge and card change.
  - **Approve only what it shows.** The daemon offers allow only when the
    body holds the whole request — the command, file, URL or query on one
    line, unclipped (ADR-035: a button must not answer a question it did not
    show). Otherwise the notification offers **Open in Caprock** and
    **Deny**. No list of destructive commands: Claude Code asks only for
    what the user's rules do not allow, and a list would be incomplete and
    read as a safety promise. "Always" is never offered from a notification:
    it writes a rule. Approve carries the authentication-required option.
  - **Withdrawn when answered elsewhere.** A `permission` frame saying the
    session no longer waits makes the page withdraw the approval
    notifications it showed for it, by notify id, so Notification Center
    keeps no stale Approve. One delivered before an app restart is not
    withdrawn; its buttons get "Already answered".
  - **Linux (2026-10-07).** D-Bus actions through `notify-rust`
    (`app/src-tauri/src/notify_linux.rs`): the default action opens the
    session, Approve and Deny answer as on macOS, each notification waits
    for its answer on its own thread. The owner asked for the click to work
    rather than be documented as missing. Not seen on a real desktop yet;
    CI builds it.
  - **Not built.** Windows toast buttons (needs a registered AppUserModelID
    and a COM activator); a follow-up.

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
  Built in WP-13 (2026-10-06): `ui/src/lib/reconnect.ts`, shared by
  `/v1/live` and every terminal; the rules, including the 2-second probe of a
  socket that looks open after a wake and the 10-second limit on an attempt
  that never opens, are in
  [03-contracts.md § Client reconnect policy](03-contracts.md#client-reconnect-policy).
- **Honest state.** "Live", "catching up", "reconnecting (n)", "offline since
  …" — never "connected" without a round trip in the last 25 seconds.
  Built in WP-13 as `ui/src/components/ConnectionState.tsx`, in the header,
  the app's status strip and over the terminal: *Live* (something heard in the
  last 24 s, re-read every second), *Catching up…* (open, the `hello` and the
  missed frames not in yet; or a terminal letting xterm.js catch up),
  *Reconnecting (n) · next try in s* (n is the try under way or next),
  *Offline since hh:mm* (when the browser reports no network) and *Control
  revoked — reason*. *Session ended* is the terminal's own.
- **Live replay.** Every `/v1/live` frame carries a `seq`. The daemon keeps a
  ring of the last 2,000 frames or 10 minutes; a client reconnects with
  `?since=<seq>` and gets the gap, or a `reset` frame and refetches its views.
  Notifications are in that ring, so a phone that was offline sees what it
  missed.
  Built in WP-12 (2026-10-06); the wire contract is in
  [03-contracts.md § Live socket, replay](03-contracts.md#live-socket-replay).
- **Offline queue.** A message sent from the keys bar while offline is held,
  shown as "will send", and sent on reconnect — only if the session is still
  live and no permission prompt is pending; otherwise it stays as a draft with
  **Send now**. Raw keys and permission answers are never queued.
  Built in WP-13 in `TerminalKeys`: "pending" is asked of
  `GET /v1/agents/{id}/permission` at the moment of sending, and a failed
  answer counts as pending (a draft, never a guess); "still live" is the
  terminal socket's `hello` with no exit since. Held messages and drafts are
  kept in the tab's `sessionStorage`, so a phone that discards the page in the
  background still has them; each has **Edit**, which puts it back in the
  field. A raw key pressed while not live is not sent and says so for four
  seconds. Typing into the terminal itself (a desktop) keeps protocol v2's
  4 KiB queue.
- **Chat view.** The conversation as messages (what the agent wrote, tool
  calls collapsed to one line, prompts), built from the events Caprock already
  stores, with the scrolling rule; the input box types into the session.
  Built (WP-14): it keeps the DOM small by windowing — the newest 120
  messages, more revealed at the top — rather than with
  `content-visibility: auto`, whose estimated heights change without a DOM
  mutation and so move the reader past the anchor correction.
  Polished for the phone (2026-10-06):
  - *Offline queue.* The field follows the live socket's state (the chat
    types over HTTP, and `/v1/live` is what says the daemon is reachable):
    the WP-13 rules apply as in the terminal's keys bar, and held messages
    share its `sessionStorage` key. When the session ends, the field stays
    for what was waiting, as drafts; one typed after the end is a draft at
    once.
  - *A reconnect that left a hole.* When the newest page starts after the
    newest message held, earlier pages are fetched with `before=` until one
    reaches it — at most 10 (3,000 events) — and merged at once, so the
    reader's first visible message stays put and the pill counts what
    arrived. Past that bound it starts again from the newest page.
  - *Bottom-anchored.* A conversation shorter than the view sits at its
    bottom (a flex column; the first row's auto top margin, zero once the
    log overflows).
  - *Compact header.* On the Chat tab under 640 px: back, project, title,
    state and a Details toggle on one line; pause, resume, kill, continue
    and relay on one row; ids, folder, links, activity, Remove and the
    figures under Details or on the other tabs.
  - *Photo.* The keys bar's Photo button saves the picture through
    `POST /v1/paste` (downscaled first, as in the terminal) and puts its
    quoted path in the field, sent with the words about it.
- **Start work.** New project, clone and worktree from the phone (see
  [§ Projects](#projects)), then a session in it, with the clone's progress
  surviving a drop.
  Built in WP-15 (2026-10-06): `#/start` (`ui/src/components/NewProject.tsx`),
  reached from **Start work** on Now on a controller phone; a clone is
  followed by `ui/src/lib/startwork.ts`, which keeps the request (with its
  `op_id`) in localStorage, asks `GET /v1/projects/ops` on every reconnect and
  re-sends the same `op_id` only when the daemon never heard of it; then
  **Start an agent here** opens the spawn dialog and lands on the chat.
- **Tailscale by QR.** The pairing panel shows the Tailscale address
  (MagicDNS name or `100.x`) as a QR beside the LAN one when Tailscale is up.
  Built in WP-15: the daemon listens on both addresses, and the panel picks
  *Wi-Fi*, *Tailscale* or *Tailscale name* for the QR. Without Tailscale the
  panel says that a phone off the Wi-Fi cannot reach Caprock at all.

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
records integrations that show green while listing nothing. Built in WP-19;
the auth decision is [ADR-039](08-decisions.md#adr-039--github-the-daemon-talks-to-the-api-with-the-gh-login-a-pasted-token-or-a-device-flow-token-that-never-leaves-it),
the endpoints [03-contracts.md § GitHub](03-contracts.md#github), the user
guide [docs/app.md § GitHub](../docs/app.md#github).

- **The daemon calls the GitHub API directly** (`internal/github`, no new
  library). Three sources, the easiest first: the GitHub CLI's login (`gh
  auth token`, read when needed, never written down), a pasted fine-grained
  or classic token, or the OAuth device flow when a Caprock OAuth app's
  `github_client_id` is configured.
- **A token Caprock keeps** goes to the macOS login keychain, named by path
  so no system dialog can appear, else a `0600` file in the data directory
  with a note in Settings saying why. Never in SQLite, `config.json` or
  logs, and never sent to a client.
- **Opt-in and revocable** — an outbound call the user switched on (rule 4).
  Disconnect removes only what Caprock stored.
- **Conditional requests** (`ETag`, `If-None-Match`) and the rate-limit headers
  respected; a followed repository is read at most once a minute, backing off
  to 8 minutes when nothing changes.
- **Every error shown** with what was attempted; a health line (last success,
  last error, scopes, rate limit) in Settings.

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
  install, independent of OS code signing: a minisign signature over the
  bundle and the version it was signed for (ADR-042). The plugin's own
  JavaScript commands are granted to no page; the page calls ours.
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
  with. Each release also carries the app files under names without the
  version (`Caprock-macOS.dmg`, `Caprock-Windows-setup.exe`,
  `Caprock-Linux.AppImage`, `.deb`, `.rpm`), so
  `releases/latest/download/<name>` is a permanent link for the site's
  download buttons; the release is marked Latest only once they are all
  attached (`scripts/app-latest.sh`).

## Privacy prompts on macOS

macOS asks before a program reads Desktop, Documents, Downloads and a few
other places, and remembers the answer per program and per code signature
(ADR-040). What follows from Caprock being ad-hoc signed:

- **The daemon is the program that asks**, for itself and for every session
  it runs: a pty-host and the agent under it are attributed to the daemon
  that launchd started. An agent reading `~/Downloads` asks as "caprock".
- **Every release asks again.** An ad-hoc signature's designated
  requirement is its cdhash, so each build is new code to TCC.
- **One path, one entry.** The app runs its daemon from
  `<data_dir>/bin/caprock` and moves a Homebrew daemon (a new Cellar path per
  release) onto it, so a new release replaces the entry instead of adding
  one. Sessions that were already running keep the old binary until they end.
- **Isolated daemons stay out.** Tests, stands and previews run with a
  temporary HOME; such a daemon refuses the account's Desktop, Documents and
  Downloads (`internal/tcc`), and `bench/stand.sh` refuses to live there.
- **With a Developer ID** (the Apple account): one entry that survives
  updates, and, with the daemon as an `SMAppService` helper of the app, the
  app's name and icon — to verify on the first signed build.

The user-facing note is in [docs/app.md](../docs/app.md#macos-privacy-prompts).

## Updates

Built 2026-10-06 (WP-21, F20). The decision and its reasons are
[ADR-042](08-decisions.md#adr-042--the-app-updates-itself-in-one-click-a-minisign-signed-bundle-one-channel-checked-only-when-the-release-check-is-on-or-the-user-asks);
the release side is [RELEASING.md § The desktop app](../docs/RELEASING.md#the-desktop-app);
the user guide [docs/app.md § Updates](../docs/app.md#updates).

- **The offer.** When the daemon's release check (`/v1/update`) knows a
  release newer than *the app's* version and this install can replace
  itself, a card in the bottom-right corner announces it once per version
  — *Caprock vX.Y.Z is available*, **Update and restart**, *What's new*,
  **Later** (`AppUpdateToast.tsx`, owner 2026-10-07, after Orca) — and the
  status strip keeps **Update to vX.Y.Z — Restart**
  (`ui/src/components/AppUpdateNotice.tsx`). The card shows the download's
  progress too and never takes focus. One click: the shell fetches
  `latest.json`, downloads the platform's bundle with progress
  (`Downloading vX.Y.Z` and a bar, 5 events a second at most), verifies it,
  installs it (`Installing … — restarting…`) and restarts. A failure opens a
  panel with the reason, **Try again** and the release page. The ▾ beside the
  button shows what is new and **Not now**, which hides that version (the
  same key as the dashboard banner).
- **Checking by hand.** **Check for Updates…** in the macOS app menu and the
  tray menu, and *Check for updates* in the palette, fetch `latest.json`
  once, with or without the release check on: *Checking for updates…*, then
  the offer, *Caprock is up to date* for 6 seconds, or the failure. A check by
  hand answers even for a version the user dismissed.
- **The first launch** asks once, in the app (never an OS dialog): *Check for
  updates automatically?*, **Yes** focused and highlighted. Yes turns on
  `update_checks`, which makes the daemon check at once; No changes nothing.
  The answer is `<data_dir>/app-update.json` (`{"asked": true}`), kept apart
  from `app.json`, whose absence means the app never started a daemon. With
  checks already on it is not asked. The dashboard banner's own offer is not
  shown in the app.
- **Who can update itself** (`updater::blocked`): the macOS `.app` (not from
  the disk image or a translocated path), the NSIS install and the AppImage.
  A `.deb` or `.rpm` install, a development build or an unknown bundle keep
  F12's notice, with the reason in its panel.
- **The daemon after an update.** The relaunched app finds its own daemon
  (`<data_dir>/bin`) different from the bundled one and moves it over once
  per launch (`Supervisor::should_adopt`, ADR-040's amendment: the
  copy-shutdown-start); pty-hosts keep the sessions. A cask upgrade gets the
  same.
- **Everything comes back as it was** (the owner's bar, 2026-10-06:
  "update like Orca does — without losing sessions, everything stays in its
  place", translated). Sessions live in pty-hosts and survive both the app's
  restart and the daemon's move; tabs, their order, the front tab, splits
  and sizes (`caprock.app.workspace.v1`) and the sidebar
  (`caprock.app.expanded`, `caprock.app.hidden-projects`,
  `caprock.app.project-folds`) are in the page's storage; on *installing* each
  terminal saves where it is scrolled (`caprock.app.resume.v1`,
  `ui/src/lib/termresume.ts`) and goes back there after the replay; the
  shell waits a second for WebKit to write that, and saves the window state
  before it installs. A half-typed line lives in the agent's process and is
  repainted with the rest. Checked end to end by `bench/update.mjs`
  (two signed builds, a loopback update server, the fake `claude`).
- **What it sends** is in ADR-042: the plugin's `User-Agent`, an `Accept`
  header, no identifier and no version in the URL.

## Telemetry

None. No analytics, no crash upload, no usage pings. A crash or a stall the
app detects (a UI long task over 1 second, a WebView reload) is written to a
local log, and Settings has **Copy diagnostics**, which the user may send
themselves. The update check is the release check that exists, off until the
user turns it on; the app asks once on its first launch (§ Updates).

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
  one. *Mitigation:* the running daemon wins (on macOS the app's own, unless
  it is older: ADR-040); api_level gates features; one data directory.
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
   always shown, never swallowed. *Amended by WP-19 (ADR-039):* the GitHub
   CLI's login and a pasted token come first; the device flow is offered once
   the app's client id is configured.
5. **Minimum OS versions:** macOS 13, Windows 10 22H2, WebKitGTK 4.1
   distributions.
6. **Name and bundle id:** "Caprock", `dev.caprock.app`.
7. **Background service:** installed on first run, with a visible switch.
8. **Phone:** clone and worktrees in P0; shell tabs in P1.
9. **How the app gets its UI:** from the daemon's own URL (as in the Tauri
   spike), so the UI ships with the daemon and no new origin is admitted.
10. **Focus:** macOS first for polish and release; Windows and Linux stay
    green in CI and follow.
