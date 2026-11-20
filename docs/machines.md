# Run agents on another computer

Put Caprock on a second computer — a Windows PC, a Mac mini, a Linux box, a
server you reach over SSH — and drive it from your laptop: you start an
agent from the laptop, it runs on the other computer, and you watch it, type
into it and answer it from the laptop.

How it works, in one paragraph: each computer runs its own Caprock. The
computer that runs agents waits at a relay with *access from anywhere* on;
your laptop's Caprock dials that relay and talks to it through an end-to-end
encrypted channel. The relay sees that two computers talk, when and how
much — never what. Nothing reaches the computer that runs agents until you
press **Allow** there, by name, and you can remove the laptop at any time.
Linking computers is free and not counted.

## 1. Install Caprock on both computers

- **Windows:** the installer from the
  [releases page](https://github.com/dspv/caprock/releases), or `scoop
  install caprock`.
- **macOS:** the app, `brew install --cask dspv/tap/caprock-app`, or the
  command line only, `brew install dspv/tap/caprock`.
- **Linux:** the archive from the releases page.

Then start it on each: open the app, or run `caprock up`.

## 2. On the computer that runs agents: its checklist

**Settings → Computers → Run agents for another computer.** It lists what
this computer still needs, in order, each with one button, and ticks each
item by itself a few seconds after it is done:

1. **Git** (Windows and macOS). On Windows Claude Code needs it. **Install**
   opens a terminal tab with `winget install --id Git.Git -e --source
   winget` typed; press Enter, and Windows asks once for an administrator.
   On macOS it opens Apple's installer for the Command Line Tools.
2. **Claude Code or Codex**, at least one. **Install** types its installer
   into a terminal tab.
3. **Sign in** to your subscription: **Sign in** types `claude auth login`
   (or `codex login`); the browser opens. Caprock cannot tell whether Codex
   is signed in when it keeps the sign-in in the system keyring, so that
   item shows **?** and stays offered.
4. **A project to work in:** **Add** clones a repository or picks a folder.
5. **Link to your laptop:** **Turn on** access from anywhere, then **Show
   the link**. The link is valid five minutes, for one use.

Caprock never installs anything by itself: every button types the command
and you press Enter. Something you install shows as done without
restarting Caprock. When all five are ticked it says *Ready. Start agents
from your laptop.* Until then, Home shows what is left.

## 3. On your laptop: add the computer

**Settings → Computers → This is where I work**, paste the link and press
**Add**. Or, in a terminal: `caprock machines add '<link>'`.

The other computer now shows a card: *"MacBook wants to control this
computer"*. Press **Allow** there. Its checklist ticks *Link to your laptop*.

## 4. On your laptop: start an agent there

In Settings → Computers the computer reads *ready*, with what it has
(*online · Claude Code · signed in · 2 projects · Windows · 32 GB*), and
**Start an agent there**: New agent opens on it. Pick a folder there, the
agent and a first message, and **Start**. A tab opens with the session's
terminal; it runs on the other computer.

If something is still missing there, the laptop says which: *Home PC needs
one more step: no agent is installed there yet. Open Caprock on it and
finish its checklist, or run `caprock setup` there over SSH.*

To rename a computer on the laptop, right-click it in the sidebar →
**Rename**.

## Over SSH (a VPS, a Mac mini with no screen)

Everything above has a terminal form. On the computer that runs agents:

```bash
caprock up                 # or: caprock service install, to keep it running after you log out
caprock setup              # the same checklist: [ok] or [  ], and the command for each missing step
caprock setup --link       # then: access from anywhere on, a one-time link, and Allow by name
```

`caprock setup` prints each item with what to do and `run: <command>` for
the ones a command fixes; run it, then `caprock setup` again. `caprock
setup --link` ends by printing the link for your laptop (paste it in
Settings → Computers, or `caprock machines add '<link>'` there) and waits
to ask *"MacBook" wants to control this computer. Allow? [y/N]*. Later,
`caprock machines pending` lists who waits and `caprock machines allow
<name>` allows one.

**Linux:** keep it running with nobody logged in — `caprock service install`,
and once `loginctl enable-linger $USER` (as root or with polkit), or Caprock
stops when your SSH session ends. `caprock setup` reminds you when lingering
is off. Install Git with the package manager (`sudo apt install git`,
`sudo dnf install git`, `sudo pacman -S git`). A project over SSH:
`git clone` it, then pick its folder in New agent on the laptop.

## What to check

Tick each one, and note anything that is not true.

- [ ] **The checklist.** On a fresh computer every missing step is named,
  each with a button (or, on Linux and over SSH, the command), and it ticks
  without a restart once done.
- [ ] **Ready on the laptop.** The computer reads *ready* with its chips,
  and **Start an agent there** opens New agent on it.
- [ ] **Folders come from that computer.** The suggestions are its projects;
  a path that is not there says *not on <name>*.
- [ ] **Typing.** Type into the terminal on the laptop; the agent answers.
  Note roughly how the delay feels (instant, noticeable, annoying).
- [ ] **One list.** The session is in the laptop's sidebar under that
  computer, tagged with its name, and on Home under *On other computers*.
- [ ] **Needs you.** Ask the agent to do something that needs permission (in
  the default mode: "create a file hello.txt"). On the laptop, within a few
  seconds the session moves to the top with an amber dot, and the desktop
  app notifies you, ending *· on <name>*. On macOS and Linux the
  notification carries **Approve** and **Deny**; on Windows a click opens
  the session, whose prompt card answers it.
- [ ] **Cost across computers.** **Cost → All computers** adds a row for
  each computer and *Total (2 of 2)*.
- [ ] **It goes away and comes back.** Quit Caprock there: within a minute
  the laptop shows it *offline* with why, and never $0 for its cost. Start
  it again: it comes back by itself.
- [ ] **Remove.** On the computer that runs agents, Settings → Computers →
  **Disconnect** the laptop (or `caprock machines revoke <name>`). The
  laptop says *removed there* at once.

## How to report

- **In the app:** **Send feedback**, near the bottom of the sidebar. Say
  which step, what you expected, what happened, and attach a screenshot. It
  goes to Caprock support and nowhere else; the screen says what is sent
  before you press Send.
- **On GitHub:** an issue at
  [github.com/dspv/caprock/issues](https://github.com/dspv/caprock/issues),
  if you prefer it public.

Include, for both computers: the operating system, `caprock version`, and
whether each one is the app or the command line. On the computer that runs
agents, `caprock setup` says how it stands; on the laptop, `caprock
machines` says how each computer stands.

## The relay: how long a key takes, and running your own

Everything between the two computers goes through a relay — by default
`wss://relay.caprock.dev`, a Cloudflare Worker, or one you run. The relay is
the other computer's choice: the laptop dials the relay named in the link it
pasted.

What it costs, measured: on 2026-11-06, with both ends on one Mac in Israel
(Cloudflare served it from Tel Aviv), a keystroke's echo through
`relay.caprock.dev` took 132 ms at the median and 213 ms at p95, against
1.5 ms through a relay on the same machine ([.ai/21-app.md § The hosted
relay, both ends on one Mac](../.ai/21-app.md)). The time is the trip to the
relay and back, twice per keystroke, not Caprock's own work. Two computers
on one home network reach the hosted relay the same way, so they pay about
the same. From another country, or another Cloudflare location, nobody has
measured it yet.

**Run your own when** your computers are usually on one network or one
private network (Tailscale, a VPN) and the delay in a remote terminal
bothers you, or when you want nothing of yours, not even ciphertext and
timing, to pass through a server Caprock runs. It is not worth it for
reading sessions, answering prompts and the cost view, which send little.
Nobody has measured a self-hosted relay between two real computers yet, so
there is no figure for what you would gain; measure it with the steps under
*Measuring a link*, below.

1. **Start it** on a machine both computers reach — the other computer itself
   is fine:

   ```bash
   caprock remote relay --addr 127.0.0.1:8787
   ```

   It listens without TLS on that address. On a private network only (your
   LAN, Tailscale) you can listen on that network's address instead:
   `--addr 100.x.y.z:8787` (the other computer's Tailscale address), and use
   `ws://100.x.y.z:8787` below. Anywhere else, put it behind TLS — Caddy
   (`your.relay.example { reverse_proxy 127.0.0.1:8787 }`) or a load balancer
   — and use `wss://your.relay.example`. Keep it running with your service
   manager, as Caprock's own service is.
2. **Point the computer that runs agents at it:** `caprock remote on --relay
   wss://your.relay.example` (over SSH is fine). Phones already paired with
   the other computer through the old relay need pairing again.
3. **Show a new link there** (`caprock pair --computer`, or *Show the link*)
   and on the laptop **Disconnect** the other computer, then **Add** the new
   link and allow the laptop there again: the relay travels in the link, and
   the laptop keeps using the one it was paired with until then.
4. Check: `caprock machines` on the laptop names the relay host for that
   computer, and the Computers panel says *through <your relay>*.

The relay sees the same as the hosted one: which machines talk, their IP
addresses, when and how much — never what (end-to-end encrypted, Noise NK).
It stores nothing.

## Measuring a link, and what moving work frees (for the owner)

Three open questions need two real computers; nothing below may be quoted
until it has been run ([.ai/12-risks.md](../.ai/12-risks.md) OQ-17 to OQ-20).
Use throwaway copies where it says so, never your working Caprock's data.

**OQ-17 / OQ-18 — the link between two computers.** `bench/peer.mjs` puts
both of its throwaway daemons on one computer, so it measures the trip to a
relay and back from where that computer is — the relay's share of a link,
not a link between two machines. Run it on the laptop once per relay:

```bash
go build -o /tmp/peer/caprock ./cmd/caprock && go build -o /tmp/peer/claude ./testdata/fakeclaude
node bench/peer.mjs --bin /tmp/peer/caprock --claude /tmp/peer/claude --relay wss://relay.caprock.dev --out hosted.json
node bench/peer.mjs --bin /tmp/peer/caprock --claude /tmp/peer/claude --relay wss://your.relay.example --out own.json
```

For the two computers themselves nothing is automated yet: in a session on
the other computer, typed into from the laptop, note how the delay feels
(instant, noticeable, annoying) on each relay. Send both files with the
date and where you were.

**OQ-19 — what running a task on the other computer frees on this one.**
Pick one real task you would give an agent (the same prompt, the same
repository at the same commit on both computers). On the laptop:

```bash
URL=$(caprock status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
# Here: start the task on This Mac, then sample every 10 s until it ends.
while sleep 10; do curl -s "$URL/v1/resources"; echo; done > oq19-here.jsonl
# Elsewhere: start the same task on the other computer (New agent → Machine),
# then sample the laptop again until it ends.
while sleep 10; do curl -s "$URL/v1/resources"; echo; done > oq19-there.jsonl
```

Stop each loop with Ctrl+C when the task ends. Each line holds the laptop's
one-minute load, available memory and every session's CPU and memory
(`machine`, `sessions`). Send both files, the task, and both computers'
model, cores and memory.

**OQ-20 — is the other computer quicker at the work?** On each computer, in a
clean clone of this repository at the same commit, three times each:

```bash
time go test ./...
time (cd ui && npm ci && npm run build)
```

Send the six `real` times per computer with its model, cores, memory and OS,
and the date. Until these come back, no page says the other computer is
faster, frees anything, or that a link is instant.

## What it does not do yet

- New copies (worktrees), GitHub issues and attempts from the laptop's sheet:
  set those up on the other computer.
- A phone paired with the laptop does not see or answer the other computer's
  sessions: access is never passed on. Pair the phone with the other computer
  itself.
- Windows notifications carry no buttons (the system's plugin reports none):
  a click opens the session, whose prompt card answers it.
- After `caprock remote reset` on the laptop (new keys), every computer it
  reached refuses it, because its access there is bound to the old key: add
  each again with a new link.
