# Using the Caprock desktop app

The app is where you run your coding agents: a terminal for every project,
the sessions that are waiting on you, and the cost and plan limits Caprock
already measures, in one window. It talks to the same local daemon as the
browser dashboard and the phone, so a session started in one is live in the
others. Installing it: [install-app.md](install-app.md).

![The app: projects and their sessions on the left, a shell tab on the right, plan limits and today's spend along the bottom](shot-app.png)

*Demo projects and sessions, made up for this picture.*

<details>
<summary>Light theme</summary>

![The same window in the light theme](shot-app-light.png)

</details>

## The window

- **Sidebar.** *Waiting on you* comes first: sessions blocked on a permission
  prompt, then sessions whose turn has ended, oldest first. Below it, every
  project with its branch and today's cost (or how many sessions wait), opening
  to its worktrees and the agent sessions and shells in each. The dot says
  what a session is doing: green working, amber waiting, red looping, grey
  idle, hollow ended. Hover a project for *New agent* and *New shell*.
  Sessions in a folder that is not a repository sit under *Other folders*.
  *Dashboard* at the bottom opens Now, Cost, Lifetime and the other screens
  inside the window.
- **Projects.** Caprock lists the repositories your sessions ran in. ⌘O adds
  a folder, makes a new one (`git init` optional) or clones a repository with
  git's progress shown. Branch, changed files and ahead/behind follow commits
  and checkouts made anywhere, the terminal included. Removing a project from
  the list never touches its files.
- **Tabs.** One strip of terminal tabs per project, an agent session or a
  shell each. Tabs come back when you reopen the app. Closing a tab (⌘W)
  never stops its session; *Stop the session…* in the inspector does, after
  asking.
- **Split panes.** ⌘E opens a new shell beside the terminal in front, ⇧⌘E
  below it; ⇧Enter on a session in the palette opens it there. Up to four
  panes a tab. Click a pane or press ⌘[ ⌘] to move between them; drag the
  divider, or focus it and use the arrow keys. ⌘W closes the focused pane and
  its session keeps running.
- **Command palette** (⌘K). Sessions waiting on you come first, then actions,
  tabs, sessions and projects, best match first. Type a task that matches
  nothing — "Add rate limiting to the API" — and Enter opens *New agent* with
  it as the first message, in a new worktree named after it.
- **Terminal.** A real terminal for every session Caprock started and every
  shell, and it keeps running when the app or the daemon restarts. Scrolled
  up, new output never moves what you are reading; a "↓ N new lines" pill
  takes you back down.
- **Chat.** An agent tab switches between its terminal and its chat with the
  chat button in the tab strip: your prompts, what the agent wrote, and each
  tool call on one line that opens. The field under it types into the
  session.
- **Inspector** (⌘I). The session's agent, model and folder, its cost,
  turns, tokens and context, the permission prompt with its buttons, and the
  uncommitted changes in its checkout. Click a changed file to open it in
  your editor at its first change.
- **Changes.** Click a worktree's ±N in the sidebar (hover the row for the
  same button), *Review and commit* in the inspector, or "Review changes" in
  the palette. The files are listed as *Staged*, *Changes* and *Conflicts*;
  the one selected shows its diff, unified or side by side (**v**). Hover a
  file to stage, unstage or discard it, or press **s**, **u**, **d**;
  **j**/**k** move between files. A diff's *Stage hunk* takes one hunk.
  Discarding throws away a file's unstaged edits, or deletes a new file,
  and asks first; staged work is kept. Write a message (*Use the agent's
  summary* starts one from what the agent said last), then *Commit* (⌘↵) —
  the staged files, or every change when nothing is staged — or *Commit &
  Push* (⇧⌘↵). *Push* publishes a new branch and tracks it, and never
  forces; *Pull* only fast-forwards; *Fetch* refreshes ahead and behind.
  Your git hooks run, and when one refuses, what it printed is shown. The
  commit is made as the author your git config names.
- **Find** (⌘F). A find bar over the terminal you are in: matches light up
  as you type, Enter and ⇧Enter step through them, **Aa** matches case and
  **.\*** takes a regular expression. Esc closes it and you are back in the
  terminal.
- **Open in your editor.** Right-click a project or a worktree in the
  sidebar to open it in VS Code, Cursor, Zed or a JetBrains IDE — whichever
  are installed; the palette and the inspector have *Open in …* too.
  Settings → *Editor* picks the default. Only this computer can do this; a
  paired phone cannot open an editor here.
- **Terminal look.** Settings → *Terminal*: the colours (Caprock, Paper,
  Catppuccin Mocha, Tokyo Night, Solarized Dark), the font (JetBrains Mono,
  or SF Mono, Menlo, Fira Code and other monospace fonts you have), size,
  line height and cursor, with a preview. Every open terminal changes as you
  choose.
- **Status strip.** Whether the daemon is live, the 5-hour and 7-day plan
  windows, today's spend, and the front terminal's size. With release checks
  on (Settings → *Privacy*), *v… is out* appears there when a newer Caprock
  is published; click it for the command that upgrades your install — `brew
  update && brew upgrade --cask caprock-app` for the app from Homebrew — or
  *Not now* to hide that version. Caprock never updates itself.

### Keyboard

On macOS:

| Keys        | Does                                    |
| ----------- | --------------------------------------- |
| ⌘T          | New shell in the selected project       |
| ⇧⌘N         | New agent session                       |
| ⌘O          | Add a project (folder, new, clone)      |
| ⌘1–8, ⌘9    | A tab by position; the last tab         |
| ⌃Tab, ⇧⌘[ ] | Next and previous tab                   |
| ⌘W          | Close the tab (the session keeps going) |
| ⌘E, ⇧⌘E     | Split: a new shell beside, below        |
| ⌘[ ]        | Previous and next pane                  |
| ⌘J          | Next session waiting on you             |
| ⌘F          | Find in the terminal                    |
| ⌘K          | Command palette                         |
| ⌘I          | Inspector                               |
| ⌘\          | Hide or show the sidebar                |
| ⇧⌘D         | Dashboard                               |

On Windows and Linux each is Ctrl+Shift with the same letter; Ctrl+Shift+C
and Ctrl+Shift+V stay the terminal's copy and paste. The terminal's own keys
(Ctrl+C, Ctrl+W, Option as Meta) always reach the terminal.

## Outside the window

- **Menu bar** (a tray icon on Windows and Linux). On macOS a click on the
  icon opens a small panel under it without leaving the app you are in: what
  needs you first (a permission prompt with **Approve** when the whole
  request fits on the panel, else **Deny** and *Review in Caprock*; then
  sessions whose turn ended), then what is running with its cost, today's
  spend, and the Claude and Codex 5-hour and 7-day windows with when they
  reset. Click a session to open it in the window; Escape or a click
  elsewhere closes the panel. A right click shows the menu: the same figures,
  the sessions waiting for approval, *Show Caprock* and *Quit*. On Windows
  and Linux the menu is the whole tray. On macOS the 5-hour figure and the
  waiting count sit beside the icon.
- **Badge.** The Dock icon (a dot on the Windows taskbar) counts the sessions
  waiting for approval, and clears when none do.
- **Global shortcut.** ⌃⌥⌘C on macOS, Win+Alt+C on Windows and Linux, brings
  the window up from any app, and hides it when it is already in front.
  Change it or turn it off in Settings → *Global shortcut*. Wayland does not
  give apps global shortcuts; the tray's *Show Caprock* still works there.
- **Closing the window.** On macOS Caprock stays in the menu bar; ⌘Q quits.
  On Windows and Linux closing quits. Quitting never stops the daemon or a
  session.

## Notifications

When an agent stops on a permission prompt, the app shows a notification
naming the project, the session and what it wants to do: `Bash: go test
./...`, the file an edit would change, or the question it asked. Nothing is
shown for the session you are already looking at.

On macOS the notification carries buttons:

- **Approve** answers *yes* to that prompt, without bringing Caprock forward.
  It is offered only when the notification shows the whole request, on one
  line and uncut. A longer command offers **Open in Caprock** instead, so you
  read it on the prompt card before answering.
- **Deny** answers *no*.
- A click on the notification opens the session with its prompt card.

A notification never offers "always allow", because that would write a rule
to your settings. If the prompt was answered in the meantime — in the
terminal, on the card, from the phone — the button does nothing and says
*Already answered*, and the notification is taken away when the prompt goes.
macOS asks once whether Caprock may send notifications.

On Windows and Linux a notification has no buttons; a click opens the
session with its Yes and No buttons.

Settings → *Desktop notifications* has two switches: *waiting for approval*
(on) and *has finished* (off). They are separate from the Telegram alerts in
[Phone alerts](../README.md#hear-about-it-on-your-phone), which stay off until
you turn them on.

## Your phone

The phone opens the same Caprock in its browser, over your Wi-Fi or over
[Tailscale](https://tailscale.com/download). Nothing passes through a server
of ours.

### Pairing

1. In the app, open *Dashboard* → **settings** → *Open Caprock on your phone*
   and press **Show a code**.
2. Pick the address the QR code carries: **Wi-Fi** for a phone on the same
   network, **Tailscale** (or **Tailscale name**) for a phone that has
   Tailscale on, which then works from mobile data too. The Tailscale choices
   appear when this computer is on Tailscale.
3. Point the phone's camera at the code. It opens Caprock and pairs by itself;
   the six digits and the address are there to type for a phone without a
   camera.

The phone appears under *Paired devices*. It can look but not change anything
until you press **Let it control sessions** beside it; **Take control away**
undoes that at once. The rest of what pairing allows, and why, is in
[Open it on your phone](../README.md#open-it-on-your-phone).

### Working from the phone

A phone you let control sessions can:

- **Start work.** *+ Start work* on Now offers **Clone** (an `https://` or
  `git@` address, into a folder under your home), **New project** and
  **Worktree**. Then **Start an agent here** starts a session and opens its
  chat. A clone runs on the computer: lock the phone or lose the signal
  halfway and the page catches up when it is back, without cloning twice.
- **Chat with a session.** On a phone a session opens on its chat. Type into
  the field and send; **Photo** attaches a picture by putting its path in the
  message. The keys bar has Esc, Tab, the arrows, Enter and Ctrl+C for the
  agent's menus.
- **Answer a permission prompt** with the buttons on the prompt card.
- **Commit and push.** A session's *Changes* tab starts with what is
  uncommitted in its worktree. Tap files to commit only those (nothing
  ticked commits everything), write a message or take the agent's summary,
  then **Commit** or **Commit & Push**; **Pull** and **Fetch** sit under
  them. Only in a project under your home folder. A phone that can only
  look sees the list and no buttons.

It reconnects by itself. The header says where it stands — *Live*,
*Catching up…*, *Reconnecting*, *Offline since* — and says *Live* only when
the computer answered in the last 25 seconds. A message sent while offline
waits as *Will send when connected* and goes when the connection is back,
unless a permission prompt is waiting; then it stays as a draft for you to
send. Keys like Esc and Ctrl+C are never held back to be sent later.
