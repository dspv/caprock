# Run agents on another computer

Put Caprock on a computer at home — a Mac mini, a Linux box, a Windows PC —
and drive it from your laptop: you start the agent from the laptop, it runs on
the home computer, and you watch it, type into it and answer it from the
laptop. This page is a test script: follow it on two computers and report what
you saw.

How it works, in one paragraph: each computer runs its own Caprock. The home
computer waits at a relay with *access from anywhere* on; the laptop's Caprock
dials that relay and talks to the home one through an end-to-end encrypted
channel. The relay sees that two machines talk, when and how much — never
what. The home computer's owner (you) allows the laptop once, by name, and can
remove it at any time. Linking computers is free and not counted.

## What you need

- Two computers, both on the internet. They do not need to be on the same
  network.
- Caprock on both. The same version is best; check with `caprock version`.
- Claude Code (or another agent Caprock starts: Codex, OpenCode, Gemini CLI)
  installed and signed in **on the home computer**. The laptop does not need
  it for this.

## 1. Install Caprock on both computers

- **macOS:** the app, `brew install --cask dspv/tap/caprock-app`, or the
  command line only, `brew install dspv/tap/caprock`.
- **Windows:** `scoop install caprock`, or the installer from the
  [releases page](https://github.com/dspv/caprock/releases).
- **Linux:** the archive from the releases page.

Then start it on each: open the app, or run `caprock up`.

On a home computer without a screen (over SSH), keep it running when you log
out: `caprock service install`. On Linux also run `loginctl enable-linger
$USER` once, or Caprock stops when your SSH session ends.

## 2. On the home computer: turn on "From anywhere" and show a link

With a screen: **Settings → Computers**, choose **Connects to another**, then
**Turn on** (access from anywhere) and **Show the link**.

Without a screen, over SSH:

```bash
caprock remote on
caprock pair --computer
```

Either way you get a link, valid for five minutes and for one use. Copy it to
the laptop (a message to yourself is fine: it is useless after one use).

## 3. On the laptop: add the home computer

**Settings → Computers**, choose **The main one**, paste the link and press
**Add**. Or, from a terminal: `caprock machines add '<link>'`.

The home computer now reads *waiting for Allow* on the laptop.

## 4. On the home computer: allow the laptop

A card asks *"MacBook wants to control this computer"*: press **Allow**. Over
SSH, `caprock pair --computer` asks the same question in the terminal, or run
`caprock machines pending` and `caprock machines allow <name>`.

On the laptop the home computer turns *online*, and a **Computers** heading
appears in the sidebar with its name.

## 5. On the laptop: start an agent on the home computer

1. **New agent** (the button at the top of the sidebar; its key is shown on
   it, ⇧⌘N on macOS).
2. **Machine:** pick the home computer. The sheet becomes *New agent on
   <name>*.
3. **Folder on <name>:** pick one of its projects, or type a path on the home
   computer. Under the field it says *on <name>* when the folder is there.
4. Pick the agent and permissions, type a first message, **Start** (the key is
   shown on the button).

A tab opens with the session's terminal. It runs on the home computer.

## What to check

Tick each one, and note anything that is not true.

- [ ] **Machine picker.** It lists *This Mac* (or *This computer*) and the
  home computer. A computer waiting for Allow, removed there, or offline is
  listed greyed out, with why.
- [ ] **Folders come from the home computer.** The suggestions are the home
  computer's projects. A path that is not there says *not on <name>*, and
  Start then says *That folder is not on <name>*.
- [ ] **It runs there.** On the home computer, the session shows in its own
  Caprock as one Caprock started.
- [ ] **Typing.** Type into the terminal on the laptop; the agent answers.
  Note roughly how the delay feels (instant, noticeable, annoying).
- [ ] **One list.** The session is in the laptop's sidebar under the home
  computer, tagged with its name, and on Now under *On other computers*.
- [ ] **Needs you.** Ask the agent to do something that needs permission (in
  the default mode: "create a file hello.txt"). On the laptop, within a few
  seconds: the session moves to the top under the home computer with an amber
  dot, the computer's row says *1 needs you*, Now shows the reason, and the
  desktop app shows a notification ending *· on <name>*. Clicking it opens
  the session, where the prompt card answers it.
- [ ] **Home goes away.** Quit Caprock on the home computer (or turn its
  Wi-Fi off). Within a minute the laptop shows it *offline* with a reason and
  when it last answered, lists none of its sessions, and New agent shows it
  greyed out. Turn it back on: it comes back by itself.
- [ ] **Laptop asleep.** Close the laptop's lid for a few minutes and open
  it. The terminal reconnects and the agent on the home computer kept working.
- [ ] **Remove.** On the home computer, Settings → Computers → **Disconnect**
  the laptop (or `caprock machines revoke <name>`). The laptop says *removed
  there* at once and can no longer reach it.

## How to report

- **In the app:** **Send feedback**, near the bottom of the sidebar. Say which step, what you expected, what happened, and attach
  a screenshot. It goes to Caprock support and nowhere else; the screen says
  what is sent before you press Send.
- **On GitHub:** an issue at
  [github.com/dspv/caprock/issues](https://github.com/dspv/caprock/issues),
  if you prefer it public.

Include, for both computers: the operating system, `caprock version`, and
whether each one is the app or the command line. If something failed, the
output of `caprock machines` on the laptop says how each computer stands.

## What it does not do yet

- Approve or Deny from the notification itself for a session on another
  computer: the click opens the session, and its prompt card answers.
- New copies (worktrees), GitHub issues and attempts from the laptop's sheet:
  set those up on the home computer.
- Cost totals across computers: each computer's Cost screen counts its own.
