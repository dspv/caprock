# Caprock — Build Status

The running log: what is done, what is not, what is next. **Update this file and § Current State in [00-index.md](00-index.md) whenever the state of the world changes.** Dates in absolute form, never "last week". What "done" means per task is defined in [09-execution-plan.md](09-execution-plan.md).

**Last updated: 2026-08-24** · Phase **2 — Orchestrate, complete** · **every phase is tagged and published** (Homebrew formula in `dspv/homebrew-tap` — `brew install dspv/tap/caprock`). The live unattended orchestrator run (the Phase 2 tag gate) is done — a real `claude` orchestrator autonomously assigned a task, spawned a worker, and drove it to green verification. Post-Orchestrate: v0.4.0 = plan-limit windows + orchestrator-lifecycle fixes + Homebrew formula; v0.4.1 = the formula ships the hook shim + honest hook status; v0.5.0 = distribution polish (statusLine auto-install, honest first-run errors, readable MCP names, a release CI-gate, CODE_OF_CONDUCT); **v0.5.1 = Windows install via Scoop (`dspv/scoop-bucket`) + a README project map; **v0.6.0 = light theme + `go install` with a real embedded UI; **v0.7.0 = per-project spend on Now, larger numbers, and the graph out of the top nav; **v0.8.0 = the three owner-agreed surfaces — a live activity feed, plan value (API-priced usage against the stated subscription), and an attention strip for loops/errors/stalls.** v0.8.1 = the optional update notice (B2 closed). **v0.9.0 = Answers (B0): Claude's own prose, searchable across sessions, plus the byte-truncation repair.** **v0.9.8 = interface hierarchy plus four honesty fixes: every cost figure states its basis, percentages floor, and the live indicator no longer freezes.** **v0.10.0 = the live pulse: a track per session, one bar per minute, where the shape of the track is the shape of the work.** **v0.9.9 = eight defects found by hunting rather than by tests — a third of the active-day count missing, settings wiped by a partial body, tasks lost when created together, and an unknown API path answering 200 with a web page.** Next: backlog B3 (Claude desktop usage) in [09-execution-plan.md](09-execution-plan.md). The orchestration graph shipped but did not earn a nav slot; see [04-ui.md § Graph](04-ui.md).

## Progress by track

Percentages are deliberately coarse — they answer "is this track started, half-built, or done", nothing finer. The same numbers drive the progress bars in [README.md](../README.md); **update both in the same commit.** "90%" means "works, not hardened"; never 100% for anything that has not run in the environment it was built for.

| Track                           | Progress | State                                                                 |
| ------------------------------- | -------- | --------------------------------------------------------------------- |
| Documentation (`.ai/`)          | 90%      | Corpus built, audit green, kept current with code                     |
| Phase 0 — Observe (T0–T10)      | 100%     | Works on macOS + CI (macos/ubuntu/windows); v0.1.0 tagged + published |
| Phase 1 — Control (T11–T16)     | 100%     | v0.2.0 tagged + published; green on the 3-OS CI matrix                |
| Phase 2 — Orchestrate (T17–T25) | 100%     | v0.3.0 tagged + published; live unattended run with hooks passed      |
| Phase 3 — Delight               | 0%       | No plan by design                                                     |

## Milestone status

| #       | Milestone                    | Status                                                                 |
| ------- | ---------------------------- | ---------------------------------------------------------------------- |
| M0      | Spec migration + loss audit  | done                                                                   |
| T0      | ConPTY spike                 | done (informational; ptyspike job)                                     |
| T1      | Repo bootstrap               | done                                                                   |
| T2      | store + migrations           | done                                                                   |
| T3      | hookd + shim + installer     | done                                                                   |
| T4      | ingest                       | done                                                                   |
| T5      | rollup + pricing             | done (parity vs formula; OQ-01 resolved)                               |
| T6      | api + live WS                | done                                                                   |
| T7      | UI: Now + Session Detail     | done                                                                   |
| T8      | UI: Cost                     | done (plan-limit windows shipped via statusline; OQ-03 resolved)       |
| T9      | Loop detector                | done                                                                   |
| T10     | Release hardening → v0.1.0   | done (v0.1.0 tagged + published 2026-08-19; cask in dspv/homebrew-tap) |
| T11–T16 | Phase 1 (Control) → v0.2.0   | done                                                                   |
| T17–T25 | Phase 2 (Orchestrate)→v0.3.0 | done                                                                   |

## What is true right now

- **All three phases are built and green.** The Go module + `ui/` exist and are exercised by `make check` (Go tests, `go vet`, `golangci-lint`, docs gates, and the UI typecheck/vitest/build) on the 3-OS CI matrix. Phase 2's orchestration loop has been driven end to end by a real `claude` orchestrator (see the Phase 2 log entry). **every phase is tagged and published** (Homebrew formula in `dspv/homebrew-tap`).
- The Python measurer (`~/dev/caprock-legacy`, PyPI `caprock` 0.3.0) is frozen ([ADR-007](08-decisions.md#adr-007--the-harness-is-caprock-new-go-codebase-in-dspvcaprock-python-measurer-frozen)); the Go binary shipped its first release as **v0.1.0** on 2026-08-19.
- **OpenCode is supported and released.** Caprock reads OpenCode's SQLite
  database, shows those sessions on the same screens as Claude Code, and the Now
  screen carries an `all / claude / opencode` switch that applies to the whole
  screen. Observation only: it cannot start, steer or stop an OpenCode session,
  and the task runner does not work with it. See [16-opencode.md](16-opencode.md).
- Toolchain versions in [10-infrastructure.md](10-infrastructure.md) were checked on 2026-08-18 and are now exercised in CI.

## Log

### 2026-08-28 — A terminal you can live in, and two tests that proved nothing

The written milestone diagnosed its own root cause — input is line-buffered,
submitting on Enter — and told us to treat that as true until disproved.
Checking first was the whole value of the day: `term.onData` had always sent
every keystroke straight to the PTY. What was broken was the **size**.
`Resize` was declared on the agents interface and called from nowhere, so a
PTY kept 120×40 for its entire life while Claude Code laid its menus out to
it. Arrow keys moved a selection that was off screen, which is precisely what
a user means by *"only Enter works"*.

**Shift+Enter took two wrong answers before the right one.** CSI u
(`ESC [ 13 ; 2 u`) is sent only after negotiating the kitty keyboard protocol,
which this terminal never does, so it did nothing. A bare line feed looked
safe — the documentation says Ctrl+J works everywhere and Ctrl+J *is* a line
feed — but Claude Code reads a lone line feed as **submit**. Vova's report
contained the tell: on an empty prompt it looked like a newline, because there
was nothing to submit. The answer was on disk the whole time: `/terminal-setup`
writes a binding into iTerm2 that sends `5c 6e` — a backslash and the letter
n. **When a product configures a terminal for itself, read the configuration
instead of inferring the protocol from prose.**

Shipped with it: copy/paste on VS Code's rule (Ctrl+C copies with a selection,
interrupts without), WebGL rendering with a canvas fallback, scrollback 5k →
10k, and paste-a-file — bytes to `POST /v1/paste`, path typed into the session.

**Two tests passed while proving nothing, and both were caught by breaking the
code they covered.** The WebGL fallback test matched on `constructor.name`,
and the real addon minifies to `l`, so the branch never fired — the component
would have died on every machine without WebGL and passed here. The text-paste
test asserted no upload happened rather than that the event was not swallowed,
so intercepting *every* paste passed it. A test that cannot fail is worse than
no test: it is a claim of coverage.

**And a security decision that arrived as a failing test.** `POST /v1/paste`
first took a raw body with the image's own content type, and its test returned
403 — the forgery guard working exactly as designed. `image/png` is a *simple*
content type, so a raw endpoint would have been reachable by any page in the
browser without a preflight; an endpoint that writes files to disk must not be
that. Base64 inside JSON costs a third more bytes and keeps it behind the same
guard as everything else.

### 2026-08-27 — The share card, decided by looking at it

The card was a poster: a heading, one enormous number, three figures and a
disclaimer. Nobody shares a poster about their own work — what people post is a
screenshot of the thing working, which is what the owner said and what the
rebuild follows.

**Three layouts were drawn on real figures and looked at, not described.** The
one that read as a cropped screenshot was rejected on sight — panels of
differing heights, bars running under their own numbers — and the one that won
is the dashboard's own shape: eight tiles over two breakdowns.

**What the card does not carry is the part worth remembering.** The
instantaneous burn rate read $7.33 one minute and $33.54 the next; a figure
true for ninety seconds does not belong on an image that lives in a feed for
weeks. Turns and tool calls went because nobody has a feel for them, and the
session count went because it was the same problem in another unit — replaced
by cost per million tokens, the only tile that answers *dear or cheap*.

**Three defects were found by looking at the real output rather than a
mockup**: thin bars drew as hooks (a corner radius wider than the bar), the
caveat had been dropped in the rewrite, and gateway model ids carry a slash
that on a posted image is indistinguishable from a repository path. The SVG
mockups showed none of them — canvas rounds corners differently, and the
mockups used ids that happened to have no slash.

The button that produces it was the word "share" in 11px grey between
"feedback" and "status". It is now in the ALL TIME panel beside the figures,
and the nudging moved to a separate control that waits for an occasion — a
button that renames itself to shout about a milestone is one people stop
recognising.

### 2026-08-27 — The paid tier gets a boundary, and gives one feature back

Three things, and the middle one is the one worth keeping.

**Keys can be issued by hand.** The Stripe webhook was the only thing that
could mint one, which meant no way to serve a customer who paid another way, a
refund reissued, or a friend at a conference. `caprock license issue` closes
that. Building it found two defects: a key with no random suffix was rejected
although its date was complete — so one dictated over the phone would not have
worked — and `license set` stored whatever it was given, turning a typo into a
support email instead of an error message.

**A feature was removed from the paid tier because it became free.**
Third-party pricing was going to be sold: DeepSeek and MiniMax arrive through
OpenCode as usage nobody could cost, and $155 of the owner's own spend sat
outside his total. Then adding the providers' published prices turned out to be
an afternoon's work, less than building a paywall around them would have been.
Charging for something the free version performs is how a paid tier becomes a
hostage, so the feature was deleted from the list rather than kept as a claim.

That is now a rule with a test behind it ([ADR-022](08-decisions.md)): a lock
may only cover a feature that does not exist yet, never a panel showing
measured data. It has already been decided against us twice — the cap's preview
was blurring out today's real spend, a figure the same screen gives away for
free.

**The unpriced warning was lying.** It fired on turns recorded with explicit
zero tokens, because the query tested for NOT NULL rather than for a number
greater than zero. The dashboard told users their total was missing money when
it was missing nothing.

### 2026-08-26 — The payment path, end to end

Money can now reach us and produce a working feature, which it could not that
morning: the page thanking a buyer promised an email nothing sent, and there
was no key for it to carry.

**Licensing is decided and built** ([ADR-022](08-decisions.md)): a key with its
own expiry, checked offline, seven days of grace. The reasoning is in the ADR;
the short version is that a check in an Apache-2.0 binary is deletable in five
minutes whatever it costs to build, so the thing worth engineering against is
not theft but a customer paying and receiving nothing.

Three defects came out of building it rather than reasoning about it: the
expiry day itself was not covered, taking a day the customer paid for; the
grace message named the day features stop rather than the last day they work;
and `PUT /v1/settings` decodes a named allow-list, so `license_key` was
accepted with a 200 and silently discarded — a payment that appeared to work
and did nothing.

**Three tiers**: free, $30/year or $5/month, and $100 once. Lifetime is an
ordinary key with a date in 2076 rather than a flag, so the daemon keeps one
code path.

**The welcome email works**, verified by running the real webhook code with the
real key and reading what arrived. Getting there found a fault no amount of
reading would have: the Resend key belonged to a different workspace, so the
dashboard showed `caprock.dev` verified while the API refused every send. A
domain looks the same from both sides right up until you try it.

**What is not verified**: no real purchase has been made. Everything either
side of Stripe is exercised; the transaction itself is not.

### 2026-08-26 — Selling from inside the product, and a panel that was slow

The owner read the dashboard as a buyer would and found nothing to buy. Three
things came out of it, and the first is the one worth remembering.

**The banner was invisible because of a rule I wrote.** It was kept off Now to
avoid interrupting people at work, which sounds right and meant that a user
with no loop and no runaway session never learned a paid version exists. The
caution was so complete it removed the offer. Judgement about restraint is
still judgement about the product, and it can be wrong in the direction of
doing nothing.

**Selling through a locked feature beats selling through a sentence.** The
daily cap now sits in its real place on the Cost screen, behind glass, with
the reader's own figures under it. It is honest in a way a feature list is
not: the thing is visibly not working yet, which is exactly true.

**A slow panel was reported by eye before it was measured.** The owner said
the ALL TIME panel took too long; `GET /v1/history?range=all` was 0.76–1.17s
against 0.15s elsewhere, and `ToolDistribution` was 60% of it — an index that
matched `(kind, ts)` and did not carry `tool`, so ~80k rows were read from the
table for one column. Covering index, 139 ms → 46 ms warm.

The site changed with it: the landing page's final call to action offered
`caprock up` to people who had not installed anything, the terminal — the
feature that let the first full-time user drop the Claude Code IDE — had never
been mentioned, and the teams page argued across ten sections before offering
a call. It is three now: what you get, where it runs, book the call.

### 2026-08-26 — A user moved in, and told us what was wrong

The first person to use Caprock as his main working surface replaced the Claude
Code IDE with it. The terminal is what made that possible — which reframes a
Phase 1 control feature as the thing that makes Caprock somewhere a person can
live, and makes a font defect in it not cosmetic.

What he asked for, and what happened:

- **JetBrains Mono in the terminal.** Not a missing font: it was already
  bundled with all six subsets. xterm.js paints to a canvas and was handed the
  literal string `var(--font-mono)`, which a canvas context cannot resolve, so
  every glyph fell back to the system monospace — invisible in Latin, ugly in
  Cyrillic. Two adjacent defects: the cell was measured against the fallback
  and never re-measured, and no subset was ever fetched because subsets load
  when a matching character enters the DOM and canvas text never does.
- **The new-session button, and creating the folder.** Both done. The button
  was at the bottom of Now in 11px grey; `create` on `POST /v1/agents` makes
  the directory, opt-in and one level deep.
- **Quick chat.** A session with no repository at all, one directory per chat
  under `<data_dir>/chats/`.
- **Plan limits he could not find.** They existed, on the Cost screen, under a
  thirty-day chart — and the panel vanished when there was no data, so the one
  screen that could explain the absence explained nothing. Now also a line on
  Now, plus alerts at 90%.
- **Third-party models** and **paying for models through Caprock** are open:
  both readings of the first are weeks apart, and the second would make us a
  payment intermediary for someone else's API. Recorded in
  [`.fdck/`](../.fdck/00-index.md), not guessed at.

He also priced it, unprompted: $20/month for what exists, $50 with other
models, $100 with Claude and GPT. Then found the real price — $30 a year — and
said he would buy after payday. **No money has changed hands**, so this is one
person's stated intent and not a measurement; it is the first time anyone
reached the card, which is why it is written down.

`.fdck/` exists as of this entry: the feedback that moved this product used to
arrive in chat logs and live nowhere, and both the Windows hook break and the
install-prompt rewrite were reconstructed from memory after the fact.

Two defects found while fixing his, neither reported by anyone: a directory
counted as two projects when one of its sessions started outside a repository,
and the screenshot scrubber renamed projects but not the directories above
them, so published images carried this machine's layout.

### 2026-08-25 — OpenCode ships, and the filter that made it usable

The reading half went in overnight and released as v0.21.0. What followed was
a day of a user's questions turning into defects, which is the pattern worth
recording: each one looked like a small omission and was actually a thing that
made the feature not work.

A user upgraded, saw his OpenCode projects appear, and asked how to switch
between the two agents — because there was nothing to switch between. The
agent label existed on exactly one surface, the session card at the bottom of
Now, while the live pulse and the projects list showed OpenCode work unmarked
(v0.21.3). Marking the rows was still not the ask: he wanted to see each agent
on its own, so the projects panel gained `both / claude / opencode` (v0.21.4).
That left a filtered list beside an unfiltered total — the way a reader ends up
quoting a number that means something other than what the heading says — so the
filter moved to the screen and reached every panel (v0.22.0). Then the control
itself proved unreadable at 11px in a bordered strip, and 'both' would become a
lie the moment a third agent arrives (v0.22.1, v0.22.2).

Two defects were found by writing tests rather than by using the product.
`touch_dir` is derived from the payload by the store, so the ingester emitting
OpenCode's own field names left every tool call unplaced and per-directory
cost silently empty. And spend from a session the filter excluded fell into
the "orphan" row, which exists for deleted sessions — under a filter that row
collected the *other* agent's money and showed it, unlabelled, under this
agent's heading.

Coverage of `internal/opencode` was 2.3% in CI before the fixtures, because
both tests needed a real OpenCode installation. It is 89% now, identical with
and without OpenCode present, and checked by mutation.

### 2026-08-24 — OpenCode: measured, decided, deliberately not finished

A user asked whether Caprock could watch OpenCode sessions. Rather than estimate
from documentation, the question was answered against a real installation: 70
sessions, 10,923 messages and $156 of usage already sitting in
`~/.local/share/opencode/opencode.db` on the owner's machine.

The finding that set the plan is that OpenCode is **easier to observe than Claude
Code**, not harder. It keeps one SQLite database in which `cost`, the four token
counts, `directory` and `model` are already columns — no shim, no config
injection, no transcript parsing, and no pricing table, because OpenCode prices
its own turns. `internal/opencode` was written and verified against that database
in about an hour: per-repository cost, tool-name normalisation (`bash`→`Bash`,
`task`→`Agent`), and file-path extraction for per-directory attribution all
work on real data.

Two things were measured that a later implementation would otherwise get wrong.
Subagent sessions are separate rows carrying their own cost, so a naive
`SUM(cost)` overstates a project by 1.4% ($156.25 against $154.06 root-only) —
47 of the 70 sessions are children. And OpenCode's cost is modelled from
models.dev list rates rather than billed, the same caveat Caprock already states
about its own figures.

The owner decided the shape: **one screen over both agents** rather than a mode
switch, because a machine running both has its spend split across two tools that
each see half of it, and nothing else shows the whole bill. Breadth first — Now,
Cost and History from the database — with the live SSE stream (`opencode serve`
exposes one, verified) as a later pass.

Work stopped at the groundwork on purpose: the remaining ~7 hours are scheduled
for a night the owner will nominate. See [16-opencode.md](16-opencode.md).

### 2026-08-24 — Projects: the directory breakdown becomes a tree, and a click that went nowhere

Expanding a repository listed every touched directory as a full path, ranked by cost: **43 rows at depths 0 to 4** on the owner's `caprock`, with `/ui/src/components`, `/ui/src/screens` and `/ui/src/lib` sitting beside `/ui` and nothing saying the first three live inside the fourth. It answered "what is most expensive" and could not answer "what does `/ui` cost". It is now a **tree, one level at a time**, capped at **three levels** — expanding shows the **9 rows** under the root, `/ui/src/screens` is the deepest reachable, and the first level is 9 rows instead of 43. Behaviour and the reasoning for each choice in [04-ui.md](04-ui.md); the arithmetic in `ui/src/lib/pathtree.ts`.

**The tree is built in the client, and the contract did not change.** The flat list already carries cost, tokens and turns per path, so the tree is arithmetic over data on the wire. The depth cap is a display choice — encoding it in the API would make every future consumer inherit one panel's layout budget and turn a stylesheet-sized decision into a contract change (rule 8). Keeping the flat list as the single truth also makes `sum(tree) === sum(flat)` a unit test rather than a property of two independent aggregations.

**Spend deeper than the cap is charged to the deepest visible row, and the row says so** (`+1 deeper`). Dropping it would stop the parts summing to the whole, and giving it a row is what the cap forbids — so it is absorbed **visibly**, because a number that quietly swallows its children is what rule 6 exists to prevent. A parent's **own** spend is stated apart from the roll-up (`$0.39 here · $390.35 in 1 subdirectory`): the two are the same number only on a leaf. A pass-through directory **collapses into its child**, but only when it has no spend of its own — an unconditional collapse loses real money, and the totals test catches it.

**The click that "landed nowhere" was never a link.** The owner clicked a directory row and arrived at `#/session/5c987068-…`, a session in `bloq-blockmaze` — a different repository. No breakdown row has ever had an `onClick` or an `href`. Expanding a repository injected dozens of rows and grew the panel far past the **Live activity** feed beside it in the two-column grid; the next click landed on a feed row, every one of which *is* a link to a session, and `5c987068` was the feed's top entry. Both halves are fixed: the tree removes the rows that caused the overshoot, and a breakdown row is explicitly inert — no anchor anywhere in the panel, asserted by a test. A row is a figure, not a link.

**The two non-directory rows lost their italic.** `outside the repository` and `repository-wide work` rendered in a slanted face the panel has nowhere else, which separated them from the table by making them look like a different product rather than by saying what they are. They are siblings of the directory rows — real spend, part of the repository total — so they now read as table rows and are separated by **role**: a small-caps `not a directory` heading over the pair, and the path column's monospace dropped, which is the difference that is actually true.

**Tests: 19 in `pathtree.test.ts`, 5 added to `Projects.test.tsx`, all 22 existing green unchanged.** Twelve mutations were run and every one turned a test red — dropping spend past the cap ($5 vanished, totals mismatch), removing the cap (depth 7 rendered), double-counting a parent's own spend ($107 for a $100 repository), collapsing unconditionally ($7 lost), letting the buckets into the hierarchy, not lifting the root, restoring the italic, removing the `not a directory` heading, linking a row to a session, removing `+N deeper`, removing the own-spend sub-line, and rendering every descendant at once.

### 2026-08-23 — What the money went on, and a measurement that was an artifact

The Cost screen could say how much, on which model and where, but not **on what**. `work` on `/v1/stats/summary` and a third panel beside the model mix now answer it: one row per kind of work each turn did — writing code, running commands, reading and searching, web research, MCP tools, other tools, no tool call — ranked by cost, each turn charged **whole** to one row so the rows sum exactly to the total. `caprock report` carries the same rows. Rule, categories and timings in [03-contracts.md § Work attribution DDL](03-contracts.md#work-attribution-ddl-migration-0014); the panel in [04-ui.md](04-ui.md).

**The finding that started this was an artifact, and checking it was the whole job.** A prior measurement on the owner's database reported *78.4% of spend on turns with no tool at all* and *0.0% on commands* — the shape of a publishable finding. It reproduces exactly, and it is wrong. It joins tool calls to turns on `msg_id`, and `msg_id` is present on **96.1%** of tools that name a file but **0.1%** of those that do not (measured 2026-08-23): `ingest.BackfillToolMessageIDs` deliberately filters on `touch_dir IS NOT NULL`, because per-directory attribution never needed the others, and the hook plane's `PreToolUse` payload carries no message id at all. So Bash — 35025 calls, half of all tool use — was structurally invisible, and its money landed in "no tool". Recovering the linkage from the transcripts (which still hold it: every unlinked row has a `tool_use_id`, and the project-root walk resolves **53744 of 53763**, 99.96%) inverts the result: **commands 54.0%, no tool call 8.4%** (all time). The lesson is the one rule 6 encodes — a number that already looks like a headline is the one to re-derive, not the one to publish.

**The filter is now gone (OQ-10, resolved 2026-08-23).** The backfill covers every unlinked tool call, not only the ones naming a file: **53948 of 53967** recovered on the owner's database, and the 30-day breakdown moved from **86.5%** unlinked to **0.004%**, putting `command` at **59.1%** of spend where it had read **0.0%**. Widening it took the pass from ~3 s to **~30 s** over a 1 GB transcript tree, so it no longer runs before the port opens — `Daemon.backfillToolLinks` runs detached once the daemon is serving, in id batches with a resume cursor committed after each. A retry cannot corrupt anything: a `tool_use` id maps to exactly one assistant message (checked across all 1560 transcripts, 69552 ids, no duplicates), and all 53313 pathless links written were verified against transcript ground truth with zero mismatches.

**Because that failure is invisible, its size is still published.** An unlinked tool call leaves its turn looking exactly like a turn that called nothing, so `work_unlinked_calls` travels with the breakdown: the dashboard warns above 1% of the range's tool calls, and `caprock report` **withholds the breakdown entirely** above 5% and prints why — that output is written to be pasted in public, where a wrong ranking becomes someone else's headline.

**The labels are the design.** Each has to survive "is that true of every turn in this row?". A turn that called no tool is labelled **"no tool call"**, never "conversation", "thinking" or "planning": such a turn may have been reasoning, planning, answering a question or writing prose, and the capture records which tools ran, not what a turn was doing. Precedence (`store.WorkKindRule`) settles a turn that mixed kinds — writing beats running a command beats reading — ordered by strongest evidence, never by cost, which would let the ranking rewrite itself. It moves little money regardless: only 4.4% of tool-using turns mix kinds, carrying 2.2% of spend.

**Performance: no query of its own.** The rows needed are exactly the rows the carry-forward scan already reads, so the classification rides along in it. Summary end-to-end (30d, Go driver, best of fifteen, 191k events): **249 ms → 279 ms (+30 ms)**. A separate aggregate cost **292 ms** by itself — ten times as much for the same seven numbers. `tool` had to enter the covering index or the scan fell onto the table (**~578 ms** against **~80 ms**), so migration **0014** widens `idx_events_attr` into `idx_events_attr_work` and drops the original; SQLite cannot add a column to an index in place, and a stale duplicate would tax every write for nothing.

Tests: rows sum to the total across every category, a no-tool turn does not inherit the previous turn's kind, a turn that edited and read is counted once by the stated rule, kinds never cross a session boundary, an empty database yields no rows rather than a divide-by-zero, and the report withholds on poor linkage. Each was mutation-checked.

### 2026-08-23 — Six defects from a security audit: the hive trusted what a worker wrote

A security audit of v0.17.0 found six defects with one root cause: **files written by a worker Claude session were treated as trusted input.** A worker runs with `--dangerously-skip-permissions` and is the designed author of mailbox messages and task files, so none of these needs an attacker — a confused or prompt-injected worker is enough. Decisions and rationale are in [ADR-020](08-decisions.md); the behaviour is documented in [03-contracts.md](03-contracts.md) and [05-orchestration.md](05-orchestration.md).

- **Arbitrary file write outside the hive (highest).** `Send` validated its `to`; `Deliver` re-parsed the message off disk and did not, so `to: ../../../pwned` made `MkdirAll` + write land anywhere on the machine — reproduced writing three levels above the hive root. Overwriting `~/.claude/settings.json` or `~/.zshrc` with partly-controlled content is code execution as the user. `validID` now runs on both `to` and `from` at delivery, backed by a `withinRoot` containment check; a refused message moves to the sender's `rejected/` and is ledgered as `mail.rejected` rather than being dropped, retried forever, or failing the whole pass.
- **`git worktree add -B` destroyed user commits (high).** `-B` force-reset an existing branch; worker names are predictable and nothing removed branches, so a second run silently dropped a user's commits to the reflog. Now `-b`, with a refusal naming the branch and the fix, and reattachment to a worktree Caprock already owns. **Worktrees are deliberately still not auto-removed** — removing one would delete unmerged work and contradict the visible-output rule.
- **Path traversal via task ids (medium).** `CreateTask` validated; `GetTask`/`UpdateTask` did not, and `ListTasks` reads the id from *inside* a task file, making a hand-written file a write primitive on the next update. Both validate now.
- **`trustFolder` rewrote the whole of `~/.claude.json` (medium-high).** A `map[string]any` round-trip sorted the user's 204KB config alphabetically and truncated integers past 2^53 (`9007199254740993` → `…992`, both reproduced). It now uses the ordered-JSON codec the settings installer already had. Grants are recorded in `<data_dir>/trust-grants.json` so `hooks uninstall` revokes exactly what Caprock granted — never a folder the user trusted themselves, and never one that was already trusted when Caprock found it.
- **The settings.json backup never refreshed, and nothing restored (medium).** `backupOnce` returned early if any backup existed: the owner's only snapshot was dated 10 July for a file last edited 20 August. It now backs up when the content is not already captured, disambiguates a same-second collision (which would have silently overwritten a snapshot), keeps the oldest plus the most recent four, and `caprock hooks restore` lists and restores them — snapshotting the current file first, so a restore is undoable.
- **`pruneLoop` could have deleted every event (low, catastrophic).** The goroutine is gated on `RetentionDays > 0` at startup but `prune()` re-reads config live; at 0, `AddDate(0,0,0)` is now and the whole database goes. Unreachable today, one refactor from catastrophic — guarded with `if days <= 0 { return }`.

Every fix is covered by a test that demonstrates the attack or the loss, each verified to go red when the guard is removed: the traversal tests assert on files *outside* the hive root, and the worktree test asserts the user's commit is still reachable from the branch. Test isolation was itself a finding — the package's spawn tests reached the real `~/.claude.json` and data dir, so `internal/agents` now redirects both in `TestMain`.

### 2026-08-22 — `caprock report`, and the pulse tiers the light theme flattened

**A published number that cannot be re-run goes stale silently.** The launch figures were hard-coded constants read on one day, which is the one failure mode a page premised on honest numbers cannot survive. `caprock report` re-reads the same measures from the same capture — total at API list prices, the plan multiple, turns, sessions, projects, cache hit rate and what the cache cut, the date window with its active-day count, top projects and models, and the pricing-table version — in three shapes: a block for a post, `--markdown`, and `--json` shaped to regenerate the site's facts block. Re-running it against the owner's live daemon on the day of writing already reads **$9,688 over 33 active days across 26 projects**, against the $9,660.51/34-day/26-project constants recorded a day earlier — the drift the command exists to make visible.

**It reads the daemon, not the database.** The CLI has never opened SQLite (`internal/store`: "Nothing else in Caprock issues SQL"), the daemon holds the pricing table and the plan settings the figures are computed against, and going through the API means the report cannot contend for a write lock on a database a live daemon is using. It issues only GETs, pinned by a test. Active days come from `/v1/history`'s own indexed `daily_stats` count rather than being re-derived from daily rows: that count has been got wrong once already (32 real days reported as 21), and a second implementation in the CLI would be a second chance to get it wrong.

**The caveat is output, not documentation.** The wording is lifted from `CostBasis`/`PlanValue` rather than newly written, so the CLI, the dashboard and the site say the same thing — three different phrasings of the same disclaimer is how a caveat stops being believed. It is the second line rather than a footnote, so quoting the headline visibly cuts something off. The multiple is **refused** when no plan fee is stated, and prorated to the measured window when one is (the same arithmetic `PlanValue` uses), with the fee printed beside it so the division can be checked. An empty database gets one honest sentence; figures that cannot be measured are omitted from `--json` rather than sent as `0`, because a consumer cannot otherwise tell a real zero from a missing value.

**The raw token counts came back after the site lost them.** The /numbers page had carried the cache-read against fresh-input contrast, and dropped it when it switched to `caprock report` as its only source — correctly refusing to publish a figure the command does not print. The report now prints them: one line in the human output, own fields in `--json`, own rows in `--markdown`. They are counts only; no ratio is derived from them, because the hit-rate and cost-cut percentages already state what the cache did. The prorated fee also gained cents in the same pass — it is the denominator of the printed multiple, and `$233` rounded from `$233.33` made the reader's own division disagree with the printed 41.5 in the first decimal.

**The pulse's cost tiers were the same colour in the light theme.** The bar colours were hardcoded rgba lifted from the dark palette, so composited against a white panel `around it` and `well above it` came out at a contrast ratio of **1.05** — indistinguishable — while the legend went on naming them as different things. Every bar was also nearly invisible on white (1.46–1.68 against the panel) and the idle hairline sat at 1.13. The tiers now resolve through the design tokens the rest of the dashboard already uses (the pattern `Projects.tsx`'s `SparkCanvas` had already adopted, in a comment that named Pulse as the holdout), each with its own alpha. Each theme supplies its own hue: dark climbs in brightness, light climbs in depth, because light's `--color-accent-strong` is *darker* than `--color-accent`, so "high = brightest" could not be ported naively.

**Verified by measurement, not by eye.** Sampling the real rendered canvas in a browser in both themes: the same bars read `rgb(255,203,133)` in dark and `rgb(143,88,8)` in light, worst adjacent-tier separation now **1.93 in light** (from 1.05) and 1.59 in dark, every tier above 1.9 against its panel, and idle visible (1.40) yet still the quietest thing on the track. Two related defects fell out of the same work: a theme switch left the canvas painted in the old theme's colours until its next event (it now repaints on the theme attribute), and the legend swatches were a second hardcoded copy that had already drifted — the idle chip drawn at alpha 0.35 against the canvas's 0.16.

**Tests.** Proven by mutation. Removing both fee guards makes the multiple `NaN×` and fails `TestReportRefusesAMultipleWithoutAPlanFee` (either guard alone still covers a zero fee, so neither is individually load-bearing — the redundancy is deliberate); deleting the caveat line fails all three plan shapes with "human output carries no caveat"; removing the empty-database early return panics on a nil window; forcing `months := 1.0` fails the prorating test with "got $200.00 over a 60-day span, want $400.00"; counting daily rows instead of the daemon's total reports 2 active days instead of 20. The later additions are pinned the same way: deleting the raw-token line fails "the raw cache/fresh token counts are missing from the human output"; adding a derived `×  more cached than fresh` line fails the no-ratio test on the phrasing *and* on there being more than one `×` in the output; dropping the four token assignments fails `--json`; and printing the fee without cents fails a test that parses the report's own printed figures, divides them the way a reader would, and checks the result against the printed multiple. On the UI side, collapsing the three tiers onto one token fails four cases including "tiers share a token", and keeping the tokens but restoring the old alphas fails **only** in light — "below median" and "around it" at 1.21 against a 1.25 floor — which is the original bug reproduced as a test failure.

### 2026-08-22 — First-contact defects: the panic on `caprock up`, and three numbers that lied

A first-contact audit walked the first five minutes of a stranger's install. Eight defects, all fixed; the four that mattered are below. The security findings from the same audit are the entry after this one.

**`caprock up` panicked with a stack trace (the worst possible first impression).** `hooksObject(root, true)` returns `nil` when the existing `hooks` key is not a JSON object, and that `nil` went straight into `hasOurEntry`, which calls `.Get` on it — a full SIGSEGV on the very first command a new user runs. Every trigger is realistic: `{"hooks": null}`, `{"hooks": []}` or `{"hooks": "…"}`, written by a user who tried hooks and cleared them, or by another tool. `Inspect` already nil-checked correctly, so only the write path was exposed. `Install` now returns an error naming the file and the key's actual JSON kind, in the style of the existing malformed-JSON message, and never overwrites the user's value.

**Unpriced models rendered as a confident `$0.00` (rule 6).** The event layer is right — the rollup leaves `CostUSD` nil and logs "model not in pricing table; cost left unknown" — but every aggregate flattened it with `COALESCE(SUM(cost_usd),0)`, so 61k tokens of an unpriced model displayed as `$0.00`, indistinguishable from free. This bites the day a model ships newer than the pricing table, and on any gateway whose model ids do not normalise. `/v1/stats/summary` and `/v1/history` now carry `unpriced` — `{turns, tokens, models[]}`, omitted when everything was priced — and the Now, Cost and History screens report the volume beside the total. The models are **named**: an unknown model id is something a user can act on; "some tokens are unpriced" is not.

**A fatal ingest failure was invisible.** The tailer runs in a goroutine whose error was logged and swallowed. With a read-only `~/.claude` the daemon reported healthy, `caprock status` said `ingest: 0 transcripts … backfill done`, and the dashboard showed "No sessions yet — start `claude` in any terminal" forever. The user follows that instruction and nothing ever appears. The terminal error is now stored, carried on `/v1/status` as `ingest_error`, and reported by `caprock status`, the Now screen (a warning bar beside the hooks one) and Status.

**A new user's first screen was a wall of `$0.00` under a warning tile.** Before any session exists the summary endpoints return Go zero values, so Today rendered a `$0.00` hero, `Sessions 0`, `Turns 0` — and `Cache hit 0%` toned `warn`, because the fault threshold (`< 0.9`) is true of a zero. The only coloured element on a new user's first screen was a warning about a cache that had never been used. Now, Cost and History all distinguish "nothing measured yet" (em dash, no tone) from a measured zero, which still shows `$0.00`.

**Four smaller ones.** The `claude`-not-found explanation existed in `SpawnDialog` and was unreachable, because the only thing that opened the dialog was a button hidden when `claude` was absent — the control is now always shown and the dialog does the explaining, with a `claude:` line added to `caprock status` and the Status screen. `Error: 501 Not Implemented` replaced a server payload that said what to do about it; a shared `errText` helper now surfaces `error` **and** `detail` at every call site (Tasks had three, SpawnDialog dropped `detail`). `caprock statusline install` printed nothing and exited 0 when another statusLine was set, because its explanatory line sat behind `if !yes` and the subcommand passes `yes=true`. And the first-run backup could contain Caprock's own hooks: with no `settings.json`, `Install` created one and the statusline install then "backed up" the file we had just written — a `.caprock-backup-*` that was our own output misnamed as the user's restore point.

**Tests.** Each of the four main defects is pinned by a test proven by mutation: reverting the nil guard reproduces the original SIGSEGV inside `TestInstallRefusesNonObjectHooksKey`; dropping the `unpriced` wiring fails `TestSummarizeAndHistoryCarryUnpricedVolume`; dropping the stored error fails `TestStatusReportsATerminalIngestError`; and restoring the `summary.data ?` truthiness check fails two cases in the new `Now.test.tsx` with `expected 'Cache hit0%0% input cost cut' to contain '—'`.

### 2026-08-22 — Pre-launch security: cross-site RCE closed, the database made owner-only

A launch-readiness audit found the loopback API reachable from any web page the user happened to visit, and the SQLite database world-readable. Both are fixed; a third finding is reported, not fixed.

**Cross-site request forgery → remote code execution (the blocker).** The `/v1` guard was `if o := r.Header.Get("Origin"); o != "" && !isLoopbackOrigin(o)`. The `o != ""` clause meant a request with **no** `Origin` skipped the check — and browsers omit `Origin` precisely on cross-site *simple* requests (an HTML form POST, `fetch` with `text/plain`). So any page could reach `POST /v1/agents`, which takes `command` from the body and executes it, plus `/input`, `/signal`, `/orchestrator/start`, `/hive`, `PUT /v1/settings` and `POST /v1/tasks` — all unauthenticated. The comment above it ("Browser same-origin protects the API") was the mistaken premise: same-origin stops a page *reading* a response, not *sending* a request. Replaced with a layered `checkOrigin` (`internal/api/csrf.go`): `Sec-Fetch-Site` first (unforgeable by script, and now refused cross-site on reads too), then a loopback `Origin`, then a loopback `Host` for browser-shaped requests (DNS rebinding), then a bearer token *or* `Content-Type: application/json` for anything with no browser provenance. A missing `Origin` is never trusted on a state-changing method. Contract in [03-contracts.md § Cross-site request protection](03-contracts.md).

Two further holes surfaced while testing the fix. `isLoopbackOrigin` prefix-matched, so `http://localhost.evil.example` — a hostname anyone can register — passed as loopback; it now parses the URL and compares the host. And the WebSocket routes were already correct (`OriginPatterns` rejects a missing `Origin`), which is what the REST surface was measured against.

Every in-repo client was checked against its **real** request shape rather than an idealised one, and each has a test: the hook shim and `caprock statusline` (JSON + bearer), `caprock down` (bearer, **no body and so no Content-Type** — the reason a bearer token alone is sufficient), `caprock task create` (JSON), `caprock tasks`/`status`/`healthz` (plain reads), the dashboard's one mutation helper in `ui/src/lib/api.ts` (already JSON), and bare `curl`. `make smoke` is unaffected — it only reads.

**The database was 0644.** `caprock.db` holds prompts and responses in cleartext (that is what makes the Answers screen searchable) yet was left at the process umask, while `config.json` beside it had always been 0600. `store.secureDBFiles` now sets 0600 on the database and its `-wal`/`-shm` siblings on **every** `Open` — not only at creation, because existing databases keep 0644 until something changes them and SQLite recreates the siblings under the umask. A `chmod` the filesystem refuses is a logged warning, not a failed start. Windows is a deliberate no-op (no POSIX modes; `os.Chmod` there only toggles read-only) and the tests skip there with that reason, keeping rule 2 green.

**Secrets in the database — reported, not fixed.** Verified on a `.backup` snapshot, never the live file. The audit's headline (524 matching events, 9 in typed prompts) does not reproduce: it came from `payload LIKE '%ghp_%'`, where SQL `LIKE` treats `_` as a single-character wildcard, so `ghp_` matched every "graph" and inflated 11 to 478. Counted literally with `instr()`: **53 distinct events** match any of the four patterns, of which most are the audit conversation quoting its own pattern list back into the database. The real finding is smaller and sharper — **11 events hold 2 distinct full-length `sk-ant-api03-` keys, all captured from *tool output* (10 `tool.post`, 1 `tool.pre`), none typed by the user**. Redaction is a design decision for the owner, not a pre-launch patch, so nothing was built; the honest disclosure was missing and is now in [SECURITY.md](../SECURITY.md), which previously said nothing about cleartext storage or file modes.

Also confirmed and left in place for the owner to decide on: the audit's own demonstration wrote a real row into the live database — session `42d16cbf-92c1-4128-a2ee-a131c16d1977`, `owned=1`, zero events, `spawn_command` = `/bin/echo --session-id … pwned`. It is the only row in the database with `owned=1` or a non-null `spawn_command`, and it is direct evidence that the forgery path reached the spawn handler.

Tests are mutation-verified — each was shown red against the code it covers, including restoring the original `o != ""` guard (13 assertions fail, spawn answers 501 instead of 403) and removing the `chmod` (a fresh database comes out 0644, exactly the mode found on the live machine).


### 2026-08-22 — Orchestration explains itself and shows its output

The owner's verdict on a feature he built months ago: *"I still don't understand what it is or what it's for."* A five-person panel traced that to one fact rather than to thin docs — **the feature had no visible output.** Workers did the work on `caprock/worker-N` inside `.caprock-worktrees/`, and the product never showed the diff, never named the branch, and never helped land it. A panelist put it exactly: *"A session diff exists but the task card never links to it."* `GET /v1/sessions/{id}/diff` had shipped in v0.1.0; `Tasks.tsx` had zero references to it.

**Show the work.** A task with an assignee is now clickable and opens to four answers, in the order they are asked: what changed (the diff, via the newest session attributed to the task), what proved it (the latest verification round's commands and exit codes), where the work is (branch, worktree, repo, stated plainly), and how to take it (`git merge --no-ff caprock/<worker>`, copyable). The card itself carries the branch, so the board answers "where did that go?" without opening anything. The merge command is text, not a button: it writes to the user's repository, and running git on someone's branch from a web page is not a thing a local-first tool should do. `GET /v1/tasks/{id}` grew a derived `work` block (branch, worktree, repo, sessions, verifications) plus `done_criteria` read back off the hive file, assembled in the daemon's `boardAdapter` — the only layer that knows the repo — so `internal/board` was untouched.

**Explain itself.** `grep -- "--hive" README.md docs/` returned zero hits before this: the feature was undiscoverable from the front door. Added a README section under How it works — the real command, the tree it creates, a complete example task file, `done_criteria` explained as shell commands Caprock runs (and that they leave build artifacts behind, because they run in a real checkout), and the three things to know before turning it on. A fresh hive is now seeded with a `README.md` and an example task, so the directory documents itself instead of being three empty folders. The off-state was rewritten to carry the three facts that decide whether anyone runs this — separate worktree, Caprock runs the checks, the directory is new — instead of naming a flag and the word "hive".

**Report and control it.** The hive appears in `caprock status`, `/v1/status` (`hive`, `repo`), the startup line and the daemon log; it was reported in none of them, so there was no way to ask a running daemon what it was orchestrating. `caprock task create` is new (title, budget, repeatable done-criteria, body) — the queue could previously only be filled from a form. `caprock tasks` now rejects unknown arguments (`caprock tasks create` used to ignore its argument and print the board, a fake success) and measures the id column instead of a hard-coded `%-14s` that misaligned every row against 17-character ids. "Phase 2" is gone from every user-facing string, CLI and API alike.

**The framing.** Adopted the panel's recommendation: the honest description is **an unattended task runner with a test gate**, not "a multi-agent hive" — the closest thing a user knows is a git worktree plus a shell loop, and what this adds is that a worker cannot stop early, failures bounce back with output attached, spend is attributed per task against a budget, and there is a board. Also documented, rather than left to be discovered: it only suits **independent** tasks, because nothing merges branches or notices two workers editing the same file. Per the owner's instruction it stays an advanced opt-in and is **not** promoted to a headline; the headline remains cost observability. See [05-orchestration.md § How we describe it to users](05-orchestration.md).

Thirteen new tests, each proved by a mutation that restores the original behaviour and turns it red: six on the CLI (argument rejection, column alignment, create round-trip, the criteria guard, both status branches, no "Phase 2" in any help text), five on the enriched task detail (branch/worktree, `done_criteria`, verifications, session link, and no invented branch before assignment), two on hive seeding (a parsable example; never overwriting an existing hive), and six in the UI's first `Tasks.test.tsx` — seven mutations there, since the drawer test is pinned independently by the diff panel and the merge command.

### 2026-08-22 — Eight orchestration safety defects: the verification claim made true, every loop bounded, a stop button

A five-person user panel audited Phase 2 and found eight confirmed defects, all in the machinery that is supposed to make unattended agents safe. Every one is fixed, and every fix is proved by a test that goes red when the old code is put back.

- **Empty `done_criteria` was an unconditional pass.** `verify.go` had `if len(t.DoneCriteria) == 0 { res.Passed = true }` with the comment "trust the worker", nothing validated criteria at creation, and the UI sent `[]` for an empty textarea — while the same screen promised "Nothing reaches Done until its `done_criteria` pass". The headline claim was false for the easiest task to create. Now: `POST /v1/tasks` requires at least one non-blank command, the UI refuses to submit without one, and a criteria-less task that reaches verification escalates to `needs_you` instead of passing.
- **The orchestrator had no forced-continue guard.** The counter is keyed per (session, task), `TaskForAgent` always returns `""` for the orchestrator, so `n` stayed 1 and `n > MaxForcedContinues` was never true — and its inbox was never drained (`drainConsumedAssignments` iterated workers only). One stuck escalation pinned an unattended `--dangerously-skip-permissions` session in an unbounded loop. Now: a session with no task counts under the reserved key `/no-task` under the same limit, and the orchestrator's inbox drains by the same rule as a worker's.
- **The wake loop had no ceiling.** `WakeThrottle` bounded the rate, not the total: a message an agent never cleared cost one typed kick — one Claude turn — every 20 seconds, forever. Now `MaxConsecutiveWakes` (10) bounds it; past the ceiling the router stops waking, marks the agent stalled, parks its task and escalates. Clearing the inbox resets the budget.
- **Budget parked a file but never stopped the process.** `OverBudget` rewrote markdown; there was no `Signal()` anywhere in the path, so the session kept its turn and kept spending. And `budget_usd <= 0` meant unlimited while tasks defaulted to 0 — the safe default was the unsafe one. Now the router kills the worker session first and parks the task second, and a task created without a budget gets `board.DefaultBudgetUSD` ($5).
- **The `CanTransition` silent-no-op, again.** The Stop-guard escalation was wrapped in `if hive.CanTransition(...)`, so an illegal hop (`assigned → needs_you`) was dropped in silence: the task stayed live and the router kept the worker alive and kept waking it. Replaced with `board.moveTo`, the route-walking fix this codebase already made once in `verify.go`.
- **Verification could run in the wrong directory and still pass.** A `cwd` that did not stat as a directory left `cmd.Dir` empty, so the checks ran wherever the daemon sat. Auditing this turned up a **second, subtler half the panel did not name**: `VerifyTask` fell back to `RepoCwd` when an assigned worker's worktree was missing, and because `RepoCwd` exists nothing downstream could tell — the criteria ran against a clean main repo and the task passed for work nobody inspected. Both are closed: a bad cwd escalates rather than passing, `runCommand` refuses to run instead of falling back, and an assigned task is verified in its worker's worktree or not at all (an unassigned task still uses the repo).
- **Verification output was discarded.** `RecordVerification` was called with `""` for `output_path` while the docs promised the path was recorded, so a green result carried no evidence. Output is now persisted to `<hive>/verifications/<task>/round-<n>-cmd-<i>.log` and the path stored.
- **There was no stop-everything.** `POST /v1/orchestrator/stop` kills the orchestrator and every worker in one call and latches the router so it does not respawn them next tick (without the latch the stop lasted two seconds); `start` clears the latch. Task files are untouched. The per-agent `signal` 400 now names the `action` field, not only its values.

Sixteen mutations were run to prove the tests, each restoring the original defect: the two most telling are the wake ceiling (**50 wakes in 50 ticks** without it, 3 with) and the orchestrator guard (**50 of 50 Stop hooks still blocked** without it). One fix immediately caught something else: the Phase 2 e2e smoke test — the scenario that exists to prove the flow works — never created the worker's worktree and edited the main repo directly, so it had been exercising the wrong-directory defect rather than the real path. It now stands up the worktree the router creates and the worker fixes the build there. Docs updated in the same commit per rules 8 and 9: [03-contracts.md](03-contracts.md) (the new endpoint, `done_criteria` required, the budget default, the reserved counter key, the real `output_path`) and [05-orchestration.md](05-orchestration.md) (unverifiable-is-never-verified, the wake ceiling, budget kills the process, stop everything). Deliberately **not** changed, as owner calls rather than bugs: `--dangerously-skip-permissions`, the env inheritance in `childEnv`, and the `trustFolder` global write.

### 2026-08-22 — Projects: carry-forward attribution (the strict rule replaced)

The per-directory rule shipped earlier the same day was **rejected by the owner on his real data**, and correctly so. Strict attribution charged a directory only when *every* file a turn touched was in it, which produced the monorepo $1735.42 with `/app` at 9.4% and **87.6% ($1520.52) "repository-wide work"**. He asked what a service costs and seven eighths of the answer was "we could not tell". Technically defensible, practically worthless.

**What it missed:** work happens in **stretches**, not in isolated tool calls. You say "finish /app", and Claude edits a file, runs the tests, reads the output, greps, edits again — for an hour. That whole stretch is work on `/app`. The strict rule counted only the minutes containing a direct file edit and discarded the rest, which is why Bash-heavy turns (half of all tool calls) fell out.

- **The rule now: carry-forward.** A turn belongs to the directory of the **most recent file touch at or before it, within the same session**, carrying forward until a touch elsewhere moves it. No cost is split, pro-rated, or modelled — each turn's price goes **whole** to one row and the rows still sum exactly to the repository total (verified on real data: reconciliation diff **0.000000**). What changed is the rule for deciding *which* row, and it is stated to the user on hover. It is **not** measured file-by-file attribution and is never described as such (rule 6).
- **Outside the repository is its own row**, not folded into the root and not dropped. It is **25.8%** of the monorepo and **28.7%** of `caprock` — not other people's work but work on *this* project whose files live elsewhere: `~/.claude/projects/<project>/memory` ($378), agent scratchpads under `/private/tmp/claude-501/…` ($251), `/private/tmp/a monorepo-e2e-results` ($126). It deliberately does **not** try to separate "another checkout" from "scratch space": the only test available is whether the path sits under some other repository root the database happens to know, and that is unstable — `caprock-web` is a real repository on disk that no session was ever launched from, so the same path would classify one way today and another tomorrow.
- **Turns before any touch stay in the repository-wide row** rather than carrying *backward* from the session's first touch. Measured both ways: backward moves **$2.39 of $3426** in the monorepo and **$11.45 of $1729** in `caprock` (0.1% / 0.7%) — far too little to justify a second rule pointing the opposite way. That row now means one narrow thing (a session's opening turns) and is **omitted when it cost $0**.
- **The carry never crosses a session**, or one piece of work would be charged to another's directory.
- **Performance: one ordered scan, and it got faster.** Carry-forward is sequential, so tool calls and turns are read together in event order with the carry threaded in Go — replacing the two queries the strict rule used. A window function was rejected: deciding whether the carried directory is inside the repository needs the same path normalization the ingest path uses, and re-doing that in SQL would be a second, silently diverging definition. Ordering by `(session_id, ts, id)` over the old index sorts 90271 rows in a temp B-tree (**~290 ms**); migration **0013**'s `idx_events_attr` puts the order in the index and covers every column read → **~93 ms**, no sort. Nothing in the daemon runs `ANALYZE`, so the query pins the index with `INDEXED BY`. End-to-end summary (30d, Go driver): **~250 ms before → ~243 ms after**.
- **On the owner's real data** (all time, 2026-08-22): the monorepo $3426.15 = `/app` **$2090.67 (61.0%)**, `/.ai` $233.96, `/app/tests` $94.95, `/deploy` $42.53, `/db` $35.76, outside the repository $883.96, repository-wide $2.39. `caprock` $1729.30 = `/internal/smoke` $247.86, `/ui/src/components` $231.38, `/.ai` $201.90, `/` $110.16, 30 more directory rows, outside $496.80, repository-wide $11.45.
- **Tests.** Every attribution test was re-proved by mutation. The ones whose expectations the rule genuinely changed were rewritten and say so in their doc comments: `TestMultiDirectoryTurnIsNotSplit` → `TestTurnGoesWholeToTheLastDirectoryTouched` (the no-split promise is unchanged; only the destination moved), `TestTouchOutsideRepositoryIsNotCharged` → `TestCarriedDirectoryOutsideRepositoryGetsItsOwnRow`, `TestTurnWithNoTouchesIsUnattributed` → `TestCarryForwardCoversTurnsWithNoTouches`, and `TestUnlinkableToolCallDoesNotAttribute` → `TestHookPlaneTouchWithNoMessageIDStillAttributes` (carry-forward does not need `msg_id`, so a hook-plane session no longer collapses into the bucket).
- **A latent ordering fact surfaced:** a turn and its own tool calls often share a millisecond, and the turn row is written first. So a turn is placed by the touches of *earlier* turns — the file Claude was working on when it produced that turn — which is what the rule intends. Only **4 of 15516** touches sort before a same-millisecond turn on the owner's database.

### 2026-08-22 — Projects: cost per directory, charged by the files Claude touched

The Projects breakdown keyed its per-directory rows on the **session's cwd**, which answers "where was the terminal", not "which service costs what". In a monorepo nobody launches Claude from `/services/api` to work on it — they open the root and let it edit across services — so on the owner's real database **only one repository expanded at all**. The breakdown is now charged by **which files each turn touched**.

- **The linkage is the assistant `message_id`, and it is exact.** A `tool_use` block and the usage billed for it are content blocks of the *same* message, so they share its id by construction. It had to be written at ingest: one API response is written as several assistant lines (thinking / text / tool_use) that each repeat the same usage, the store keeps only the first (key `msg:<id>`), and the tool_use blocks arrive on a later line whose turn row was deduped away — so the tool rows land *after* the next distinct turn. Measured against transcript ground truth, ordering by id recovers the true message id for only **1981 of 5115** tool calls (38.7%): a systematic one-turn shift, which is why the read-time fallback was rejected rather than merely disliked. **Assumption:** that the transcript keeps tool_use blocks in the message that requested them. It degrades safely — a tool call with no `msg_id` (the hook plane never carries one) is reported unattributed, never guessed.
- **Strict attribution, chosen over completeness** — **superseded the same day; see the carry-forward entry above.** A turn's cost reached a directory only when *every* file it touched was in that one directory. The no-split half of this decision survives; the refusal to place a turn at all did not.
- **The touch rule:** a tool that names a **file** touches its directory (`Read`, `Edit`, `Write`). `Bash` does not, even with a path in the command — `grep -r foo /services` reads a tree, `cd /services/api && go build ./...` names one directory and touches many. Bash is **32581 of 65915** tool calls on the owner's database, so this is why the repository-wide row is large; the panel states it rather than redistributing it.
- **That row is named for the work, not for the bookkeeping.** It first shipped as *"unattributed"*, which describes caprock's failure to place the spend rather than what the user actually did — and since it is normally the biggest number on screen, it invited the conclusion that the panel is broken. It is not: the tool calls behind it are overwhelmingly Bash (**17382 of 27158** calls in the monorepo, **5246 of 6743** in `caprock`, measured 2026-08-22) — test runs, `git log`, tree-wide greps, builds. It now reads **"repository-wide work"**, with the reason on hover.
- **Directory depth: the full path, not the first segment.** `/services/api` and `/services/web` are the two rows a monorepo owner opens this to compare; collapsing to `/services` would hide exactly the distinction the feature exists for.
- **Columns, not JSON on read.** `/v1/stats/summary` is polled. Measured through the Go driver (not the sqlite3 shell — they differ by orders of magnitude): the summary was **~152 ms** warm; `json_extract` over the 48212 `tool.pre` rows in a 30d range costs **~215 ms** alone, versus **~9 ms** for the indexed column. The summary is now **~250 ms**, the added cost being the per-turn scan attribution needs (~89 ms). Migration 0012 adds `msg_id` and `touch_dir` with their indexes.
- **Backfill.** `touch_dir` is derived in Go (SQLite has no `reverse`, and the dirname must use the same normalization as the ingest path). `msg_id` on historical tool calls was **not in the database at all**, so it is read back from the transcripts still on disk — **53948 of 53967** unlinked tool calls recovered on the owner's database (99.96%), pathless ones included since OQ-10. It runs detached after the daemon is serving, in batches with a resume cursor. Rows whose transcript is gone stay unattributed.
- **On the owner's real data** (30d, re-measured 2026-08-22), every repository now expands. `caprock` shows `/.ai` $31.10, `/ui/src/screens/orchestration` $13.51, `/internal/store` $6.46 and 36 more rows; the monorepo shows `/app` $233.10 (12.2%) with **85.2% ($1628.06) repository-wide** — honest, because only 7816 of its 26384 turns touch a file at all, and 99.5% of those that do touch exactly one directory.
- Each row states tokens, its **share of the repository total including the repository-wide row** (so the column sums to 100%), and cost. Percentages floor; a real-but-tiny share shows `<0.1%` rather than a zero beside a non-zero dollar figure.

### 2026-08-22 — Projects: the measure toggle removed, both figures shown

The `$ / tokens` toggle shipped hours earlier is **gone**. Owner review killed it on the ground that it solved the wrong half of the problem: the complaint was never "I cannot see tokens", it was "the second number is a whisper", and a toggle answers that by making the reader re-decide which half to see on every visit. The row has room for two numbers, so it shows two.

**Tokens lead, cost follows, both legible.** Tokens at 17px accent; cost directly beneath at 13px `text-fg-muted` — the size Pulse gives a per-session cost and the tone the product uses for text meant to be read. The old sub-line was 11px `text-fg-faint`, which is the chrome tone used for session counts and timestamps; that is precisely what made it unreadable. Tokens lead because on a flat plan dollars are a proxy for consumption rather than a bill, and because the panel header already carries the dollar total — a dollar-led row would state the same thing twice while consumption appeared nowhere large. The header now states both in the same relationship, and an expanded directory row states both on one line rather than stacked, so the breakdown does not grow taller than the thing it breaks down.

**Sparkline basis: tokens**, named once as `SPARK_BASIS` rather than spelled at four call sites. It matches the figure that leads the row; a picture scaled on cost under a tokens headline would be a second, silently different ranking. The choice is close to free — for one project the two curves have near-identical shape, since its model mix barely moves within a range — but the shared ceiling and the share bar compare *across* projects, which is exactly where the two orderings diverge, so matching the headline is the deliberate call. The contract is unchanged: `spark.cost` and `spark.tokens` both still ship, because re-basing the picture must never cost a round-trip on a polled endpoint.

**A latent bug the removal exposed.** The directory breakdown scaled its bars on `paths[0]`, assuming the first row is the largest. The daemon sorts `paths` by **cost**, so under a tokens basis the first row is not the one with the most tokens and another row could render past 100% — reproduced at 900% under mutation. The maximum is now computed.

**Dead code removed:** `MEASURES`, the `MEASURE_KEY` localStorage key and its `initialMeasure` reader, the persistence `useEffect`, the `measure` state, and the `measure` prop threaded through `ProjectRow`, `PathRow` and `SparkCanvas`. `Measure`/`seriesOf` stay in `lib/spark.ts` — both series still ship and the module stays parametric so the basis is a one-word change.

Tests: the seven `ProjectsPanel measure toggle` cases described behaviour that no longer exists and were deleted; eight `ProjectsPanel figures` cases replace them, each verified **red** under a deliberate mutation — restoring the 11px faint sub-line (two cases red), paying a fixed cost instead of the row's, dropping the cost half of the header total, flipping `SPARK_BASIS` to cost, scaling the share bar on cost, dropping the cost half of a directory row (two cases red), scaling directory bars on `paths[0]` again, and re-adding a pair of toggle buttons.

### 2026-08-22 — Projects: a measure toggle, a sparkline, and a truncation bug the test found

The Projects panel made cost the headline and tokens an 11px afterthought. On a **flat plan the dollar figure is not money owed** — it is a proxy for consumption — so a `$ / tokens` toggle now swaps which is large, and drives the sparkline and the share bar with it. A bar still scaled on cost under a tokens headline would contradict the figure beside it, and the two orderings genuinely differ: a cheap model burns tokens cheaply.

The share-of-the-largest bar was **replaced** rather than joined. It restated the ranking the sorted numbers already gave — the widest bar sits on the top row by construction — so it spent the row's only free horizontal space on information the reader already had. When the spend happened is in no number on the row: $40 in one afternoon and $40 across three weeks are the same row until you draw them.

**Rejected: `daily_stats` as the source.** It is keyed `(day, project, model)` where `project` is the **label**, and labels collide — on the owner's database one label (`repo`) maps to two distinct roots. Serving the sparkline from it would reintroduce the exact bug the repository-grouping rewrite fixed, one level down, and it cannot answer `today` at all (no sub-day resolution). The series instead comes from the scan the summary already makes, with one extra `GROUP BY` column keyed on `repo_root`.

**Cost, measured through the Go driver on the owner's 191k-event database, best of six:** `30d` 142.4ms → 154.0ms (+11.6ms), `today` 25.9 → 26.6 (+0.8), `7d` 46.1 → 48.6 (+2.5), `all` 197.6 → 215.7 (+18.1). Well inside the ~30ms budget, so no rollup table was needed. The 10-minute burn window calls plain `Summarize`, which builds no series and pays nothing.

**The bug the test found.** SQLite's integer division truncates **toward zero**, so `(ts - from) / width` for an event *before* the grid yields `-0` — bucket 0 — and its spend was painted onto the first column. Reachable whenever the bucket grid starts after the range does. `TestSummarizeSparkSumsToRowTotal` was written with a grid offset one hour into the range specifically to separate "the row total" from "the sum of the columns", and failed on the real code before any mutation was applied. Fixed with a `CASE WHEN ts < from THEN -1` guard; out-of-grid spend still counts toward the row, because dropping it would understate the bill (rule 6).

Tests, each verified **red** under a deliberate mutation before being accepted: `TestSparkSpecBucketBoundaries` (clamping an out-of-range bucket into the last), `TestSummarizeSparkKeepsEmptyBuckets` (allocating a zero-length series), `TestSummarizeSparkSumsToRowTotal` (dropping out-of-grid spend from the row; and reverting the truncation guard), `TestSummarizeSparkPathsStillSumToRepo` (dropping tokens from the path roll-up), `TestSummarizeWithoutSparkCarriesNoSeries` (making the burn path build series). UI: seven `ProjectsPanel measure toggle` cases and twelve in `ui/src/lib/spark.test.ts`, mutated by pinning the headline to cost, scaling the bar on cost, plotting only cost, dropping persistence, freezing the panel total in dollars, removing the empty-bucket flag, removing the gamma, and scaling each row to itself. Two tests were **strengthened after surviving their mutation** — `peak` had its maximum moved to the last row, and the row-total test given an offset grid.

`ui/src/test-setup.ts` now stubs `ResizeObserver`, which jsdom does not implement; without it any canvas component throws inside React's commit phase. Contract and UI docs updated in the same commit ([03-contracts.md](03-contracts.md), [04-ui.md](04-ui.md)). No DDL change and no migration: the series is computed from `events`, not stored.

### 2026-08-22 — `caprock service`: the daemon survives a reboot

Until now the daemon died on reboot and the user had to run `caprock up` by hand. There was no autostart of any kind — a monitoring tool you must restart manually is one you stop trusting inside a week. `caprock service install|uninstall|status` registers the daemon with the OS's own login supervisor. New package `internal/service` + `cmd/caprock/service.go`; contract in [03-contracts.md § Autostart service files](03-contracts.md#autostart-service-files), user-facing section in [README.md](../README.md).

- **One mechanism per OS, all user-level:** a launchd agent (`~/Library/LaunchAgents/dev.caprock.daemon.plist`, `launchctl bootstrap gui/<uid>`), a systemd **user** unit (`~/.config/systemd/user/caprock.service`, `systemctl --user enable --now`), and a Startup-folder `.cmd` on Windows. No root, no installer, nothing written outside the user's own home — and never in `~/.claude/`.
- **Why the Startup folder over `schtasks`.** A Scheduled Task cannot be generated into a temp dir for a test; verifying it means creating a real logon task in the runner's Task Scheduler store, and a test that mutates machine state is exactly how rule 2 gets broken. The Startup script is a plain user-owned file, so its generation is unit-tested on all three OSes like the plist and the unit. The cost — no per-user crash supervisor without admin rights, so Windows restarts at logon but not mid-session — is stated in the README rather than papered over.
- **The shape of the package is what makes it testable.** `Plan` → pure `Render()`/`Path()`/`Installed()`/`Write()`/`Remove()`; only `Load`/`Unload`/`Registered` shell out. So one machine's tests assert all three platforms' file contents, and the Windows CI job runs the same suite with no skips and no platform tool.
- **Details that fail silently if wrong, each pinned by a test:** `--foreground` on every platform (all three supervisors track the process they start, so the normal detach reads as an instant exit → restart forever); `KeepAlive.SuccessfulExit=false` / `Restart=on-failure` so a deliberate `caprock down` is not fought; XML escaping in the plist (a `&` in a path makes launchd refuse to parse it); systemd `%`-escaping and quoting; `StartLimit*` in `[Unit]` not `[Service]` (v229+ ignores them under `[Service]` with only a log warning); `start "" /b` and CRLF in the .cmd; `os.Executable()` rather than a bare `caprock` (a login agent has no shell `PATH`); `CAPROCK_DATA_DIR` carried through, or a custom data dir yields a second empty database at each boot. `--no-hooks` is deliberate: hook and statusline registration stays an interactive consent decision, never something a login agent does.
- **Idempotent by construction.** Install rewrites and re-registers, so twice = one file, identical bytes; a file differing from what the current binary would write reads "installed, stale" and install refreshes it. Uninstall with nothing installed is a clean no-op with the path it looked in. `status` reports file state and supervisor registration separately, because they can legitimately disagree.

Every test was verified real by mutation — 16 deliberate breakages of the production code, each confirmed to turn the suite red and then reverted. Two of them exposed weak tests, both since strengthened: an `IsAbs` assertion that a bare `"caprock"` also satisfied (now pinned to `os.Executable()` itself), and the `StartLimit*` section, which nothing checked until it was pinned to `[Unit]`.

### 2026-08-21 — three orchestration defects: $0 tasks, stranded tasks, a decorative budget

The three follow the same shape as the earlier "green test, dead feature" finds: each was covered by a test that asserted the wrong thing.

- **Per-task cost was $0 for every task — again.** The 2026-08-19 fix wired `OpenAssignment` into the router keyed on the worker's **session** id (correct: `AttributeTaskCost` joins `events.session_id`), but verification closed the window with `updated.Assignee` — the hive **agent** id (`worker-1`). The keys never matched, the `UPDATE` touched no row, and the window stayed open forever. An open window has no upper bound, so a finished task silently absorbed everything that session did next: in the regression test the task ends up billed $9.42 for $0.42 of work. Fix: `store.CloseTaskAssignments` closes every open window **by task** — the identifier both sides already agree on, and correct when a task was worked by more than one session (reassignment, or a worker respawned after a crash). Verification also mirrors before attributing, since `AttributeTaskCost` writes onto the `tasks` row and `UpsertTask` does not carry `cost_usd`. The two tests that hid this are fixed: `TestTickOpensAssignmentWindow` now asserts the window's `session_id` **equals the spawned session id** (not just that a row exists), and the smoke e2e helper no longer passes the agent id as both the window key and the event's session id — a join that succeeded on a key production never uses. `store.CloseAssignment` (close one (task, session) window) was left with no caller by the fix and is deleted rather than kept as the next trap of this exact kind.
- **Verifying from an illegal status stranded the task.** The failure path wrapped both transitions in `CanTransition` guards; from `inbox`, neither `needs_you` nor `in_progress` is legal, so both no-opped and the task stayed put — and the next verify hard-errored `illegal task transition inbox → done`. The success path's "force the legal step" had the same hole (it set `done` unconditionally after a guarded hop). Fix: `hive.TransitionRoute` returns the shortest legal path, and `board.moveTo` walks it one step at a time, so verification always lands the task somewhere the board can act on; a genuinely unreachable target is a returned error, never a silent no-op.
- **`budget_usd` was decorative.** Validated, stored, mirrored and rendered red in the UI, but nothing ever compared it to spend — and with cost stuck at $0 it could not have fired anyway. The router's reconciler tick now re-attributes cost for every live task and parks one that has outspent its budget in `needs_you` with the reason recorded on the task, which is what [05-orchestration.md § Approvals](05-orchestration.md) has always promised. Attribution on the tick is also what makes the number live: it previously only ran when verification finished a task, so a runaway worker was invisible until it was done. A budget of 0 or unset means no limit.

Tests (each verified to go **red** against the unfixed code, then green): `TestVerifyClosesAssignmentWindowBySession`, `TestVerifyFromIllegalStatusDoesNotStrand`, `TestOverBudgetParksTaskWithReason`, `TestTickEscalatesTaskOverBudget`, `TestTickLeavesTaskUnderBudgetAlone`, `TestTickZeroBudgetMeansNoLimit`, `TestTickOverBudgetUsesInjectedSeam`, `TestTransitionRoute`, plus the strengthened `TestTickOpensAssignmentWindow`. No DDL or contract change: the escalation reason is appended to the task body (which the UI already renders) rather than added as a column.

### 2026-08-20 — Live Orchestration Graph (the "wow" view) — MVP complete

The Phase-3 "delight" visualization, chosen over a radar / activity-river by a 5-persona ICP panel (3-1-1, including the adversarial skeptic) because the picture **is** the differentiator: the orchestrator pinned center, workers on a stable ring, tasks flowing through a **verify gate** that turns green only after `done_criteria` pass — the verified-team story the competitor's office can't show. Built in 8 focused commits under `ui/src/screens/orchestration/`: (1) plumbing — the WS `task` frame was emitted but the client dropped it; now handled, plus route + nav; (2) fixed radial layout — a node's slot is its index in the ever-seen sorted registry (grows only) so nothing ever reshuffles (the panel's #1 anti-jitter constraint, **never force-directed**, enforced by test); (3) model reducer; (4) static SVG renderer; (5) the money shot — verify gate + dot go `--color-ok` green with a CSS pop on verifying→done; (6) damped rAF motion — dots glide toward their status target, overshoot-free, a mid-flight verify bounce re-aims smoothly; (7) empty-state — no hive degrades to your live sessions on the ring (never blank); (8) ambient breathing polish. Pure theme-aware SVG (light+dark free), reads the existing live frames + `/v1/tasks`,`/v1/sessions` — **no backend change**. 42 UI tests green. Fast-follows (deferred): real mailbox-pulse frame, cumulative-spend arc, click-through. Docs: [04-ui.md § Graph](04-ui.md).

### 2026-08-21 — hunting bugs instead of writing tests

With coverage closed, the remaining defects were the ones tests do not reach: wrong numbers, missing validation, and behaviour that only shows on a real database. Eight were found and fixed. The methods mattered more than the count.

**Comparing every displayed number against the database.** Take each figure an endpoint returns and query the same thing directly. Five of six matched on History; "active days" read 21 where 32 days had events, because it counted distinct session *start* dates — a session that ran twelve days contributed one. The sixth, `files_touched`, was not wrong but was mislabelled: it sums distinct files per session, so a file edited in three sessions counts three times (1,703 shown against 1,502 distinct paths). Both readings are defensible; showing one under the other's name is not, so the tile now says "summed per session".

**Summing one endpoint against another.** `/v1/stats/daily` and `/v1/stats/summary` disagreed by $1,603 on the same range, because an out-of-range `days` clamped to the *default* of 30 rather than to the ceiling. The dashboard always asks for 30, so no user saw it; the endpoint was still wrong.

**Fuzzing every mutating endpoint on a running daemon.** Twelve endpoints, eight hostile bodies each. No 5xx anywhere and the daemon survived, but the tasks endpoint accepted a task with no title, a hundred-thousand-character title, a negative budget, and `1e308`; and `PUT /v1/settings` treated an absent field as a cleared one, so `PUT {}` answered 200 while resetting the stated plan and switching the release-check opt-in off. Both are now validated, and settings are a patch rather than a replace.

**A linter for what no test can reach.** Three loops iterated rows without checking `rows.Err()`, so a query that stopped early returned what it managed to read as though it were everything — twice followed by an UPDATE that changed every matching row. `QueryContext` fails on the context before iteration begins, so no test can drive that path; `rowserrcheck` is now in the linter instead. Its companion `sqlclosecheck` is deliberately not enabled, and the config says why.

Three things worth keeping.

**A fix can be a regression.** Counting active days correctly made History four times slower (0.37s → 1.63s) by scanning every event. Reading the same answer from `daily_stats` costs 0.38ms. Measured through the Go driver, not `sqlite3(1)`, where the shell reports 12ms vs 58ms and understates the gap by three orders of magnitude.

**Test setup can be weaker than production.** `:memory:` gives every pooled connection its own empty database, so concurrency surfaced as "no such table" — a convincing impersonation of a product bug. Each `Open` now names its own shared in-memory database. That also switched `foreign_keys` on, which immediately failed a test writing `session_stats` for a session that did not exist: the on-disk database has always enforced this, so the tests had been running in a weaker mode than the product.

**Most alarms were false.** Three apparent defects — a session count of 56 against 51, an identical burn rate across every range, sixty concurrent requests all returning `000` — were errors in the checking, not the code. Verifying the check before reporting the bug is the cheaper order.

### 2026-08-20 — tests where a bug reaches the user's machine

`internal/shim` (0% → 88.7%) and `internal/ptyman` (0% → 81.9%) are the two packages where a defect does not degrade Caprock but breaks something of the user's: the shim runs inside every hook of every session, and ptyman owns the processes Caprock spawns.

The tests cover failure paths, not the happy path the smoke suite already drives end to end — no daemon, a stale `runtime.json` pointing at a dead port, malformed and oversized stdin, a daemon that hangs, a non-200, a non-JSON reply, a panic inside `Run`; and for ptyman: an empty command, a missing binary, a non-zero exit, concurrent `Wait`, the paused input-hold, a double `Close`, context cancellation.

**Two real defects surfaced, both in production code rather than in the tests.**

`session.Close()` returned `file already closed` whenever the process had already exited — the `Wait` goroutine closes the PTY first, so an ordinary ending reported an error. Any caller that checked would log a failure for a session that finished exactly as intended. `os.ErrClosed` now maps to nil.

More seriously, `-race` found a genuine data race: both the `Wait` goroutine and an explicit `Close()` call `pty.Close()`, and go-pty's implementation mutates the handle without a lock. Four races on a single run. The PTY now closes through a `sync.Once`.

**Three tests were written, passed, and turned out to prove nothing.** Each was caught by deliberately breaking the code and watching the suite stay green.

- The panic test in the shim passed with `recover()` deleted. Rewritten to drive a panic through a failing reader.
- The paused-write test asserted only the returned `(n, err)` — which a Write that forwards straight to the PTY also satisfies. Rewritten to feed a shell that echoes what it reads, so the assertion is whether the child ever saw the input.
- The kill test waited on `Wait()`, but closing the PTY ends a POSIX child in ~100ms on its own (measured), so it passed with the kill removed. No POSIX test can isolate the explicit SIGKILL from the hangup that follows teardown; the test now asserts the property the product needs — no process left in the OS — and says plainly what it cannot prove.

Worth keeping: coverage says a line executed, not that it was checked. Every one of these was green while testing nothing, and only breaking the code on purpose told them apart.

**`internal/daemon` followed** (6.5% → 22.8% in unit tests). The number understates it: `daemon.Run` — `newDaemon` plus `run`, 200 lines of opening the database, binding the port and starting the goroutines — is driven by the smoke suite on all three OSes, which the default `-cover` run does not count. Measured together, the package is at **58.7%**.

What the new tests pin is the logic the daemon alone owns: a loop alert stops being reported once the detector's window has passed (and is deleted rather than merely hidden, so the map cannot grow for the life of the process); settings survive a round trip to disk, since a dropped field would price usage against the wrong plan; the release-check opt-in follows the user exactly and stays revocable (rule 4); changing the plan does not disturb it; and the background workers return on context cancellation rather than holding the process open at shutdown. Each was verified against a deliberately broken daemon.

The rest of the uncovered surface is adapter plumbing — one-line methods forwarding to `board` and `agents`, already exercised through those packages. Testing them here would assert that a forwarding call forwards.

**`internal/config` (62.8% → 72.3%) and `internal/agents` (67.7% → 75.0%) followed.** The two things worth pinning were the atomic write and the terminal fan-out. `WriteFileAtomic` is what keeps `runtime.json` readable while it is being rewritten — the shim reads that file on every hook, so a torn one silently stops every session from being recorded; the test runs concurrent readers against alternating payload sizes and fails if any of them sees a size that is neither. `Subscribe`/cancel is where a "send on closed channel" would panic the whole daemon rather than fail one request, since `pump` broadcasts while `wait` closes every subscriber and a browser tab can unsubscribe at any moment.

**`internal/store` (72.1% → 80.3%) and `internal/api` (71.1% → 72.9%) closed the round.** Pinned: a session is only marked ended once it has actually gone quiet, and the sweep does not re-report what it already ended (the daemon emits an event per returned id); `EventsAfter` returns strictly what a reconnecting browser has not seen, since a repeat duplicates feed rows and a miss loses one forever; `WithTx` rolls back rather than leaving a half-applied write; and the Answers endpoints return Claude's prose verbatim, answer `[]` rather than `null` for a session with none, and treat a typed `%` or `_` as text instead of a LIKE wildcard.

Two of these took three attempts to make meaningful, and the pattern was the same both times: the example chosen was one where the bug could not show. The wildcard test searched for `100%`, but `100` already narrows the result to a single note, so dropping `escapeLike` changed nothing — the assertion had to be on a bare `%`, which as a wildcard matches everything. The page-cap test lived at the endpoint with a handful of rows, where every limit looks identical; it moved into the store with more rows than the cap. Both now fail when the guard is removed.

Another test proved less than it claimed, found the same way. `TestRingSnapshotIsACopy` was meant to catch `snapshot()` handing out the ring's internal slice — but it passed with the copy deleted, because `write` rebuilds the slice with `append` rather than editing in place (confirmed by printing the backing pointer: it moves on overflow). A stale reference is therefore never corrupted, and the copy is defence in depth rather than the thing keeping the test green. Rewritten to assert what is actually true — that mutating a snapshot cannot reach into the ring — and the comment now says which of the two it proves.

### 2026-08-20 — v0.9.8: hierarchy, and four numbers that were quietly wrong

The dashboard was asked to look like the site — large figures, clear at a glance — and the exercise turned up four honesty defects that the redesign itself had nothing to do with.

**A cost with no basis reads as a bill.** Shown to five readers, three took a hero figure for an amount owed. The qualifier existed on Now and nowhere else: History said `API-equivalent`, our own jargon; Cost and Session said nothing beside the number. The wording now comes from one component so the four screens cannot drift, and it follows the stated plan, because no single sentence is honest for everyone — on a flat plan the figure is explicitly not a bill, on metered billing it *is* approximately the bill, and with no plan stated it names the basis and claims nothing further.

**A percentage that rounds up invents a perfect score.** A 99.5% cache hit displayed as `100%` is a number the data does not support. `fmtPct` floors.

**Cache hit was tinted green permanently.** It sits near 99% forever on Claude Code, so a colour that is always on points attention away from the money rather than at anything. It speaks up only below 90%, where a drop means something broke.

**A liveness label that stops updating is worse than none.** The header dot computed the age of the last frame only when a frame arrived — and on an idle machine no frame arrives *by definition*, so it froze at `live · now` and kept saying it for hours. Exactly the reading someone glancing from across the room relies on, and the one case where it was wrong.

Also: an attention rule for sessions with many turns and few files, and note search that matches the prompt that produced an answer, not only the answer's own text.

Two things worth keeping.

**The rule was reworded after the owner could not judge his own session.** It said "Spent with little to show" — a verdict. Asked whether the flagged session had actually gone wrong, the person who was there said he did not know. If they cannot tell from the outside, the dashboard certainly cannot; it now reports what it counted ("Lots of turns, few files") and leaves the judgement alone.

**Two defects were found only by looking at the rendered page against a real 342MB database.** The Cost subtitle truncated once the basis was appended to the session count — cutting off precisely the part the change existed to add — and the Session tile could not fit the basis beside the model name at one-sixth width. Both invisible to a passing test suite.

An "all clear" banner was considered for the empty attention strip and rejected: an always-on banner is what trains people to stop reading the space where the real warning will appear.

### 2026-08-20 — v0.9.7: the desktop app's plan usage, and the case for building less

B3 closed in about an hour instead of the 7-9 estimated, because reading the actual file changed what was worth building. `plan-usage-history.json` holds a timestamp and two window percentages — no tokens, no cost, no content. So the charted, stored version originally sketched would have answered a question the data cannot answer ("what did the desktop app cost") and invited exactly the invented number rule 6 forbids. One line on the status screen answers the question the user actually had: did my plan go somewhere other than Claude Code.

Two properties of the source shape the presentation. It is written only while the app runs — 27 samples in a day on this machine against ~290 at its five-minute interval — so the reading carries its age and says "app closed since" rather than passing an old figure off as current. And most people do not use the desktop app at all, so absence returns nothing rather than an error, and the row simply does not appear.

Worth keeping: the estimate that killed the expensive version came from opening the file, not from reasoning about the feature. Twenty minutes of looking saved most of a day.

### 2026-08-20 — v0.9.6: the dashboard on a large history

Three to ten times faster on the author's 184k-event, 306MB database. Session list 240ms → 23ms, Answers 156ms → 2ms, Cost (all) 818ms → 230ms, History (all) 828ms → 340ms.

One shape caused most of it: every aggregate filters by `kind` and then by time, but only `ts` was indexed — so each query read the whole range and discarded ~70% of it, since `tool.pre` and `tool.post` are two thirds of the table. Migrations 0006–0009 add `(kind, ts)`, a covering variant carrying `model` and the token/cost columns, `(session_id, id)` for the per-session lookup behind Now, and `(kind, id)` for the id-ordered note queries. Two totals that summed `CASE` expressions — which no index can help — group by kind instead.

Three things worth keeping for whoever profiles this next.

**Profile through the driver, not the shell.** The model-mix query timed 83ms in `sqlite3` and 1.26s through Go, because `model` sat outside the covering index and the driver pays per row to reach it. Timing SQL in a shell would have missed the single biggest win.

**Know whether a number is warm.** The first summary after startup costs ~1.2s and every one after ~345ms. Chasing the cold figure would have sent someone optimising the wrong thing.

**Two optimisations were rejected for being wrong rather than slow.** Replacing `COUNT(DISTINCT session_id)` with a count from `sessions` is faster but disagrees — 51 against 56 — because sessions exist with no assistant turn. And an FTS5 index answers note search in 6ms against ~165ms, but matches whole words: `chestr` finds 394 rows with LIKE and 0 with FTS. People search their sessions for fragments, so the scan stays.

### 2026-08-20 — v0.9.2: what only shows up when you run the thing

The v0.9.1 sweep read the code. This one ran the daemon against hostile transcripts and rendered the dashboard with malformed data, and the difference in what it found is the lesson.

The worst was a compound failure no single reading would catch. A transcript line stamped year 9999 rolls past year 10000 in a positive UTC offset; `time.Time` refuses to marshal that; `json` aborts the *entire array* rather than the one element; and `writeJSON` wrote 200 before encoding and discarded the error. Result: `/v1/sessions` returned HTTP 200 with a zero-byte body while five healthy sessions sat in the database, the dashboard threw parsing it, and nothing appeared in the logs. The event persists, so it survived restarts with no recovery path. Three independently reasonable pieces of code combined into silent, permanent corruption — fixed at all three layers, because each was wrong on its own terms.

The UI equivalent: `toFeedItem` threw on a wrong-typed tool argument, and the throw surfaced inside `ws.onmessage` — outside React, where no ErrorBoundary sees it — starving every later subscriber and stopping the tick that drives refetching. The dashboard froze on stale numbers showing no error. Both halves were fixed: coerce the leaves (Go's narrator already did this with a typed struct; the TypeScript port trusted its types), and isolate a throwing subscriber.

A pre-release check then caught the thing that would have made this release a lie: the built dashboard is committed to the repo so `go install` works without Node, and the committed bundle was several commits stale — so v0.9.2 would have shipped a UI with none of the fixes above while the changelog claimed all of them. The Go half was in the binary; only the UI half was missing, which is the hardest version of this to notice. `dist-check` existed to catch exactly that and had two holes: it was never added to `make check`, and it used `git diff`, which ignores untracked files — a rebuild emits a new hashed filename, so it saw a clean tree while the old bundle sat committed beside it. Both closed.

Also worth recording from the run: reads are capped at ~70 req/s because the store holds a single connection, and `/v1/stats/summary?range=all` costs ~580ms on 183k events and grows linearly with `retention_days` defaulting to keep-forever. Neither is a bug today; both are on the clock.

### 2026-08-20 — v0.9.1: a sweep for numbers that lie and controls that lead nowhere

Prompted by a user report that hovering the daily-cost bars did nothing — the bars carried a native `title` tooltip, which is a real answer that arrives after a browser delay in the OS font, long enough to read as broken. That framing turned out to name a whole class, and two parallel audits found eleven more instances of it.

The pattern worth remembering: **every finding was invisible from the code alone and obvious against real data.** "files touched" reported 1690 for today, for 30 days and for all time — the SQL had no WHERE clause, which reads as fine until you run all three. `notes?limit=5001` returned 200 rows where `limit=5000` returned 2372, at a one-unit boundary. A five-hour window claimed it resets in 2030, and the test fixture had encoded that very value as expected behaviour. History counted active days in UTC while the chart beside it used local time, so "21 active days" sat above 31 bars.

Two lifetime bugs were the most serious: starting the orchestrator and running verification both used the HTTP request's context. The PTY itself was already protected with `context.WithoutCancel`, but the ownership write thirteen lines later was not — so a browser disconnect could leave a real `claude` process running with no row recording that Caprock owned it, which is exactly the state rule 7 exists to prevent. `go test -race` was clean before and after; all of these are latent until the timing lands.

### 2026-08-20 — v0.9.0: Answers — the prose was always there, and always hidden

An early user asked where Claude's actual answers were: the timeline showed `turn.assistant → Bash` and a 200-character slice, never the paragraph. Checking the data settled it in minutes — `payload.text` had carried the prose all along. The feature was therefore a presentation defect, and the reason it matters is that for many sessions the deliverable is the conclusion rather than the diff: "done, but I couldn't verify X — ask the team". That paragraph lived only in scrollback, so people kept a notepad beside the terminal.

A parallel audit of 12k events said the data would support it and named four things to fix first, all of which turned out to be real. The worst was self-inflicted: the parser capped text at 2000 **bytes** and sliced at an arbitrary offset, halving Cyrillic prose and corrupting a fifth of clipped rows — hardest on the closing summaries the whole feature is about. Fixing the parser only helps new lines, so a one-time repair re-derives damaged rows from the transcripts on disk; on this machine 452 corrupted rows became 3.

Building that repair taught more than the audit could: a session's recorded `transcript_path` is frequently **not** where its messages live (Claude Code records whichever file the last line arrived on, so main-thread turns land under a subagent path and vice versa, nested arbitrarily deep), an arbitrary 200-file sweep cap silently left rows unrepairable in a project holding 916 transcripts, and `ParseLine` returns a `Line` whose `Message` pointer is nil for system lines — dereferencing it panicked the daemon at startup, which would have hit every user with an older database on upgrade. All three were only visible by running against real data rather than fixtures.

### 2026-08-20 — v0.8.1: the update notice, and rule 4 stated honestly

B2 is closed, but not as originally sketched. The owner asked whether the UI could just have an "update" button; it cannot, and the reasons are worth keeping: upgrading replaces the running binary, so the daemon would be killing the process executing its own upgrade — a race whose failure mode is a user left with no working Caprock and no clear message; running a package manager on the user's behalf from a web page opens exactly the surface a local-first tool should not; and a large share of installs (`go install`, a downloaded binary, a source build) have no package manager to drive. So the notice names the exact command for how *this copy* was installed, inferred from the executable's path, and the user runs it in their own terminal.

The check is the first genuine outbound call in the codebase, which made the honest half of the work documentation rather than code. Rule 4 ("no outbound calls") was true and is no longer literally true, so it now reads "no outbound calls except the release check the user explicitly turns on" in `00-index.md`, `06-engineering-rules.md`, `01-product.md`, the README and `CLAUDE.md` — a promise quietly outgrown is worse than one restated. The opt-in is enforced server-side (`POST /v1/update/check` is 403 while checks are off) rather than only in the UI, reading status performs no I/O at all, and a `dev` or `git describe` build is never nagged.

### 2026-08-20 — v0.8.0: the three surfaces that make the data speak

Everything here was already being collected; none of it was being said. The live activity feed turns the event stream into one readable column of what every session is doing — the surface that makes the dashboard feel alive rather than like a table that occasionally changes. Plan value answers the question nobody can answer for themselves ("what would this have cost through the API?") and required deciding what Caprock is allowed to claim: it cannot detect a plan, so the user states it in a header chip, and the framing changes with the billing model — a multiple on a flat plan, no multiple at all on metered billing where the API-list figure is roughly the real bill. It never says "you saved $X", because without the plan the usage would not have happened; a test pins that the word never appears. The attention strip generalises the lone loop banner into a set of rules with two disciplines built in: no "all clear" state (an always-on banner trains people to ignore the space), and cost alone is never a reason to fire (spending is the job; only waste is news).

The owner's framing drove all three: the graph had been the candidate "wow" and was judged to convey nothing in its empty state, so the effort moved to surfaces that state facts the user cares about — what is happening, what it is worth, and what is going wrong.

### 2026-08-22 — Projects group by repository, and expand into it

The Projects panel had been grouping by the **basename of the session's cwd**, which is not a project. On the owner's own database that produced `caprock` and `ui` as separate repositories, `app` as a project (it is a directory of the monorepo), `worker-1` and `outbox` as projects (they are Caprock's own agent plumbing), and — the failure that matters, because it is silent rather than merely untidy — two different `testrepo` paths and two different `repo` paths each summed into a single row of unrelated work.

A row is now the repository. The root is resolved by walking up for `.git`, once per distinct directory behind a cache, **at ingest**, and stored on the session (`repo_root`, `repo_path`, migration 0011) rather than derived on read. Storing it is the decision that carries the feature: historical sessions point at scratchpad directories that are already gone, so a read-time walk would relabel yesterday's spend according to what happens to be on disk today, and `/v1/stats/summary` is polled on an interval, where a filesystem walk per row would be a syscall storm. Existing databases are backfilled on first open. A `.git` **file** is followed to the repository that owns the worktree, so an agent's spend lands on the repository it is working on; a submodule is left as its own repository. Nothing outside a repository is given an invented repository name — such rows are keyed on their own cwd, so two `scratch` directories stay two rows, and labels that would collide are widened with parent segments (`livegraph/repo` vs `orch-live/repo`) only when they actually collide.

The second level is the point of the first. Knowing `caprock` cost $1,662 raises the question the number cannot answer, so each row expands to spend per top-level directory inside the repository — `ui`, `internal`, and a `(repo root)` row for work at the top. A repository with one directory has no breakdown, because it would restate the row's own total. Both levels come out of one pass over the events, aggregated per session and grouped in Go: measured on the owner's 190k-event database through the Go driver, best of six, the whole summary went from 210ms to 193ms, so the added level is free.

### 2026-08-20 — v0.7.0: per-repo spend on the landing screen; the graph loses its nav slot

Owner review drove both halves of this release. Per-project cost already existed but was buried in History behind a range picker, so Now opens with a Projects roll-up: measured spend, tokens, and session count per repository, a share-of-largest bar, and a live dot when a session is running in that repo. It answers the question a session list structurally cannot — what a repo costs and who is working in it — and it needed one contract addition, `sessions` (distinct sessions per project) in `/v1/stats/summary`. On the same review the type scale was corrected: a stat value at 17px against its own 10px label had to be read up close rather than scanned.

The orchestration graph came out of the top nav. Shown its real empty state — five session ids in a ring around a `caprock` hub — the owner's verdict was that it conveys nothing, and that is a design fault rather than a polish gap: the graph draws **topology** (which processes exist, something the user already knows) when the interesting question is **what is happening and how it ends**, which is about time, not space; and putting our hub at the centre frames the picture around Caprock instead of the user's work. It still reads well while an orchestrator is running, so the route stays at `#/graph`, Tasks links to it while any task is assigned and unfinished, and it earns a nav slot back only if the framing is reworked. Agreed next, in order: a live activity feed, a plan-value screen (API-priced usage against the subscription price), and an attention feed for loops and stalls.

### 2026-08-20 — v0.6.0: light theme + `go install`

Two shipped-ready additions. **Light theme:** a header toggle (sun/moon) flips the dashboard between dark and light; the light palette redefines the same semantic tokens under `[data-theme="light"]`, so every screen and the xterm terminal follow along (the terminal reads the CSS vars at mount). The choice persists to localStorage and follows `prefers-color-scheme` when unset; an inline pre-paint script avoids a flash. The site got the same treatment — because the landing uses CSS UI primitives (not screenshots), it adapted for free with no images to redo. **`go install`:** the built dashboard is now committed under `internal/api/dist/` (596K, deterministic Vite output) so `go install …/cmd/caprock@latest` embeds a real UI instead of the placeholder; a `make dist-check` + CI step rebuild the UI and fail if the commit is stale. Also: `paceForecast` now uses the injectable daemon clock (consistent + testable, with a Rule-6 honesty test), and `statuslineCommandStr` quotes only the path so a spaced install location registers correctly.

### 2026-08-20 — v0.5.1 shipped (Scoop live); test coverage + a spaced-path fix

v0.5.1 published — the full Windows chain worked end to end: tag → verify gate → goreleaser → the Scoop manifest (`caprock.json`, both `.exe`s, 64bit + arm64) auto-pushed to `dspv/scoop-bucket` (the newly-scoped token works), and the Homebrew formula bumped to 0.5.1. Local daemon `brew upgrade`d to 0.5.1, `hooks: 8/8`. Then a round of improvements: CLI tests for `lastLogError` (port-in-use / error / panic / clean / missing-file), the statusline subcommand wiring, and `statuslineCommandStr`; a `post()` test asserting the **whitelist promise** (only rate-limits + session_id leave — no prompt/model/cost); and a real correctness fix — `statuslineCommandStr` now quotes only the path (not the whole command), so a caprock under a spaced path (`/Users/My Name/bin/caprock`) registers as `"…/caprock" statusline` instead of one broken quoted token. Coverage: cmd/caprock 13.5→18%, statusline 62.5→80.6%, hooks →82.3%. Whole project green under `-race`.

### 2026-08-20 — Windows install via Scoop; site/README Windows instructions

Windows users had no package-manager path — the site and README named "macOS / Linux / Windows" but only gave a `brew` command and a "download the zip" fallback, so a Windows user had to place binaries on PATH by hand. Added a `scoops` block to `.goreleaser.yaml` (manifest pushed to the new public **`dspv/scoop-bucket`** repo on release, skipped on prerelease), and Windows instructions everywhere: README quickstart, the site's `/install` page and `/install.md`. `scoop bucket add dspv https://github.com/dspv/scoop-bucket` then `scoop install caprock`. The `HOMEBREW_TAP_TOKEN` PAT was granted `Contents: write` on `dspv/scoop-bucket` too, so the Scoop push works (verified on v0.5.1 — see the next entry). All project repos now cross-link through a README project map, and all are on `master`. winget deferred (needs a PR into `microsoft/winget-pkgs` + their review) until there's real Windows traffic.

### 2026-08-20 — v0.5.0 published; the CI-gate caught a broken release before it shipped

v0.5.0 is tagged and published. The first tag failed the new `verify` gate — golangci-lint ran before the UI build, so `internal/api/ui.go`'s `//go:embed all:dist` had nothing to embed ("no matching files") — and goreleaser was correctly **skipped**: nothing reached `brew install`. This is exactly what the gate is for. Fixed by building the UI first in the `verify` job, re-tagged, and the second run published cleanly: `verify` green → goreleaser green → the tap formula auto-bumped to 0.5.0 in `Formula/` (both binaries), no manual step. Verified live: `brew upgrade` → `caprock 0.5.0`, `caprock up` offers hooks **and** statusLine, `caprock status` reads `hooks: 8/8`, statusLine set, ~179k events / 52 sessions of history intact.

### 2026-08-20 — Distribution polish: statusLine auto-install, honest port errors, CoC, MCP names, release CI gate

Prepping for public distribution — a read-only audit plus a live look surfaced five gaps, all fixed. **(1) Release didn't gate on CI.** `release.yml` fired on a tag with no dependency on `ci.yml` (which runs on branches/PRs, not tags), so a tag on a red commit would build + publish + push the formula — while the docs claimed it waited for CI. Added a `verify` job (npm ci + golangci-lint + `make check` + Windows cross-build on the tagged commit) that goreleaser now `needs:`. **(2) statusLine wasn't installable.** The plan-limit feature needed the user to hand-edit `~/.claude/settings.json`; new users never got it. `caprock up` now offers it under the same consent contract as hooks (TTY prompt / `--yes`), plus `caprock statusline install|uninstall`; idempotent, backs up once, never clobbers a user's own statusLine (`internal/hooks/statusline.go`, tests). **(3) Port-in-use hid behind a timeout.** On a detached-start timeout `caprock up` now tails the real cause from `caprock.log` — the common "address already in use" becomes an actionable message. **(4) No CODE_OF_CONDUCT.** Added Contributor Covenant 2.1, linked from CONTRIBUTING. **(5) Long MCP tool names truncated** in History's Tool Usage — `mcp__server__tool` now renders as `server·tool` with the full name on hover (`fmtTool`, tests). All green under `make check` + 3-OS cross-build; `caprock.dev` homepage in the formula verified live (serves the OSS site).

### 2026-08-19 — v0.4.1: Homebrew install ships the hook shim; status/uninstall see the self-hook form

Found by installing v0.4.0 via `brew` on a real machine. Two linked bugs. **(1) The formula installed only `caprock`, not `caprock-hook`** — my `bin.install` stanza omitted the shim, so `hooks install` fell back to the `…/caprock hook` self-command. **(2) `Inspect`/`Uninstall` only recognized the dedicated `caprock-hook` shim**, not the self-hook form, so `caprock status` (which the daemon computes against the data-dir shim path) read `0/8` for a working install, and `hooks uninstall` silently no-op'd, producing duplicate hook entries on the next install. Fix: goreleaser + the tap formula now install both binaries; `isOurEntry` also matches a `…/caprock hook` command (base `caprock` + single arg `hook`). Tests: `TestInspectRecognisesSelfHookForm`, `TestUninstallRecognisesSelfHookForm`. Verified live: after the fix, `caprock status` reads `hooks: 8/8`, backfill done (1463 transcripts), no duplicates. The daemon binds 127.0.0.1:4173; the shim is never the daemon.

### 2026-08-19 — Orchestrator lifecycle fixes: workers stop cleanly, restart is idempotent

Two live-reproduced bugs found while capturing a real tasks-board screenshot (four tasks driven to `done` by a live orchestrator, real per-task cost). **(1) Workers looped instead of stopping.** An `assign` is a fire-once instruction, but nothing drained it from the worker's inbox after it acted; `InboxCount` stayed >0, so the Stop hook forced continuation forever and the router re-kicked the worker into an endless inbox-poll (`loop detected`). Fix: the reconciler now archives a worker's assign to its `processed/` dir once the task moves past `assigned` (new `Hive.ArchiveInbox`; deterministic on task status, not on the agent's own file housekeeping). `result`/`question` mail is never touched. **(2) Restarting the orchestrator spawned a duplicate.** `Start` was not idempotent — a second call spawned another orchestrator session (leaking the first) and started a second router loop racing the first on the same hive, so newly-queued tasks were never assigned. Fix: `Start` re-kicks the live session instead of respawning; a dead session is replaced normally. Verified live end to end: three tasks (one added mid-run and picked up after a re-kick) reached `done` with `assign archived`×3, `loop detected`×0, `guard tripped`×0. Tests: `TestArchiveInbox`, `TestTickDrainsConsumedAssignment`, `TestTickKeepsUnpickedAssignment`, `TestStartIdempotent`, all green under `-race`. Docs: [05-orchestration.md](05-orchestration.md) reconciler steps + the two invariants.

### 2026-08-18 — Phase 2 complete: orchestrator, verification runner, cost attribution, e2e (T21–T25)

The trust gap is closed end to end. `internal/orchestrator` spawns the orchestrator as a real `claude` session with a hive-aware system prompt (`.ai/07-orchestrator.md`, embedded + kept in sync by a test), spawns workers into per-worker git worktrees, and runs the mailbox router; the daemon maps a session id back to its hive agent so the Stop-loop checks the right inbox. `internal/board`'s verification runner runs a task's `done_criteria` in the assigned worker's worktree — all green ⇒ `done` (and cost is attributed to the task via the assignment windows), any red ⇒ bounce the failing output to the worker, escalate to `needs_you` after R=3 rounds. Verified two ways at the time: live on macOS (`caprock up --hive` → `POST /v1/orchestrator/start` spawns a real orchestrator that registers in the hive and gets its prompt), and a scripted `-tags smoke` e2e on a fixture repo (task → assign → failing build → verify fails → bounce → worker fixes → verify passes → done, cost attributed). New endpoints: `POST /v1/orchestrator/start`, `POST /v1/tasks/{id}/verify`; `--hive`/`--repo` flags. The full unattended run followed the next day (see below).

### 2026-08-19 — OQ-03 resolved: rate-limit windows via the statusline

The last open question is answered with a real feature. Claude Code exposes plan-limit state (`rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, Pro/Max only) to the **statusline** command — not to hooks or transcripts — so Caprock now ships `caprock statusline` (new `internal/statusline`, mirrors the shim's safety contract: print from stdin first, fire-and-forget POST ≤300ms, silent-drop if the daemon is down, always exit 0, never the whole JSON — only the rate-limit numbers + session id). It POSTs `/v1/statusline`; the daemon stores a latest-per-window row + a throttled history sample (migration 0005: `rate_limit_latest`, `rate_limit_history`). The Cost screen shows the current window ("5h: 23% · resets 15:40", threshold-coloured) and an "at current pace" forecast **only** when the measured slope is rising and would hit the limit before the window resets (≥2 same-window samples ≥60s apart) — otherwise the fact alone, never a guess. The absolute plan threshold is never emitted by Claude Code and is deliberately not shown. Tests: statusline render/safety (malformed/empty/no-rate-limits all safe), store record/latest/pace with the honesty gate (flat and across-reset produce no forecast), and the `/v1/statusline` → summary endpoint. Also: the user's `~/.claude/settings.json` had a `caprock statusline` line pointing at the retired Python tool (pipx `caprock` 0.1.25, which shadowed the Go binary in PATH) — uninstalled it so the Go command takes effect. Contract/DDL/UI in this commit per Rule 8.

### 2026-08-19 — Docs-vs-code-vs-tests audit: close a dead feature and untested rules

A three-agent audit checked every doc-claimed capability against the code and its tests (does it work? is it covered by a *real* test, not a mock?). Phase 0 and the Phase 2 reconciler came out well-covered; the audit found one more "green test, dead feature" of the same class as the earlier dead loop, plus several product rules with no test. Fixed:

- **Cost attribution was dead in production.** `store.OpenAssignment` had no non-test caller, so `task_assignments` was always empty and every task's `cost_usd` was 0 — the tests passed only because their helpers opened the window themselves. The router now opens the assignment window when it spawns a worker for a task (`OpenAssignment` made idempotent per open (task, session) so it is safe every tick), and a new `TestTickOpensAssignmentWindow` drives the real tick and asserts the window exists — catching the regression the old tests missed.
- **"The shim never breaks a session" — the worst path was untested.** All shim-timeout tests used a dead port (fast dial failure). Added `TestShimHungDaemonExitsWithinBudget`: a listener that accepts then never replies (a wedged daemon) — the shim must still exit 0, silently, within budget. This covers the `ResponseHeaderTimeout` path that actually protects the session.
- **"We never signal a process we did not start" was tested only for input.** Added `TestControlRefusedForNonOwnedSession` — pause/resume/kill/resize on a non-owned session are all asserted refused.
- **Spawn hygiene, previously untested:** `TestSpawnStripsNestingEnv` (the daemon's `CLAUDE_CODE_CHILD_SESSION`/`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` markers are stripped so a spawned session is a normal top-level one) and `TestSpawnPreacceptsFolderTrust` (spawn writes `hasTrustDialogAccepted` for its cwd, so a refactor dropping the call is caught).
- **Endpoints and dispatch with no HTTP/CLI test:** the whole Phase 2 API (`/v1/tasks/{id}/verify`, `/v1/orchestrator/start`, approve/**reject**, the 409 error path, the 501-when-disabled path), `GET /v1/history`, the `/term` terminal WebSocket (snapshot-on-connect + streaming), auto-pause (owned-only + opt-in, extracted to `Daemon.maybeAutoPause`), the `cmd/caprock` CLI dispatch (all subcommands incl. the hidden `hook` fallback, `shimCommand`), and a pin on the exact 8 hook events. Net: ~19 new tests (116 test functions total), all green on the 3-OS matrix.

### 2026-08-19 — Tag gate met: real orchestrator drives a task to green, autonomously

The unattended run is done. With hooks installed in a real `~/.claude/settings.json`, `POST /v1/orchestrator/start` spawned a real `claude` orchestrator that read the task board, set `assignee`+`status: assigned`, and wrote an `assign` message; the router materialized that intent — spawned `worker-1` into its worktree, the worker wrote the missing function, reported a `result`, and the orchestrator moved the task to `verifying`; the router ran `go build`/`go vet`, both passed, and the task reached `done` — start to finish with no human input. Getting there closed three real gaps the earlier "complete" hid: (1) the router ran under the per-request context and died the instant `/orchestrator/start` returned — now it runs under the daemon-lifetime `BaseCtx`; (2) a freshly-spawned interactive `claude` waits for a first message and does not react to inbox files landing, so `SpawnWorker` was never triggered and verification was never driven — the router is now a reconciler that spawns a worker per assigned task, runs verification for each `verifying` task (in-flight-guarded), and re-kicks (throttled) any idle session with unread mail; the orchestrator/worker each get one initial typed "kick" to start their first turn; (3) the folder-trust dialog (which `--dangerously-skip-permissions` does not suppress) is pre-accepted in `~/.claude.json` (`hasTrustDialogAccepted`) before spawn, so a session starts in its main loop instead of blocking. Design was decided by an agent council per `.ai/06-engineering-rules.md § Council quorum`. See `.ai/05-orchestration.md § Design decisions`.

### 2026-08-18 — Phase 2 (Orchestrate) foundation: hive, board, Stop-loop, approvals (T17–T20)

The trust-gap machinery's base is in and tested. `internal/hive` is the on-disk source of truth (agents/tasks/mailboxes/ledger, single writer, atomic writes, a dependency-free YAML reader/writer for the fixed task schema, validated kanban transitions). `internal/board` bridges it to the SQLite mirror and the API and answers the worker's Stop hook — forcing continuation while the inbox is non-empty, with the N=10 guard escalating to `needs_you`. Approve/reject move the task and notify the orchestrator by mailbox. `caprock up --hive <dir>` turns it on; the task endpoints return 501 otherwise. Verified live on macOS: tasks created via the API become `tasks/*.md` files and render on the kanban. A costly lesson this session: an accidental `git add -A` while Phase 2 files sat in the tree leaked them onto the Phase 1 branch and broke its CI on all three OS; the fix was to reset the branch to its last clean commit and re-apply only the intended changes — a reminder to stage explicitly when multiple phases share a working tree. Phase 1 merged to master green on the matrix (PR #2); Phase 0's T7/T8 merged as PR #1.

### 2026-08-18 — Phase 1 (Control) lands on a branch: spawn, terminal, control, auto-pause, History

Verified end-to-end on macOS: from the dashboard I spawned a real `claude` session into a demo repo, typed a task into its live xterm.js terminal, watched Claude create a file, and controlled it with owned-only pause/resume/kill. `internal/ptyman` (the T0 backend) drives it; `internal/agents` owns spawn/stream/input/signal/exit with `claude --session-id <uuid>` so hooks and transcript land under the id Caprock already knows, and strips inherited Claude/Caprock nesting env so an owned session is a normal top-level session. Two subtle bugs found and fixed while dogfooding: `/v1/status` never populated `claude_available` (spawn worked but the UI showed observe-only), and Spawn used the HTTP request context so the process was killed the instant the response was sent (`signal: killed`) — now `context.WithoutCancel`. Auto-pause is opt-in and owned-only. History (T15) reports lifetime sessions/turns/tool-calls/files/avg-duration/cache-hit/cost plus tool distribution, model mix and top projects. New endpoints: `POST /v1/agents`, `/v1/agents/{id}/input|signal`, `WS /v1/agents/{id}/term`, `GET /v1/history`. Migration 0003 adds `owned`, `worktree`, `throttle_observations` (verbatim) + spawn bookkeeping.

### 2026-08-18 — Phase 0 backend + first UI cut land on master (T1–T6, T9; T7/T8/T10 half)

One evening from empty repo to a working observe-only mission control: `store` (pure-Go SQLite, DDL v1 verbatim + additive v2), `cost` (versioned pricing, cache-savings formula ported from `_savings.py`), `rollup` (single write path), `hookd` + `internal/shim` + `caprock-hook`, `hooks` installer (ordered-JSON merge — the user's key order survives), `ingest` (fsnotify + poll tailer, schema-versioned parser, golden fixtures), `loop` (episode-based, normalized signatures), `narrate` (phrase/health/plan), `gitdiff`, `api` (REST + WS + embed), `daemon`, the `caprock` CLI (`up` detached, `down` via token-gated shutdown, `status`, `hooks`), the smoke DoD scenario, and a React 19 / Vite 8 / TS 7 dashboard with Now, Session Detail (timeline / live diff / files) and Cost. Two facts learned from real transcripts that the spec could not know: one API response is written as several assistant lines repeating the same usage (dedupe by `message.id`, verified across 16k groups), and `<synthetic>` model lines are not turns. Everything except the OS matrix is green locally: `go test ./...`, `golangci-lint`, `tsc`, `vitest`, `make docs-check docs-links`, `go test -tags smoke`.

### 2026-08-18 — Corpus built from the hand-off spec; repo prepared for development

The template repo (`corpus`) was turned into Caprock's home: `CaprockV2-SPEC.md` decomposed into eleven `.ai/` files with zero information loss, audited by parallel reviewer subagents ([docs/migration-audit.md](../docs/migration-audit.md)), then deleted; MIT license replaced with Apache-2.0; template-only files (`TEMPLATE.md`, `CONTRIBUTING.md`) removed; README, CLAUDE.md, AGENTS.md rewritten. While preparing, three facts surfaced that the spec did not know: (1) Claude Code now ships a native `type: "http"` hook — rejected in favour of the shim because it shows a transcript error when the daemon is down ([ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type)); (2) the legacy repo has no `pricing.json` or transcript fixtures, so the pricing table is authored from the Anthropic pricing page and T5 parity is redefined ([ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson), `OQ-01`); (3) the current Stop-hook output shape differs from the spec's (`OQ-06`). Toolchain pinned to latest stable ([ADR-017](08-decisions.md#adr-017--toolchain-go-126-moderncorgsqlite-coderwebsocket-fsnotify-cobra-react-19--vite-8--typescript-7-native-tailwind-4-vitest)).
