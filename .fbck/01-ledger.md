# Request ledger

Every request a user made, what we decided, and where the work lives. Ids are
`FB-NNN`, assigned in order, never reused. Newest first.

Status is one of: **open** (no decision yet) · **planned** (decided yes, not
started) · **building** · **shipped** (in a release, with the version) ·
**declined** (decided no, with the reason in the story).

| Id     | Date       | From | Request                                                    | Status   | Landed in         |
| ------ | ---------- | ---- | ---------------------------------------------------------- | -------- | ----------------- |
| FB-008 | 2026-08-26 | Vova | Pay for models from inside Caprock                         | open     | —                 |
| FB-007 | 2026-08-26 | Vova | Show plan limits where they are actually looked at         | open     | —                 |
| FB-006 | 2026-08-26 | Vova | Quick chat: a findable "new project" that makes the folder | planned  | —                 |
| FB-005 | 2026-08-26 | Vova | Third-party model providers, free ones first               | planned  | —                 |
| FB-004 | 2026-08-26 | Vova | JetBrains Mono in the terminal — Cyrillic was unreadable   | building | —                 |
| FB-003 | 2026-08-26 | Vova | Would pay $20/mo; $50 with models; $100 with Claude+GPT    | open     | —                 |
| FB-002 | 2026-08-25 | Vova | Filter the dashboard by agent after OpenCode appeared      | shipped  | v0.21.4           |
| FB-001 | 2026-08-24 | Alex | Hooks never fired on Windows                               | shipped  | v0.27.3 + v0.27.4 |

## Detail

### FB-008 — Pay for models from inside Caprock

Vova wants to buy model credit through Caprock rather than holding a separate
account with each provider. Unscoped and large: it makes us a payment
intermediary for someone else's API, which is a different business from a
local dashboard. **No decision.** Recorded because it arrived alongside the
willingness-to-pay numbers in FB-003 and the two are probably one thought.

### FB-007 — Show plan limits

Plan limits already exist on the Cost screen (`ui/src/screens/Cost.tsx`) and
read live from Claude Code's status line. So the request is not "build this" —
it is "I did not find it". Treat as a placement problem, not a feature.
Confirm with Vova which screen he expected it on before moving anything.

### FB-006 — Quick chat, and the new-project button

**Two of the three parts are built** (not yet released): the button moved to
the top of the Now screen at the size of an action, and the spawn dialog grew
a `create it if it does not exist` checkbox backed by `create` on
`POST /v1/agents`. Quick chat itself — a way to talk to a session without
going through the terminal — is still open, and is the part that needs a
decision about what it actually is.

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
