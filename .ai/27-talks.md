# Talks: agents speak for two people

**Status: accepted 2026-11-28; P1's backend built (below), no screen yet.** The decision is
[ADR-110](08-decisions.md#adr-110--talks-agents-speak-for-two-people); this
file is its build plan. Two people who trust each other link their Caprocks
once; after that, a one-line goal starts a Talk in which each side's own
agent, grounded in its owner's 2nd Brain and sessions, talks to the other's
until they reach an outcome both people accept. Nothing but what the Talk
lists as sent leaves either machine.

## The P1 principle

**Super convenient for trusted pairs first.** The first user is the owner
and a partner he trusts. Every step a stranger would need and a partner does
not is left out or off by default, and kept for the team phase (P5): the
second-model check is a toggle per partner, off; the brief is optional and
pre-filled; the safety code is shown, never a step. What stays on for
everyone from the first PR is cheap and silent unless it fires: secret
redaction, the caps, the hold, and the log of what left the machine.

**The friction target** (ADR-110, *Friction is a number*), checked by a UI
test in P1 that walks both paths and counts:

- a pair already linked: **at most 2 actions** from "I want to talk to Ana"
  to the first agent message — pick Ana, type the goal and press Enter;
- a new pair, both with Caprock: **at most 5 clicks** in all, typing and
  pasting the invite into a messenger not counted — inviter 2, partner 2,
  inviter 1.

A PR that adds a click to either path says so and why, and moves the target
only by amending ADR-110.

## What already exists

- **The relay and the channel** (ADR-058): Noise NK end to end, ciphertext
  on the relay (`internal/remote`).
- **Daemon-to-daemon links** (ADR-067): `peers.Manager`, its channels and
  `Do`, tokens bound to the peer's relay key (`internal/peers`).
- **The rendezvous key** (ADR-108): one use, a hash in memory, five wrong
  secrets burn it, pre-approval of one proven key (`internal/peers/join.go`).
- **The gate's allowlists** (`internal/api/lanauth.go`:
  `controllerRoutes`, `computerRoutes`): a new kind gets its own list, closed
  until named.
- **Headless agent calls with no tools** (ADR-103): `brain.Runner` for
  Claude Code, Codex, Cursor and Gemini CLI, with usage read back.
- **Read-only tools over the user's data** (ADR-078): the `caprock mcp`
  answers, already passed through `internal/redact`.
- **Redaction** (`internal/redact`): `Text` returns the redacted string and
  the counts per kind.
- **Pricing and plan dollars** (`pricing/`, ADR-084), **notifications** to
  the desktop, the phone and Telegram, and **the chat view** (desktop and
  phone).

## Phases

Each phase is a few small PRs, green on the three-OS matrix, with its docs,
contracts and migration in the same commit (rules 8, 9) and a changelog
fragment. A phase reaches users in one release, not PR by PR: no Talk is
usable before its guard exists.

### P1 — a trusted pair: link, Talk, redaction, hold

- **P1.1 The person link.** `kind: "person"`, role `talk`, and
  `personRoutes` in the gate (deliver an envelope, read delivery state) with
  a test that a person device gets 403 on every other route. `people.json`
  (0600) beside `machines.json`. Invite: `POST /v1/talks/invite` makes a
  24-hour rendezvous key (ADR-108's desk with a person kind), returned once
  as the key and as `https://caprock.dev/talk#<key>`; accept: `POST
  /v1/talks/accept`, which turns access from anywhere on and pairs both ways,
  each code pre-approving the other's proven key. The site page
  (`caprock-web`, its own PR there) opens the app with the fragment or shows
  how to install it. The safety code on the partner's page. **Remove** from
  either side. *Let Ana start talks* set on at accept.
- **P1.2 The Talk.** Tables (`talks`, `talk_envelopes`, `talk_outbox`) in a
  migration; the envelope of ADR-110 with per-sender sequence and previous
  hash; the outbox retried while the other side is offline. Starting: one
  line of goal (`POST /v1/talks`, and ⌘K *Talk with…*). The turn loop: the
  owner's default agent and its strongest model through the ADR-103 runner,
  incoming text quoted as data, ADR-078's read-only tools scoped by
  ADR-110's default (2nd Brain and sessions except *Personal* folders and
  unshared vaults), structured answer, only the message leaves. Turns
  alternate; an agent's *done* or *needs my owner* ends its turn.
- **P1.3 The guard and the hold.** The default brief (*never share secrets,
  keys, credentials, or other people's private data*), editable in Settings
  → Talks and from the chat header, with optional literal never-share terms.
  `internal/redact` plus those terms on every outgoing envelope; a hit holds
  it. Caps: 12 messages and $5 per side per Talk, defaults in Settings →
  Talks, a hold when reached. The hold notification (desktop, phone,
  Telegram when on) with Send / Edit / Drop.
- **P1.4 The chat view and the log.** A Talk in the existing chat view, three
  voices (my agent, theirs, the two people), live on desktop and phone; a
  person can type in, pause their agent, take over, end. *What left this
  machine* from the chat header. Cost per message and per Talk from this
  side's pricing; the other side's total when shared (on by default, a
  switch in Settings → Talks). Notifications only for a hold (and, from P2,
  an outcome card).
- **P1.5 Rule 4 and the docs.** ADR-110's draft sentence into `CLAUDE.md`
  rule 4 and `.ai/00-index.md`'s rule 4; `docs/talks.md` for users;
  `03-contracts.md` § Talks; the friction test.
- **Built, the backend (2026-11-28):** P1.1 without the site page and the
  partner's screen; P1.2 without ⌘K; P1.3 with the hold notification on
  the desktop and the phone, not Telegram, and the settings through `PUT
  /v1/talks/settings`; P1.5's rule 4 and contracts
  (`03-contracts.md` § Talks, § Talks DDL). The turn has no tool at all:
  this side's 2nd Brain is handed to it read only, as grounding in the
  prompt (up to 12 memories about the goal), rather than through ADR-078's
  tools. Cost is what the agent reports (Claude Code reports dollars; for
  an agent that reports only tokens it is 0 until priced from `pricing/`).
  Open in P1: the chat view, the log view and the hold's buttons on screen
  (P1.4), ⌘K *Talk with…*, Telegram for a hold, `docs/talks.md`, the
  friction test, and the site page in `caprock-web`.
- **Tests:** two daemons and a local relay in the smoke setup with a fake
  agent: invite, accept, a Talk of four turns, a redaction hit held and
  sent from the hold, a cap reached, Remove from each side; an incoming
  message that asks the agent to run a tool or approve a prompt changes
  nothing (the turn has no such tool); the person token refused on every
  route outside `personRoutes`; no secret value in a log, event or file.

### P2 — the outcome card and shared artifacts

- The outcome card (decision, open points, who does what, cited sources):
  proposed by either agent, through the guard, versioned on both sides,
  agreed only when both people Accept; a notification for each new card.
- **Copy for Slack** (plain text that survives a paste) and **Keep in 2nd
  Brain** (a decision memory with the Talk as its source, that side only).
- Shared text artifacts: content-hashed versions with their author, through
  the guard, the whole history on both sides, a version written against an
  older one shown as a branch.

### P3 — the second-model check, a toggle per partner

- The check of ADR-110 (fresh context, no tools, the brief, the draft and
  the sources read, never the other side's text), on the talker's model by
  default; a flag holds the message.
- A switch per partner, off by default; per Talk from the chat header.
- The red-team set that answers `OQ-35`: scripted probing partners against
  a set of briefs, measuring what redaction alone and redaction plus the
  check let through, and what the check holds needlessly.

### P4 — each person reads in their own language

- A translation per message made on the reader's side by the reader's agent,
  at the reader's cost, shown in the chat with the original one tap away;
  never sent.
- The agents write in the goal's language unless a party sets another.

### P5 — team rooms, the store and team rules (the team tier)

- Rooms of three or more (each member's Caprock linked to each other's, or
  through the team's server; decided when the team server of ADR-021 is
  built). Behind the offline licence (ADR-022).
- The shared artifact store on the team's self-hosted server.
- Team rules: a team brief applied as a floor under every member's brief,
  narrowable and never widened.
- The heavier defences as the team's defaults: the second-model check on, a
  brief required before a member's agent speaks, a held message for every
  flag.
- Whether a guest without a licence may join a room is `OQ-36`, the owner's.

## Not in this plan

- Web search or fetch inside a turn.
- Files other than text as artifacts.
- A2A interop (the envelope stays mappable to it).
- Store-and-forward while the other side is offline (a server, ADR-109, is
  the way).
- Starting or answering a Talk from Telegram; voice.
