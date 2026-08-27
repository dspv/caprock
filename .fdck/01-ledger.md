# Request ledger

Every request a user made, what we decided, and where the work lives. Ids are
`FB-NNN`, assigned in order, never reused. Newest first.

Status is one of: **open** (no decision yet) · **planned** (decided yes, not
started) · **building** · **shipped** (in a release, with the version) ·
**declined** (decided no, with the reason in the story).

| Id     | Date       | From  | Request                                                            | Status  | Landed in         |
| ------ | ---------- | ----- | ------------------------------------------------------------------ | ------- | ----------------- |
| FB-019 | 2026-08-27 | Dima  | Reach Caprock from a tablet or phone, the way Claude Code is       | open    | —                 |
| FB-018 | 2026-08-27 | Vova  | Shift+Enter did not work for him; Option+Enter was what he pressed | shipped | v0.31.3           |
| FB-017 | 2026-08-27 | Dima  | Wanted an update button, or at least clear steps per OS            | shipped | v0.31.2           |
| FB-016 | 2026-08-27 | Almas | brew said "already installed" for a release that was already out   | shipped | v0.31.2           |
| FB-015 | 2026-08-27 | Dima  | Hover invisible, caveat too wordy, two buttons out of line         | shipped | v0.31.2           |
| FB-014 | 2026-08-27 | Dima  | The premium banner's line was a metaphor, not an explanation       | shipped | v0.31.1           |
| FB-013 | 2026-08-27 | Dima  | Sharing a card produced two images, downloading produced one       | shipped | v0.31.1           |
| FB-012 | 2026-08-27 | Dima  | Plan limits looked odd and belonged to nothing on the screen       | shipped | v0.31.1           |
| FB-011 | 2026-08-27 | Dima  | No clear way to update; the share button was easy to miss          | shipped | v0.31.1           |
| FB-010 | 2026-08-27 | Dima  | The share dialog explained too much and read as a hang             | shipped | v0.31.0           |
| FB-009 | 2026-08-27 | Vova  | Shift+Enter in the terminal, for multi-line prompts                | shipped | v0.30.1           |
| FB-008 | 2026-08-26 | Vova  | Pay for models from inside Caprock                                 | open    | —                 |
| FB-007 | 2026-08-26 | Vova  | Show plan limits where they are actually looked at                 | shipped | v0.28.0           |
| FB-006 | 2026-08-26 | Vova  | Quick chat: a findable "new project" that makes the folder         | shipped | v0.28.0           |
| FB-005 | 2026-08-26 | Vova  | Third-party model providers, free ones first                       | part    | v0.30.0           |
| FB-004 | 2026-08-26 | Vova  | JetBrains Mono in the terminal — Cyrillic was unreadable           | shipped | v0.28.0           |
| FB-003 | 2026-08-26 | Vova  | Would pay $20/mo; $50 with models; $100 with Claude+GPT            | open    | —                 |
| FB-002 | 2026-08-25 | Vova  | Filter the dashboard by agent after OpenCode appeared              | shipped | v0.21.4           |
| FB-001 | 2026-08-24 | Alex  | Hooks never fired on Windows                                       | shipped | v0.27.3 + v0.27.4 |

## Detail

### FB-019 — Reach it from a tablet

Dima's idea, not a user request — which is why it is open rather than planned.
The picture is a Mac mini running Caprock and a tablet as the pane of glass.

**Nobody has asked for this.** Vova replaced his IDE with Caprock and never
mentioned a phone; Almas asked how to upgrade. Before any of the three routes
below is worth building, the question is whether anyone wants it at all.

The premise needs correcting too: **Claude Code has no tunnel of its own.**
People who drive it from a phone install Tailscale, ngrok, or forward a port
over SSH — the product does not do it for them. What people picture when they
say "like Claude Code from my phone" is usually claude.ai, which is a hosted
product with Anthropic's servers behind it, not Claude Code on their machine.

Three routes, and they are not variations on one thing:

- **LAN.** The daemon also listens on a private address, a device pairs with a
  short code. Works at home and in the office, not from a café. Nothing leaves
  the network. The safety core for this is built and tested
  (`internal/pairing`); no listener is wired up.
- **Our own relay.** Works anywhere. Sessions — what Claude wrote, which files
  it touched — would pass through a machine we run, which contradicts rule 4
  and the three places the site says nothing leaves your machine. Also servers,
  cost, and responsibility for other people's code.
- **Someone else's tunnel (Tailscale).** Works anywhere, traffic goes directly
  between the user's own devices, encrypted, with no server of ours. The user
  installs it — which is what people already do with Claude Code. Our part
  would be a page explaining it and a dashboard that helps: show the address,
  check the tunnel is up, offer a QR.

Held until somebody asks.

### FB-018 — Option+Enter, not Shift+Enter

FB-009 shipped Shift+Enter in v0.30.1. Vova came back: the combination that
worked for him was **Option+Enter**, and he only found it by trying.

Checked against Claude Code's own documentation rather than guessed. It accepts
four ways of asking for a newline — Shift+Enter (CSI u, needs a terminal that
speaks the kitty keyboard protocol, which is why `/terminal-setup` exists),
Option+Enter (ESC then CR, what macOS users are told to enable), Ctrl+J (a line
feed, working in **every** terminal with no configuration at all), and
backslash-Enter. Which one a person reaches for depends on what they learned
elsewhere.

Implementing one of four was the mistake, and the one implemented was the most
fragile of them. All four are handled now.

**The second half of the fix is a line under the terminal saying so.** It had
worked for a month and he could not find it: he pressed Enter, watched half a
thought get submitted, and concluded multi-line prompts were not possible here.
A feature nobody can discover is not shipped.

### FB-017 — "Can it update itself, or at least tell me how"

Asked twice, and my first answer conflated two things. Self-updating is not
impossible — a daemon can fetch a new binary, put it in place and restart. What
makes it wrong here is ownership: where Homebrew, Scoop or `go install` owns
the binary, replacing it behind their back breaks the next upgrade, and on
macOS a binary fetched outside that path loses its notarisation.

So: no button, and the dialog now says why rather than leaving someone hunting
for one. What it does instead is answer the whole question — tabs for macOS,
Linux and Windows, the routes each has, and three numbered steps (update,
restart, check) with their own copy buttons. The platform choice is remembered.
Where the daemon's own reading of the binary path contradicts the browser's
user-agent, the daemon wins.

Also asked for and shipped: **"what's new" beside the version** — the release's
own notes in a dialog, from the same response that already carries the version.

### FB-016 — Homebrew said "already installed" for a release that was out

Almas ran `brew upgrade caprock` and got `0.31.0 already installed` hours after
0.31.1 shipped.

**Nothing was broken — the tap was stale on his machine.** A tap is not served
by the Homebrew API; it is read from a local git clone that `brew upgrade`
refreshes only through auto-update, which runs at most once every 24 hours. He
had run some brew command earlier that day, so the window had closed.

The sting is that Caprock itself hands people that command. Every place that
names it now says `brew update && brew upgrade caprock`: the dashboard dialog,
the README, and the install page on the site. A test pins the reason so it does
not get "simplified" back into the broken form.

### FB-015 — Three things the eye caught

Reported from screenshots, all of them things a test cannot see.

- **Hover did nothing visible.** "Save the image" changed only its border
  colour against a dark panel. A control you cannot confirm you are pointing at
  reads as disabled; it fills now.
- **The caveat was a paragraph.** Two sentences of small grey prose, where the
  reader is scanning for what leaves the machine. Two bullets, larger, one
  claim per line — now pinned by a test, since this is exactly the copy that
  gets reworded whenever the dialog is tightened, and the card's "not a bill"
  caveat was lost that way once already.
- **Quick chat and + New session did not line up.** Quick chat sat in a wrapper
  div beside a bare button, so they were two different boxes in one flex row.

### FB-014 — The premium banner was a metaphor

"Premium stops a day that runs away from you, and alerts before a plan window
does." One line, two claims, neither a thing the reader can picture — the
verdict was simply "непонятно". The modal behind the button already said it
plainly ("set a number for the day; when the cost crosses it, Caprock pauses
the sessions it started"), so the banner now uses those words: **Premium pauses
sessions when the day crosses a limit you set.**

A banner has one line to name something concrete. Writing around the mechanism
because the plain version sounds ordinary makes it unreadable instead.

### FB-013 — Two images from one share

Sharing the card put two copies of it wherever it landed; saving it to disk put
one. That split was the whole diagnosis: the download path draws once and
writes one file, so the duplicate could only come from the native path, which
called `navigator.share({files, text})`. Two payloads, and the receiving side
decides what they mean — macOS's Copy resolved it as two items. The card
already carries every figure and the caveat, so the caption was never
load-bearing; the file now travels alone.

A second, independent way to get two cards was fixed in the same change: one
`busy` flag both labelled the button and disabled it, and clearing it early
(so the label would stop saying "drawing…" while the OS sheet sat open)
re-enabled the button underneath that sheet.

### FB-012 — Plan limits belonged to nothing

A full-width panel holding two percentages, three rows above the money. On the
owner's machine both windows were stale — the 5-hour one claimed a reset in
2030 — so the band spent its width explaining that the figures beside it meant
nothing. It is now a cell in the Today row beside burn, sessions and cache hit:
the same question ("can I keep going") at the size of its neighbours.

### FB-011 — No obvious way to update

Two findings from one session. The version chip said a newer release existed
and stopped there, which answers the half of the question nobody needs help
with; the owner, on a stale build, could not tell how to move off it. It is now
a button opening a dialog with the exact command for how *this* copy was
installed — the daemon already worked that out — and a copy button.

**Caprock will not update itself.** A daemon that overwrites its own running
binary, as root on some install paths, is a worse thing to own than a stale
version. The dialog says so rather than leaving a person hunting for a button
that should not exist.

The share button was the second finding: grey 11px lowercase between "feedback"
and the build label, invisible enough that the person who commissioned the
feature could not find it. Bordered and in the accent colour now.

### FB-010 — What does Share actually do

Three paragraphs of caveats above a button labelled "Share…", and the owner
could not tell what pressing it would do. An ellipsis is not a destination.
Rewritten to two large buttons, each naming where the picture goes, with the
privacy line moved below them — it answers "is this safe to post", which only
arises once "what happens if I press it" is settled.

### FB-009 — Shift+Enter in the terminal

He noticed it works when he opens `claude` in a normal terminal and not in
Caprock's, which was the whole diagnosis: a terminal cannot tell Shift+Enter
from Enter, and the ones that support multi-line prompts are configured to send
CSI u instead. xterm.js does not by default.

**A user comparing our behaviour against the thing we wrap is the most useful
bug report there is** — he had already isolated the variable.

### FB-008 — Pay for models from inside Caprock

Vova wants to buy model credit through Caprock rather than holding a separate
account with each provider. Unscoped and large: it makes us a payment
intermediary for someone else's API, which is a different business from a
local dashboard.

**The margin was checked on 2026-08-26 rather than assumed, and it is thin.**
OpenRouter, which does exactly this, states it passes provider pricing through
"without any markup on inference pricing" and earns on payment fees — 5.5% via
Stripe. It has no public affiliate programme. DeepSeek publishes no reseller
tier either; volume terms exist but are negotiated, and its prices fell far
enough (a 75% cut made permanent) that a percentage of them is a small number.

So the case for it is not margin. It is that a developer holding accounts with
three providers finds that painful, and Caprock already counts the money — the
reselling would be a convenience people pay for, with the fee incidental.
**Still no decision**, and it needs users whose production traffic we can see;
today we only see their development.

### FB-007 — Show plan limits

Plan limits already existed, so this was never "build this" — it was "I did not
find it". A UX review found two reasons why, and both are fixed:

- **They were on the wrong screen.** Cost answers *what has this cost me*; a
  limit answers *can I keep going*, which is a question about right now. They
  were in the second column of Cost's bottom row, under a thirty-day chart.
  Now they are a line on the Now screen too, above Today.
- **The panel vanished when there was no data.** Anyone whose status line was
  not feeding Caprock saw nothing at all, so the one screen that could have
  explained the absence explained nothing — the same shape as the spawn button
  that used to hide the dialog explaining itself. It now renders either way and
  names what produces the data.

Both screens share one component: the staleness rule (a reset clock already
past, or more than eight days out, is a stale sample rather than a fact) is
subtle enough that a second copy would drift.

### FB-006 — Quick chat, and the new-project button

**All three parts are built** (not yet released):

- the button moved to the top of the Now screen at the size of an action;
- the spawn dialog grew `create it if it does not exist`, backed by `create`
  on `POST /v1/agents`;
- **Quick chat** starts a session with no directory at all, backed by `chat`.
  Vova uses Claude to ask things — look something up, talk something through —
  and being made to name a repository first is a wall in front of a question.
  Caprock makes a directory per chat under `<data_dir>/chats/`. Default model,
  changeable inside the session afterwards.

Per chat, not one shared folder: Claude Code keys a transcript by working
directory, so a shared one would collapse every conversation the user ever had
into a single project row with a single transcript.

Two things in one request:

- **The button is hard to find.** `+ New session` sits at the bottom-left of
  the Now screen, below the session list — the last place on a screen people
  read top-down. The code comment there already records that an earlier
  version pointed at a control that did not exist, so this corner has been
  awkward before.
- **Creating a project should create the folder.** Today you point Caprock at
  a directory that already exists. Vova wants to name a project and have the
  directory made for him.

### FB-005 — Third-party model providers

**Half of it shipped in v0.30.0, and it was the half nobody asked about
explicitly.** Caprock already saw DeepSeek, MiniMax and OpenAI arriving through
OpenCode — it could not price them, so $155 of the owner's own spend sat
outside his total. The providers' published prices are now in the table, so a
total is a total whichever agent ran the work.

That is the observing reading of the request. The other reading — running
non-Claude models *from inside* Caprock — is untouched, and still needs Vova to
say which he meant.

"Free ones first." **Ambiguous in a way that matters** — it could mean either:

- observe sessions that already run through Bedrock, Vertex or a proxy
  (`ANTHROPIC_BASE_URL`), which is close to what exists; or
- run models other than Claude from inside Caprock, which is not.

Neither exists today: there is no Bedrock or Vertex handling anywhere in the
Go code. Ask before building — the two readings are weeks apart.

### FB-004 — JetBrains Mono in the terminal

The terminal is *why he moved onto Caprock full-time*, and Cyrillic in it was
unreadable. Root cause was not a missing font: JetBrains Mono ships in the
bundle with all six of its subsets. xterm.js paints to a canvas and was handed
the literal string `var(--font-mono)`, which a canvas context cannot resolve,
so every glyph fell back to the system monospace — invisible in Latin, ugly in
Cyrillic. Two further defects in the same place: the cell was measured against
the fallback and never re-measured, and no subset was ever requested because
canvas text never enters the DOM to trigger a lazy load.

CJK, Arabic, Hebrew and Thai are **not in the face at all** and cannot be
enabled here. They fall through to the system monospace.

### FB-003 — Willingness to pay

Quoted, in his words, on 2026-08-26: **$20/month** for what exists today,
**$50** with third-party models, **$100** with Claude and GPT together. He
then found the real price — **$30 per year** — and stopped, intending to buy
after payday.

**This is one person's stated intent, not a measurement.** No money has
changed hands. The only thing that would settle it is him returning
unprompted. Recorded because it is the first time anyone reached the card.

### FB-002 — Filter by agent

After OpenCode support shipped, he saw his OpenCode projects appear in a list
that did not say which agent anything belonged to. Shipped as a
`both / claude / opencode` switch. See [.ai/16-opencode.md](../.ai/16-opencode.md).

### FB-001 — Windows hooks

Found in a chat log Dima forwarded. Hook registrations were written with
backslashes and unquoted; Claude Code runs them through a POSIX shell even on
Windows, which ate every separator, so no hook ever fired. Two adjacent
defects nobody reported: `statusLine.command` had the identical bug, and
`filepath.Base` used the host separator so Windows entries went unrecognised.
