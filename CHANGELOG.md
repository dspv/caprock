# Changelog

All notable changes to Caprock. Format: [Keep a Changelog](https://keepachangelog.com/).
Versions map to the roadmap phases in `.ai/09-execution-plan.md`: **v0.1.0** = Observe,
**v0.2.0** = Control, **v0.3.0** = Orchestrate. **v0.4.x**/**v0.5.0** are post-Orchestrate
polish (plan-limit windows, orchestrator-lifecycle fixes, Homebrew formula, first-run UX).

## [Unreleased]

Phase 3 (Delight) has no plan by design.

## [0.9.0] - 2026-08-20

### Added

- **Answers — what Claude actually said.** For a large share of sessions the
  deliverable is not the diff but the conclusion: "this is done, but I could
  not verify X; check with the team and then we finish it." Caprock always
  stored that paragraph and never showed it — the timeline rendered a
  200-character slice on one line, so it survived only in terminal scrollback.

  A new **Answers** screen searches Claude's prose across every session, which
  is the question people actually have ("which session was it where Claude
  explained the SSO thing?"); each result names its repo and links back. Every
  session gains an **Answers tab** with its own prose, newest first. And the
  timeline now expands into readable text with formatting intact, keeping the
  raw event behind a disclosure instead of offering only JSON.

  Subagent chatter is excluded — about half of all assistant turns are
  subagents, and presenting their words as the main thread's would be worse
  than showing nothing. Everything stays on the machine.

- **`GET /v1/sessions/{id}/notes` and `GET /v1/notes?q=`.**

### Fixed

- **Assistant prose was clipped on bytes and corrupted.** The transcript parser
  capped text at 2000 *bytes* and cut at an arbitrary offset, so non-English
  prose was clipped at roughly half the intended length and about a fifth of
  clipped rows ended in a corrupted character — landing hardest on closing
  summaries, the very thing worth keeping. Text is now clipped on character
  boundaries at a far higher limit, and **a daemon started against an older
  database repairs the damaged rows once** from the transcripts still on disk,
  rewriting only the text and leaving ids, costs and everything else untouched.
  On the author's machine that took 452 corrupted rows to 3.
- **Asking the events endpoint for more than its ceiling returned fewer.** A
  `limit` above the maximum silently fell back to 500, so a caller requesting
  everything received the *start* of a session and could mistake an early
  fragment for its ending. It now clamps to the ceiling.

## [0.8.1] - 2026-08-20

### Added

- **Optional update notice.** When a newer release exists, Now leads with a
  line naming it and the exact command for how this copy was installed —
  `brew upgrade caprock`, `scoop update caprock`, or
  `go install …/cmd/caprock@latest` — one click to copy. When no package
  manager owns the binary it links to the release page instead.

  There is deliberately **no "update now" button**: upgrading replaces the
  running binary, so the daemon would be killing the process executing the
  command, and running a package manager on your behalf from a web page is a
  surface a local-first tool should not open. You run one line in your own
  terminal, where you can see exactly what it does.

  The check is **the only outbound call Caprock makes**, so it is off until you
  turn it on — offered once in plain words, revocable, throttled to once a day,
  and carrying no body, credentials, or usage data. The opt-in is enforced by
  the daemon (`POST /v1/update/check` is 403 while checks are off), not merely
  hidden in the UI, and reading the status never touches the network. A `dev`
  or source build is never told it is out of date.

- **`GET /v1/update` and `POST /v1/update/check`**; `update_checks` added to
  `/v1/settings`.

### Changed

- **Engineering rule 4 now states the exception honestly** — "no outbound
  calls" became "no outbound calls except the release check the user
  explicitly turns on", in the rules, the product doc, and the README, rather
  than leaving a promise the code no longer keeps literally.

## [0.8.0] - 2026-08-20

Three surfaces that answer questions the dashboard could already have answered
from data it was collecting but never said out loud.

### Added

- **Live activity feed on Now.** One column of what every session on the
  machine is doing, newest first, fed by the existing live WebSocket and seeded
  from recent history so it is never empty on open. A session list says what
  exists; the feed says what is happening. Only events worth reading become
  lines — successful tool results, assistant turns, cost ticks and mail are
  dropped, because a feed of raw event kinds is noise. Long absolute paths in
  shell commands collapse so the verb stays visible. Pause to read.
- **Plan value.** What your measured usage would have cost at API list price,
  against what you actually pay. Caprock cannot detect your plan — Claude Code
  does not report it, and inferring one from usage would be an invented number
  — so you state it in a header chip that is one click from being changed. On a
  flat plan (Pro/Max/Team seat) you get a multiple; on metered billing (API
  key, Bedrock, Vertex, Enterprise at API rates) no multiple is shown at all,
  because that figure is approximately your real bill. It never says "you
  saved $X": without the plan you would not have run that much.
- **Attention strip.** Reports a live loop (with the evidence and what that
  session has spent), a session that errored, and a session that has been
  waiting on you long enough to cost you time. There is no "all clear" state —
  it renders nothing when nothing is wrong. Being expensive is never on its own
  a reason to fire.
- **`GET`/`PUT /v1/settings`** for the stated plan, validating rather than
  coercing so a typo cannot drive a wrong headline figure.

## [0.7.0] - 2026-08-20

### Added

- **Per-project spend on Now.** The landing screen opens with a Projects
  roll-up: one row per repository with its measured cost, tokens, session
  count, a bar showing its share of the largest project, and a green dot when
  a session is live in that repo. A session list could not answer "what does
  this repo cost and who is working in it" — this does. The range selector
  (`today` / `7d` / `30d` / `all`) defaults to 30d, because "today" is empty
  most mornings and an empty panel reads as broken rather than as an honest
  zero. Every figure is measured from captured events at API list price.
- **`sessions` in each `projects` entry** of `GET /v1/stats/summary` — the
  count of distinct sessions that touched a project in the range.

### Changed

- **Numbers now carry the cards.** A stat's value sat at 17px against its own
  10px label, close enough in weight that a card had to be read up close
  rather than scanned; values are larger throughout.
- **The orchestration graph left the top nav.** With no orchestrator running
  it can only draw session ids around a hub — topology rather than work — so a
  permanent nav slot bought a screen that says nothing to a solo user. The
  route stays at `#/graph` and the Tasks board links to it while any task is
  assigned and unfinished.
- **The graph reads at a glance** when it *is* meaningful: a headline of
  verified / in-flight / worker counts, each worker labelled with the task it
  is working on and a plain-language status, and larger nodes and gates.

### Fixed

- **Inline links no longer underline whole cards.** A session card is an
  `<a>`, so a global hover rule underlined every label and number inside it;
  underlining is now opt-in for genuine inline links.

## [0.6.0] - 2026-08-20

### Added

- **Light theme.** A header toggle (sun/moon) flips the dashboard between the dark
  ops-room look and a light theme; the choice is persisted and, when unset,
  follows your OS preference. Every screen and the live terminal adapt.
- **`go install` works with a real UI.** `go install
  github.com/dspv/caprock/cmd/caprock@latest` now embeds the built dashboard (the
  UI is committed and a CI check keeps it in sync), so a Go install is a full
  Caprock, not a placeholder page.

### Fixed

- **Plan-limit forecast uses the daemon clock** (consistent + deterministic), and
  the status-line command quotes only the binary path — so a caprock installed
  under a path with spaces registers correctly.

## [0.5.1] - 2026-08-20

### Added

- **Windows install via Scoop.** `scoop bucket add dspv
  https://github.com/dspv/scoop-bucket` then `scoop install caprock` — no more
  hand-downloading a zip. The manifest is pushed to the bucket on each release,
  and the README, install guide, and site now show the Windows path alongside
  Homebrew.
- **Project map** in the README linking the site, the Homebrew tap, and the Scoop
  bucket, so any repo in the project points to the rest.

## [0.5.0] - 2026-08-20

Distribution polish — a smoother first run and a safer release pipeline.

### Added

- **Plan limits, set up for you.** `caprock up` now offers to register the
  `caprock statusline` command (the 5h/7d plan-limit windows on the Cost screen)
  under the same consent contract as hooks — a TTY prompt, or `--yes` for
  scripts. New `caprock statusline install` / `caprock statusline uninstall`
  subcommands manage it explicitly. It backs up `settings.json` once and never
  touches a status line you set yourself. New users get plan limits without
  hand-editing any file.
- **CODE_OF_CONDUCT.md** (Contributor Covenant 2.1), linked from CONTRIBUTING.

### Fixed

- **Honest first-run errors.** When the daemon can't start (most often the port
  is already taken), `caprock up` now surfaces the real cause — e.g. "port
  127.0.0.1 is already in use — try `caprock status` / `caprock down`, or
  `--port <n>`" — instead of a bare "did not report ready" timeout.
- **Readable MCP tool names.** In History's Tool Usage, `mcp__server__tool` now
  renders as `server·tool` with the full name on hover, instead of truncating.
- **Release can't ship a red commit.** The release workflow now runs a `verify`
  job (`make check` + Windows cross-build on the tagged commit) before goreleaser
  builds or publishes anything, and writes the Homebrew formula to `Formula/`
  (not the repo root, which `brew` ignored — a stale formula could otherwise be
  served).

## [0.4.1] - 2026-08-19

### Fixed

- **Homebrew install now includes the hook shim.** The formula installed only
  `caprock`, not `caprock-hook`, so a `brew` install fell back to the
  `caprock hook` self-command. Both binaries ship now.
- **Hook status/uninstall recognize the self-hook form.** When hooks were
  registered as `…/caprock hook` (no sibling shim), `caprock status` read
  `0/8` and `hooks uninstall` silently left them in place (causing duplicates on
  reinstall). Inspection now matches both the dedicated shim and the self-hook
  command, so status is honest and uninstall is clean.

## [0.4.0] - 2026-08-19

Post-Orchestrate polish: a new plan-limit feature, orchestrator-lifecycle fixes,
and CLI packaging.

### Added

- **Plan-limit windows** — `caprock statusline` (register as Claude Code's
  `statusLine.command`) reads Claude Code's `rate_limits` and shows your 5-hour /
  7-day window usage and reset time on the Cost screen, with an honest "at current
  pace" forecast shown only when your measured usage would reach the limit before
  the window resets. Pro/Max only; absent otherwise. The command also prints a
  compact one-line status (model · context% · cost · limits) and can never break
  or slow the session.

### Fixed

- **Orchestrator: workers now stop cleanly.** A worker's fire-once mail lingered
  in its inbox after it acted, so the Stop-loop forced continuation forever and
  the worker was re-kicked into an endless inbox-poll. The router now archives a
  consumed message to the agent's `processed/` dir once its task moves past the
  state that message was driving — both a picked-up `assign` and a verify-bounce
  the worker has since fixed. Live mail (questions, un-acted bounces) is kept.
- **Orchestrator: `Start` is idempotent and race-safe.** Starting the
  orchestrator while a session is already live no longer spawns a duplicate
  (which leaked the first and raced a second router loop on the same hive); it
  re-kicks the live session so it picks up newly-queued tasks. A `starting` guard
  closes the check-then-spawn window so two concurrent starts can't both spawn.

### Changed

- **Homebrew formula, not cask.** A CLI binary ships as a formula (casks are for
  GUI apps), so install is now `brew install dspv/tap/caprock` (no `--cask`); the
  formula also works on Linux Homebrew.

## [0.3.0] - 2026-08-19

**Phase 2, Orchestrate**: a verified multi-agent team. Driven end to end by a real
`claude` orchestrator, unattended, with hooks.

### Phase 2 — Orchestrate

- On-disk hive (agents / tasks / mailboxes / append-only ledger), single writer,
  atomic writes, dependency-free YAML.
- **Tasks board** (kanban over `tasks/*.md`), New-task dialog, approvals.
- **Orchestrator agent** — a real `claude` session with a hive-aware system prompt
  that spawns and coordinates workers via mailboxes; the router is a reconciler
  that spawns a worker per assigned task, runs verification, and wakes idle
  sessions with unread mail.
- **Stop-loop autonomy** — a worker's Stop hook is answered to force it to keep
  going while its inbox is non-empty, with a hard guard (N=10) that escalates.
- **Verification before done** — a task's `done_criteria` run in the worker's
  worktree; only green checks reach `done`; red bounces the failing output back
  (R=3 rounds, then escalate). Destructive commands never run unattended (they
  escalate to `needs_you`). Cost is attributed to the task.
- New endpoints: `POST /v1/orchestrator/start`, `POST /v1/tasks/{id}/verify`;
  `--hive` / `--repo` flags.

## [0.2.0] - 2026-08-19

**Phase 1, Control**: spawn and drive `claude` sessions from the dashboard.

### Phase 1 — Control

- Spawn real `claude` sessions from the UI into an optional git worktree, with a
  live xterm.js terminal (bidirectional) in **Session Detail**.
- Owned-session controls: pause / resume / kill — **only** for sessions Caprock
  spawned; externally started sessions stay observe-only.
- Opt-in auto-pause of a looping owned session.
- **History** screen — lifetime stats: cost per project / day / model, tool
  distribution, model mix, top projects.
- New endpoints: `POST /v1/agents`, `/v1/agents/{id}/input|signal`,
  `WS /v1/agents/{id}/term`, `GET /v1/history`.

## [0.1.0] - 2026-08-19

First tagged release — **Phase 0, Observe**: watch every `claude` session on the
machine, live, with token burn and cost, entirely on-device.

### Phase 0 — Observe

- Single static Go binary: a loopback daemon (`127.0.0.1:4173`) that serves the
  REST API, a `/v1/live` WebSocket, the hook receiver, and the embedded dashboard.
- **Hook plane** — a tiny `caprock-hook` shim registered in `~/.claude/settings.json`
  (non-destructive, backed up, cleanly removable) forwards the core Claude Code
  hook events; a broken or absent daemon never affects the user's session.
- **Transcript plane** — tails `~/.claude/projects/**`, schema-versioned parser,
  tolerant of malformed lines and unknown fields; usage counted once per response.
- Normalized event stream in SQLite (pure-Go, no CGO); cost from a versioned
  pricing table (Anthropic list prices, dated) and cache-savings math.
- **Loop detector** — flags a session repeating the same tool with similar input
  (K=5 in T=3 min), with an alert banner.
- Dashboard: **Now** (per-session narration, health, plan progress, live burn),
  **Session Detail** (event timeline, live `git diff`), **Cost** (burn, model mix,
  per-project, 30-day), **History** (lifetime stats, tool distribution).
- CLI: `caprock up | down | status | hooks install|uninstall|status | tasks`.
- Event retention (`retention_days`, default off) caps database growth.

## Notes (all releases)

- Local-first: loopback only, no telemetry, no outbound calls from the daemon.
- Prices and context-window sizes live in `pricing/pricing.json` (dated, sourced
  from the Anthropic pricing page). No invented numbers.
