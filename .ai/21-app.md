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
  translated). Since 2026-10-09 it is outlined, not filled: a 1px accent
  border, accent label and icon on the panel, an accent-tinted hover
  (`.app-primary`); the key hints beside it, *Add project* and *Dashboard*
  are the label's size, muted (`.app-kbd`, 12.5px mono) — at 10.5px the
  owner could not read them. Then the projects, as an accordion (owner,
  2026-10-09: "the left has tons of items, which one is active, which to
  pick, unclear … we need a simpler interface", translated; he had landed
  on an old session started in another terminal and understood nothing).
  A project is one line: a fold chevron, the name, a 40×12 line of its last
  hour (turns and tool calls per two minutes from `GET /v1/activity`, polled
  once a minute and resting while the window is hidden; amber while something
  in it works, absent for a quiet hour), a green dot with the count of live
  sessions and shells, the waiting badge, and a faint **+** (new agent in the
  project) that needs no hover — no branch, no ±, no spend. The owner asked
  for the three on 2026-10-11 (translated: "neat small activity charts, a
  button to fold or hide, a quick button to add something in the same
  project"); hide, a new shell, the menu and close stay on hover. The
  *Projects* heading says how many and how many have something running
  (*● 3 of 12*), and *Outside projects* can be hidden from its row like any
  project (it was the one row with no way out; owner, 2026-10-11). **Under
  each project, every agent session** (owner, 2026-10-13, translated:
  "when will this *+1 more* go away … show only the agent sessions, don't
  move anything, don't add extra elements"): working, waiting and idle,
  one 38px row each, its title 14px, its state a dot and a word, with no
  agent mark (the agent is in the tooltip), and
  no *+N more* line. That line (FB-053, earlier the same day: only what was
  active, the rest folded behind *+N more*) hid the very rows the owner
  steered by. Shells and file tabs have no rows — they are in the strip —
  an ended session drops off, and a hidden row is gone until *More…*
  shows it again. A project's chevron folds it by hand, kept per viewer
  (`caprock-sidebar-folded`); folded, it still lists what waits in it
  ([04-ui.md](04-ui.md) § Sidebar). Rows read the strip's names
  (`lib/tablabels.ts`; a branch only when it is not the project's). No
  worktree or branch rows, and no ended session — those are on the
  project's page (*Recent*), in ⌘K and in the Inbox. The one selected row
  in the sidebar is the tab in front — accent tint, 3px accent edge, bold
  title; the current project's name is bold, with no edge or fill. **Rows keep their
  places** (owner, 2026-10-13, translated: "fixed positions, I orient
  visually by them"; `lib/rowOrder.ts`): by the order set by hand, then by
  when the session started, never by the strip, the front or a state, so a
  row picked from the list stays where it was when it becomes a tab. A
  row is moved by dragging it onto another or with ⌥⇧↑ ⌥⇧↓ on it; the
  order is kept per project and viewer (`caprock.app.row-order`; the flat
  list's under `*`). **Group by project or one list** (owner, same day,
  translated: "top I see 1, 2, 3; on the left I see 4, 2"): a switch
  beside the heading (`caprock.app.sidebar-grouped`; *Projects* | *Tabs*
  in words since 2026-10-14) switches to one flat list of every agent session;
  since 2026-10-15 a row there no longer draws its project's name (a user
  could not read the rows) — the tooltip and the accessible name say it. **Tabs are the navigation**
  (owner, 2026-10-14, translated: "I sometimes work with 5 projects at
  once, sometimes 2. I just want to switch between them with key combos"):
  ⌘1–⌘9 (Ctrl+Shift+1–9 off macOS) is the strip's Nth tab, ⌘9 the last,
  and the strip is in the order the tabs were opened — a new tab goes last
  with the next number; only a close or a drag changes the numbers; a
  restart keeps them. Every tab shows its digit, the one in front too,
  after its session's name and its project's dot and short name, and its
  sidebar row shows the same digit. The sidebar is **Flat** ("Tabs") —
  the tabbed sessions in the strip's order, then the ones running with no
  tab, without a digit — or **Tree** ("Projects"), projects with their
  sessions under them (Settings → Appearance, or the heading's switch;
  `lib/sidebarMode.ts`). A new viewer starts on Flat; one who used the app
  before and never chose keeps Tree (.ai/04-ui.md).
  Projects have no digit; a click on one opens its page. For a day ⌘N had
  been the sidebar's Nth item, a project or a session by grouping, with N
  only on the tab it brought; projects on ⌃⌘1–⌃⌘9 were tried and turned
  down. A one-time line says the keys after the update (`KeysHint`).
  ⌥⌘↑ ⌥⌘↓
  walk the sessions of the project in front (the whole list when flat),
  ⌥⌘← ⌥⌘→ the projects
  (Alt+Shift arrows off macOS; [04-ui.md](04-ui.md) § The app workspace, *Keyboard*, says why not
  ⌥← ⌥→ or ⌘↑ ⌘↓). There is no *Waiting on you* section
  (owner, 2026-10-11: "not needed at all — everything is already visible in
  Projects", translated): a session that waits is marked on its own row,
  an amber dot and the amber word *waiting* (or *asks* at a permission
  prompt) — never a fill or an edge, which are the tab in front's — and
  a project folded by hand still lists what waits in it. Every row under a
  project can be got rid of (owner, same day: "nothing can be done … I
  can't close it or hide it afterwards", translated): a tab row's × closes
  the tab; a row with no tab has a × that hides it from the list, signalling
  nothing (rule 7), and ■ beside it stops what Caprock started after a
  confirmation. Hidden rows are listed under *More…* and come back by
  themselves when they next wait on you. The same actions are in each row's
  right-click / Shift+F10 menu; the buttons are 26px, on hover and focus,
  and always shown on a touch screen ([04-ui.md](04-ui.md) § Sidebar).
  Under the projects, the **other computers** (ADR-067): with none linked,
  one quiet *+ Add a machine* row opening Settings → Computers; with some, a
  *Computers* heading, each computer and the sessions running there, tagged
  by its name, opening in the Dashboard tab through `/v1/m/{id}/…`
  ([04-ui.md](04-ui.md) § Other computers). A **Dashboard** entry opens the existing
  screens in a Dashboard tab pinned at the left of the tab strip (2026-10-09:
  it replaced the whole workspace, and the first tester read that as every
  terminal closing, translated); in it, Now leaves out the session cards and
  the projects panel the sidebar already shows, and keeps the Repos table
  under the pulse ([04-ui.md](04-ui.md) § Repos on Now). A session Caprock
  cannot type into — started in another terminal, ended, or detached by a
  restart — opens in **an app tab of its own**, never the Dashboard tab
  (owner, 2026-10-13: "why when I click one of these on the left am I taken
  to something like the web version of the dashboard instead of into the
  session?", translated). The tab (target kind `observe`, `lib/tabs.ts`;
  never split) is named after the session with its agent's mark and shows
  `components/ObservePane.tsx`: a header (dot, mark, title, *in another
  terminal* or *ended*, ⋯ with *Hide from the list*, *Open in dashboard*,
  *Close tab*), the session's conversation live and read-only (the session
  page's `ChatView`), the inspector beside it as for an owned session, and,
  where the terminal would be, *Started in another terminal — Caprock
  watches it, it can't type into it* with **Continue here** and *Open in
  dashboard*. Continue here is `--resume` in a new process Caprock starts:
  a copy under a new id (`fork`) in a new tab while the original still
  runs, the same conversation in the same tab once it ended or was detached
  (the tab turns into a session tab when the daemon holds its terminal).
  Nothing is sent to the other process (rule 7). Only the tab in front reads
  the conversation. *Hide from the list* closes the tab and hides the row
  (`hideSessionRow`, the same `caprock.app.hidden-sessions` list as the
  row's ×), and the row stays hidden until it next needs you
  (`rowHidden`). *Quick chat* (⌥⌘N) under
  *Add project* starts a session with no folder to pick, in a tab (the
  tester could not find how to, translated).
- **Quick chat: vendor and model** (owner, 2026-10-09: "three buttons to
  switch between model vendors — Claude, Codex, Gemini — and a model in two
  clicks", translated). Decision then: **⌥⌘N never asks** — it started at
  once on the vendor and model used last. **Reversed 2026-10-12** (owner:
  "Quick chat opened a terminal without asking with whom, and now I can't
  get out of there", translated): **⌥⌘N asks, with one keystroke to
  accept.** Every way in — ⌥⌘N, the sidebar, the strip's + menu, the
  palette's *Quick chat…* — opens a chooser sheet
  (`components/QuickChat.tsx`) with the agent and model used last (else
  Claude Code on its default) picked and focused, so Enter starts it: a segmented
  row of the agents installed here (`useSpawnableAgents`), the selected
  one's models under it with the New agent sheet's labels (since
  2026-10-10 from `GET /v1/agents/catalog`: Codex's catalog, the models of
  the providers connected to OpenCode, Grok's cached list, a custom agent's
  own). An agent missing something shows `AgentSetupNote` above its models —
  OpenCode with no provider: *Connect a provider*, which opens a shell tab
  with `opencode auth login` typed, not run (`POST /v1/shells` `type`) — and
  the agents not installed are named under the list, each opening its install
  note (ADR-046). A click on a model
  starts the chat on it — another vendor's model is two clicks, the last
  vendor's one; Enter starts on the highlighted model; ← → or 1–9 (⌘1–9
  too) switch the agent, ↑ ↓ the model, Esc closes. The choice is kept per viewer in
  localStorage (`caprock.quickchat`). With more than one Claude Code or
  Codex sign-in, a Subscription select sits under the agent row, opening on
  the pick kept in `caprock.subscription.<agent>.-` or else the default one,
  and sent as `subscription` (ADR-048). Rejected: a header on the started tab
  that restarts the chat on another model — it starts a process only to kill
  it, and cannot change vendor once a conversation has begun.
  **Reversed again 2026-10-16** ([ADR-071](08-decisions.md); owner: Quick
  chat is one button, with at most a model choice, translated): ⌥⌘N, the
  sidebar's *Quick chat*, the + menu's and the palette's *Quick chat* start
  at once on the choice kept in `caprock.quickchat`, and the chat opens on
  its conversation (ChatView), so there is no terminal to get lost in — the
  2026-10-12 complaint. The chooser stays as *Quick chat with…* in the +
  menu and the palette.
- **A quick chat's tab** (owner, 2026-10-12, same report). It is named
  *Quick chat · Opus 5.5* — the pricing table's model name once it has
  answered, before that the model it was started on, which the window that
  started it keeps (`caprock.quickchat.started`), else the agent's name — in
  the strip, the sidebar row and the inspector's header (`lib/quickchat.ts`;
  a chat is known by its folder, `<data_dir>/chats/<stamp>`, as the daemon's
  `chatLabel` knows it; since ADR-071 the session row also says `chat`). The
  sidebar groups it under *Outside projects* only while it has a tab or waits
  on you (every chat is on the Chats screen); the tab no longer wears that
  group as its chip, and opens on the conversation. A line above it says *Quick chat with Claude · Opus 5.5 — ⌘W or /exit
  ends it* (keys through `keys()`; Gemini's is /quit), with a × that hides it
  for good (`caprock.quickchat.hint`). **When the agent exits** the tab stays,
  dimmed, with *The chat ended*, **Close tab** (focused, so Enter takes it)
  and **Start again** (a new chat on the same agent and model, in the same
  tab: `replace-session`). Every other agent's tab becomes a shell in its
  folder on exit ([04-ui.md](04-ui.md)); a chat's folder is Caprock's own,
  and that shell — a login prompt in Application Support, under the same
  tab — was the "can't get out": the owner typed `/exit`, was still in a
  terminal, and reloaded the window to leave.
- **Closing a quick chat ends it** (owner, 2026-10-12: closed chats piled
  up as idle sessions under *Outside projects*). ⌘W, the tab's ×, the
  sidebar's × and *Close tab* stop a quick chat's process with the tab — the
  same `kill` as the cockpit's *Stop the session…*; the conversation is
  kept and can be continued. An idle chat ends with no question; one still
  answering (activity `working` or `looping`) asks once — *Stop the chat? It
  is still answering.* — with **Stop and close**, **Keep it running, close
  tab** and **Cancel** (`CloseChatConfirm`). Only a chat Caprock started and
  still running is stopped (`owned`, not ended; rule 7): known by its
  folder, or one this window spawned a moment ago that the session list
  does not have yet (`planChatClose`, `lib/closeShell.ts`). One whose agent
  already exited is not signalled. Closing the tab of any other agent
  Caprock started ends it when it is idle, with a toast that the
  conversation is saved; one working or waiting asks one sentence with two
  equal buttons, each with a line saying what it does: *Keep it running*
  (focused; only the tab closes) and *Stop it* (since 2026-10-17; before,
  *Close tab* and a quiet *Stop it instead*; `lib/agentClose.ts`,
  .ai/04-ui.md). Escape cancels. Ending is the
  `end` signal — SIGTERM, then SIGKILL after 5 s — so the transcript is
  written and the session can be continued; an agent another terminal started
  only loses its tab. The tab's × says *the chat ends* on a chat, *keep
  the agent running or end it* on an agent Caprock started and *the agent
  keeps running* on the rest.
- **Tab strip** (owner, 2026-10-09: "tabs are barely noticeable", and "the
  + amber, or better a dropdown", translated). The tab in front has a 3px
  accent top edge over its hairline frame and a bold label, and is the only
  tab that does (2026-10-15: a waiting tab is an amber dot, not a bar)
  (`.app-tab-front`); every other tab is a faintly filled surface with its own
  hairline frame (`.app-tab-back`), 4px apart, so each reads as a tab in both
  themes. The pinned Dashboard tab is not a session and looks it
  (`.app-tab-dash`): an amber grid icon, an amber-tinted fill and frame
  while it is behind, and a hairline divider after it. The + is an amber outline (`.app-primary`, like the sidebar's New
  agent) that opens a menu (`components/NewMenu.tsx`, portalled): *New
  agent* ⇧⌘N, *Quick chat* ⌥⌘N (at once), *Quick chat with…* (the chooser),
  *New shell* ⌘T, *Open file…*, *New browser tab* (only while the in-app
  browser is on, § Browser tabs), *Add project* ⌘O, each with its key; ↑ ↓,
  Enter, Esc. The separate >_ new-shell button is gone: it is the menu's
  third row and ⌘T, and two lone icons side by side read as one ambiguous
  control.
- **Renaming a session** (owner, 2026-10-13: "edit a session's name in a
  few clicks from the tabs and the projects on the left; the new name must
  show at once in the top tab", translated). A double-click on an agent's
  tab or sidebar row (a tab row or a muted live row), or *Rename…* in the
  row's menu, puts a field in place of the name (`components/InlineRename.tsx`):
  Enter or blur saves, Esc cancels, its keys reach nothing else. The held
  session list is patched before the request (`lib/sessionNames.ts`
  `renameSession`, applied by `useWorkspaceData`), so the tab and the row
  change in the same frame; a refusal rolls it back. `PUT
  /v1/sessions/{id}/name` stores it (`sessions.name`, migration 0052) and
  sends a session frame, which renames it in every other window. A shell
  or a file tab has no rename. Unnamed, a session is called by
  `sessionTitle`: the agent's title, else `promptTitle` — up to four words
  that carry meaning from its first meaningful prompt, the request's
  opening ("can you please", "I want you to") dropped, cut at the first
  "to / in / and …" after two of them, a path as its last part. String
  work on text the list already holds; nothing is computed on the daemon.
- **Every agent in New agent, with what it lacks** (owner, 2026-10-10:
  "OpenCode there is empty — either give buttons to connect it or remove
  it", translated; ADR-046). The Agent select lists the startable agents
  (`GET /v1/agents/catalog`: installed, not locked), then the rest marked
  *not installed* (or *Premium* for a custom agent whose licence lapsed);
  the default is never one of those. Picking one hides Model and
  Permissions, disables Start, and shows the install command with *Install
  in a shell tab*, Copy and the docs link. An installed agent missing a
  provider or a sign-in keeps Start and shows the fix under the row. Grok and
  custom agents carry a line that Caprock does not read their turns or cost;
  a custom agent has no Permissions field and, without `{prompt}` in its
  arguments, says the first message is not sent. Settings → Custom agents
  (Premium, behind `Locked`) edits the list (`PUT /v1/agents/custom`).
- **New agent's Project field is a search** (owner, 2026-10-10: "quickly
  search projects by repo in my folder", translated). A combobox, focused
  when the sheet opens, with its list open and the current project first:
  Enter keeps it, a second Enter starts. Typing ranks projects, recent
  folders and repositories under the default folder by name (prefix, word,
  substring, then the letters in order; then the path), matched letters in
  bold; ↑ ↓ Enter pick, Esc closes the list before the sheet. A recent folder
  or repository is added (`POST /v1/projects {path}`) when picked and
  selected. The same ranking serves the Add project sheet.
- **A folder of repositories** (2026-10-12, ADR-055): *Add* on an
  existing folder that holds two or more repositories (two levels deep, `GET
  /v1/projects/scan`) asks once, in place of the search and the folder
  browser: *One project of N repositories* (the default) or *N separate
  projects*, each repository a checkbox, ticked unless another project holds
  it; the button says *Add 1 project* / *Add N projects* (`RepoChoice.tsx`,
  `lib/multirepo.ts`). A folder inside one repository asks nothing.
- **New project wizard** (owner, 2026-10-14, translated: "I still don't
  understand how to make a multi-repo project, and it matters to me. I want
  big: quickly click through and the project is created with everything. Or
  a monorepo, even faster."; `ProjectWizard.tsx`, `lib/projectWizard.ts`).
  ⌘O, *Add project*, the empty page's *Add a project* and New agent's *New
  project…* (beside the Project label and as the search list's last row,
  carrying the first message typed so far) open it when the projects API is
  there; the Add project sheet below stays for clone and a new empty folder,
  linked from the wizard's footer. Three steps, each one click or Enter:
  - **Folder.** A 46px path field, chips for the places projects live (the
    parents of listed projects, recent folders and repositories under the
    default folder, most first; then the default folder; home last), and the
    folders inside the field's folder as 44px rows (`GET /v1/browse`, 250 ms
    after the last key): a click on a row picks it, › looks inside one that is
    not a repository. In the desktop app *Choose…* opens the system's folder
    chooser (`pick_folder`, app/README.md).
    **A name typed after the last separator searches the folder before it**
    (owner, 2026-10-15, translated: "typing the first letters should search
    these folders in this directory"; until then `~/dev/cap` emptied the
    list). When the field is not an existing folder, the folder before the
    last `/` or `\` is listed instead, kept to the names holding the typed
    letters, ignoring case: the ones that start with them first, then the
    ones that hold them elsewhere, the matched letters marked
    (`splitTyped`, `filterFolders`). Each key re-filters at once; only a new
    folder waits for the daemon. The first match is highlighted, ↑↓ move
    the highlight, Enter picks it as a click would, and Tab completes the
    field to it with a separator (`drillPath`) to keep going inside. With no
    match the list says *No folder starting with 'cap' in ~/dev* and Enter
    looks at what was typed. A field naming an existing folder lists what is
    inside it with nothing highlighted, so Enter looks at that folder, as
    before. `~`, `~\`, drive letters (`C:`, `C:\Us`) and backslashes work
    the same way: the daemon expands `~` and resolves the path.
  - **What is there** (`GET /v1/projects/scan`), in 26px type: *One
    repository* (the folder is one, or is inside one — then it is that
    repository, no question), *N repositories* as big checkable cards, all
    ticked but one in another multi-repo project, each naming its own
    CLAUDE.md / AGENTS.md (*Create project of N repos*, or *Or add them as N
    separate projects*; a single pick adds that repository alone), or *A plain
    folder*. One repository below the folder is scanned itself. A folder
    already listed says so and *Open project* adds nothing. On the same
    screen: *Already has CLAUDE.md — agents read it* with *Show* (the scan
    returns the text), and an optional *Instructions for every agent here*
    box (⌘↩ creates from it), saved as `defaults.system_prompt` on every
    project made.
  - **Done.** *Start an agent here* (focused; Enter) opens New agent on the
    project with the first message handed back; *Just add* (Esc) closes.
- **What the agents are told, at a glance** (owner, same day: "whether this
  project has a prompt set up — that's important — and by a click see it").
  `ProjectInstructions.tsx`, in New agent (bigger, for every agent; one
  Caprock does not hand instructions to says so) and on the project's page:
  *Project instructions* "Set · N lines" or "None" with Show and Edit (Add),
  and *Repository's own* — `instruction_files` from the project, members'
  as `api/CLAUDE.md` — with Show reading each through `GET …/file`. The
  sidebar row's tooltip ends with the same in words.
- **Add project sheet** (owner, 2026-10-09). The folder field starts on the
  default folder — `settings.default_folder` (Settings → Projects, labelled
  *Where you keep your code* since 2026-10-12: a tester read *Default folder*
  as the one place projects may live and asked for more of them; the help now
  says it limits nothing, it only sets where Add project and Browse open and
  where the new-session search looks for repositories), else
  `~/` — and is focused; *Set … as default* beside it keeps the field's
  folder (an existing folder's own, the parent of a new project or a clone's
  destination). Under it, 250 ms after the last key, what is there (`GET
  /v1/browse/stat`, `lib/addproject.ts`): *no such folder* / *not a folder* /
  *already in Caprock* for an existing folder; *will be created* or *exists —
  add it as an existing folder instead* for a new project; *will be
  created*, *exists, empty — will clone here* or *exists — not empty, clone
  will fail* (red) for a clone. Since 2026-10-10 (owner: ~/dev/caprock-website
  for ~/dev/caprock-web got only *no such folder*) the last segment typed in
  Existing folder searches projects, recent folders and the repositories
  under the default folder (`GET /v1/browse/repos`, `lib/projectSearch.ts`,
  `ProjectSearch.tsx`): up to six matches under the field, ↓ ↑ and Enter
  pick; *no such folder* is said only when nothing matches, and then with
  the nearest names by shared start or edit distance as one-click fixes.
  Browse is a folder browser: it opens on the
  default folder, a breadcrumb and ↑ walk up, a click selects, a
  double-click, Enter or › goes in, *Choose* picks the selection or the
  folder shown; ↑ ↓ ← → from the keyboard, hidden folders never listed.
  Recent leaves out temp folders, Caprock's data directory and
  `.claude/worktrees` (§ contracts, `/v1/recent-dirs`). Keys, shown on the
  buttons: ⌘↩ Add / Create / Clone from anywhere in the sheet, Esc Cancel,
  ⌘1 ⌘2 ⌘3 the modes, ⌘B Recent ⇄ Browse (Ctrl off macOS).
- **Today strip** (owner, 2026-10-08: "useful data on the left too",
  translated). Under *New agent*: today's spend across every agent, agents
  running and waiting on you, and Claude Code's 5-hour and weekly windows
  as thin bars with % and reset time. Every figure is one the workspace
  already holds — `summary.cost_usd` and `rate_limits` from the day's
  summary the status strip and cockpit read (`planWindowsFor('claude')`,
  `readWindow`'s staleness rule and the cockpit's tone thresholds), the
  counts from the sidebar model (`agents`, `working`, the Inbox's non-stale
  items). Spend is a dash until the summary answers; no plan windows, no
  bars. Clicks: spend → `#/cost`, a window → `#/cost?section=limits`,
  *Running* → `#/now`, *Waiting* → the first Inbox item. Code:
  `components/TodayStrip.tsx`, `lib/today.ts`. While the sidebar is open
  the status strip drops its plan windows and spend, so the same figures
  are never on screen twice. It folds to one line (spend, running, what
  waits, the 5h and 7d percentages) by its chevron and hides by a hover ×;
  its right-click menu offers Full card, One line and Hide; Settings →
  Appearance shows it again, and while hidden the list's heading counts
  what waits (a user, 2026-10-15; `lib/todayCard.ts`, [04-ui.md](04-ui.md)
  § Sidebar). No Share button since 2026-10-16.
- **Project menu** (owner, same day: "a way to hide or close projects";
  the hover-only eye was not found). The row's ⋯ — on hover or focus — a
  right-click on the row, or
  Shift+F10 / the context-menu key opens `ProjectMenu.tsx`: hide or show
  again, close its tabs (the `close-project` workspace action drops every
  tab whose `projectId` it is, splits included; nothing is signalled, so the
  sessions and shells keep running — rule 7), *Open in* each editor from
  `GET /v1/editors`, *Clean up copies…* for a repository (every worktree
  with its state and size, removing Caprock's; `CopiesSheet.tsx`,
  [04-ui.md](04-ui.md); finished copies below), and *Remove from Caprock…*, which confirms inline and
  then unlists (`DELETE /v1/projects/{id}`, or the page's local list on a
  derived source) and closes the project's tabs. There is no "Open in
  Finder": no endpoint reveals a folder, and the editors cover opening it.
  The menu is portalled to `<body>`: the sidebar's backdrop filter makes it
  the containing block of anything fixed inside it.
- **Finished copies** (owner-approved design, 2026-10-12). A copy Caprock
  made that is merged (or its pull request is), pushed, clean and has
  nothing running in it is *finished*; Settings → Worktrees says what
  happens to it: *Off*, *Ask* (the default) or *Auto*. Ask puts one quiet
  line on the project's page and over the deck's Branches view — never the
  sidebar — *3 copies done · 2.1 GB · Clean up · Review*; *Clean up*
  confirms on the same line and removes exactly those, *Review* opens the
  copies sheet with them ticked. Auto removes a copy 24 hours after it
  finished. Either way the line then says *Removed 3 copies · 2.1 GB freed
  · Undo* for a day, the branch is kept 7 days (Restore in the sheet's
  *Recently removed*), and a tab on a session in a removed copy closes.
  Checked when a session in a copy ends, when a pull request is seen merged,
  and once a day; never polled. Code: `internal/projects/cleanup.go`,
  `components/CleanupLine.tsx`; contract in
  [03-contracts.md](03-contracts.md) § Projects and shells.
- **Keeping the project list short** (owner, 2026-10-08: "a ton of stuff
  hanging in it and it's unclear how to hide things", translated). Since
  2026-10-09, above `FOLD_ABOVE` (8) projects the list is what is in play —
  a live or waiting session, a tab open, a pin, or the project in front —
  and everything else folds under *More projects · N* (it was *Quiet*, a
  week without activity, which left eighteen projects standing in the
  owner's list); with eight or fewer nothing folds (a preview with three
  projects hid two of them, which only made the short list shorter). Each
  group is in a stable order — pinned, the hand-set `sort`, then name —
  because ordering by activity moved a project when it was clicked. A project hidden by hand
  from its menu or closed with its row's × (which since 2026-10-09
  replaces the hover eye, and hides only when nothing runs or waits in it)
  is hidden (under *More…* since 2026-10-13), where the
  same actions show it again. Hidden wins over what runs in it, but not
  over being in front: the project in front stays listed, last, with its
  tabs open. It comes back
  out only when it needs you again — a permission prompt, or a turn that ended
  after it was hidden (`projectHidden`, the same rule as a hidden session
  row). Until 0.112.0 a project in front or with any agent at "your turn"
  (up to twelve hours) was forced back into view, so *Hide* did nothing on
  exactly the projects it was pressed on (owner, 2026-10-13).
  `groupProjects` in `ui/src/lib/sidebar.ts` decides; *Other folders* always
  keeps a row.
  Hidden ids, each with when it was hidden, live in the page's storage
  (`caprock.app.hidden-projects`; an older plain list of ids still reads),
  not the daemon: the projects API has no hide flag, and unlisting
  (`DELETE /v1/projects/{id}`) takes the project out of every list, phone
  and palette included, which is not what hiding means. Since 2026-10-13 the *More projects*
  and *Hidden* folds are one quiet *More…* row at the end of the list
  (owner, translated: "one button like *More…*"): it opens a menu of the
  other projects (click to open), then hidden projects and hidden session
  rows (click to show). `caprock.app.project-folds` now holds only the footer fold.
- **Tabs (main).** Terminal tabs — an agent session or a shell — of every
  project in one strip, each with its project's chip; picking a project
  never takes a tab out of it (2026-10-09: with a strip per project, the
  first tester lost a plain shell the moment he moved to a project, and
  Vova's two rateguard tabs "vanished" when he clicked another project,
  both translated). The sidebar lists the current project's tabs under the
  same names. The terminal's default palette, *Match app*, takes the window's own panel
  colour, so it no longer reads as a dark window laid on the beige one. The permission prompt card
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
  window are reached through their badge, their marked row in the sidebar, ⌘J, the menu bar popover,
  the notification and the phone, which keep their buttons.
- **Agent cockpit (right).** The inspector, open by default (⌘I closes it,
  and closed is remembered per machine), becomes the agent cockpit beside an
  agent's terminal: the session's project (and its branch when not the
  default; the path on hover), the agent's character in its state (working,
  *background agents working · N* once its turn ended with subagents still
  at work, waiting on you, looping, idle, ended) with three figures at
  the right that the viewer picks from one list (cost, burn rate, tokens,
  cache hit rate, turns, time working, last call, tool calls): a big
  headline and two short lines under it (*$4.08/h burn ▾*, *4.01B tok ▾*),
  never one twice, burn rate, tokens and cost by default; when the two
  lines would squeeze the agent's own, they move to the chips' row at its
  right. Under what it is doing now, the spend details, open on a chart of the
  period (*Chart | Numbers*, for the session, today, 7 or 30 days; the
  bars measure cost, tokens or turns, picked from a ▾ after the total;
  Numbers is three more figures the viewer picks), folding to one strip of
  the same bars and three figures, the context bar and what the next call pays to
  re-read it, what it is doing this second (the open tool call and how long
  it has run, or *Thinking* since the last one finished; while a permission
  prompt waits, who asks and what — "Subagent (general-purpose) wants to run
  Bash" over the command's first real step, the full text on hover, or "2
  approvals waiting"), a *Subagents · N* section while any works (one row
  each, five at most: a dot that pulses while its call runs, its type and the
  task the parent gave it, its model ("Haiku 4.5") and how long it has
  worked, its current call with how long it has run, how many calls it has
  made and what it has cost, *waiting on you* while it has a prompt
  outstanding; under them, muted, up to three that finished in the last 30
  minutes with model, duration and cost, "+N finished" opening the rest as
  rows; the header carries what all of the session's subagents cost — a
  cost is shown only when every turn behind it was priced, never as $0;
  every row opens in place, one at a time, to the task the parent gave it,
  its own calls live, what it answered and its numbers — owner, 2026-10-12:
  "can we expand the subagents to look inside?"; the hero's chips, groups
  of four up to two rows of twelve, open a row too), its last seven tool calls with what each acted on, how it ended and how long ago (a repeat folded to ×N; the Inspector in [04-ui.md](04-ui.md)), the
  uncommitted changes, the plan windows of its agent (each a bar with a tick
  where an even pace would be by the clock, the percentage large, and one
  line — *resets in 4 h 56 min · ✓ enough* or *⚠ out at 23:50*, amber, red
  under half an hour — from the daemon's `limit_at`, never computed here;
  `lib/pace.ts`. A click shows the exact reset and the forecast in words.
  Codex is never forecast, so its line has no verdict. The section header is
  the plan chip, to confirm or change the plan in place; owner, 2026-10-11:
  "I want to understand at once whether it's enough or not, in one line"),
  and a loop warning only
  while an alert is live. It is the screen that shows what only Caprock
  knows, so it is built from figures Caprock already holds and nothing else:
  the session row the sidebar polls, the main thread's newest 400 calls and
  turns (`events?newest=1&main=1&kind=tool.pre,tool.post,turn.assistant`;
  an unfiltered 400 held none of a busy parent's own calls, whose subagents
  logged 635 tool calls in an hour, and the list read *No tool calls yet*),
  fetched once and then followed on the live socket; the daemon's summary of
  the subagents (`/v1/sessions/{id}/subagents`), read again at most every two
  seconds while their events arrive and every twenty regardless, so their
  thousands of events never reach the page — one opened subagent is read
  once (`/subagents/{agent}`) and then followed on the socket; the session's permission prompt;
  and the day's summary for the plan windows, which are account-wide and
  labelled so. A figure an agent does not report is left
  out, never drawn as zero — no context bar without `context` (its
  `context_note` instead), no plan windows for an agent with none. A shell
  tab keeps the plain inspector (folder, changes, actions). Code:
  `components/Cockpit.tsx`, derivations in `lib/cockpit.ts`.
- **Claude Code's own status line: Full, Short, Hidden or Off** (owner, 2026-10-13:
  the cockpit already shows cost, turns and limits, so the full line inside
  Claude's TUI repeats it and crowds the bottom of the terminal). Settings →
  *Status line* (`components/StatuslineSetting.tsx`, `statusline_mode`),
  Full by default so nothing changes for anyone who does not choose. Short
  is model, context and the two plan windows, with the five-hour reset time
  only from 80%; Off removes Caprock's own `statusLine` entry from Claude
  Code's settings (never the user's own) and any other choice puts it back.
  The line reads the choice as it draws, and Off also stops Claude's plan
  windows reaching the cockpit, which the setting says. Hidden (owner, later
  the same day: the row should go but the limits must keep coming) keeps the
  entry and prints nothing, so Claude Code draws no row while the plan
  windows still reach the cockpit; the page recommends it under every other
  choice and never picks it for anyone
  ([03-contracts.md § Statusline](03-contracts.md#statusline)).
- **Session deck (under the agent's terminal)** (owner, 2026-10-11,
  translated: "I want to be able to enlarge the bottom area so that I
  basically type in the centre, a bit below the middle of the screen —
  that's comfortable — and in this new area show data useful to me while I
  work"). A full-width terminal puts Claude Code's prompt on the window's
  bottom edge; the deck is a band under the terminal of the agent in front
  that lifts it. It holds one cell, **Pull requests & CI** (owner,
  2026-10-12, translated: "Remove the Branch cell — put it somewhere else …
  CI/CD and Pull requests should simply be merged properly into one, with
  all the statuses and so on, plus at least a couple of previous PRs"; it
  was three cells — CI, Branch, Pull requests — until then). Its header ends
  in *Pipeline* (the Pipeline tab, ⌘P) and a × that hides the deck (⌘B,
  or *Pipeline bar: On/Off* in the palette) ([04-ui.md](04-ui.md) § The
  sidebar footer).
  - **Header.** The title; the session's branch as a mono chip, *feat/x →
    main* when the current PR is from it, its tooltip saying what is not
    committed or pushed and, beside it in amber, *3 not committed · 2 not
    pushed* (a click opens the Changes view, ⇧⌘G); the release chip
    *Release v0.109.1 · ~6 min* while a release builds (a click opens
    Release); in Main the branch and *runner* with its cost; the **PRs |
    Branches | Release | Main** switch, kept per viewer in `localStorage`. The chips give way below a
    480px container.
  - **PRs view.** The session's pull requests from `GET
    /v1/sessions/{id}/prs` — its latest four (`session_prs`): the open one
    (the current) first, then the earlier ones newest first, and *No earlier
    PRs from this session.* when there is one. A row: a state dot (green
    open, a hollow ring draft, violet merged, grey closed; `.pr-dot`,
    `--color-merged`), the number and title, the mini pipeline, the CI in
    words — *✓ 9m 10s · −6%* (the run's time and its delta, below), *✗
    failed at test (windows)*, *running · 3/5 · 4m 10s* (since the first
    check started, measured), *CI not started* (muted, for 10 minutes after
    the PR opened — GitHub often has not registered the checks yet) and *no
    checks* after that, never "CI no CI" — then the review GitHub returned
    (*approved*, *changes requested*, *review required*) and *conflict* when
    GitHub says it cannot merge, both only for an open PR, then the age
    (*now*, *5m*, *2h*, *3d*; since merged, closed or opened) and ↗ (the
    PR on GitHub). Columns line up row to row; the pipeline, then the
    review, give way as the deck narrows. A click on a row opens it in place,
    one at a time, into its GitHub Actions from `GET
    /v1/sessions/{id}/ci?pr=N`: *run 9m 10s · −6%* (one workflow), *runner*
    — the finished jobs' time from GitHub's own stamps plus the running ones
    on the clock, the minutes per OS beside it and in its tooltip, and its
    cost (below) — and *checks ↗*; then a row per job with a mark (an amber
    turning ring while it runs, ✓, ✗, ○ queued, – skipped or cancelled), its
    name, the step it failed at or is on, its OS (from the runner labels),
    its time ticking each second while it runs, and its time against its
    median. A job opens into its steps, and a failed step into the lines
    around the error in the job's log (monospace, scrolling, the error line
    marked) with *Investigate* and *Open on GitHub*. The jobs flow into as
    many columns as the deck's width holds — three at about 1300px, two at
    about 900px, one when narrow — each a fixed set of tracks after the name
    (OS, time, against the median, cost) so a column lines up row to row;
    an open job takes the whole row and its steps flow the same way (owner,
    2026-10-12, translated, of the 0.109 deck's one tall column with its
    right half empty: "see how much space is wasted, although the
    information is important and good — it was just laid out
    inconveniently"). One job is open at a time: opening one folds the one
    before and brings it to the top of the CI's scroll area, where its line
    stays pinned while its steps scroll under it, with *Fold Esc* at its
    end; the steps are never taller than that area and scroll on their own,
    so the open job fits a deck of any height. A click on the job, *Fold* or
    Esc folds it and the job goes back to its row, in view (owner,
    2026-10-12, translated, of the 0.111 deck: "when you start expanding
    things, you can't see a damn thing, and then it's impossible to
    collapse"). Esc folds the innermost open thing — the job, then the open
    PR — and only while the focus is in the deck, so the terminal keeps its
    own Esc; with nothing open it is not the deck's. Every PR row carries a
    chevron (right folded, down open), and the open PR's line stays pinned
    at the top of the list. The first failed job of each PR opens by itself. No
    PR opens by itself: the deck opens on the overview, every row on its
    line with its checks in one short group (*✗ 1 failed ✓ 11*, *✓ all 12 ·
    6m*; every check on hover); a row opened by hand is opened again the
    next time, kept per viewer and session, until it is folded (owner,
    2026-10-13, [04-ui.md](04-ui.md) § CI in the session deck). The same
    summary, a ring or the jobs by OS sit in the cockpit's CI block, from
    what the deck read ([04-ui.md](04-ui.md) § CI in the cockpit). Every row keeps its line and the open one's CI takes the
    height left, scrolling inside, so the earlier PRs stay in view; while a
    job or an error log is open they fold into one line (*also #13 ✓ #12
    ✓*) so it has the room. A settled PR's runs are read once while the deck is
    open, so its row carries its time against the median without being
    opened. While GitHub is not connected the rows show what the session
    recorded (open, merged) and *connect GitHub for CI* turns the integration
    on through the `gh` login in one click (ADR-047: this click is the user
    turning it on), else opens Settings.
  - **What stands in a PR's way, and forcing a fix** (owner, 2026-10-12, translated:
    "From the PRs I want to see, for example, when there's a conflict, or
    that you (an agent) are looking at it or fixing it — and if needed I want
    to FORCE a fix or a check"; 2026-10-13: "I understand it could get
    overloaded"). An open PR's row says at most one problem, the most
    important: *conflict* (red; `mergeable` false or `mergeable_state`
    dirty), failed CI, *behind* (amber; GitHub's own `behind`, which it
    reports when the base must be merged in first), *review* (changes
    requested), *draft*; GitHub still computing says nothing. It is a chip,
    except failed CI, which the CI words already say (*✗ failed at …*); the
    other problems are in the chip's tooltip. Beside it, one accent word that
    acts: *Fix* for a conflict, *Fix* and *Re-run* for failed CI, *Update*
    for behind. *approved* and *review required* stay words, giving way below
    a 1100px deck; the mini pipeline goes below 1000px, before the title
    gives way, and the CI words column is at most a fifth of the deck, so at
    860px the title keeps about half the row.
  - **Whether anything is on it** (owner, 2026-10-13, translated: "I want to
    see whether it's in the plan or in work"). One word before the chip, the
    first that holds: *in work* (accent, a small spinner: a live agent whose
    checkout — the sidebar's worktree row — is on the PR's head branch is
    working, or an action Caprock started is still running), *waiting* (an
    agent on the branch waits on you), *queued* (a message queued for an
    agent on the branch, or one queued elsewhere that names the PR's link, or
    GitHub's auto-merge on: `auto_merge` on the PR GitHub already returned).
    Nothing when nobody is on it. The agent's initial in a small tinted
    square sits beside the word (an idle agent is its initial alone), *+1*
    for more, the tooltip naming each; a click opens that session's tab. The
    queues are read per agent (`GET /v1/agents/{id}/queue`) with each PR
    poll, only for Caprock-started agents on open PRs' branches and the
    session itself. Tasks-board tasks are not matched: a task is not tied to
    a repository and only its body would name the PR.
  - **The actions.** Every open PR has a ⋯ at every deck width (and, while
    GitHub is not connected, every PR not known merged or closed) that opens
    its row with the focus on the line of actions under its header: the
    one-word action opens the same line in its row without opening the CI.
    *Fix conflict with agent* (with a conflict), *Update branch* (behind and
    no conflict), *Fix CI with agent* and *Re-run checks* (with checks; the
    re-run disabled while they still run). Each asks first in that line —
    the sentence, *Confirm*, *Cancel* (Esc), never a modal — then the row
    says *in work*, what it does in the word's tooltip (*agent fixing…*,
    *re-running 5 jobs…*, *updating branch…*), until GitHub shows it done
    (the checks running again, the head moving) or four minutes pass; the
    PRs are asked every 20 s meanwhile. Not connected, the four actions are
    there greyed with *Connect GitHub* beside them. They act on any open PR
    the cell lists (the session's `session_prs`), from the Mac only: a
    paired device that may only watch has them disabled with the reason. A fix goes to the
    Caprock-started agent on the branch as a queued message (ADR-053's
    queue); Fix CI otherwise goes to the session in front as Investigate
    does; else a new agent starts in the branch's checkout, or in a new
    worktree `pr-N-fix` at the PR's head (`worktree_pr`) when there is none
    or an agent Caprock did not start works in it — rule 7: nothing is typed
    into a process Caprock did not start, and the confirm says so. The
    conflict message asks to merge `origin/<base>`, resolve, run the checks
    and push (to `HEAD:<branch>` from a new worktree, whose local branch is
    `caprock/pr-N-fix`); Fix CI sends Investigate's message for the first
    failed job with its log, else one about flaky checks. Re-run and Update
    branch are GitHub's own (`POST /v1/sessions/{id}/prs/{n}/rerun`,
    `…/update-branch`; `.ai/03-contracts.md`), with the user's token; a
    refusal names the permission the token lacks — *Actions (write)*,
    *Pull requests (write)* — in the toast. Code: `lib/prforce.ts`.
  - **Time against the median** (owner, 2026-10-12, translated: "In CI runs
    I want to see the execution time plus an estimate relative to the
    average — plus or minus percent"). A run's wall-clock time (started to
    last updated) and each job's duration are set against the median of the
    same workflow's last five successful runs on the repository, jobs
    matched by name (`baseline` on runs and jobs, `github.WithBaselines`):
    *4m 45s +18%* once finished and passed — amber past +20%, green below
    −10%, muted between; while running *≈ 3m left* (an estimate, the
    tooltip giving *median 7m 40s*) and *+12% over median* once past it.
    The tooltip names the basis, *the median of the last 5 successful
    runs*. Fewer than two past runs is no figure at all (rule 6); a failed
    job has none (it stopped early). Reading the past runs costs one list
    per workflow per 30 minutes and one jobs read per past run, kept for the
    daemon's lifetime since a finished run never changes, and only the
    deck's routes ask for it.
  - **Release view** (owner, 2026-10-12, translated: "Can I also see here,
    in the deck, the status of the release build? And whatever else matters
    to me"): the repository's newest release build — the newest run started
    by a tag push or a release, found for any repository without knowing its
    workflow file (`GET /v1/sessions/{id}/ci/release`): its tag, a mark, the
    time so far ticking and *about N min left (estimate from the last K
    runs)*, the median of that workflow's last successful release runs from
    GitHub's own run times, or nothing when fewer than two exist; once done,
    *v0.109.1 · published 3 min ago ✓* linking the GitHub release (else
    *built*, or *failed … ✗*), then its jobs as a PR's, with steps, errors,
    *Investigate* and each job against its median.
  - **Main view**: the newest run of each workflow on the default branch, a
    header per workflow with its mark, mini pipeline and *run 9m 10s · −6% ·
    $0.10* (`GET /v1/sessions/{id}/ci/main`), so a red default branch shows
    at once. Above them, what GitHub itself billed for Actions this month,
    from its billing report (`GET /v1/github/actions-usage`, asked for the
    repository's owner only while this view is shown, kept 30 minutes by
    the daemon): *Actions this month: 1,240 min · $7.40* — net of GitHub's
    discount, which is how included minutes appear, the gross and the SKUs
    in its tooltip. When the token may not read billing, a muted *Real
    billing: needs the token's Plan (read) permission* (for an
    organization, Administration (read) as its admin) with *token settings
    ↗*; no report for the account is one quiet line; nothing while GitHub is
    not connected.
  - **Runner cost** (owner, 2026-10-12, translated: "can we add runner
    costs?"). Each finished job carries the daemon's price from the runner
    rate table (`pricing/actions.json`, `.ai/03-contracts.md` § Runner
    cost; worded in `lib/runnercost.ts`): beside its time, *4m 45s · $0.31*;
    a run beside its time (*run 9m 10s · −6% · $0.42*; with one run, said
    once, on *runner*); a PR row after its CI words (*✓ 9m 10s · −6% ·
    $0.42*, from the runs read for it). *$0 · public repo* (green) when
    every priced minute ran on standard runners in a public repository,
    GitHub's billing docs saying why in the tooltip; *unpriced* (muted) for
    a self-hosted runner or one the table does not know, the reason in the
    tooltip; *≥$0.42* while a job runs or could not be priced. Every
    tooltip says it is an estimate at list rate, before a private
    repository's included minutes, and names the table's version and source
    page. Nothing while no job has finished.
  - **Pipeline** (owner, 2026-10-13, translated: "I also want to expand
    the panel bigger, to see the statuses large and in detail, plus
    statistics … sometimes it's interesting to look"; renamed from *PRs &
    CI* and made one list on 2026-10-14, translated: "PR rows with their
    statuses, so I understand how things travel, what gets released"; a
    page of the dashboard for part of 2026-10-15, then, translated: "I want
    the Pipeline shown in the dashboard too, and as a separate page with
    its own tab — among the system tabs, next to the dashboard"). In the
    app `#/pipeline` is the **Pipeline tab**, pinned right after the
    Dashboard tab and before Mail, folded to its glyph and ⌘P like them
    (`Workspace.pipeline`, kept across restarts). ⌘P, the sidebar footer's
    *Pipeline*, the deck header's *Pipeline*, the palette's *Open Pipeline*
    or the cockpit's *Pipeline ↗* bring it to the front for the agent in
    front's repository, else where it was left (`screens/Pipeline.tsx`,
    `components/PipelineView.tsx`, words in `lib/prstats.ts`, steps in
    `lib/journey.ts`, the repository in `lib/pipeline.ts`); a picker in its
    head switches repository. The dashboard keeps its nav entry and Home's
    card; inside the Dashboard tab both lead to the Pipeline tab, so the
    page is drawn once, and hidden it asks nothing. A Pipeline pane tab
    stored before (`kind: 'prs'`) comes back as the Pipeline tab at that
    Pipeline, never as a dead pane (`pipelineInStore`). From it, *Back ⌘P*
    in its head, ⌘P, the footer's button or its × bring back the tab or
    screen it was opened from. ⌘B stays the deck. Off macOS the key is Ctrl+Shift+P
    (rule 12). ⇧⌘B, its key until 2026-10-15, still works and is no longer
    shown (Ctrl+Alt+Shift+B off macOS, where ⌘B's Ctrl+Shift+B is the
    deck's). `#/pipeline?…&pr=N` opens pull request N's detail as the page
    opens: a Work row's title links there. It is drawn as the
    dashboard's other pages are ([04-ui.md](04-ui.md) § The Pipeline). It
    shows:
    - **The figures** — in flight, needing a fix, ready, throughput a day
      over 14 days, the CI median, opened → merged, merged → released marked
      *estimate*, agent cost, as Stat tiles, each explained in a card under
      it (`board.flow` in [03-contracts.md](03-contracts.md) § `…/ci/stats`).
      Home's CI/CD panel shows the first five for the same repository.
    - **One list** of pull requests in three scopes — *This session*,
      *Repository* (the repository's 50 most recently updated, the default,
      kept per viewer) or *Open*. A row: its number, its whole title, its
      labels (GitHub's colour as a dot, at most six), the four steps *Open →
      CI → Merged → Released* as pills — the step it is on filled in its
      tone (*CI red* with a ✗, *CI running* with a turning ring, *CI green*,
      *Conflict*, *Changes requested*, the release's tag), the ones behind
      it checked, the ones ahead outlined — how long it has been on that step,
      and its agent cost. In flight first (needing a fix, CI running, ready,
      draft; longest-waiting first), then merged and not released, then
      released (newest first; ten, then *Show N more released*), then closed.
      The step is the board's (`board.cards[].stage`), else the pull
      request's own state (`journey` in `lib/journey.ts`, which the
      cockpit's bars use too). Below the list the releases, each with the
      pull requests it shipped and their agent cost.
    - **The chosen one** — a click on a row opens it beside the list (under
      it on a narrow window; `data-prs-detail`, × or Esc closes): its state, CI,
      merge state and review as large pills, branch → base, the diff's size
      (*+181 −59 · 13 files · 2 commits*, from GitHub's answer for the pull
      request), when it was opened and how long it took to merge; the
      deck's actions (lib/usePRForce, shared with the deck's rows); its jobs
      as a grid of job × runner OS (a matrix job's OS taken out of its
      name), each cell its state, time, time against its median and the
      step it failed at or is on; the jobs on the run's clock, each with
      its median as a tick; and a job's steps — the first failed job by
      itself — with the end of its log and *Investigate*. Its CI is read
      only while it is open.
    It asks only while it is the page in front and the window is visible,
    through the deck's routes and kept answers (it opens on what the deck
    last knew). The Board's six columns and the List's figures strip (red
    runs, Actions minutes) went with the one list.
  - **Branches view** (owner, 2026-10-12, translated: "seeing branches with
    statistics would also be interesting"; `GET
    /v1/sessions/{id}/branches`, `lib/branches.ts`): the session's
    repository's branches, the current one first, then by last activity
    (the later of the last commit and the newest Caprock session on it). A
    row: the name in mono (*current*, *default*, *origin* for one only on
    the remote, and a *stale* tag — no commit in 30 days and no open PR),
    ahead and behind the default branch (*↑3 ↓1*, *even*), its pull request
    (state dot, number, mini pipeline for an open one), what Caprock's
    sessions on it cost and how many (*$11.52 · 2 sessions*, at API list
    price, the agents in the tooltip), and the last commit's age and
    author (*3h · Ada*). Fifteen rows, then *Show all N*. A click on a
    branch with a PR opens that PR in the PRs view when it is one of the
    session's, else on GitHub. Below a 460px container the row keeps the
    name, the PR and the cost; the session count, the author and the tags
    give way first above it. The commits are local git (`for-each-ref`, no
    network); the PRs one cached list of the repository's 50 most recently
    updated; the cost one indexed query. Asked every minute while shown,
    every 20 s while an open PR's checks run.
  - **States and cadence.** The repository is the session's directory's
    remote; a folder with none, a remote off GitHub and GitHub not connected
    are one line each, the last with the connect button. No PR, no runs and
    a failed read are one short line each. The PRs are asked every 20 s
    while a check runs, else every minute (the Branches view too); the open
    row's CI and Main every
    12 s while a job runs, else every minute; the release build whatever the
    view, as often — all only while the deck is open and the window visible.
    The daemon keeps each PR 20 s while its checks run, 2 min once settled
    and 30 min once merged or closed, and a commit's runs 10 s while one runs
    and 2 min once settled, so a poll inside that costs GitHub nothing.
  - **Mini pipeline** (owner, 2026-10-12, translated: "I'd like the CI/CD
    stages together with the pull requests — like GitLab's pipeline
    indicators"; `components/MiniPipeline.tsx`): a circle per job — ✓ on
    green, ✗ on red, a turning ring running, hollow queued, a grey slash
    skipped or cancelled — joined by a thin line within a workflow and set
    apart between workflows, up to 14 and then *+N*. GitHub's API does not
    report `needs`, so the jobs stand in the order they started, the ones
    not started last. Hover names the job, its state and its time; a click
    opens that job, with its steps and error (for a PR row, that row opens);
    a check that is no Actions job opens its own link. A PR row's circles
    come from the checks already read, so they cost no extra request.

  The CI part replaced *Context*, which repeated the status bar (owner,
  2026-10-11, translated: "sacrifice it for CI/CD"). The minute chart, the plan windows, *Now* and *Spent* left the
  deck on 2026-10-11 (owner, translated: "we already have charts
  everywhere", "Spent doesn't help", "Working now is debatable"); the
  sidebar and the inspector carry them, and the deck holds no session
  events and no clock. Its top edge is a faint accent rule with a low glow
  upward (the first, brighter one distracted; a grey hairline lost the
  division), framing the line above it where the prompt sits. A figure the agent does not report is
  left out, never drawn as zero. ⌘B (Ctrl+Shift+B off macOS), a strip
  button beside the inspector's — labelled *Deck* with its key, since an
  icon alone left the deck unfound — and the palette open and close it; the
  Add project sheet's own ⌘B is not reached, since a sheet owns the
  keyboard. Its top edge is a separator: dragged, the band is drawn over
  the terminal at the new height and the terminal's box changes once, on
  release, so a drag is one fit and one PTY resize, not one per frame; ↑ ↓,
  Page Up/Down, Home and End move it and settle after 250 ms the same way;
  double-click restores the default (176px; a height kept before 0.107.1 is lowered by a third once). Clamped between 72px and 60%
  of the pane, the CSS height capped at 60% too, so a window made smaller
  never leaves the terminal a sliver. Closed by default; open and height
  in `caprock.app.deck` (`lib/deck.ts`). A shell tab has no deck and no
  button, and ⌘B there says why. Performance: a sibling of the terminals,
  so nothing in it redraws one; not mounted while closed, while a shell or
  the Dashboard is in front, so no clock and no subscription then; its
  events are the cockpit's, held once per session with a reference count
  (`lib/sessionEvents.ts`) — one fetch and one live listener for both, let
  go when the last reader closes. Code: `components/SessionDeck.tsx`.
- **Empty project (main, no tab open).** New agent, New shell, Add a
  project, then the project's six most recent agent sessions (ended ones
  nobody wrote in left out) with cost, age and one button: *Continue* resumes
  an ended one in a new tab, *Open* a running one. The sidebar is for what
  runs; this is the way back to what ended.
- **Status strip (bottom).** Connection state, plan limits (5-hour and 7-day)
  and today's spend while the sidebar is hidden (its Today strip carries
  them otherwise), with an agent in front what its processes use (*agent
  cpu 8.1% ram 413 MB*, which opens the last hour's CPU and memory charts
  and who uses the most, [04-ui.md § Status strip](04-ui.md)), what Caprock
  itself costs this computer — *caprock
  1.1 GB · 2.2 GB*, memory and disk, memory alone in a window under
  1,250 px, the warning colour with a dot when the doctor flags something,
  and a click (or the palette's *Caprock doctor*) opens `caprock doctor` as
  a panel ([04-ui.md § Caprock footprint](04-ui.md)) — the daemon's state
  and version — read again on every
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
- **F06 — Dashboard screens.** Home, Work, Session Detail, Cost, Lifetime,
  Pipeline, Memory, Week, Tasks and Settings are the existing React screens,
  opened in the same window. Switching to them never unmounts a visible
  terminal. **Work** (`#/work`, second in the nav, ⇧⌘W —
  Ctrl+Alt+Shift+W off macOS — and back, as ⌘P does for the Pipeline) is
  every piece of work on its way to a release ([04-ui.md](04-ui.md) § Work);
  Home shows its headline and first rows as a strip above the Live pulse.
  On both, a session row brings that session's tab forward (opening one
  when it has none) rather than its dashboard page: AppShell hands
  `onOpenSession` down through `PipelineHostContext`.
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
  1–9, new session, new shell, dashboard, find. Keys named after what they
  open (owner, 2026-10-15, translated: "bind shortcuts to the names"): ⌘D
  the Dashboard (⌘0 stays), ⌘P the Pipeline (⇧⌘B before, kept as a silent
  alias), ⇧⌘W Work, ⇧⌘T the theme picker at the foot of the sidebar,
  ⇧⌘F Send feedback; ⌘F stays Find and ⌘T New shell, a terminal's keys.
  Off macOS: Ctrl+Shift+D (never bare Ctrl+D, a shell's end of input),
  Ctrl+Shift+P, Ctrl+Alt+Shift+W, Ctrl+Alt+Shift+T, Ctrl+Alt+Shift+F — the
  three ⇧⌘ chords take Alt because their ⌘ twin (⌘W Close, ⌘T New shell,
  ⌘F Find) is Ctrl+Shift there (`OFF_MAC_ALT`). None is an item of Tauri's
  default macOS menu (there is no Print). **⌘W closes the tab, not the
  window** (owner, 2026-10-16, translated: "Cmd+W must close tabs"). Tauri's
  default menu put Close Window on ⌘W in File and in Window, and a menu's
  key equivalent is taken before the page sees the key, so ⌘W hid the
  window and the page's own ⌘W (the `detach-tab` command, the tab's ×
  with its confirm) never ran. `menu::install` swaps both: File → **Close
  Tab** holds ⌘W and, with the main window in front, dispatches
  `caprock:close-tab` (`CLOSE_TAB_EVENT`, `ui/src/lib/shell.ts`) to the
  page, which runs the same command the key would; with another window in
  front (Mail, the popover) it closes that window, as ⌘W always did
  (`menu::close_target`). Window → **Close Window** stays, with no key.
  With the Dashboard in front ⌘W does nothing: the window is put away by
  Close Window, its red button, ⌘H or ⌘M, never by a key that closes tabs
  everywhere else. Windows and Linux have no app menu, so Ctrl+Shift+W
  reaches the page directly; bare Ctrl+W stays the shell's delete-word.
  The full list
  is `SHORTCUTS` in `ui/src/lib/appkeys.ts` and docs/app.md § Keyboard.
- **F10 — Badge.** The dock (macOS) or taskbar (Windows) badge is the number
  of sessions waiting on you — the sidebar's marked rows: a permission prompt or
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
  check runs every 15 minutes and on focus (hourly from 2026-10-15, every
  6 hours before), conditionally
  ([04-ui.md § Update notice](04-ui.md#update-notice); § Updates).
  The `.dmg` opens on a branded window (`bundle.macOS.dmg` in
  `tauri.conf.json`, 2026-10-10): 660×400, caprock.dev's paper ground, the
  mark and wordmark, the app icon at (170, 196) and the Applications folder
  at (490, 196) in two soft wells with a dotted arrow between, and *Drag
  Caprock to Applications*. The picture is `app/src-tauri/dmg/background.png`,
  rendered from `background.html` beside it (one image at window size: the
  bundler takes PNG, JPG or GIF, so no @2x). CI's macOS app job mounts the
  built `.dmg` and fails without `.background/*.png` in it, and so does
  `make app-release`.
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
- **Typing into or signalling a process Caprock did not start** (rule 7; the doctor's per-item, confirmed stop is the one exception, ADR-059).
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

### A session on another computer (2026-10-18)

`bench/peer.mjs` ([bench/README.md](../bench/README.md)), ADR-067 PR3: two
throwaway daemons on one Mac — a target and a controller, each with its own
HOME, data directory and port, a clean environment and the fake `claude` —
and `caprock remote relay` on loopback. The controller pairs by link, the
target allows it, the controller starts the session on the target through
`/v1/m/{id}/…`; then one key at a time, timed from the send to the frame
that echoes it (the target's tty echo, terminal protocol v2), 400 keys a leg
in two alternating rounds, 40 ms apart. *Local* is the target's own terminal
socket; *peer* is the same session through the controller's proxy, the
relay, Noise and the target's Host. Raw JSON:
[bench/results-2026-10-18-peer/peer.json](../bench/results-2026-10-18-peer/peer.json).

Measured on 2026-10-18 (00:31 local), Apple M1 Pro, 10 cores, 16 GB, macOS
27.0 (Darwin 27.0.0), on the owner's working Mac with a one-minute load of
27 (a busy machine, not a quiet one):

| Leg   | Keys | Median  | p95     | Max      |
| ----- | ---- | ------- | ------- | -------- |
| local | 400  | 2.14 ms | 47.8 ms | 87.6 ms  |
| peer  | 400  | 2.47 ms | 56.8 ms | 103.0 ms |

What it says, and what it does not:

- On one machine, the hop through the proxy, the relay and Noise added 0.33
  ms at the median and 9 ms at p95. That is the cost of Caprock's own path,
  not of a network: both daemons and the relay were on loopback.
- It does not measure two computers on a home network, from abroad, or the
  hosted relay (`relay.caprock.dev`): OQ-17 and OQ-18 stay open for those
  ([12-risks.md](12-risks.md)), and no latency figure for a real link is
  stated anywhere public before they are measured (rule 6).
- The p95 of both legs is the busy machine's; re-run on a quiet one before
  reading the tail.

### A hidden window does no work (2026-10-13)

The owner measured the WebContent process of an app window with nothing
happening using about 3% of a core, and more while sessions streamed. The
rule since: a hidden window does no work, and a visible idle one almost
none ([04-ui.md § A hidden window does no work](04-ui.md#a-hidden-window-does-no-work)).
Found with a headless profile of the workspace (nine tabs, four agents at
work) and fixed:

- **A hidden window redrew for every hook event.** Each frame of the live
  socket went to React whether or not the window was shown: about as many
  commits a second hidden as visible. Frames are now held while hidden and
  applied together every 2 s (urgent ones at once), and the debounced tick
  and every poll and clock rest.
- **Timers woke a hidden page.** Polls skipped their ticks while hidden but
  kept their intervals; they now clear them. Each `useApi` hook ran its own
  debounce timer per burst, and one was set for frames that move no tick;
  now one timer per pace, only for a new tick.
- **A hidden terminal blinked and drew.** The tab in front kept parsing and
  drawing output, and its cursor blinked, with the window hidden.
- **Clocks redrew whole screens every second.** The cockpit, Now and the
  Session screen (thousands of timeline rows) re-rendered each second to keep
  "4m ago" current; now seconds only while something is that fresh.
- **Live screens rendered per event.** The Session timeline, Live activity,
  the pulse and the cockpit's events now apply a 250 ms batch at a time.

The popover renders nothing while closed (its tick is held, its fetches were
already gated on being shown). The shell's own supervisor polls `/healthz`
every 500 ms while the window is shown and every 5 s while it is hidden, in
the app's process, not the page's; unchanged.

### Typing beside busy agents (2026-10-09)

The owner found typing sluggish in 0.94.0 with several agents at work.
`bench/busy.mjs` (bench/README.md) measures that case: nine tabs over three
projects, one hidden tab printing 20 lines a second, four agents sending a
hook event every 200 ms, 200 keys typed into a silent tab, in Playwright's
headless Chrome (GPU on, ANGLE Metal) on the M1 Pro. Other agents loaded the
machine (1-minute load average 20–48 on 10 cores), so single runs vary;
the main-thread figures below repeat across runs, the echo tails less so.

Found, each measured on its own, and fixed:

- **Every live frame redrew the workspace.** `useLiveTick` read the tick
  through `useLive()`, which re-renders on every frame, and debounced only
  what it returned; `useDaemonVersion` and the permission card did the same
  for the connection state. The workspace — sidebar, tab strip, inspector,
  all nine terminal panes — committed 772 times in a 50 s typing run (722
  of them the whole `AppShell`). Now the tick is debounced before React sees
  it, the others read one field, session and project frames are applied
  together at most every 300 ms, an unchanged refetch keeps the list it
  had, a pane is redrawn only when its session, visibility or focus
  changes, and the tray's summary re-renders nothing when it is unchanged.
- **Hidden tabs did terminal work.** xterm redraws every row of a hidden,
  DOM-rendered terminal on each scroll (its selection refresh ignores the
  paused renderer) and measures each glyph again, because a `display: none`
  box measures zero and is never cached. One hidden tab at 20 lines a
  second took the page's main thread from 7.6% to 19.5% busy. A hidden pane
  now holds what arrives after its first output and writes it when shown;
  past 256 KB it lets the socket go and the daemon keeps the rest.
- **The working dots repainted every frame.** The Today strip's and the
  cockpit's pulses animated `box-shadow` (and the cockpit's scan line
  `background-position`), which restyle and repaint on the main thread at
  60 fps: with nothing else running, the one dot held the main thread 7.6%
  busy, 0.2% with it paused. They now animate `transform` and `opacity` on
  a pseudo-element, which the compositor runs.
- Measured and not a cause: the links addon (its provider runs on hover,
  not on render) and WebGL (only panes in front hold a context).

Three busy runs per build, each on a fresh stand killed before the next,
the builds interleaved, 14:47–14:52 with the machine quiet again (load
average 3.5–7.8). Echo is in ms, from the key event to the frame after the
echo is parsed; a run is about 55 s:

| Busy run, per build        | 0.93.1            | This change       |
| -------------------------- | ----------------- | ----------------- |
| Echo p50                   | 6.8 / 7.0 / 7.0   | 4.5 / 4.1 / 4.3   |
| Echo p95                   | 16 / 17 / 17      | 17 / 14 / 15      |
| Echo max                   | 22 / 25 / 32      | 28 / 24 / 21      |
| Long tasks                 | 0 / 0 / 0         | 0 / 0 / 0         |
| Main thread busy           | 5.8 / 5.5 / 5.7 % | 3.4 / 3.6 / 3.3 % |
| React commits while typing | 805 / 784 / 776   | 411 / 423 / 406   |

The same runs with the machine at a load average of 80–256 (other agents'
builds) spread far wider — p95 24–137 ms and up to 75 long tasks on master
— and this change still had the fewest long tasks (0 / 1 / 0) and the
least main-thread time (2.7–4.8%). What is left of the commits is the
workspace taking session and project updates (at most about three a second)
and the live ticks; the terminals are not among them. The p95 is the frame
and the machine, not the page: it did not move on a quiet machine.

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
  for when no daemon answers; on a dark system it is drawn in Dark Pastel's
  colours (`app/fallback/fallback.css`), the dashboard's default dark palette
  since 2026-10-13, so the window does not change palette once the daemon
  answers. Both windows are transparent with no background colour of their
  own; the first paint is the page's (the pre-paint script in
  `ui/index.html`, then `tokens.css`, which paints Dark Pastel for a dark
  `<html>` nothing has marked yet). The React code detects the app
  (`window.__TAURI_INTERNALS__`) and turns on the app-only surfaces: tabs
  layout, native notifications instead of in-page ones, the badge.
- **The shell talks to the page through Tauri commands**, allowlisted for the
  daemon's origin only: `notify`, `set_badge`, `set_tray`, `register_hotkey`
  (with `hotkey_status`; built in WP-10, app/README.md),
  `open_external` (https and the editors' schemes, and `tg:` only when an app handles it), `daemon_status`, and
  the updater's `app_update_status`, `app_update_check`,
  `app_update_download` (Update automatically, ADR-042 as amended
  2026-10-15), `app_update_install` and `app_update_asked` (F20), and `open_mail_app` and
  `open_mail_window`, which open Mail in a window of its own (below). No
  shell, filesystem or HTTP plugin is exposed to the page. The bundled
  fallback page, on the app's own origin, alone gets `start_daemon`,
  `update_daemon` and `set_background` (built in WP-02; the others arrive
  with their work packages).
- **Mail opens in a window of its own, never as a workspace tab** (owner,
  2026-10-15, translated: "it should be native — either call the installed
  app, or show a big banner to go there"). The sidebar's *Mail*, ⇧⌘M and the
  palette ask `open_mail_app` first: on macOS the installed Caprock Mail
  preview (`app/mail-mac`, bundle id `dev.caprock.mail.preview`, in
  /Applications or ~/Applications) is launched or brought forward with
  `open`. Without it, `open_mail_window` opens a second window of the app,
  *Caprock Mail* (label `mail`, `src-tauri/src/mail.rs`), on the daemon's
  `/?mail=1` — Mail alone, no sidebar or tabs — with the main window's link
  rule and download handling, and a capability of its own that grants
  `open_external` alone (`capabilities/mail.json`). It follows the daemon to
  a new port and reloads after a swap, as the popover does. The Mail tab is
  left for a browser (under a banner that opens `/?mail=1` in a browser
  window) and for a shell older than these commands. .ai/04-ui.md § Mail.
- **The daemon supervisor** reads `runtime.json`, starts the bundled binary
  when no daemon answers, and never stops a daemon it did not start — save
  one case on macOS: a Homebrew formula's daemon, moved onto the app's own
  once when that is not older (ADR-040). On every OS it also replaces its
  own daemon once per launch when the bundle carries a different one
  (ADR-040, amended), so the daemon follows the app up, down and to a local
  build. Until 0.106.0 that replacement ran on macOS alone, and a Windows
  app updated past its daemon kept the old one running for good. On
  Windows the running `caprock.exe` is renamed aside before the copy (a
  running exe can be renamed, not overwritten).
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
  port it reloads the main window, the popover and the Mail window (the
  URL, hash route included, is kept). On another port the page moves there on the same
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
  with `since` below 256 KiB (xterm.js's write callbacks), or after 15 s
  with no write callback at all: a pause must not outlive the callbacks it
  waits for.
- **Hidden tabs.** A tab not visible for 30 seconds closes its socket; showing
  it reconnects with `since`. Waiting and permission state come from
  `/v1/live`, never from the terminal socket, so a hidden tab still badges.
- **Input ownership.** No locks. Any client allowed to type may type; a phone
  can never lock the desktop out (the failure seen in the reference app's
  issue tracker).
- **Size.** The terminal in use sizes the PTY, as tmux's `latest`
  ([03-contracts.md § Terminal socket, protocol v2](03-contracts.md#terminal-socket-protocol-v2)).
  Typing makes a terminal the one in use on the daemon's side; on a desktop
  (`TerminalPane`, and `TerminalView` on a fine pointer) so does looking at it
  — the window gaining focus or coming into view, the tab coming to the front,
  a click in the pane — sent as `{"focus":true}`, debounced to one claim per
  100 ms (`TermClient.focus`). A touch device claims only by typing: picking
  a phone up is not taking the session over. Merely attaching never resizes:
  a phone opening the Terminal tab is drawn at the desktop's size until it
  types, and the desktop takes the PTY back, with a full repaint, the moment
  it is focused, clicked or typed into. It used to be "the last resize wins",
  and the desktop only sent a size when its own box changed (Vova,
  2026-10-12). Every claim carries the terminal's size, and focus anywhere in
  the pane counts, the composer included (it types over HTTP, so the daemon
  never sees it as input). Going out of sight gives the PTY back at once, on
  every device: the page hidden, a phone locked or sent to the background, a
  tab hidden behind another, or the page going away sends `{"blur":true}`
  (`TermClient.blur`), and the daemon hands the PTY to the terminal in sight
  used most recently. Without it the desktop stayed at the phone's width after
  the phone was put away, until the session was reopened (Vova, 2026-10-13).
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
- **Multi-repo projects** (owner, 2026-10-12, translated: "both monorepo and
  several repos … very important and must be done carefully";
  [ADR-055](08-decisions.md)). A folder holding several repositories is one
  project with named members (migration 0050): one sidebar row (*work · 3
  repos*, the members in its tooltip), its sessions and spend summed, and on
  its page (`ProjectRepos.tsx`) each member's branch, ± changed, ↑↓, open
  pull requests and share of today's spend. *Edit* there
  (`ProjectEditor.tsx`): rename, tick and untick members, *Rescan* the
  folder, merge repository projects in, split into one project per member.
  Nothing deletes a file. A session in a member is its own row under the
  project with that member's branch, which the deck shows. Agents start in
  the folder; one started inside a member gets the others as `--add-dir`.
  Members are not watched (contract in 03-contracts.md § Projects and
  shells). A monorepo stays one repository with its per-directory split.

## Composer

An optional box under an agent's terminal to write a message in (owner,
2026-10-13, translated: "if it's optional and can be switched on and off,
why not; the main thing is no abrupt change"; earlier: "the area where you
type isn't highlighted enough"). Built in `ui/src/components/Composer.tsx`
and `ui/src/lib/composer.ts`.

- **Off by default, and off changes nothing.** Settings → Terminal →
  *Composer: type in a box under the agent*, kept per viewer in localStorage
  (`caprock.app.composer`) like the terminal's appearance; every pane follows
  at once. The pane's tree has the same shape on or off (an inner box that
  fills the pane when there is no composer), so switching never remounts the
  terminal's host, and with it off the pane is pixel-identical to before
  (compared against a master build, 2026-10-13: zero differing pixels in the
  terminal's area). Its own ⋯ menu turns it off again; there is no pane menu
  to put the switch in, and adding one would change the pane with it off.
- **Which panes.** A session Caprock started, live, not detached, not a
  shell (`composerFits`, the same test as `typeable` in `lib/prforce.ts`):
  rule 7, it never types into a session from another terminal. App
  workspace only (`TerminalPane`); the phone and the dashboard's terminal
  are unchanged.
- **Sending** is the chat's queue path, `POST /v1/agents/{id}/queue`
  (ADR-053): typed in at once at the prompt, otherwise held and typed when
  the turn ends. The daemon types each line break as ESC CR and Enter after
  a pause (`promptBytes`), so several lines arrive as one message — checked
  with the fake agent, which keeps ESC CR in its prompt as `↵`, and received
  `first line of the message↵second line, same message` as one line. While a
  message waits the box says *queued · sends when the agent is free*.
- **Keys.** Enter sends, Shift+Enter is a newline in the box, Esc goes back
  to the terminal (after closing a picker). ↑ and ↓ on an empty box, or one
  still showing a history entry, walk the last 50 messages sent from it to
  that session (localStorage, `caprock.composer.history.<id>`). No global
  shortcut: the placeholder's keys go through `keys()`, so Windows and Linux
  read *Enter* and *Shift+Enter*.
- **Focus is never moved behind the user's back.** A click in the terminal
  focuses the terminal, a key typed there stays there, and showing a tab
  focuses the terminal as before. A permission prompt (the live permissions
  set, or the queue's `permission`/`question`) tints the box's edge amber and
  says *Claude is asking — answer in the terminal (1/2/3)*.
- **Pickers, saved prompts, images.** The chat field's `/` and `@` pickers
  (`useChatPicker`), the session's saved prompts behind a *Saved* button (a
  pick fills the box, never sends), and a pasted image handed to the
  terminal's own paste path (`attachTerminalInput().sendFiles`), so Claude
  Code shows `[Image #N]` in its prompt and the words sent from the box
  follow it.
- **Look.** `.app-composer` in `tokens.css`: the slab's own ink at 5% over
  the terminal's ground, a hairline at rest, the accent edge and a 3px
  accent halo when it has the keyboard, in every terminal palette.

## Quick replies

One-click replies to a running session (owner, 2026-10-15: "one-click quick
replies to a running session: Continue, Shorter and the like"). Built in
`ui/src/components/QuickReplies.tsx`, `ui/src/lib/quickReplies.ts` and
`internal/config/quickreply.go`.

- **Where.** A row of small chips under the terminal of a session Caprock
  started — live, not detached, not a shell (`composerFits`, rule 7) — above
  the composer when it is on, and whether or not it is; and above the chat's
  field while the chat can type (`ChatView`, the phone's chat included). A
  session Caprock only watches never gets the row, and the daemon refuses
  its queue whatever the page draws. A sibling after the terminal's box, so
  it never remounts the host.
- **Sending** is the composer's path, `POST /v1/agents/{id}/queue`
  (ADR-053): the reply's fixed text, typed in at once at the prompt,
  otherwise held and typed when the turn ends; the daemon types a line
  break as ESC CR and submits with Enter after a pause. The chip clicked
  shows a tick for a moment; a refusal says *Not sent: <why>* beside the row.
  A click keeps the keyboard where it was (the terminal or the box).
- **The list.** *Continue* (`Continue.`), *Shorter* (`Shorter, please: say
  it in fewer words.`), *Explain* (`Explain what you just did and why.`),
  *Run tests* (`Run the tests and fix what fails.`), *Commit* (`Commit the
  changes with a clear message.`) — `config.DefaultQuickReplies`, until the
  user changes them in Settings → Terminal → *Quick replies*: add, remove,
  reorder (↑ ↓), rename; at most 10, a label of 24 characters, a text of 300
  bytes. Kept by the daemon (`settings.quick_replies`, 03-contracts § Settings),
  so the app, a browser tab and a paired phone draw the same row; an empty
  list draws no row. A chat (ADR-071) leaves out *Run tests* and *Commit*,
  known by their default text (`forChat`), since a chat has no repository; a
  reply the user wrote or reworded is kept there too.
- **Keys.** None: no new global shortcut (rule 12); the chips take Tab
  focus like any button.
- **Look.** `.app-quick` in `tokens.css`: 22px pills in the slab's own ink
  over the terminal's background, like the composer's box, so they read on
  a dark or a light terminal palette. Off the slab (the chat, the phone's
  included) they sit on the page's own panel instead: `--color-term-bg` is
  dark in every theme there, and drew dark pills on a light chat until
  2026-10-16.

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
- **Closing a shell's tab closes the shell** (owner, 2026-10-09: "close means
  really close", translated). Until then the × of a shell's tab, in the strip
  or the sidebar, and ⌘W left the shell running, and it came back as a muted
  *Shell* row: idle shells piled up as ghosts. Now it behaves as iTerm,
  Terminal and VS Code do. The daemon names the shell's foreground program
  (`program` on `GET /v1/shells`, [03-contracts.md § Projects and
  shells](03-contracts.md#projects-and-shells-desktop-app-wp-05-wp-07-wp-08)),
  and the app, asking for the list fresh at the moment of closing:
  - ends an idle shell with the tab, through the same kill as *Stop the
    shell…*, without asking;
  - asks about a busy one — *Shell 1 is running claude. Close and stop it?* —
    with **Stop and close**, **Keep running, close tab** and **Cancel**;
  - leaves agent tabs as they were: closing the tab of Claude Code, Codex or
    any agent never stops it — except a quick chat, which ends with its tab
    (*Closing a quick chat ends it*, above).

  The same holds for a shell's pane in a split. A shell running a program
  reads *Shell 1 · claude* in the strip and the sidebar. A shell left running
  with no tab — kept by *Keep running, close tab*, or from before this — is
  still the muted row with ■ to stop it.

  *Close project* (a project's ×) does the same for every shell of the
  project, with a tab or without: idle ones end, and when some run a
  program one question lists them — *alpha: Shell 1 is running claude,
  Shell 2 is running npm. Stop them and close?* — with **Stop and close**,
  **Keep them running, close tabs** and **Cancel**. Its agents are never
  stopped. The project's ⋯ menu *Close tabs* still only closes tabs.
- **Links in a terminal** (`ui/src/lib/termlinks.ts`, .ai/04-ui.md § Session
  Detail). ⌘-click (Ctrl+click off macOS) opens a link in the default
  browser, through the shell's `open_external`. ⇧⌘-click (Ctrl+Shift+click)
  on an http(s) link opens a chooser at the pointer: the browsers installed
  here, the default first and marked, then *Copy link* (owner, 2026-10-17).
  The daemon finds them (`internal/browser`, `GET /v1/browsers`: LaunchServices
  on macOS, the registry's StartMenuInternet on Windows, `.desktop` entries
  for `x-scheme-handler/http(s)` on Linux) and opens a picked one
  (`POST /v1/browsers/open`), a process Caprock starts (rule 7). The
  chooser's rows are entry kinds (`lib/linkchooser.ts`); *Open in Caprock*
  follows the browsers while the in-app browser (beta, ADR-075) is on, and
  is not listed while it is off.

## File tabs

The owner asked (2026-10-09) to read a project's files inside the app —
Markdown at least, code too — without adding weight to a window that is
already at the edge of what it should carry. So a file is a **tab kind**,
not a panel or a screen: it sits in the strip beside the terminals, closes
with ⌘W and is restored on relaunch like them
([04-ui.md § The app workspace](04-ui.md#the-app-workspace), File tabs).

- **Read-only.** `GET /v1/projects/{id}/file` and `…/files`
  ([03-contracts.md § Files](03-contracts.md#files-read-a-projects-file)):
  a path resolved, symlinks included, inside the project's folder or the
  worktree's; 1 MB at most; a binary says so and sends nothing. Editing
  stays the editor's (*Open in …*).
- **Light.** No syntax highlighter and no Markdown library: Markdown goes
  through the chat's own renderer read as a document, code is plain
  monospace with line numbers. The bundle gains a few kilobytes, not a
  grammar set.
- **Opened from** the Changes view, the cockpit's changed files, a relative
  link in a Markdown file, and ⌘K → *Open file…* (git's file list, filtered
  in the browser).
- **Kept current without a timer**: read when the tab comes to the front,
  on focus, and when a `project` frame or an agent's edit of that path
  arrives on the live socket.
- **A phone may read** what a paired viewer may already read in a diff; it
  cannot write anything here.

## Browser tabs

The in-app browser, beta, off until Settings → *In-app browser (beta)* turns
it on; with it off no page window is ever made. Decided in
[ADR-075](08-decisions.md), which also records why 0.123.0's Page tab
crashed (ADR-070); what the user sees is in
[04-ui.md § The app workspace](04-ui.md#the-app-workspace), *Browser tabs*.

- **A tab kind, apart.** `page` in `ui/src/lib/tabs.ts`: after every other
  tab behind a divider, a globe and the page's title, no ⌘1–⌘9, no sidebar
  row, never split, never counted as an agent.
- **A window of its own, never a child webview.** Each page is a top-level
  `WebviewWindow`, `browser-<id>` (`app/src-tauri/src/browser.rs`),
  borderless, laid over the tab's content box: a child window of the main
  one on macOS (moves with it), owned on Windows and transient on Linux
  (moved by the shell when the main window moves or resizes; Wayland may
  not let it be placed). The main window keeps its one webview, so
  `get_webview_window` and the drops (§ Dropping a file) work as without a
  browser. One command, `browser_tab` (`{id, act}`; app/README.md § What a
  page may call): open, place, show, hide, close, go, back, forward, reload,
  focus, pause, retain.
- **Kept where it was.** Behind, the window is hidden, never reloaded or
  unloaded. A page is closed only with its tab, when the switch is turned
  off, or when a reloaded dashboard no longer has its tab (`retain`); a
  closed page is hidden, sent to `about:blank` and closed 1.5 s later, so
  its WebContent process is done with it first (the 0.124.0 crash, ADR-075).
  A dashboard reload hides every page; the tabs that come back show theirs.
- **Opened from** File → *New Browser Tab* (macOS, a globe), ⌘K and the +
  menu, an address typed into ⌘K, *Open in Caprock* in the link chooser
  (`caprockEntry`, `openInCaprock` in `ui/src/lib/browsertab.ts`), and a
  page's own new window (target=_blank, `window.open`): another tab, never a
  popup. ⌘-click keeps opening the default browser.
- **A new tab starts in its address box**; plain words search with the
  engine chosen in Settings (DuckDuckGo by default).
- **Keys**: ⌥← ⌥→ step between tabs while a browser tab is in front, outside
  a text field (Ctrl+PageUp and Ctrl+PageDown off macOS, where Alt+← → are
  Back and Forward); ⌘L (Ctrl+L) the address box; ⌘W closes the tab. The
  page reads these through the shell's `KEYS_SCRIPT`, which hands each over
  as a refused navigation to `caprock-browser:<key>`; every other key is the
  page's.
- **A stranger to Caprock**: no capability names `browser-*`; its store is
  non-persistent and its own; it follows only web schemes; a download goes
  into Downloads, never opened.
- **An agent waiting on you** while a browser tab is in front: a strip names
  it with *Go* and a playing video is paused (Settings; #618's idea).
- **Not verified in a real run** (ADR-075): the overlay on Windows and Linux,
  Wayland placement, `navigator.clipboard` and drops inside a page.

## Feedback screenshots

The feedback box (`.ai/04-ui.md` § Feedback) carries its screenshots to
GitHub by clipboard. In the app three commands do the native parts
(`src-tauri/src/capture.rs`), granted to the daemon's page alone:

- **`clipboard_image`** takes a PNG as the request's raw body, decodes it
  (`tauri::image::Image`) and writes it with the clipboard manager plugin
  (arboard). The page's `navigator.clipboard.write` with an image depends on
  the webview — WKWebView wants it inside the click, WebKitGTK may not have
  it — and the shell's clipboard does not. The plugin's own JavaScript
  commands are granted to no page.
- **`capture_webview`** returns the calling page as PNG bytes, drawn by its
  own webview: `takeSnapshotWithConfiguration:` on macOS (an `NSImage`,
  encoded through `NSBitmapImageRep`), `ICoreWebView2::CapturePreview` into
  an in-memory stream on Windows. Neither touches the screen, so neither
  needs the Screen Recording permission that capturing a window through the
  OS (CGWindowList, the dev-only `snapshot` feature) asks for. Linux answers
  "not supported": WebKitGTK has `webkit_web_view_get_snapshot`, but it could
  not be built and checked where this was written, and the page hides the
  button there (`captureSupported` in `ui/src/lib/shell.ts`). The command
  waits at most 5 s for the webview.
- **`read_dropped_image`** reads a file only if its path is one of the last
  native drop's (the drop handler records them in `capture::Dropped`), its
  extension is png/jpg/jpeg/gif/webp, and it is a file of at most 10 MB. Any
  path at all would make the command a file reader for whatever page the
  window shows.
- **`read_dropped_text`** keeps the same rule for the brief of New project
  from a template (§ Dropping a file): one of the last drop's paths, a
  `.md`, `.markdown` or `.txt` file of at most 1 MiB, returned only when it
  is UTF-8. Unit-tested in `capture.rs`; the ACL test refuses it to every
  other origin.
- **Verified**: macOS by `cargo clippy -D warnings` and `cargo test` (the
  path rules, and the ACL: another origin is refused all three); the Windows
  code by `cargo clippy --target x86_64-pc-windows-msvc -D warnings` on a
  crate holding `capture.rs` alone (the app's own cross-check stops at
  `ring`'s C build). The capture and the native clipboard were not run in the
  app before they shipped: running the app on the owner's machine would have
  taken his clipboard and could have adopted his daemon.

## The first click

The first click on a Caprock window that is not in front reaches the page
(2026-10-15). The main window is built with `accept_first_mouse(true)`
(`shell.rs`): macOS otherwise spends a click on an inactive window on
bringing it forward, and the tab strip sits in the overlay title-bar band, so
closing a tab with its × from another app took two clicks — the first one
only focused the window. Windows and Linux already pass that click through;
the setting is a no-op there. Dragging the window is unchanged: the strip's
empty space and the sidebar's top keep `data-tauri-drag-region`, and a press
that moves still drags the window, while a press that does not lands on what
is under it, as before. The popover and the other windows keep the default.

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
  the order holds. An image path goes in as a bracketed paste instead, so
  Claude Code shows `[Image #N]` ([04-ui.md](04-ui.md), § Paste or drop
  files).
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
- **A dialog over a terminal takes the drop.** While any dialog is open
  (a `[data-dialog-backdrop]` is in the page) no terminal types a dropped
  path: the file was aimed at the dialog, not the terminal under its
  backdrop. Feedback reads an image from such a drop through the shell
  (§ Feedback screenshots), and New project from a template reads a `.md`
  or `.txt` dropped on its Brief step as the brief (`read_dropped_text`,
  the first path only; [04-ui.md](04-ui.md) § New project from a template).
- **The popover** shows no terminal and keeps the default handler, so a
  drop there does nothing.
- **Verified** by unit tests on both halves (`shell.rs` script, the
  terminal's routing and quoting), by `make e2e` (the page's half in a
  browser: the event types the quoted path into the terminal under the point
  only), and by `main.rs`'s mock-app tests (the handler records a drop on the
  `main` webview; the listener is registered with `on_webview_event`, never
  `on_window_event`). A real Finder drag needs a person: OS automation is not
  used from tests.

Where it goes (`routeDrop`, lib/xtermInput.ts): a dialog on screen takes
it (Feedback, a sheet); else the terminal under the point; else the
terminal used last that is on screen; else the only terminal on screen;
else a short note says to drop it onto a terminal. A drop is never dropped
without a word — it used to reach only a terminal whose box held the point,
and a drop on the tab strip or a margin read as "drag and drop is broken
again" (owner, 2026-10-16).

The shell hears a drop both as the window's event and as the dashboard
webview's (`WindowEvent::DragDrop`, `WebviewEvent::DragDrop`): which one
Tauri sends depends on whether the dashboard is the window's content or a
child of it. 0.123.0 made it a child (the `unstable` feature, for the Page
tab) while listening on the window, and no drop arrived; 0.124.1 removed the
Page tab and listens for both. The in-app browser that came back (ADR-075)
puts each page in a window of its own, so the main window's drops are what
they were; a file dropped on a page is the page's (its window's own drop
handler is off).

## Notifications

- **One source.** `internal/alerts` already decides when the phone hears about
  a session (ADR-036). It gains a second sender: a neutral `notify` frame on
  `/v1/live`, `{id, seq, kind, session_id, project, title, body, prompt_id?,
  actions?}`, with `kind` one of `approval`, `finished`, `loop`, `limit`,
  `error`. Telegram and the app read the same decision; the rules, cooldowns
  and hourly cap are the same. A queued message's turn ending is a
  `finished` alert at once, titled *Queued message done*
  ([03-contracts.md § Queue](03-contracts.md#queue)).
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
  `online`, window focus and network type change; the ping and 25-second
  dead deadline of protocol v2 on `/v1/live` as well. A client between
  sockets is watched every second too, so a thrown `WebSocket` constructor or
  a lost timer cannot end the retries; after 3 failed tries or 10 s down the
  state offers **Reconnect now** (2026-10-15, after Vova's terminals all
  stayed at *Reconnecting…* past a Wi-Fi drop until each tab was closed).
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

- **The phone home and the Inbox** (2026-10-13, ADR-056). What the
  home-screen app opens to: what waits on you, Continue, Saved, and one
  field docked at the bottom that starts a chat in a chosen project or
  saves a note or photos to the Inbox, which the Mac lists in Quick chat
  ([04-ui.md § The phone home](04-ui.md#the-phone-home)). Manifest
  shortcuts and a share target are declared and need `https` (OQ-12).

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
- **A browser tab's page gets nothing at all** (ADR-075): its window,
  `browser-<id>`, is named by no capability, so it is refused every command
  even on `127.0.0.1`; its store is non-persistent and its own; the one
  script the shell gives it reads the browser keys and can call nothing.
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
  Developer account ($99 a year); until then, release builds are signed
  with a stable self-signed certificate so macOS keeps privacy answers
  across updates ([§ Privacy prompts](#privacy-prompts-on-macos)), other
  builds ad-hoc, and the install page says how to open an app from an
  unidentified developer.
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
(ADR-040). What follows from Caprock having no Developer ID yet:

- **A session asks in its own name** (ADR-044). Until then the daemon was
  the program that asked for every session it ran: a pty-host and the agent
  under it were attributed to the daemon launchd started, so an agent
  reading `~/Downloads` asked as "caprock". Every session, shell, verify
  command and login-shell read now starts through `internal/disclaim`,
  which re-executes it with its responsibility disclaimed; the prompt names
  `claude` (Developer ID signed, so the answer survives its updates and
  Caprock's), `codex` or the shell.
- **The daemon's own background reads skip guarded places**
  (`tcc.Guarded`): Desktop, Documents, Downloads, iCloud Drive, cloud
  storage, Music, Movies, Pictures, `/Volumes`, and links into them. What
  the daemon still asks for is what the user opened, and Desktop, Documents
  or Downloads when a session runs there (finding its repository reads up
  that folder, `tcc.GuardedBeyondWork`).
- **One certificate, one answer** (2026-10-14). TCC stores an answer with
  the program's designated requirement and asks again when the next build
  does not satisfy it. An ad-hoc signature's requirement is its cdhash
  (`cdhash H"…"`), new with every build, so every release asked again for
  the microphone and the folders: the owner was asked for the microphone
  after each update. Release builds are now signed with one long-lived
  **self-signed** code-signing certificate ("Caprock Self-Signed Code
  Signing", RSA 2048, code-signing EKU, valid to 2036), whose requirement is
  `identifier "dev.caprock.app" and certificate leaf = H"<the certificate's
  SHA-1>"` for the app and `identifier caprock` / `"caprock-pty-host"` and
  the same leaf for the daemon binaries (the bundler signs the sidecars
  without an explicit identifier, so codesign takes the file name). Neither
  half changes between builds, so an answer given once survives updates.
  Measured locally: two daemon builds with different version stamps, signed
  with the certificate, print the identical requirement and each satisfies
  the other's (`codesign --verify -R=`); the same two signed ad-hoc print
  different cdhashes and do not.
  - **How.** The `.p12` and its password are the secrets
    `MACOS_SELFSIGN_P12_BASE64` and `MACOS_SELFSIGN_P12_PASSWORD`;
    `scripts/macos-selfsign-keychain.sh` imports them into a temporary
    keychain on the macOS runner (release.yml's `app-macos-build`, ci.yml's
    macOS `app` job) and exports the certificate's SHA-1 as
    `APPLE_SIGNING_IDENTITY`, which `tauri build` uses in place of the
    config's `"-"`, keeping the hardened runtime and
    `Entitlements.plist`. `scripts/check-app-signature.sh` (in CI and
    `app-release.sh`) prints each binary's requirement and fails unless all
    three are `identifier … and certificate leaf = H"…"` with that
    certificate. Without the secrets (a fork's pull request, `make
    app-local`) the build stays ad-hoc exactly as before and the check
    expects ad-hoc. The private key exists only in the secrets and with the
    maintainer; a new certificate would ask every user once more, like the
    switch itself.
  - **The switch asks once more.** The first release signed this way
    satisfies no stored cdhash, so it asks one last time for the
    microphone and each folder; from the next update on it does not.
  - **Gatekeeper is unchanged.** The certificate is not from Apple, so to
    Gatekeeper the app is still from an unidentified developer (`spctl
    --assess` rejects both, ad-hoc and self-signed, the same way): the
    `.dmg`'s first open and the cask's quarantine step stay as they were.
    Not notarized, and the TeamIdentifier stays unset.
  - **The Homebrew formula's daemon** is goreleaser's, linker-signed ad-hoc,
    and still asks per release whenever it is the daemon that runs.
- **One path, one entry.** The app runs its daemon from
  `<data_dir>/bin/caprock` and moves a Homebrew daemon (a new Cellar path per
  release) onto it, so a new release replaces the entry instead of adding
  one. Sessions that were already running keep the old binary until they end.
- **Isolated daemons stay out.** Tests, stands and previews run with a
  temporary HOME; such a daemon refuses the account's Desktop, Documents and
  Downloads (`internal/tcc`), and `bench/stand.sh` refuses to live there.
- **The microphone** (ADR-045). The hardened runtime refuses the
  microphone without a prompt to a program signed without
  `com.apple.security.device.audio-input`, which the app and its daemon
  were: an agent's voice mode recorded silence whenever the daemon was the
  responsible program. The bundler now signs both with that entitlement
  (`app/src-tauri/Entitlements.plist`), the app's Info.plist carries
  `NSMicrophoneUsageDescription` (`app/src-tauri/Info.plist`), and
  `scripts/check-app-mic.sh` checks both in CI and in `app-release.sh`. The formula's binary has no runtime
  flag and needs neither.
- **With a Developer ID** (the Apple account): the Developer ID
  certificate replaces the self-signed one (`APPLE_CERTIFICATE` and
  notarization, docs/RELEASING.md), the requirement becomes `anchor apple
  generic and … certificate leaf[subject.OU] = <team id>`, Gatekeeper opens
  the app without "Open Anyway", and, with the daemon as an `SMAppService`
  helper of the app, the prompts carry the app's name and icon — to verify
  on the first signed build. The change of requirement asks every user once
  more, as the switch to the self-signed certificate did; drop
  `macos-selfsign-keychain.sh` and its secrets then.

The user-facing note is in [docs/app.md](../docs/app.md#macos-privacy-prompts).

## Updates

Built 2026-10-06 (WP-21, F20). The decision and its reasons are
[ADR-042](08-decisions.md#adr-042--the-app-updates-itself-in-one-click-a-minisign-signed-bundle-one-channel-checked-only-when-the-release-check-is-on-or-the-user-asks);
the release side is [RELEASING.md § The desktop app](../docs/RELEASING.md#the-desktop-app);
the user guide [docs/app.md § Updates](../docs/app.md#updates).

- **The offer.** When the daemon's release check (`/v1/update`) knows a
  release newer than *the app's* version and this install can replace
  itself, a card in the bottom-right corner announces it once per version
  — *Update 0.107.6 → 0.107.7* large, the running version to the new one
  (owner 2026-10-11: "an arrow from one to the other"), *Sessions and tabs
  stay as they are.*, **Update and restart**, *What's new*, **Later**
  (`AppUpdateToast.tsx`, owner 2026-10-07, after Orca) — and the
  status strip keeps **Update to vX.Y.Z — Restart**
  (`ui/src/components/AppUpdateNotice.tsx`). The card shows the download's
  progress too and never takes focus; while the version panel is open (it
  offers the same update in the same corner) the card is hidden. One click: the shell fetches
  `latest.json`, downloads the platform's bundle with progress
  (`Downloading vX.Y.Z` and a bar, 5 events a second at most), verifies it,
  installs it (`Installing … — restarting…`) and restarts. A failure opens a
  panel with the reason, **Try again** and the release page. The ▾ beside the
  button shows what is new and **Not now**, which hides that version (the
  same key as the dashboard banner).
- **When a release is found** (owner 2026-10-16, translated: "why isn't
  the update highlighted when there is an update?" — 0.124.0 was out for
  twelve minutes and 0.123.1 showed nothing; then 0.124.1, published at
  16:21:29 local time, was still not shown by 0.124.0 at 16:59 — its
  daemon had last checked at 16:16:48, five minutes before the release, and
  the hourly throttle held the next check to 17:16; the page then polled
  `/v1/update` only every ten minutes). The daemon's check is due
  every 15 minutes (`update.Interval`, a five-minute tick on the wall
  clock), and when the main window gains focus or is shown the page asks
  for one more (`POST /v1/update/check?soon=1`, `ui/src/lib/updatesoon.ts`)
  — run only if the last check is ten minutes old (`update.SoonInterval`,
  held by the page and again by the daemon). The two share one last-checked
  time, so unforced checks never run more than once per ten minutes; a
  failed one still waits 15 (`update.FailRetry`). The page reads
  `/v1/update` every five minutes while visible and takes the focus
  check's answer at once, so a release shows within minutes of the user
  looking. Each is one conditional request to the same endpoint, only
  while the release check is on.
- **Checking by hand.** **Check for Updates…** in the macOS app menu and the
  tray menu, and *Check for updates* in the palette, fetch `latest.json`
  once, with or without the release check on: *Checking for updates…*, then
  the offer, *Caprock is up to date* for 6 seconds, or *Couldn't check for
  updates* with **Retry** — all in the status strip beside the version,
  never in a banner at the top (owner 2026-10-16: he looks for the answer
  bottom right; [04-ui.md § Update notice](04-ui.md#update-notice)). A
  check by hand answers even for a version the user dismissed.
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
  (`caprock.app.hidden-projects`,
  `caprock.app.project-folds`) are in the page's storage; on *installing* each
  terminal saves where it is scrolled (`caprock.app.resume.v1`,
  `ui/src/lib/termresume.ts`) and goes back there after the replay; the
  shell waits a second for WebKit to write that, and saves the window state
  before it installs. A half-typed line lives in the agent's process and is
  repainted with the rest. Checked end to end by `bench/update.mjs`
  (two signed builds, a loopback update server, the fake `claude`).
- **The Dock icon after an update** (`src/dock_icon.rs`, macOS, from a real
  `.app` only). The bundle is swapped in place, and the Dock and
  LaunchServices kept the old icon cached: 0.109.1's new icon did not show
  on updated installs. Every launch sets the running app's Dock tile from
  the bundle's `Contents/Resources/icon.icns`
  (`NSApplication.setApplicationIconImage`, main thread; the badge is the
  tile's label and draws over it). When the version differs from
  `<data_dir>/app-last-run-version` (absent counts as different), the shell
  records it and, on a background thread, touches the bundle's mtime and
  runs `lsregister -f <bundle>` (ten seconds at most, every error ignored).
  Never `killall Dock`, no prompt, no privilege.
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
  The reverse happened too: the default menu's Close Window took ⌘W before
  the page could close a tab with it, fixed by File → Close Tab (F09).
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
   ADR-029 and ADR-034). F19 waits for it. *Decided 2026-10-13:* the relay
   is built — ADR-058, end-to-end Noise over a relay that sees ciphertext,
   for a phone with nothing installed.
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
