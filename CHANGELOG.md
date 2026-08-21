# Changelog

All notable changes to Caprock. Format: [Keep a Changelog](https://keepachangelog.com/).
Versions map to the roadmap phases in `.ai/09-execution-plan.md`: **v0.1.0** = Observe,
**v0.2.0** = Control, **v0.3.0** = Orchestrate. **v0.4.x**/**v0.5.0** are post-Orchestrate
polish (plan-limit windows, orchestrator-lifecycle fixes, Homebrew formula, first-run UX).

## [Unreleased]

Phase 3 (Delight) has no plan by design.

## [0.11.2] - 2026-08-21

Both reported by the first outside user.

### Fixed

- **Answers looked like it had lost your history.** The list loaded a fixed 500
  notes and stopped, which on a busy machine is half a day — so it showed an
  answer from 22 hours ago followed immediately by one from 30 days ago, with
  nothing between. Nothing was lost; the middle had never been fetched. The list
  now pages backwards on demand, and reaches everything.

- **An answer did not feel connected to its session.** Clicking through opened
  the session at the top of a timeline holding thousands of events, leaving you
  to find the passage you had just clicked. It now opens at the moment the
  answer was written, with those events marked.

## [0.11.1] - 2026-08-21

### Added

- **"What did it ask?"** — a session waiting on you now has a button showing the
  last thing Claude said, so you do not have to go back to the terminal to find
  out what it wants. It shows the last *complete* thought rather than the newest
  line: roughly a third of sessions end mid-sentence, and "Let me check that…"
  is not an answer.

  It reads and does not write. Typing into a session Caprock did not spawn is
  refused by design, so the footer names where the reply goes instead of
  offering a box that would fail.

## [0.11.0] - 2026-08-21

### Added

- **A feedback button that files an issue without sending anything.** Two
  clicks and a sentence: pick whether something is broken, missing or unclear,
  type what you saw, press the button. A prefilled GitHub issue opens in a new
  tab and you submit it yourself.

  Nothing is transmitted from the dashboard. You install Caprock because
  nothing leaves your machine, and a form that quietly posted to a server would
  break that even with a click in front of it.

  What gets attached is shown before anything happens — version, platform,
  which screen, how many events, whether hooks are on. Not attached: project
  names, file paths, or cost. Those are your repositories and your money, and
  neither helps fix a crooked button.

## [0.10.1] - 2026-08-21

### Fixed

- **Over half the loop alerts were ordinary work.** Replayed over 64,733 real
  tool calls, the detector fired 436 times — and 236 of those were a repeated
  `Read` of one file, which is what re-reading after an edit looks like. Tool
  calls cost nothing, so those alerts could not have been about the budget the
  feature exists to protect, and noise in an attention surface teaches people
  to stop reading it.

  `Read`, `Glob`, `Grep`, `ToolSearch` and `NotebookRead` no longer raise loop
  alerts. On the same history that is 436 alerts down to 174; what remains is
  tools that can actually do something.

## [0.10.0] - 2026-08-21

### Added

- **Live pulse — the shape of the work, one bar per minute.** A track per
  session on Now, showing the last hour. A bar's height is how much happened in
  that minute and its colour is what it cost, so the shape of a track is the
  shape of the work: a task that ramped up and finished draws a bell, steady
  grinding draws a plateau, working in bursts draws a comb.

  Every pixel corresponds to something recorded — there is no motion that does
  not. A minute with no events draws a hairline rather than a gap, because a
  hole in a chart reads as a rendering fault while a flat floor reads as
  silence.

  Hovering names the minute and what happened in it; clicking opens the session
  **at that minute**, with those events marked. Landing at the top of a
  thousand-event timeline is the same as not having clicked.

  On the right, **×N same call** counts the most-repeated identical tool call
  within six minutes. It is worded as the measurement rather than a verdict:
  polling a file with repeated reads looks exactly like being stuck, and only
  the person working knows which it was.

### Fixed

- **The pulse said "working" while Claude was waiting for you.** It inferred a
  state from the bars instead of using the one the daemon already knew. The
  bars describe the past hour; health describes this moment, and they answer
  different questions.

- **`?newest=1` on the session events endpoint.** Paging from the start returns
  the *oldest* events, so anything showing recent activity rendered an empty
  window on a busy session — hours of history, none of it recent, with nothing
  to say why.

## [0.9.9] - 2026-08-21

Bugs found by hunting rather than by tests — comparing every displayed number
against the database, summing one endpoint against another, and fuzzing every
endpoint that writes something.

### Fixed

- **"Active days" was undercounting by a third.** The History screen read 21
  active days on a database with 32 days of events, because it counted the days
  sessions were *started* rather than days with work in them. One session that
  ran twelve days contributed one. It also got four times faster along the way
  (0.37s to 1.63s and back down to 0.36s).

- **A partial settings body wiped the rest.** `PUT /v1/settings` with an empty
  or short body answered 200 and reset everything: a stated plan reverted to
  "not stated", and the release-check opt-in switched itself off. The plan
  decides what every cost figure claims to be, and update checks are the only
  outbound call Caprock makes — neither may be toggled by omission. Settings are
  now a patch: a body changes what it names and nothing else.

- **Tasks were silently lost when created together.** Ids were minted from the
  millisecond alone, so twelve tasks added at once produced four and eight
  "already exists" rejections. All twelve now succeed.

- **The tasks endpoint accepted tasks nobody could use** — no title, a
  hundred-thousand-character title, a negative budget, or `1e308`. Each is now
  refused with a reason.

- **An unknown API path answered 200 with a web page.** The dashboard is served
  from `/`, so anything unmatched fell through to it — a caller that mistyped an
  endpoint got a success and HTML, then failed elsewhere parsing it as JSON.
  Unmatched `/v1/` paths return 404 with a JSON body; the dashboard's own deep
  links still work.

- **`?days=` out of range returned the wrong total.** Asking `/v1/stats/daily`
  for everything clamped to the default of 30 days rather than the ceiling, so
  the answer was a month with nothing to indicate truncation. On a real database
  that disagreed with the summary endpoint by $1,603.

- **A query that stopped early passed for a complete one.** Three loops ignored
  the error a partial scan reports, so a cancelled or failed read returned what
  it managed to fetch as though it were everything — twice followed by an update
  that changed every matching row.

- **"Files touched" is labelled honestly.** It sums distinct files per session,
  so a file edited in three sessions counts three times; the tile says so
  instead of letting the number pass for a count of distinct files.

### Changed

- Test coverage of `internal/` is 80.4%, with the packages where a bug reaches
  the user's own machine — the hook shim and the process manager — covered
  first. Two real defects surfaced there: a data race closing a PTY, and a
  clean exit reported as an error. See `.ai/13-testing.md`.

## [0.9.8] - 2026-08-20

### Changed

- **Every cost figure now says what it is.** Shown to five readers, three took
  a large dollar number for a bill. The explanation existed on one screen and
  nowhere else — History said `API-equivalent`, which is internal jargon, and
  Cost and Session said nothing at all beside the number.

  The wording follows your stated plan, because there is no single honest
  sentence: on Pro/Max/Team it is what the same work would have cost through
  the API and is explicitly **not a bill**; on API/Bedrock/Vertex it **is**
  approximately your bill, and calling it an equivalent would be the same
  error reversed; with no plan set it names the basis and claims nothing more.

- **The dashboard has a visual hierarchy.** Cost leads at the size the number
  deserves; reference figures step down. Previously the money sat fourth of
  six at the same size as a turn counter.

- **Percentages round down.** A 99.5% cache hit shown as `100%` is a perfect
  score the data does not support.

- **Cache hit is no longer permanently green.** It sits near 99% forever, so
  an always-on colour pointed attention away from the money. It speaks up
  below 90%, where a drop means something broke.

### Added

- **An attention row for sessions with many turns and few files.** Every other
  rule skips ended sessions, so this shape had no surface at all. It is worded
  as the measurement, not a verdict — reading, investigating and designing all
  look like this from the outside, and only the person who was there can tell
  them from a session that went nowhere.

- **Note search matches the prompt that produced an answer**, not only the
  answer's own text — so searching your own words finds what Claude replied.

### Fixed

- **The live indicator stopped updating while nothing was happening.** It
  computed the age of the last frame only when a frame arrived, and on an idle
  machine no frame arrives by definition — so it froze at `live · now` and
  kept claiming that for hours. A stale liveness indicator is worse than none,
  because it is the one people trust.

- Cost subtitles no longer truncate on the Cost and Session screens.

## [0.9.7] - 2026-08-20

### Added

- **The Claude desktop app's plan usage, on the status screen.** If you also
  use the desktop app for work that never touches a repo, one line now says how
  much of your plan went there: `8% of the 5-hour window · 5% of the 7-day`.

  It reports percentages and nothing else, because that is all the app records
  — there are no tokens, no cost and no conversation content in what it writes,
  so this cannot say what the desktop app *cost*, only how much of a window it
  consumed. It is also written only while the app is running, so the reading
  carries its age and says the app has been closed since rather than passing an
  old figure off as current. Nothing is stored, nothing is polled, and the line
  is simply absent if you do not use the app.

## [0.9.6] - 2026-08-20

### Changed

- **The dashboard is three to ten times faster on a large history.** Measured on
  a real 184,000-event database:

|                    | before | after  |
| ------------------ | ------ | ------ |
| Session list       | 240 ms | 23 ms  |
| Answers            | 156 ms | 2 ms   |
| Cost (all time)    | 818 ms | 230 ms |
| History (all time) | 828 ms | 340 ms |

  Every screen filtered events by kind and then by time, but only time was
  indexed — so each query read the whole range and threw away roughly 70% of
  it. Four indexes now match how the data is actually read, and two totals that
  summed conditional expressions (which no index can help) group by kind
  instead. Existing databases are upgraded on first start; nothing is lost and
  no re-import is needed.

- **Panels show placeholders while loading** instead of announcing "No history
  yet" and then replacing it with real numbers. An empty state now means the
  answer really is empty.

  Search deliberately still scans rather than using a word index: people search
  their own sessions for fragments — half an error message, part of a path —
  and a faster search that silently misses them would be a different feature.

## [0.9.5] - 2026-08-20

### Added

- **The running version is in the header.** "Which build am I on?" was a
  question you had to open the status page to answer. When release checks are
  on and a newer version exists, the chip shows `v0.9.0 → v0.9.4` and links to
  the details. A build from source says "dev build" rather than showing a
  `git describe` string, and is never told it is out of date — it is not a
  published release, so there is nothing to upgrade to.

## [0.9.4] - 2026-08-20

### Fixed

- **A session that looped twice showed two identical banners** — same tool,
  same count, same cost — which reads as a rendering fault and makes the
  attention strip look untrustworthy. There is now one banner per session,
  showing the most recent alert.
- **The Tasks screen explained itself in terms of our internal build phases.**
  "Phase 2 runs when..." means nothing to anyone outside the repo; it now says
  what to do.
- **The favicon and the in-app logo were different marks.** Same colour,
  different shape, so a browser tab did not read as the product it belongs to.
  Both are now the triangle from the header, on the site as well.

## [0.9.3] - 2026-08-20

### Changed

- **The README and agent docs now describe what the product actually is.** They
  still listed the screens as they stood several releases ago, and never
  mentioned two of the most useful things in it: per-repository cost on the
  landing screen, and Answers — the prose Claude wrote, searchable across every
  session. Nothing in the software changed; the descriptions caught up.

## [0.9.2] - 2026-08-20

Found by running the daemon against hostile input and rendering the dashboard
with malformed data, rather than by reading the code.

### Fixed

- **One bad timestamp could make every session invisible, permanently.** A
  transcript line stamped in the year 9999 rolls past year 10000 in any
  positive UTC offset, and Go refuses to serialize that — which aborts the
  encoding of the whole list it appears in. The API then returned HTTP 200 with
  an empty body, so the dashboard showed no sessions at all while the database
  held them, with nothing in the logs. Because the event persists, restarting
  did not help. Fixed at all three layers: responses are serialized before the
  status code is sent so a failure is an honest error, impossible timestamps are
  rejected on the way in, and negative token counts are clamped.
- **A malformed live event could silently freeze the dashboard.** A tool call
  is arbitrary JSON, and one with an unexpected shape threw inside the
  WebSocket handler — outside React, where no error boundary can catch it. That
  stopped every later update, so the page sat on stale numbers showing no
  error. Leaf values are now coerced and one failing listener can no longer
  starve the others.
- **A single missing daily cost blanked the whole 30-day chart** rather than
  one bar, while the header still showed a total.
- **Figures that read as broken:** an empty range rendered "NaNh NaNm" in the
  Avg session tile; ratios could print "$∞" or "Infinity%"; the plan progress
  bar overflowed its card when a session reported more steps done than planned;
  the loop banner could say "ran the same call undefined× in undefined min".
- **"Active sessions" was wildly inflated during a first run.** A session is
  marked active on its first event and reaped later, so a backfill counted every
  historical session at once — a new user's first impression was a count in the
  dozens that then fell to one. It is now bounded to the last 30 minutes.
- **The Answers tab and search could crash** on a note with no text, and the Now
  screen could crash on a session missing its stats or activity.
- **A range like `90d` silently meant "today"**, so a longer range reported
  fewer sessions than a shorter one. Any `<n>d` range now works. The dashboard
  was never affected — it only offers the four presets.

### Internal

- **The release gate could not see a stale dashboard.** The built UI is
  committed to the repository so `go install` works without Node, and a check
  existed to catch it drifting from the source — but it was never wired into
  `make check`, and it used `git diff`, which does not notice new files. Since
  a rebuild emits a new filename, it reported a clean tree while an old bundle
  sat committed beside it. Caught one commit before tagging this release, which
  would otherwise have shipped a dashboard missing every UI fix listed above.

## [0.9.1] - 2026-08-20

A sweep for bugs of one particular kind: things that look informative but
mislead, and things that look interactive but aren't. Every figure below was
checked against real data rather than reasoned from the code.

### Fixed

- **Numbers that lied.** History's "files touched" ignored the selected range,
  showing the lifetime total under a "today" heading beside five stats that did
  move with it. "Avg session" reported 32h 59m — it measures first-event to
  last-event, so a session left open overnight counted its sleeping hours; it
  is now labelled "Avg session span · first to last event". The plan-value
  multiple divided all-time usage by a 30-day fee on the "all" range while the
  caption claimed 30 days. The bar readout announced "0 sessions" next to a
  $257 day. A session's token subtitle broke out input and output while the
  total is 99% cache reads.
- **Asking for more data returned less.** `SessionNotes`, `SearchNotes` and
  `EventsAfter` fell back to a small default when asked for more than their
  ceiling — `notes?limit=5001` returned 200 rows where `limit=5000` returned
  2372. All now clamp.
- **Stale plan limits presented as facts.** Values relayed by the status line
  were stored unchecked, so a five-hour window could claim it resets in 2030.
  Implausible samples are rejected, and a window whose reset has passed is
  marked stale rather than rendered as a clock.
- **Active days were counted in UTC** while the daily chart uses local time —
  "21 active days" beside a 31-bar chart.
- **Content you could not reach.** The session timeline showed only the newest
  events with no way back, so a long session opened as a peephole onto its last
  few seconds; there is now a "load earlier events" control. Tool output — a
  failing test tail, a stack trace — was a 160-character stub whose only escape
  was raw JSON, and now renders as text. The Files tab capped at 100 while the
  stat above said 132, with nothing admitting the list was cut.
- **Controls that led nowhere.** The spawn dialog was never rendered anywhere,
  though the Terminal tab told you to use it — so no session could ever be
  owned. It is now on Now. The settings screen offered nothing to set. The
  Tasks empty state explained itself in terms of our internal build phases.
- **Correctness and races.** Starting the orchestrator and running
  verification used the HTTP request's lifetime, so a browser disconnect could
  leave a real `claude` process running with nothing recording that Caprock
  owned it, and could kill a five-minute verification mid-run. Configuration
  was read without the lock that guards it while the settings endpoint writes
  it. Two more places sliced UTF-8 by byte, the same fault fixed in the parser
  last release — activity phrases and loop samples could render as mojibake.

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
