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
remove it at any time. The laptop's access there is bound to the laptop's own
key, with nothing for you to do: a copy of its access taken off the laptop
works from nowhere else. Linking computers is free and not counted.

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
- [ ] **Approve from the notification.** Ask again. On macOS and Linux the
  notification carries **Approve** and **Deny** (when it shows the whole
  request; otherwise **Open in Caprock** and **Deny**). Press **Approve**
  without opening anything: the agent on the home computer goes on, and the
  notification goes away. Ask once more and answer in the home computer's own
  terminal first: the laptop's notification is withdrawn, and a late press
  says *Already answered*. On Windows the notification has no buttons; a
  click opens the session, whose prompt card answers it.
- [ ] **Cost across computers.** On the laptop, **Cost**: beside the range,
  **This Mac / All computers**. *All computers* adds a panel with a row for
  each computer — its cost, sessions, tokens and the pricing table it used —
  and *Total (2 of 2)*. Note whether the home computer's figure matches its
  own Cost screen for the same range.
- [ ] **Home goes away.** Quit Caprock on the home computer (or turn its
  Wi-Fi off). Within a minute the laptop shows it *offline* with a reason and
  when it last answered, lists none of its sessions, and New agent shows it
  greyed out. Cost on *All computers* names it *offline, not counted* with
  *Total (1 of 2)*, never $0. Turn it back on: it comes back by itself.
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

## The relay: how long a key takes, and running your own

Everything between the two computers goes through a relay — by default
`wss://relay.caprock.dev`, a Cloudflare Worker, or one you run. The relay is
the home computer's choice: the laptop dials the relay named in the link it
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

1. **Start it** on a machine both computers reach — the home computer itself
   is fine:

   ```bash
   caprock remote relay --addr 127.0.0.1:8787
   ```

   It listens without TLS on that address. On a private network only (your
   LAN, Tailscale) you can listen on that network's address instead:
   `--addr 100.x.y.z:8787` (the home computer's Tailscale address), and use
   `ws://100.x.y.z:8787` below. Anywhere else, put it behind TLS — Caddy
   (`your.relay.example { reverse_proxy 127.0.0.1:8787 }`) or a load balancer
   — and use `wss://your.relay.example`. Keep it running with your service
   manager, as Caprock's own service is.
2. **Point the home computer at it:** `caprock remote on --relay
   wss://your.relay.example` (over SSH is fine). Phones already paired with
   the home computer through the old relay need pairing again.
3. **Show a new link there** (`caprock pair --computer`, or *Show the link*)
   and on the laptop **Disconnect** the home computer, then **Add** the new
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
the home computer, typed into from the laptop, note how the delay feels
(instant, noticeable, annoying) on each relay. Send both files with the
date and where you were.

**OQ-19 — what running a task on the other computer frees on this one.**
Pick one real task you would give an agent (the same prompt, the same
repository at the same commit on both computers). On the laptop:

```bash
URL=$(caprock status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
# Here: start the task on This Mac, then sample every 10 s until it ends.
while sleep 10; do curl -s "$URL/v1/resources"; echo; done > oq19-here.jsonl
# Elsewhere: start the same task on the home computer (New agent → Machine),
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
  set those up on the home computer.
- A phone paired with the laptop does not see or answer the home computer's
  sessions: access is never passed on. Pair the phone with the home computer
  itself.
- Windows notifications carry no buttons (the system's plugin reports none):
  a click opens the session, whose prompt card answers it.
- After `caprock remote reset` on the laptop (new keys), every computer it
  reached refuses it, because its access there is bound to the old key: add
  each again with a new link.
