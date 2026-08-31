# Changelog

All notable changes to Caprock. Format: [Keep a Changelog](https://keepachangelog.com/).
Versions map to the roadmap phases in `.ai/09-execution-plan.md`: **v0.1.0** = Observe,
**v0.2.0** = Control, **v0.3.0** = Orchestrate. **v0.4.x**/**v0.5.0** are post-Orchestrate
polish (plan-limit windows, orchestrator-lifecycle fixes, Homebrew formula, first-run UX).

## [Unreleased]

Phase 3 (Delight) has no plan by design.

## [0.40.0] - 2026-08-31

### Fixed

- **A session now ends when it ends, instead of half a day later.** The Now
  screen counted a whole day's finished sessions as live — "14 sessions, 0
  active" — and the live pulse drew a row per known session, so a day in one
  repository became six identical `caprock` rows over six flat hairlines.

  Nothing consumed `SessionEnd`. The shim never registered it, so the only
  path to `ended` was the 12-hour staleness sweep. Caprock now registers the
  hook and ends the session on it, and the sweep drops to **an hour** as the
  backstop it should always have been: the case where the hook never fired —
  `kill -9`, a closed terminal, a dead host. Ending early is cheap, because
  it is not a tombstone — a later event on the same session revives it.

  Upgrading registers the new hook on the next `caprock up`; nothing to do by
  hand.

- **Upgrading Caprock no longer kills the work it was watching.** Restarting
  the daemon — which every upgrade does — sent `SIGKILL` to every session
  Caprock had spawned. They died mid-turn, with no warning and nothing
  flushed: a tool that watches your work should not be the thing that eats
  it. Sessions are now asked to stop, waited on for five seconds so Claude
  Code can write out its transcript, and only then killed if they refuse. The
  upgrade banner also says how many sessions will close before you copy the
  command; sessions you started yourself are untouched, as always.

### Changed

- **The live pulse shows only tracks that ran.** Ended sessions are dropped,
  and so is any track with no events in the window — an hour of flat hairline
  says only that a session exists, and several of them read as a broken chart
  rather than as silence. When nothing ran in the last hour, the panel says
  that in one line.

- **A pulse row shows what its hour cost, not the session's lifetime.** A
  long-running session printed `$4,053.39` beside an hour of bars and a
  `$101.85` day: two true numbers answering different questions, side by side.
  The row now sums the window the bars cover, with the lifetime on hover.

- **The new-session dialog answers its own questions.** Model and permission
  mode both opened on an empty "default" that said nothing about what was
  about to run — and "default" is not a permission mode Claude Code accepts
  at all, so the dialog could send the binary a value it rejects. They now
  start on Opus 5 and "accept edits, asks before commands", with each option
  labelled by what it does rather than by its flag name. The worktree field
  and "create the directory" moved under Advanced, and the paragraph
  advertising OpenCode support left the dialog: every field on screen is a
  decision asked of someone who wanted to press one button.

- **The session timeline reads newest-first.** It was the only list in Caprock
  ordered the other way, so the same glance meant two different things on two
  screens — you arrive at a timeline wanting the last thing that happened, not
  the first. The `follow` checkbox and its autoscroll are gone with it: new
  rows arrive at the top now, so there is nothing to chase. History stays
  behind "load earlier events" rather than being rendered up front, and each
  click now pages back from the oldest row on screen — it used to refetch the
  first thousand events of the session and discard nearly all of them, which
  on a sixteen-thousand-event session fetched the wrong end of the history.

- **"Live diff" and "Files" are one Changes tab.** They answered one question
  between them — what did this session change — so reading it meant visiting
  both tabs and holding two lists in your head, and on most sessions
  "Files (0)" was empty besides. Files now expand independently rather than
  one at a time (the old accordion closed the first file when you opened the
  second, so two changes could never be compared), with a caret per row and
  expand/collapse all for reading a whole branch. Files touched but unchanged
  keep their own panel underneath. Old `?tab=diff` and `?tab=files` links
  still work.

- **The live diff measures a branch from where it forked.** The base was
  always HEAD, which answers "what have I not committed yet" — so a branch
  whose work was committed showed *no changes at all* while the session had
  rewritten dozens of files. It is now the merge base with master/main: the
  branch's own commits plus whatever is uncommitted. The panel names its base
  ("since master") beside the file count. Untracked files show their contents
  as added lines instead of "no diff against HEAD".

- **The Projects list holds its order while you point at it.** Rows are ranked
  by spend and refresh every 30 seconds, so a row could swap places between
  aiming and clicking and open a repository you never pointed at. The values
  keep updating live; only the sequence holds still, and only while the
  pointer is inside the panel.

- **Pulse rows are told apart by branch and session id.** Working all day in
  one repository drew rows labelled `caprock`, `caprock`, `caprock`, most of
  them subtitled `was responding`. The branch and a short id are what actually
  differ, so they are what the row leads with.

## [0.39.2] - 2026-08-31

### Fixed

- **Shift+Enter really does insert a newline now.** 0.39.1 sent the right
  bytes and still submitted, because the bytes were only half of it: returning
  `false` from the key handler stops xterm *interpreting* the key, but the
  browser still delivers it to xterm's hidden textarea, which emits its own
  carriage return. The socket carried `ESC CR` and then a bare `CR`
  immediately after — `[27,13]` followed by `[13]` — and Claude Code submitted
  on the second one.

  The keys now call `preventDefault`, so the textarea never sees them. Four
  attempts at this bug and the first three were all arguments about which
  sequence to send; nothing was watching what else went down the wire
  afterwards.

## [0.39.1] - 2026-08-31

### Fixed

- **Shift+Enter typed `\n` into the prompt and sent the message.** The newline
  keys sent two printable characters — a backslash and the letter n — so a
  message arrived as `first line\n` and the multi-line prompt was unusable.
  They now send `ESC CR`, which is Alt+Enter as a terminal encodes it and what
  Claude Code's own macOS instructions bind Option+Enter to.

  **Three earlier answers were wrong, and two of them shipped.** CSI u needs
  the kitty keyboard protocol negotiated, which we never do. `5c 6e` came from
  reading the binding `/terminal-setup` writes into iTerm2 — but Send Text
  *interprets* that escape, so iTerm2 puts one byte on the wire rather than
  two characters. A bare line feed looked correct against an **empty** prompt
  and submits the moment anything is typed, which is the symptom that was
  reported in the first place.

  Testing on an empty prompt is what made two wrong answers look right. The
  sequence is now verified by sending candidate bytes to a running Claude Code
  with text already typed, and the tests assert the bytes rather than the
  reasoning.

## [0.39.0] - 2026-08-31

### Added

- **The daily spend cap — the first thing Caprock does rather than shows.**
  Everything else here is observation: you look and you learn something. A cap
  acts while you are asleep, which is when a runaway loop does its damage. Set
  a number for the day; when the day crosses it, the sessions Caprock started
  are paused.

  Four rules, each covered by a test that was verified by breaking it:

  - **Only sessions Caprock started.** One from your own terminal is watched
    and never signalled, however much it costs — [rule 7](CLAUDE.md), enforced
    inside the thing holding the process handles rather than by whoever calls
    it, so the cap cannot violate it even by mistake.
  - **Paused, not killed.** The conversation, the directory and the context
    survive; resume and the session carries on. Killing would throw away work
    already paid for, which is a strange thing for a tool that exists to stop
    waste.
  - **Once a day.** A session you resume by hand must not be re-paused seconds
    later, and two turns crossing the threshold together must not both fire.
  - **Fails open.** If the spend cannot be read, nothing is paused: a missed
    pause costs money, a spurious one stops work that was fine, and the second
    is the one nobody forgives.

  **The suggested limit comes from your own history** — twice your median day,
  rounded. The median rather than the mean, because one runaway day would drag
  an average up and produce a ceiling that never fires, which is exactly the day
  the feature exists for. It is offered as a click, never prefilled: a number
  that appears in the field on its own is a number nobody chose, and this one
  stops work.

## [0.38.1] - 2026-08-30

### Fixed

- **The folder picker ran past the edge of its dialog.** A long path — the ones
  under `~/Library/Application Support` are the worst — made the list 738px
  wide inside a 520px panel, so rows spilled over the border. A grid item does
  not shrink below its own content unless told to, so no amount of clipping
  inside the picker could fix it: the containers above it had to be allowed to
  be narrower than what they hold. Paths now truncate with the full one on
  hover.

- **The picker looked like a different surface from the field above it.** It
  sat on a transparent background with the lighter border, directly beneath an
  input that had neither, and the two read as two panels at different
  opacities. It now matches the input exactly.

## [0.38.0] - 2026-08-30

### Added

- **Pick a folder instead of typing its path.** Starting a session meant typing
  an absolute path from memory into a dashboard that is already showing the
  repositories you work in every day.

  Two lists, in the order they are useful. **Recent** is where sessions have
  already run, newest first — for most people that is the whole picker, since
  the next session is almost always in a repository you were in yesterday.
  **Browse** walks down from one root for the first session in a new project;
  repositories are marked and sorted first, because a repository is what you
  are looking for and everything else is the route to it.

  The text field stays: it is the fastest input for anyone who knows the path,
  it is what a paste goes into, and the lists write into it rather than
  replacing it, so what will actually be used stays visible and editable.

  **The root is yours to set** — `browse_root`, defaulting to your home
  directory. It is a setting because "where I keep my code" is personal, and
  because the narrower it is, the less the daemon's directory listing can be
  asked for.

  Browsing is the only thing in Caprock that reads the filesystem for a web
  page, so the boundary is the feature: directories and names only, never
  contents; symlinks resolved **before** the containment check, so a link
  inside the root pointing out of it does not slip through; dotfile directories
  never listed; and "outside the root" and "does not exist" answering with the
  identical 404, so it cannot be used to test whether a path exists. Each of
  those is covered by a test that was verified by breaking it.

## [0.37.5] - 2026-08-30

### Fixed

- **The button on a session Caprock did not start now says what it does.**
  "Start one here" named an action and left *one* undefined — a reader could
  reasonably expect it to attach to, restart, or take over the session in front
  of them. It does none of those.

  It reads **"Launch a new Claude Code session here"**, and the line under it
  states the two things a reader needs before clicking: it runs a second
  `claude` in the directory shown, and **the session already running is left
  untouched**. Anything that starts a program and disturbs nothing has to say
  both halves, and the path is on screen so it can be checked before the click
  rather than after.

## [0.37.4] - 2026-08-30

### Fixed

- **"Start a session in Caprock" now starts a session.** It was a link to the
  main screen — navigation dressed as an offer, which moved the reader away
  from what they were doing and left them to find the real button themselves.
  It opens the New session dialog in place, **already pointed at the repository
  on screen**, so the one thing it promises takes one click. Asking for a
  working directory on a screen that is displaying it was asking someone to
  retype what they were looking at.

## [0.37.3] - 2026-08-30

### Fixed

- **The terminal panel on a session you started yourself now says what to do.**
  It opened with *"This is an externally started session — Caprock observes it
  but never writes into a terminal it does not own"*: accurate, and written for
  the people who built it. A reader saw a wall of text where a terminal should
  be and could not tell what was being asked of them, or whether they had done
  something wrong.

  Nothing is the reader's fault and nothing needs fixing — there is one button
  that produces a terminal, so that button is the message. The rule is still
  stated, in one line underneath, where it belongs.

## [0.37.2] - 2026-08-30

### Fixed

- **Buying takes one click.** The header chip opened the dialog and nothing
  else, so someone who had already decided still had to read a screen and then
  find a price. It is now the price itself — `premium $30/yr`, straight to the
  checkout — with a separate chevron for anyone who wants the explanation
  first. People who are ready should not be routed through a pitch.

- **The locked preview really is legible now.** Raising its opacity in 0.37.1
  changed nothing visible, because a full-panel scrim was laid over the top of
  it: the content was brighter underneath and the sheet dimmed it straight
  back. The scrim is gone; the caption and the button carry their own backing
  instead, so the panel behind them can be read.

- **A missing plan no longer takes the header down.** The chip read `.url` off
  the yearly plan without checking it was there — an older daemon, or any
  response without it, crashed every screen rather than hiding one chip.

## [0.37.1] - 2026-08-30

### Fixed

- **There was no way to buy from the main screen.** The only entry points to
  paying were the two panels behind glass, on Cost and on Lifetime — so the
  screen where people actually sit offered no path at all. `premium` now sits
  in the header on every screen: the one element there that is not amber, so
  the eye finds it when it is looking for the thing about money and not
  otherwise. It stops selling once a licence is active.

- **The locked preview was unreadable.** At `opacity-35` it was the worst of
  both — occupying the space of a demonstration while demonstrating nothing,
  so a reader could see that *something* was under the glass but not what. It
  is now legible through it, and the caption, which is the sales line on that
  panel, is larger than the body text it sits over rather than smaller.

## [0.37.0] - 2026-08-30

### Changed

- **The premium dialog, after five readers were asked to buy from it and none
  did.** Not one of them named the price — three said $30 was nothing to them.
  The verdict was the same sentence in five voices: *"I am paying for delivery
  of something I already see for free."*

  - **Both prices now say what they cover.** "$100 forever" was the most-asked
    question on the screen — forever *what*, this one feature or everything
    Premium ever gains? Two readers said they would have bought had it been
    answered.
  - **The Claude Pro comparison is gone.** Four of five said it argued against
    us: it made $100 read as five months of a tool they cannot work without,
    and invited "yours sends a message, theirs writes the code".
  - **The Telegram bot is named as a cost, not a feature.** "Through your own
    bot" was called the most alarming line on the screen while it sat among the
    benefits. It now says: one message to BotFather, about two minutes.
  - **"Everything Caprock does today stays free"** read as lawyered — free now,
    unspecified later. It says "now", and that Premium only ever adds.

  **And the report itself is sold on what changed, not on what happened** — the
  repository that cost 3× its usual week, this week against last. A digest of
  figures the dashboard already shows is a notification; what moved is what a
  week of data can say and a live screen cannot. That is a promise about what
  gets built, and it is written into `.ai/03-contracts.md` so the feature
  cannot quietly ship as a digest.

## [0.36.1] - 2026-08-30

### Changed

- **The premium dialog says the same thing in half the words.** The paragraph
  above the bullets repeated what the bullets said, and the footer explained
  the licence twice.

- **Both prices are buttons now, and the lifetime one is brighter.** An
  outlined second button reads as the lesser option, which is backwards:
  someone weighing the year should see the lifetime as the step up from it. Two
  filled buttons of ascending brightness make that legible without a word of
  copy.

- **The comparison moved under the buttons, one line each.** It was a two-row
  table above them — "Claude Pro $20/month" over "Caprock Premium $2.50/month"
  — two unrelated numbers standing where a price belonged. Each button now
  carries what it is worth in the plan the reader already pays for: about six
  weeks of Claude Pro for the year, about five months for the lifetime.

## [0.36.0] - 2026-08-30

### Changed

- **Premium is ultramarine now.** Every interactive element in this product is
  the brand amber, which left a subscribe button looking exactly like a range
  filter. Paid is a different kind of thing, so it gets a different hue —
  deliberately cool against a warm interface. Reserved strictly for surfaces
  where money is involved; an ultramarine that spread to ordinary controls
  would just be a second accent, and then nothing would be marked.

- **The premium dialog offers a year or a lifetime, and not a month.** At $5
  the monthly plan is the cheapest way to hold a licence key for a month, which
  is a worse deal for the buyer than either commitment beside it. It remains on
  the site for anyone who seeks it out.

- **The weekly report shows what would arrive, not a description of it.** It
  was three rows reading "Sent / To / Contains", which describes an email
  without showing one — and behind glass that is a blurred settings screen. It
  now previews the message itself, with this machine's own repository names in
  it. Deliberately without figures: those are already free two panels down, and
  locking them would take something away rather than preview something new.

### Added

- **winget.** `winget install dspv.caprock`, once Microsoft has merged the
  manifest for a release — the package manager already present on every Windows
  10 and 11 machine, with no bucket to add first. Deferred until there was
  Windows demand ([ADR-014](.ai/08-decisions.md)); the first Windows user to
  build from source asked for it by name.

  Unlike the Homebrew tap and the Scoop bucket, that repository is not ours:
  Microsoft reviews and merges every manifest, so a release reaches winget
  hours or days after it reaches everywhere else. That lag is the channel, not
  a fault to fix.

### Fixed

- **`make build` works on Windows.** It did not, and the very first command in
  `CONTRIBUTING.md` failed on a fresh Windows clone: make with no `sh` on PATH
  falls back to cmd.exe, which understands none of `mkdir -p`, `[ -d ]`,
  single-quoted `-ldflags`, or `2>/dev/null`. It now uses the Bash that Git for
  Windows already installs.

  **The Windows CI job was green throughout** — because CI never ran `make`. It
  invokes `go build` and `go test` directly, so every badge said the repository
  worked on Windows while its documented first step did not. A green matrix is
  not the same as a working repository, so this ships with a CI job that runs
  `make build` on Windows and checks the binaries exist.

## [0.35.1] - 2026-08-30

### Changed

- **The main screen's heaviest request went from 0.61s to 0.001s.** `/v1/history`
  answers "everything, ever" — four aggregates over the whole events table —
  and **five components on that one screen ask for it on their own timers**:
  the lifetime strip, the breakdown panel, the share card, the share nudge, and
  the screen itself. A single open tab produced bursts of identical requests
  and each one was computed from scratch.

  Requests for the same range that arrive while one is already running now wait
  for it and share its result, and a settled result is reused for three seconds
  — shorter than the fastest poller, so nothing on screen is visibly behind.
  Errors are never cached, and a caller hanging up no longer takes the answer
  away from the callers waiting behind it.

  Two smaller fixes found by the same measurements: the session count is
  grouped rather than `COUNT(DISTINCT)`, which runs off a covering index
  instead of sorting every row into a temp B-tree (0.14s → 0.02s at
  `range=all`, no slower at any other range); and idle database connections are
  kept rather than reaped after five minutes. Each connection carries its own
  page cache, and a fresh one is cold — the same query measured 378ms on a
  connection's first use and 26ms on its second.

## [0.35.0] - 2026-08-30

### Added

- **Prices can now carry the dates they applied, and a turn is costed at the
  price it actually ran under.** Sonnet 5 launched at an introductory $2/$10
  and reverts to $3/$15 on 2026-08-31. With one row per model the only way to
  record that is to overwrite the figure — which would have silently restated
  every August turn at a price nobody was charged, growing a month's reported
  spend by half overnight. That is rule 6's "no invented numbers" pointed at
  our own history.

  A superseded price now keeps its own row with `until` (the last date it
  applied, inclusive, UTC), the current price is the row with no `until`, and
  each turn is priced by the row in force at its timestamp. Tests cover all
  four boundaries and were verified by breaking them.

- **The size of the spend on the main screen, not only how it divides.** Each
  model row carries its token count beside its cost, and the panel gained an
  input / output / cache read / cache write line. A share says how the money
  split and nothing about how much there was: "opus-5, 54%" reads the same at
  forty dollars and at four thousand. Output costs five times input, so the
  ratio is the explanation of the bill, and it was a screen away on Cost.

## [0.34.1] - 2026-08-30

### Changed

- **The premium dialog no longer disclaims its own product.** It carried a
  line reading *"Not built yet"* directly above the price, which is a sales
  screen arguing against itself: the features are being built, the commitment
  is real, and hedging it sells nothing while protecting nobody.

  **What protects the buyer is the refund term, not a line of grey text.** The
  [terms](https://caprock.dev/terms/) already say that a feature described as
  being built and then abandoned is refunded for the period paid — a promise
  that costs us money, where a caveat costs us nothing. That is where the
  qualification belongs.

  A test now asserts the hedge stays off the screen, and it was verified by
  putting one back.

## [0.34.0] - 2026-08-29

### Changed

- **The premium dialog now measures its price against a Claude subscription.**
  Every statement on it was true and the screen still argued against itself:
  the loudest element was a bordered box reading *"Not built yet"*, so the
  first thing the eye landed on was a reason not to buy. Three prices sat where
  a decision belonged, and Subscribe was styled as one of three equal buttons.

  The order is now what the feature does, then what it costs against what you
  already pay, then the caveats. **$30 is neither cheap nor dear on its own** —
  the one price every reader of that dialog is already paying is a Claude
  subscription, so a year of Caprock is stated against a month and a half of
  Claude Pro. The comparison carries its source and the date it was read, on
  screen, because [rule 6](CLAUDE.md) applies to other people's prices too,
  and it says outright that the two are different things: one buys the model,
  one shows you what it did.

  Two buy buttons rather than one — **$30 a year** and **$100 once** — because
  those are the two real decisions, and the lifetime option was previously
  reachable only by leaving the dashboard for the site. $5 monthly stays as a
  line beneath them. The unbuilt notice stays too, under the buttons as a
  condition of the sale rather than as the headline.

  The compared figure lives in `internal/premium` beside our own, and the
  drift test that reads the site's pricing now reads its `facts.ts` as well,
  failing when either the price or the date it was read disagrees.

## [0.33.0] - 2026-08-28

### Added

- **Copy and paste in the terminal.** There was none: every key went to the
  process, so Ctrl+C was always SIGINT and nothing could be copied off the
  screen. It now follows VS Code's rule, which is the one people already have
  in their fingers — **Ctrl+C copies when something is selected and interrupts
  when nothing is.** On macOS the question never arises, since Cmd+C and
  Ctrl+C are different keys. Ctrl+Shift+C/V elsewhere.

  A paste goes through the terminal rather than straight to the socket, so
  bracketed paste applies and a multi-line paste arrives as one paste rather
  than as several submitted lines.

- **WebGL rendering, with a fallback to canvas.** The canvas renderer repaints
  the whole grid; WebGL draws from a texture atlas, which is the difference
  between a build log scrolling smoothly and the tab stuttering. A machine
  without WebGL, a driver that refuses, and a GPU context lost on sleep all
  fall back rather than failing — a slower terminal is a cost, a blank one is
  a broken product.

- **Paste or drop a file into the terminal.** A browser hands over an image's
  bytes and never a path — there is no path for something copied out of a
  screenshot tool — while Claude Code reads files by path. The bytes now go to
  the daemon, which writes them into its own data directory, and the path is
  typed into the session so Claude can read the file.

  The bytes travel base64 inside JSON rather than as a raw upload, and that is
  the security design rather than an inconvenience: `image/png` is a *simple*
  content type, so a raw endpoint would have been reachable by any page in the
  browser without a preflight. Types are an allow-list, the cap is 10 MB, and
  the filename is generated entirely by the daemon — nothing a caller sends
  reaches the filesystem.

- **Scrollback is 10,000 lines**, up from 5,000. A build log passes five
  thousand easily, and losing the start of what you are reading is where a
  terminal stops being one you can work in.

## [0.32.1] - 2026-08-28

### Fixed

- **The terminal now tells the daemon how big it is.** `fit()` resized the
  canvas and nothing else, so the PTY kept whatever size it was created with —
  120×40 by default — for its whole life. Claude Code lays its menus out to the
  terminal size, so on any other window it drew an interface for a screen that
  was not there: arrow keys moved a selection nobody could see, which is what
  the first user reported as *"only Enter works"*.

  The socket now carries two things, told apart by frame type: **binary** is
  what you typed, written byte for byte, and **text** is a control message —
  today only `{"resize":{"cols":N,"rows":N}}`. A text frame that is not valid
  control JSON is still written through as input, so an older dashboard
  against a newer daemon keeps typing rather than going mute.

  Keystroke passthrough itself was never the problem: `term.onData` has always
  sent every key straight to the PTY. The diagnosis in the milestone note
  turned out to be wrong, and checking it before building was what found the
  real cause.

- **Shift+Enter inserts a newline again, on a prompt with text in it.** It has
  been wrong twice, and the second one is the interesting failure: a bare line
  feed (`0x0A`) is what Ctrl+J sends and what the documentation says works
  everywhere — but Claude Code reads a lone line feed as *submit*. On an empty
  prompt that looks like a newline, because there is nothing to submit; the
  moment the prompt has text, the same key sends the message. That is exactly
  what the user reported.

  The fix came from reading a terminal that works rather than reasoning about
  the protocol: `/terminal-setup` writes a binding into iTerm2, and that
  binding is on disk — Send Text, two bytes, `5c 6e`. Claude Code sees the
  backslash before the line ends and turns the pair into a newline. All four
  keys now send it.

  (The first wrong guess was CSI u, `ESC [ 13 ; 2 u`, which a terminal only
  sends after negotiating the kitty keyboard protocol — a negotiation this
  terminal never performs, so it did nothing at all.)

## [0.32.0] - 2026-08-28

### Added

- **The cache hit rate now says what it means.** It was a bare percentage,
  amber below 90% and identical above — so 99% and 91% read the same and
  neither said anything, on a figure that runs from 6% to 99.6% across real
  sessions. One word sits beside it: outstanding at 99%+, good from 95, ok
  from 85, low below. The bands are set against the observed spread rather
  than picked for roundness, so *outstanding* lands on about one session in
  nine and is worth reading.

  It describes a state, not a performance — the cache is Claude Code's doing
  and Caprock only reads it — and `low` is a fact rather than a verdict: a
  short session has little to reuse. Nothing animates; this dashboard sits
  open all day, and motion here means live data and nothing else.

### Added

- **The share card asks the reader what theirs is.** It carried a figure and a
  domain and stopped there — someone seeing another person's total had no
  reason to think it was a thing they could do too. A question, not an install
  line: a command on a picture is an advertisement and reads as one, and the
  domain in the heading is where a person who wonders goes to find out.

### Fixed

- **Dismissing a banner recorded the wrong time.** The premium banner, the
  premium hint and the share nudge all stamped the dismissal with a fresh
  `Date.now()` while every other decision in them used the clock they were
  handed. The two disagreed by however long the render had been on screen —
  invisible in production, but it meant the test suite passed for a year and
  then began failing on the day the fixed test clock and the wall clock
  crossed, with nobody having touched the files. All three use the clock they
  are given, and the boundary is now tested to the millisecond.

## [0.31.3] - 2026-08-27

### Fixed

- **Every way of asking for a newline now works in the web terminal.** This
  shipped supporting Shift+Enter alone, and the first user to want a second
  line reported back that Option+Enter was the one he pressed — which is what
  Claude Code's own macOS documentation tells people to enable. Claude Code
  accepts four ways of asking for a newline and a person reaches for whichever
  one they learned elsewhere, so all four are handled, each sending exactly
  what Claude Code expects over the PTY: Shift+Enter sends CSI u, Option+Enter
  sends ESC then CR, Ctrl+Enter and Ctrl+J send a line feed, and backslash-Enter
  needs nothing from us.

  **Ctrl+J is the one that cannot fail** — a line feed works in every terminal
  with no configuration at all, which is why it is named in the hint.

### Added

- **A line under the terminal saying how to get a newline.** Shift+Enter had
  worked since v0.30.1 and the user who wanted it still could not find it: he
  pressed Enter, watched half a thought get submitted, and concluded multi-line
  prompts were not possible. A feature nobody can discover is not shipped.

## [0.31.2] - 2026-08-27

### Fixed

- **Homebrew reported "already installed" for a release that was already out.**
  A tap is not served by the Homebrew API: it is read from a local git clone
  that `brew upgrade` refreshes only through auto-update, which runs at most
  once every 24 hours. A user who ran any brew command earlier the same day was
  told `0.31.0 already installed` hours after 0.31.1 shipped — and the command
  Caprock itself had given them appeared to be broken. Every place that names
  the command now says `brew update && brew upgrade caprock`, with a test
  pinning the reason so it does not get "simplified" back.

- **Hovering "Save the image" now shows something.** It changed only its border
  colour — one step of grey against a dark panel — so pointing at it looked
  identical to not pointing at it. A control the eye cannot confirm it is on
  reads as disabled. It fills instead.

- **"Quick chat" and "+ New session" line up.** Quick chat sat inside a wrapper
  div next to a bare button, which made them two different boxes in the same
  flex row. The error message that wrapper existed for is positioned absolutely
  now, so a rare failure cannot change the height of the row.

### Added

- **The version chip tells you how to update, in steps.** It used to print one
  line — the command for however the daemon guessed this copy was installed —
  and stop, which answers only the first of three questions: run what, then
  what, and how do I know it worked. It now shows tabs for macOS, Linux and
  Windows with the routes each one has, the way this copy appears to be
  installed opened first, and three numbered steps with their own copy buttons:
  update, restart, check. The platform choice is remembered.

  When the daemon's answer and the browser's guess disagree — a `brew` command
  on a tab showing Scoop — the daemon wins. It read the binary's real path; the
  browser read a user-agent string.

- **"What's new" beside the version.** The published release's own notes, in a
  dialog, without leaving the dashboard. The text arrives with the version in
  `GET /v1/update` — the same GitHub response, so no extra request and no
  further exposure — and it is rendered as text, never parsed as markup.

### Changed

- **Release notes come from `CHANGELOG.md`, not from commit subjects.** The
  dashboard shows that text under "what's new", and a generated list of
  `1c836d5: fix(ui): …` lines is not something anyone reads. A version with no
  changelog section now fails the release build rather than shipping an empty
  "what's new".

- **The share dialog's guarantees are two bullets, not a paragraph.** A reader
  scanning for what does and does not leave their machine should not have to
  read a sentence to find out. Bigger type, one claim per line — and pinned by
  a test, because this is the copy that gets reworded whenever the dialog is
  tightened.

## [0.31.1] - 2026-08-27

### Fixed

- **Sharing the card produced two images; saving it produced one.** That split
  was the whole diagnosis — the download path draws once and writes one file,
  so the duplicate could only come from the native share, which handed the OS
  `{files, text}`. Two payloads leave the receiving app to decide what they
  mean, and macOS's Copy resolved it as two items. The card already carries
  every figure and its caveat, so the caption was never load-bearing; the file
  now travels alone.

- **A second way to get two cards, fixed in the same change.** One flag both
  labelled the share button "Drawing the card…" and disabled it. Clearing it
  early — so the label would stop lying while the OS share sheet sat open —
  also re-enabled the button underneath that sheet, and a second press drew a
  second card. Labelling and locking are now separate states.

### Added

- **The version chip is a button, and it tells you how to update.** It used to
  say a newer release existed and stop there, which answers the half of the
  question nobody needs help with. It now opens a dialog with the running
  version, what is published, a check-now, and the exact command for how this
  copy was installed — `brew upgrade caprock`, `go install …@latest`, or the
  release page for a downloaded binary — with a copy button.

  For a downloaded binary or a container, where no package manager owns the
  copy, there is no honest command to name — so the dialog says that and points
  at the release page rather than announcing a new version and falling silent.

  **Caprock does not update itself, and the dialog says so.** A daemon that
  overwrites its own running binary, as root on some install paths, is a worse
  thing to own than a stale version. Saying it once beats leaving someone
  hunting for a button that should not exist.

- **`make reload`** builds the dashboard and binaries, installs them over
  whatever copy is on `PATH`, and restarts the daemon. Testing a UI change
  against a running daemon took four commands and getting one wrong meant
  looking at a stale build and drawing conclusions from it.

### Changed

- **Plan limits moved into the Today row.** They had a full-width panel holding
  two percentages, three rows above the money, which made a reference figure
  look like a headline — and when both windows were stale, spent a band of the
  screen explaining that the figures beside it meant nothing. Now one cell
  beside burn, sessions and cache hit, leading with whichever window is closest
  to its limit, since that is the one that will stop the work.

- **The share button in the header is visible.** Grey 11px lowercase between
  "feedback" and the build label — invisible enough that the person who
  commissioned the feature could not find it on his own dashboard.

- **The premium banner says what the feature does.** It read "Premium stops a
  day that runs away from you, and alerts before a plan window does" — a
  metaphor for a mechanism, and the verdict on it was "непонятно". A banner has
  one line to name something the reader can picture, so it now says what the
  modal behind it goes on to explain: sessions pause when the day crosses a
  limit you set.

## [0.31.0] - 2026-08-27

### Changed

- **The share card looks like the dashboard, not like an advert.** What people
  post is a screenshot of the thing working; the old card was a poster with one
  enormous number on it. It now carries eight tiles — today, the week, the
  month, all time, the daily average, tokens, cost per million and the cache
  rate — over two breakdowns: where the money went by model and what it went on
  by kind of work, each with a percentage beside the figure.

  Three figures were deliberately dropped. The instantaneous burn rate read
  $7.33 one minute and $33.54 the next, and a card that lives in a feed for
  weeks must not carry a number that was true for ninety seconds. Turns and
  tool calls are counts of things nobody has a feel for; tokens sit next to the
  money and explain it. The session count was the same problem in another unit,
  and became cost per million tokens — the one figure that answers "dear or
  cheap" rather than "how much".

  The card is dated, and so is the file: saving two otherwise leaves you with
  `caprock.png` and `caprock (1).png`.

- **The share button can be found.** It was the word "share" in 11px grey in
  the header, between "feedback" and "status". It is now an accent-bordered
  button in the ALL TIME panel, beside the figures it offers to post, and it is
  always there — whether someone's numbers are worth posting is their call.

### Added

- **A nudge when there is something worth saying**, separate from the button.
  Three occasions, each reaching a different kind of user: a round number
  crossed, the first full week of data, and a week clear of every week before
  it. A record needs to beat the previous best by a fifth — while usage grows,
  "highest ever" is true nearly every week, and a prompt that fires every week
  is one people stop reading. At most once a week, dismissible.

### Fixed

- **Thin bars on the share card were drawn as hooks.** A corner radius wider
  than the bar itself: haiku at $0.59 is two pixels beside opus at $5,338, and
  3px rounding turned it into a squiggle.
- **The card had lost its caveat** while being rewritten. A dollar figure
  posted without "not a bill, and not money saved" reads as a bill somebody
  paid.
- **Model ids from a gateway carried a slash** — `minimax/minimax-m3` — which
  on an image about to be posted is indistinguishable from a repository path.

## [0.30.1] - 2026-08-27

### Fixed

- **Shift+Enter in the terminal, for prompts longer than one line.** A terminal
  cannot tell Shift+Enter from Enter — both are carriage return, ASCII 13, and
  have been since the teletype — so typing a numbered list submitted the first
  line and threw the rest away. Terminals that support multi-line prompts send
  CSI u instead (`ESC [ 13 ; 2 u`), which is what Claude Code listens for;
  xterm.js does not send it by default, so Caprock now does. Reported by the
  user who noticed it works in a normal terminal and not here.

## [0.30.0] - 2026-08-27

The release where the paid tier became something you can see, buy, and hand
over — and where one of its features was given away instead.

### Added

- **Paid features unlock from a licence key.** A string carrying its own
  expiry, pasted into settings, checked on the machine — no signature, no
  online validation, no machine binding ([ADR-022](.ai/08-decisions.md)). The
  binary is Apache-2.0, so any check is deletable in five minutes; what an
  offline check buys instead is that a paying customer's features cannot fail
  because of a plane, a proxy, or a server of ours being down. Seven days of
  grace after expiry, announced in words, because a late renewal is a bank's
  timing rather than a decision to stop paying.
- **`GET /v1/premium` reports the licence state** alongside what the plan
  costs, so every surface that mentions the paid version reads one answer.
- **A lifetime purchase**, $100 once. An ordinary key with a distant date
  rather than a "never expires" flag: a flag would need a second code path in
  the daemon, and the design is one path.
- **`caprock license`** — show, set, clear, and issue keys from the terminal.
  Issuing exists because the Stripe webhook was the only thing that could mint
  one, which left no way to serve a customer who paid another way, a refund
  reissued, or a friend. `license set` refuses a key that will not work rather
  than storing it and leaving someone to wonder why nothing happened.
- **Every paid feature is visible in the product**, in the place it will
  occupy, behind glass, with one click to paying. `Paywall.test.tsx` enforces
  the rule that makes this honest rather than hostile: a lock may only cover a
  feature that does not exist yet, and never a panel showing measured data.

### Changed

- **Third-party models are priced for everyone, and Premium lost a feature.**
  DeepSeek, MiniMax and OpenAI arrive through OpenCode as usage nobody could
  cost — $155 of the author's own spend sat outside his total. Adding the
  providers' published prices was cheaper than building a paywall around them,
  so `providers` is no longer a paid feature: charging for something the free
  version performs is how a paid tier becomes a hostage.

### Fixed

- **The unpriced warning fired on turns with nothing to price.** It tested for
  tokens being present rather than greater than zero, so turns recorded with
  explicit zeroes were reported as usage outside the total. The dashboard was
  telling users money was missing when none was.
- **The same model reported by two routes was two rows**, one unpriced:
  `minimax/minimax-m3` from OpenRouter and `MiniMax-M3` from the direct API.
  Gateway vendor prefixes are stripped.
- **A quick chat was labelled `2026-08-26-212735`** — the directory name that
  keeps two chats from colliding, shown as an identity. It reads
  `chat · Aug 26, 21:27` now, and a migration renames the ones already stored.
- **"Stuck in a loop … open" landed on the session's default view.** For a loop
  three hours old that is the wrong end of a long list. It opens the timeline
  at the moment the repetition started.

## [0.29.0] - 2026-08-26

### Added

- **Share from anywhere.** A `share` control in the header, on every screen,
  offering the week, the month or all time. Where the browser supports it the
  image goes straight to the operating system's share sheet; where it does
  not, the card is saved and the post opens with the text already written —
  because a browser cannot attach a picture to a tweet, and a button that
  appears to post and does not is worse than one that says so. The card
  carries `caprock.dev`, so the link travels with the image.
- **Paid features are shown where they will live, locked.** The daily spend
  cap occupies its real place on the Cost screen, behind glass, with your own
  figures under it and one click to paying. Inert and marked: a preview that
  responds to a click is a preview that lies.
- **The paid version is mentioned on Now.** It was deliberately kept to Cost
  and Lifetime to avoid interrupting anyone at work, which meant a user with
  no loop and no runaway session never learned a paid version exists at all.

### Fixed

- **The ALL TIME panel was visibly slower than everything around it.**
  `GET /v1/history?range=all` took 0.76–1.17s against 0.15s for the rest of
  the screen, and `ToolDistribution` was 60% of it: the index it matched
  carries `(kind, ts)` but not `tool`, so ~80k rows were read from the table
  for one column. A covering index makes the same plan covering — 139 ms to
  46 ms warm, and the cold figure was 1780 ms, which is what a person actually
  waits through. Migration `0016`.

### Site

- **The landing page can be installed from.** Its final call to action offered
  `caprock up` — the command you run *after* installing — so a reader who
  scrolled the whole page to decide yes was handed the one instruction that
  does nothing on a machine without Caprock on it. It now carries the real
  install, defaulting to the visitor's platform.
- **The terminal has a strip of its own.** It is the reason the first
  full-time user could drop the Claude Code IDE, and the page had never
  mentioned it.
- **The teams page is three sections instead of ten**: what you get, where it
  runs (your VPC — counters leave a machine, content never does), book the
  call.

## [0.28.0] - 2026-08-26

Most of this came from one user, who replaced his Claude Code IDE with Caprock
and then said what was wrong with it. The rest was found while fixing what he
reported.

### Added

- **Quick chat.** A session with no repository: click and start asking. The
  spawn dialog demanded an absolute path before it would do anything, which is
  the right question for work and a wall in front of "look this up for me".
  Caprock makes a directory per chat under `<data_dir>/chats/`. One per chat,
  not one shared folder — Claude Code keys a transcript by working directory,
  so a shared one would collapse every conversation into a single project row
  with a single transcript.
- **`create` on `POST /v1/agents`,** and a checkbox for it in the spawn dialog:
  starting a new project no longer means leaving the dashboard to make the
  folder in a terminal. Opt-in, one level deep, under a parent that already
  exists — a typo in an absolute path fails loudly instead of materialising a
  chain of directories somewhere you have never been.
- **Plan-limit alerts.** A warning at 90% of a 5-hour or 7-day window, high
  severity from 95%, with the reset time. Not at 85%, where the Cost screen
  turns amber: an alert that fires wherever a colour changes is one people
  learn to scroll past. A window whose reset clock cannot be believed raises
  nothing, because an alert built on a stale reading would never clear.
- **A share offer on a rhythm** — weekly and monthly, drawing the same card
  over those periods. It previously went loud only at a money milestone, so
  anyone whose spend never lands on a round number was never actually asked.
  The offer says what the image contains before anyone clicks: totals only, no
  project names, no paths, no prose, saved locally, uploaded nowhere.
- **The paid version is mentioned in the dashboard,** for the first time: a
  line on Cost and Lifetime that opens with what a day costs on this machine,
  and a note beside a loop or a session that spent a lot for nothing. Clicking
  either opens a dialog about that feature, with the price and both a way to
  read more and a way to subscribe. Never on Now, never over your work, never
  on an empty dashboard, and dismissible for a month.
- **`GET /v1/premium`** — what the plan costs, served by the daemon so no price
  is hardcoded in the UI. It ships in the binary either way (rule 4 forbids
  fetching it), but it lives once in Go, and a test reads the site's pricing
  file and fails when the two disagree.

### Fixed

- **The terminal rendered every glyph in the fallback font.** xterm.js paints
  to a canvas and was handed the literal string `var(--font-mono)`, which a
  canvas context cannot resolve — invisible in Latin, unreadable in Cyrillic.
  Two more defects in the same place: the character cell was measured against
  the fallback and never re-measured, and no subset was ever fetched, because
  subsets load when a matching character enters the DOM and canvas text never
  does. All six subsets JetBrains Mono ships are now requested by name.
- **One directory counted as two projects.** Claude Code records `repo_root`
  only when it resolves a checkout, so a session started where git could not
  answer got its own row — labelled with its full filesystem path, since a
  label is derived from the path when there is no project name.
- **Plan limits were on a screen nobody looks at for them,** and the panel
  vanished entirely when there was no data, so the one place that could have
  explained the absence showed nothing. They are now also a line on Now, and
  the panel says where the data comes from when it has none.
- **The control that starts a session** sat at the bottom of Now in 11px grey,
  beside a checkbox and a timestamp. It is at the top, at the size of an
  action.
- **Screenshots leaked the machine's directory layout.** The scrubber renamed
  projects but not the directories above them, and the Cost screen prefixes
  parent segments when two checkouts share a basename.

## [0.27.4] - 2026-08-26

### Fixed

- **Hooks never fired on Windows.** Claude Code runs command hooks through
  bash, which reads each backslash as an escape, so
  `C:\Users\…\caprock-hook.exe` reached the shell as
  `C:Users…caprock-hook.exe` and every hook failed. The dashboard still filled
  from transcript tailing, so nothing looked broken — the only symptom was a
  "command not found" line in a Stop hook.

  Paths are now written with forward slashes, which Windows accepts everywhere
  and bash leaves alone, **and** quoted, because a path can still contain a
  space (`C:/Program Files/…`, and the macOS data dir). Either fix alone is
  insufficient: quoting a backslash path leaves it one unquoting away from
  breaking again, and forward slashes alone still split on a space.

  Found by two users on the same day, one of whose agents diagnosed it and
  applied the forward-slash fix by hand before this shipped.

  Two more defects came out of the same thread. **`statusLine.command` had the
  identical bug** and was broken on the same machines, through a second copy of
  the same quoting logic — now one shared function, since two copies is how one
  gets fixed and the other does not. And **an entry written on Windows was not
  recognised as ours when read anywhere else**: the base-name check used the
  host's path separator, so a backslash registration looked like a stranger's
  to a non-Windows reader. Both separators are understood now, on every
  platform, which is also why an upgrade does not report a working install as
  missing or overwrite a line a user repaired by hand.

## [0.27.3] - 2026-08-26

### Fixed

- **Half of the Windows hook fix**, superseded by 0.27.4 an hour later. It
  quoted the shim path, which stops a space splitting the command but leaves
  backslashes to be eaten by the shell — so hooks still failed on Windows.
  Upgrade past it.

## [0.27.2] - 2026-08-26

### Changed

- **The lifetime breakdown is its own panel, between the activity feed and the
  session rows.** It spent two releases in the wrong place: hidden inside the
  all-time line nobody found it, and opening it there pushed Today and the live
  pulse below the fold. Both were the wrong position rather than the wrong
  default — these are lifetime figures, not something to check between glances
  at the pulse, so they sit below the live panels where the screen has room and
  nothing competes with them. The all-time line is one row again.

## [0.27.1] - 2026-08-26

### Fixed

- **The tool and model breakdown was hidden behind something that did not look
  like a control** — a toggle styled like the muted caption beside it, same
  size, same colour, no border, so it read as text and went unfound.

## [0.27.0] - 2026-08-26

### Added

- **The tool and model breakdowns open on Now.** The all-time line offered them
  behind a link to another screen, which is a strange thing to do with data
  already in the response that drew the line. Most-used tools by calls and
  where the money went by cost, expanded in place; the Lifetime screen keeps
  the full tables. Closed by default, since the total is the point of the line
  and this screen is mostly live panels.
- **A spend cap is offered beside the figure that argues for it.** Someone
  reading their own lifetime total is, at that moment, the person most likely
  to want a limit on it. It stays a link at the weight of the one next to it —
  a dashboard is not a checkout, and the price lives on the page it points at.

### Changed

- **Sessions are full-width rows rather than tiles.** Three to a viewport made
  a session's own figures reference material, small enough that you read the
  project name and moved on. A session is the unit this screen is about, so
  each one now gets the width and its numbers come up to the size of the ones
  in Today.

## [0.26.0] - 2026-08-25

### Added

- **The all-time total, on the screen you keep open.** A hundred and twenty-nine
  sessions across fifty-eight days at ten thousand dollars of usage is the
  figure people repeat, and it lived two clicks away — so someone who opens the
  dashboard daily could go weeks without meeting it. It now rides above Today
  as one line: the total, the three figures that make it mean something, and a
  link to the rest. Deliberately a summary rather than the screen copied
  upward; the tool table and the model mix are a screen's worth of reading and
  stay on their own.
- **What the money went on, without leaving Now.** "Which repository" and "what
  kind of work" are two halves of one question, and the second half only
  existed on the Cost screen. The projects panel now carries both, on the range
  already chosen there and from the summary it already fetches — no second
  request, one control for both answers. It renders nothing when the linkage
  behind it is too thin to mean anything: on a `today` range most tool calls
  have not yet been attached to the turn that paid for them, so a bar drawn
  from that would describe a gap in the data rather than the work.

### Changed

- **The `History` tab is now `Lifetime`.** It promised a log and held a total —
  the panel inside it already called itself Lifetime, and the tab now says the
  same. Renamed in the docs and in the screen name feedback issues carry.
- **Every screenshot recaptured**, showing the calendar view, the header's
  active-tab pill, the plan-value tiles and the work-mix strip — a day of work
  none of the published images had.

### Fixed

- **A machine with one busy session and one idle one wasted a screen of
  space.** Each state opened its own three-column grid, so "Active · 1" took a
  row and left two thirds of it empty, then "Idle · 1" did the same below. The
  cards now flow through a single grid with each run's label above its first
  card; grouping reads the same and stops reserving a row per group.
- **The screenshot anonymiser was written and never called.** Every published
  image had been anonymised by hand instead — which happened to work, and would
  have stopped working the first time someone forgot. It now runs before the
  capture and a failure aborts it. It also rewrites the activity feed's text,
  which the path rewriting never touched: the feed prints whatever the sessions
  actually did, and on a working machine that is client material. Only five
  fields reach the screen (`internal/narrate`), so those are replaced and the
  rest of the payload is left alone.

## [0.25.1] - 2026-08-25

### Fixed

- **The header said nothing about which screen you were on.** The active tab
  was a `bg-panel-2` tint against the header's own `bg-panel` — a few percent
  of lightness apart — with its label one step of grey brighter than the rest,
  so on open there was nothing to read. It is now the filled accent pill the
  agent filter already uses: a solid block of colour is recognised before any
  text is. The other labels move up to full strength from the muted grey the
  whole row had been sitting in.
- **A colour class on a link was silently ignored.** `a { color: … }` carries
  the same specificity as a `text-*` utility and was declared after them, so it
  won on order — the first attempt at the tab above rendered amber text on an
  amber pill, and the same trap waited for any link anyone tried to colour. The
  default is now at zero specificity, so a class always takes over.
- **The feedback dialog asked three questions before you could type one.**
  "Something is broken / missing / unclear" put three sentences in front of the
  box, and at a glance the buttons were near-identical because the
  distinguishing word came last in each. One word each now — `bug`, `feature`,
  `unclear`, `other` — with the catch-all there so nobody stalls deciding which
  of three a thought belongs to.
- **"One sentence is enough" was set in the same faint grey as the fine print
  below it**, so the line that decides whether anyone writes anything at all
  read as a footnote. The note under it now says the same thing in one line
  instead of three.
- **The footer's premium link was unreadable and unclear.** "what should paid
  add?" was too quiet to see and said nothing about where it led; it reads
  `premium` now, at a weight that leaves the team line as the only offer on the
  row.

### Added

- **An install prompt for the agent you already have open.** Everyone
  installing Caprock has Claude Code running in a terminal, and pasting eleven
  lines is less work than deciding whether you have Homebrew and what Windows
  does instead. Not a second install method — underneath it is still brew,
  scoop or a release binary. It names its sources rather than saying "install
  caprock", since an unrelated package of the same name sits on PyPI, and it
  says `caprock up --yes`: consent for the hook is refused rather than assumed
  when stdin is not a terminal, which is what an agent's shell provides, so
  without the flag the install completes and the dashboard never sees a
  session. In the README, on the site, and in `/install.md`.

## [0.25.0] - 2026-08-25

### Added

- **The month reads as a calendar.** A week per row, one square per day, shade
  carrying cost — so the rhythm of how you actually work is visible without
  reading a figure. Thirty bars in a row answer "how much on the 14th" and hide
  "I do not work Sundays". Shades are cut on a square-root scale, because a few
  heavy days set the maximum and linear buckets would leave every ordinary day
  in the palest step, making a busy month look empty. The bars remain, one
  click away, for when the amounts are the question.
- **The daily bars have a scale.** They are normalised to the tallest day, so
  without a labelled line a bar's height meant nothing and a $20 day could not
  be read against a $200 one. Two or three rules, rounded to a 1/2/5×10ⁿ step:
  a line labelled `$237.83` measures one particular day rather than serving as
  a ruler for the rest.

### Fixed

- **The live pulse was empty after a daemon restart, while agents were
  working.** Stopping the daemon ends every live session, and `ended` was
  permanent — the session row kept it whatever arrived afterwards — so a
  working agent stayed marked ended until it happened to start a new session.
  Anyone upgrading Caprock hit this, on the one screen whose entire job is
  showing what is happening right now. `ended` is now sticky only against
  events no newer than the one already stored, which keeps a finished
  session's transcript from resurrecting it while treating a session that is
  still emitting as what it is.
- **The plan-value panel wasted most of its width and buried its own
  headline.** Two columns on a full-width panel left two thirds of the row
  empty, and the multiple — the figure the panel exists to deliver — was set
  as a word inside a sentence at body-text size. Three tiles now read left to
  right as their own sentence: you pay this, the same work costs that, which
  is this many times over.
- **A model's snapshot date broke the column it sat in.**
  `claude-haiku-4-5-20251001` was the only name that wrapped to a second line;
  the trailing date is now elided to `…` with the full id on the row's
  tooltip, where someone reconciling against an invoice can still read it.
- **Tile captions sat at different heights across a row.** One caption
  wrapping to two lines dragged its neighbours off the shared baseline, so
  they read as text stuck to the underside of a number rather than as a row.
- **Spend from a filtered-out session appeared under the other agent.** The
  projects list has an "orphan" row for spend whose session was deleted; under
  a filter, excluded sessions looked deleted, so that row collected the other
  agent's money and showed it unlabelled.
- **Submissions could be lost silently.** Both `/api/waitlist` and
  `/api/feedback` fired their notification and never read the response: a
  missing chat id, a network error and a 403 from a revoked token were all
  indistinguishable from success. Team leads now record the failure onto the
  stored record; feedback, which has no store behind it, returns 502 so the
  form can offer the email address instead of thanking someone for a message
  nobody received.
- **The activity feed told OpenCode users to start `claude`** when it was empty
  under an OpenCode filter.


## [0.21.0] - 2026-08-25

### Added

- **An agent switch on the Now screen.** `all / claude / opencode`, in the
  middle of the Today header, on a machine that runs both. It applies to the
  whole screen — today's totals, the live pulse, the activity feed, the
  projects list and the session cards — because a filtered list beside an
  unfiltered total is how a reader ends up quoting a number that means
  something other than what the heading says. Totals filter server-side via
  `GET /v1/stats/summary?agent=`; an unrecognised value is a 400 rather than
  everything. Rows from the second agent carry a small `oc` mark.
- **`caprock status` reports the OpenCode reader.** A machine running both
  shows those sessions mixed together, so "no OpenCode sessions yet" and
  "OpenCode is not being read at all" looked identical — and someone who
  upgraded for the feature had no way to confirm it was working.

### Fixed

- **Per-directory cost was silently empty for OpenCode sessions.** `touch_dir`
  is derived from the event payload by the store rather than trusted from the
  caller, so that no writer can supply a hand-made value; the OpenCode ingester
  emitted its own field names and every tool call was stored unplaced. The
  payload is now shaped like a Claude Code hook payload, which also makes
  work-kind classification and narration work unchanged.
- **Caprock's pricing table was applied to unpriced OpenCode turns.** The
  suppression relied on a cost already being present, so a turn OpenCode had
  not yet priced acquired a figure from different arithmetic — one column
  holding two costing methods, with nothing on screen to say which produced a
  given row. No event sourced from OpenCode is priced by Caprock now.

### Added

- **Caprock now watches OpenCode sessions too, on the same screens.** A machine
  that runs both agents had its spend split across two tools that each saw half
  of it; sessions from either now share one stream, tagged with which agent
  produced them, and project cost sums across both. OpenCode keeps its own
  SQLite database with cost, tokens, directory and model already computed, so
  the import needs no shim, no settings file to modify and no transcript
  parsing — and its cost is carried across rather than recomputed, because two
  arithmetics over the same tokens would disagree about one session's total.
  The database is polled every five seconds and opened read-only; events are
  keyed on OpenCode's own identifiers, so re-reading a session stores nothing.
  Verified against a real installation: 70 sessions, 19,236 events and $156.28,
  matching the source exactly. Live streaming and session control are not built
  (`.ai/16-opencode.md`).

## [0.20.1] - 2026-08-24

### Fixed

- **The Projects panel grouped by directory, not by repository.** The label was the basename of the session's cwd, so one repository showed up as several rows (`caprock` and `ui`), a subdirectory posed as a project (`app` under `amarketer`), Caprock's own agent worktrees became projects (`worker-1`), and two unrelated paths ending in the same segment were silently summed into one row — on the owner's own database, two different `testrepo`s and two different `repo`s. A row is now the repository a session's cwd belongs to, resolved by walking up for `.git` (following a linked worktree to the repository that owns it) once per directory at ingest, and stored on the session so historical rows keep a stable label even after their directory is deleted. Existing databases are backfilled on first open.
- **The live pulse's cost tiers were indistinguishable in the light theme.** The bar colours were hardcoded rgba lifted from the dark palette, so on a white panel `around it` and `well above it` composited to a contrast ratio of **1.05** — the same orange to any eye — and the legend named a distinction a light-theme viewer could not see. Every bar was also nearly invisible there (1.46–1.68 against the panel), and the idle hairline sat at 1.13. The tiers now resolve through the design tokens the rest of the dashboard already uses, each with its own alpha, so each theme supplies its own hue: on dark the tiers climb in brightness, on light they climb in depth, because light's `--color-accent-strong` is darker than `--color-accent` rather than lighter. Measured from the rendered canvas in both themes, the worst adjacent-tier separation is now **1.93 in light** (from 1.05) and 1.59 in dark, with every tier above 1.9 against its panel. The dark theme keeps its palette and its reading order.
- **A theme switch left the pulse painted in the old theme's colours.** The canvas repaints on data change and on resize, and the colours are read from the stylesheet at paint time, so flipping the theme recoloured every panel except the one whose colours had just changed — until its next event arrived. It now repaints on the theme attribute too.
- **The pulse legend could drift from the bars it explains.** The swatches were a second hardcoded copy of the tier colours, and had already drifted: the idle chip was drawn at alpha 0.35 while the canvas drew the hairline at 0.16. Both now come from one definition, so the key cannot say something the chart does not do.

### Added

- **`caprock report` prints your measured usage in a form you can publish.** The figures behind the launch numbers were hard-coded constants read on one day, which is the one failure mode a page premised on honest numbers cannot survive: they go stale silently, and nothing says so out loud. The command re-reads the same measures from the same capture — total at API list prices, the plan multiple, turns, sessions, projects, the cache hit rate and what the cache cut, the date window with its active-day count, the top projects and models, and the pricing-table version — so a published figure can be regenerated rather than remembered. Three shapes: a block for a post, `--markdown` for a README or anywhere that renders markdown, and `--json` shaped to regenerate the site's facts block. It reads the running daemon over the existing GET endpoints and issues no writes; with the daemon down it says so rather than opening the database behind its back with a second copy of the aggregation SQL.
- **The report carries its caveat inline, on every shape.** The number is large and has a dollar sign, and shown without a qualifier it reads as an amount owed — the same misreading `CostBasis` was built for on the dashboard. The wording is the dashboard's own rather than new phrasing, so the CLI, the dashboard and the site say the same thing: on a flat plan it is what the same work would have cost through the API, *not a bill, not a discount received, and not money back*; on metered billing it is approximately the actual cost and never a saving; with no plan stated nothing is claimed at all. The caveat is the second line rather than a footnote, so quoting the headline visibly cuts something off.
- **The multiple is refused rather than guessed when there is no fee to divide by.** A flat plan with no monthly price stated has no denominator, and the report says so instead of printing a number. It is also computed against the plan fee **prorated to the measured window** — the same arithmetic `PlanValue` uses — and prints that fee alongside it, so the division can be checked rather than taken on trust. Comparing a five-week window against a single month's fee would have understated it by a quarter.
- **The report carries the raw token counts the cache percentages are computed from** — cache-read against fresh input, one line in the human output, their own fields in `--json`, their own rows in `--markdown`. On the owner's data that is fifteen billion tokens read from cache against a hundred and twenty-eight thousand fresh, which is the concrete half of the cache story: "99% cache hit" is an abstraction, the two counts side by side are a picture a reader who does not think in percentages can hold. They are published as counts and nothing else — no ratio between them is derived anywhere, because the two percentages already state what the cache did and a second derived number would leave a reader working out which one is the real claim. The caveat is unchanged: this adds detail, not a claim.
- **The prorated plan fee prints with cents.** It is the denominator of the multiple beside it, and the whole reason it is printed is that the arithmetic should check out on sight — but `$233` rounded from `$233.33` made a reader's own division come out at 41.6 against a printed 41.5. Cents cost two characters; a footnote explaining the rounding would have been more noise than the rounding it explained.
- **A new or nearly-empty database produces an honest sentence, not a wall of zeroes.** Day one has no window to describe and nothing to divide, so the report says nothing has been recorded yet and stops. Figures that cannot be measured are absent from `--json` rather than sent as `0`, because a consumer cannot otherwise tell a real zero from a missing value — a 0% cache hit rate reads as a broken cache, not as an absence of data.
- **The task runner can be turned on from the dashboard, without restarting the daemon** (`POST /v1/hive`). The Tasks screen's off state used to hand over `caprock up --hive ~/caprock-tasks` to paste into a terminal, which meant the one control the feature needed did not exist in the product. The button opens and seeds the queue directory, starts the board and wires the orchestrator on the running process, and the board replaces the off state in place. It confirms first — naming the queue directory and the repository, and saying that Caprock will be able to spawn Claude sessions with permission prompts skipped — because a silent one-click that begins spawning agents is not something a local-first tool should ship. `GET /v1/status` now carries `suggested_hive` and `suggested_repo` while the runner is off, so the confirmation names real paths rather than a placeholder.
- **The empty task board says which button comes first.** Six empty columns and two buttons do not, and starting the orchestrator over an empty board does nothing. The line appears only while there is no task at all.
- **Each project row expands to a per-directory breakdown** — what `ui` cost of `caprock`'s total — because "which part of the monorepo is burning the budget" is the question a per-repo number raises and cannot answer on its own. A repository whose work happened in a single directory has no breakdown, since it would restate the row's own total.
- **The breakdown is charged by which files Claude touched, not by where a session was started.** In a monorepo you open the repository root and let Claude edit across `/services/api` and `/services/web`; you do not start a separate session in each. Grouping by the session's directory therefore answered "where was the terminal" — and on a real database only one repository expanded at all. Every repository now expands, with rows like `/services/api` and `/internal/store`.
- **A turn counts toward the directory of the most recent file it touched, and work keeps counting there until it touches a file somewhere else.** Work happens in stretches: you say "finish /app", and Claude edits a file, runs the tests, reads the output, greps, edits again. That whole stretch is work on `/app`. Reading, editing or writing a file counts as touching it; running a command does not — so the commands, tests and searches between two edits count toward the directory being worked on rather than falling out of the answer. Each turn's cost goes **whole** to one directory, never split between two, so the rows still add up to the repository's own total exactly.
- **Each directory row shows its tokens, its share, and its cost.** The share is of the whole repository, including the two rows that are not directories, so the column adds up to 100% and nothing is hidden in the denominator. Shares round down, and a directory with real but very small spend reads `<0.1%` rather than `0%`.
- **Work whose files live outside the repository gets its own row**, labelled *"outside the repository"* — Claude's notes on the project, agent scratchpads, test-output directories, or another checkout. It is real work on the project and counts toward its total, but it happened outside the tree, so it is not charged to any directory inside it.

### Changed

- **The Tasks off state is three steps and a button, not three paragraphs.** It carries the same three facts that decide whether anyone would run this — the work happens in a separate git worktree, *Caprock* runs the checks rather than the agent, and the queue directory is created new — but as a numbered strip rather than prose, because nobody reads a wall of text to decide whether to try a button.
- **Per-directory attribution was rebuilt after the first rule proved useless in practice.** The original rule charged a directory only when *every* file a turn touched was in it, which was exact and answered almost nothing: on a real 191k-event database it put **87.6%** of one project's $1735 into "repository-wide work". Asking what a service costs and being told "we could not tell you" for seven eighths of the money is not an answer. The rule now carries forward from the last file touched, and the same project reads `/app` **61%** ($2090.67), `/.ai` 6.8%, `/app/tests` 2.8%. Nothing is split or estimated — each turn still goes whole to one row — but the row it goes to is now decided by a stated rule rather than by whether the turn happened to contain a file edit.
- **"Repository-wide work" now means one narrow thing**: the opening turns of a session, before Claude has touched any file. It is usually nothing at all, and the row is omitted entirely when it cost nothing rather than showing a puzzling `$0.00`.

## [0.20.0] - 2026-08-24

### Changed

- Expanding a repository now gives a tree instead of a flat list of full paths. It was 43 rows on a real database with nothing showing that `/ui/src/components` and `/ui/src/lib` both live under `/ui`; it is eight, each opening to what is inside it, three levels deep. Spend below that rolls into the deepest row shown and says so, so the parts still add up to the repository total.
- The two rows that are not directories — work outside the repository, and work that belongs to no single one — read as part of the same table now rather than as italics from somewhere else.

### Fixed

- Clicking a directory row could land you in an unrelated session. The row was never a link: expanding a repository grew the panel past the activity feed beside it, and the click landed there instead. The tree removes the overshoot, and breakdown rows are now explicitly inert.
- Plan value spent the right half of a full-width panel on nothing, and its multiple was aligned to the first line of a two-line sentence so the second dropped below it. Plan limits had no padding and ran into its own border. The feedback dialog was sized like a table of figures rather than a box you type a paragraph into.

## [0.19.0] - 2026-08-23

### Added

- The Cost screen shows what the money was spent on — commands, code edits, reading, MCP tools, or turns that called no tool at all — beside the existing splits by model and by project. `caprock report` carries it too, and withholds it rather than guessing when too many tool calls cannot be linked to the turn that paid for them.

### Fixed

- Tool calls that name no file — Bash above all, the most-used tool there is — were never linked to the turn that paid for them, so their spend was reported as "no tool call". On a real database that meant 86.5% of a month attributed to turns that called nothing, where the true figure is 9.4%. The links are recovered on first run, in the background, and verified against the transcripts rather than guessed; a call whose transcript is gone stays unlinked.

## [0.18.0] - 2026-08-23

### Security

- **A task-runner worker could write files anywhere on your machine.** Mailbox delivery built its destination from a field inside a message file without validating it, so a message addressed to `../../../x` wrote above the queue directory. The author of those files is a Claude session running with permission prompts skipped, so a confused worker reached this with no attacker involved. Validated on both ends now, contained to the queue directory as a second layer, and a refused message is quarantined rather than dropped.
- Task ids reached the filesystem unvalidated, so a hand-written task file could read or write outside the queue directory.

### Fixed

- **`caprock` could destroy commits on your own branches.** Creating a worker's git worktree force-reset a branch of the same name if one already existed. Worker names are predictable and nothing cleaned up after a run, so a second run dropped the first one's commits off the branch tip. It now reattaches to a worktree it already owns and otherwise refuses, naming the branch.
- Granting folder trust rewrote the whole of `~/.claude.json` to set one field, losing its key order and rounding any integer past 2^53. It now preserves the file, records only the grants it made, and `caprock hooks uninstall` revokes them.
- The `settings.json` backup was taken once and never refreshed, and nothing could restore it. It refreshes when the file has genuinely changed, keeps the oldest snapshot plus the newest few, and `caprock hooks restore` exists.
- Retention pruning could have deleted every event if retention were ever set to zero at runtime.

## [0.17.0] - 2026-08-23

### Added

- `caprock report` prints your own measured usage in a form ready to publish: what it would have cost at API list prices, against what your plan costs for the same window, with the caveat inline so it cannot be quoted without it. `--json` and `--markdown` for the other places you would paste it. The plan fee is prorated to the window and printed with cents, so the division is checkable on sight rather than asserted.

### Fixed

- In the light theme the pulse's "around it" and "well above it" tiers rendered at a contrast ratio of 1.05 — the same orange — so the legend explained a distinction a light-theme reader could not see. The tier colours were copied from the dark palette instead of reading theme tokens; the legend swatches were a second copy that had already drifted from the canvas they described.

## [0.16.0] - 2026-08-22

### Security

- **Any page open in your browser could reach the API while the daemon was running.** The cross-site check trusted a request that carried no `Origin` header, and browsers omit it on cross-site simple requests — a form post, or `fetch` with `text/plain`. Behind that check, unauthenticated, sat an endpoint that takes a command from the request body and runs it. The check is now layered — `Sec-Fetch-Site`, `Origin`, `Host`, and a JSON content type or the daemon's token — and a missing `Origin` is never trusted. A second hole found while testing the first: the loopback check matched by prefix, so a hostname like `localhost.evil.example` passed.
- **The database was world-readable.** It holds your prompts and Claude's replies in the clear and was created 0644 while the config beside it was 0600. It and its WAL and SHM siblings are now 0600 on every open. SECURITY.md now says what is stored and how to delete it.

### Fixed

- `caprock up` crashed with a stack trace when `settings.json` held `{"hooks": []}` or `{"hooks": null}` — the first command a new user runs.
- Tokens from a model that is not in the pricing table displayed as `$0.00`, indistinguishable from free. The unpriced volume is now shown, with the models that caused it.
- A fatal ingest failure was logged and swallowed: the daemon reported healthy and the dashboard said "no sessions yet" forever.
- A new install opened on a screen of zeroes whose only coloured element was a cache warning about a cache that had never been used.
- The explanation for a missing `claude` binary was unreachable, the Tasks screen showed "Error: 501 Not Implemented" instead of the server's actual message, and `caprock statusline install` exited silently when it had done nothing.

## [0.15.1] - 2026-08-22

### Added

- The task runner turns on from a button on the Tasks screen — no restart, no command to copy into a terminal. It confirms first, naming the queue directory and the repository, because this is the one feature that spawns Claude sessions with permission prompts skipped.

### Changed

- The Tasks screen explains itself in three steps instead of three paragraphs: you write a task with the commands that have to pass, Caprock runs one session per task in its own git worktree, Caprock runs the commands and only green is done. An empty board now says which button comes first.

## [0.15.0] - 2026-08-22

### Changed

- Orchestration is now presented as what it is: an unattended task runner with a test gate. A task with an assignee shows its branch, and opens to the diff, the checks that passed, and the git command to take the work — none of which the product showed before, which is why the feature was hard to explain. The README documents it, a fresh hive seeds a README and an example task, and `caprock status` says which hive is active.

### Added

- `caprock task create`, and `POST /v1/orchestrator/stop` to stop the orchestrator and every worker at once.

### Fixed

- A task with no `done_criteria` reached `done` without being checked, contradicting the promise on the screen above it. Criteria are now required, and a task without them escalates instead of passing.
- Three ways to spend money unattended with nothing to stop it: the orchestrator had no forced-continue limit, the wake loop had a throttle but no ceiling, and an over-budget task was parked as a file while its process kept running. All three now stop.
- A task whose worktree was missing was verified against the main repository — which is clean, so it passed. Unverifiable is no longer treated as verified, and verification output is kept so a green result can be audited.

## [0.14.2] - 2026-08-22

### Changed

- The Projects panel opens on the last seven days instead of thirty. A project worked on for two days out of thirty drew a sparkline that was almost entirely idle, which reads as no data rather than as a burst of work; a week is dense enough for the shape to mean something.

## [0.14.1] - 2026-08-22

### Changed

- The per-directory breakdown now counts a turn toward the directory of the most recent file it touched, and keeps counting there until work moves elsewhere — so the commands, tests and searches between two edits count toward the directory being worked on. The previous rule counted only turns whose every touch was in one place, which left 87.6% of a repository in a single row and answered nothing. Cost is still never split between directories, and the rows still sum to the repository total exactly. Turns whose work was outside the repository — notes, scratch files, test output — get their own row rather than being dropped.

## [0.14.0] - 2026-08-22

### Added

- Cost and tokens per directory inside a repository, taken from the files each turn touched rather than from where the session was launched — so a monorepo shows what each service costs without anyone having to run Claude from inside it. Every figure is measured: a turn counts toward a directory only when all of its work was there, and turns are never split between directories. Turns that ran commands, searched, or built are counted as repository-wide work, named as such and explained on hover, because dividing them up would be an estimate.

## [0.13.0] - 2026-08-22

### Added

- Each project row carries a sparkline of when its spend happened, bucketed to follow the selected range — 30 days by day, today by hour — so the picture is always consistent with the figure beside it. It replaces the share bar, which restated the ranking the sorted numbers already gave.
- Rows state both tokens and cost legibly. On a subscription the dollar figure is a proxy for consumption rather than a bill, and the second number used to sit in the faint chrome tone reserved for timestamps.

### Fixed

- The breakdown bar inside an expanded repository scaled on the first row, assuming it was the largest. Rows are sorted by cost while the bar measures tokens, so another row could render past its track — reproduced at 900% width.

## [0.12.2] - 2026-08-22

### Added

- Projects are grouped by repository instead of by directory name. Work in `~/dev/caprock/ui` counted as a project called "ui"; two unrelated paths ending in the same directory name merged into one row and summed together, so the figure was wrong rather than merely oddly labelled. Each repository expands to show where inside it the spend went, as paths — `/`, `/app`, `/ui/src`.

### Fixed

- The login agent still throttled the dashboard. 0.12.1 replaced `ProcessType=Background` with `Adaptive`, which measured no better: the process still landed at scheduler priority 4 against a normal 20, and requests still took over a second where the same binary from a terminal took 185ms. Any `ProcessType` puts the job in a managed band, so the key is now omitted entirely. Re-run `caprock service install` to pick up the corrected agent.

## [0.12.1] - 2026-08-22

### Fixed

- The dashboard took over a second to answer every request when the daemon ran as a login service, which made the range switches on Cost and Projects appear to stick: a click highlighted the new range while the numbers stayed on the old one, because the request had not come back before the next refresh overwrote it. The launchd agent declared `ProcessType=Background` with `LowPriorityIO` — correct for a watcher, wrong for a process that also serves a UI, since macOS throttles the I/O of anything it has been told is batch work. The same binary answering the same query measured 1.2s under launchd against 185ms from a terminal; `ProcessType=Adaptive` closes the gap. Re-run `caprock service install` to pick up the corrected agent.

## [0.12.0] - 2026-08-22

### Added

- `caprock service install|uninstall|status` — registers the daemon with the OS's own login supervisor so it survives a reboot: a launchd agent on macOS, a systemd user unit on Linux, a Startup-folder script on Windows. All user-level, nothing written outside your home. The service runs with `--no-hooks`; hook and statusline registration stay interactive consent decisions.
- Budget enforcement on the task board. `budget_usd` was validated, stored and rendered red past the limit while nothing compared cost against it; the reconciler now parks an over-budget task in **needs you** with the reason attached.

### Fixed

- Finished tasks no longer accrue cost forever. The router opened a task's cost window on the session id and verification closed it on the agent id, so the window never closed — and an open window has no upper bound, so a completed task went on absorbing everything that session spent afterwards. A $0.42 task billed $9.42.
- Verification can no longer strand a task. Both the success and failure paths guarded their transitions in a way that could silently no-op, leaving a task nobody could move and the next verify erroring outright.
- The model mix is answered from an index. `idx_events_cost_cover` carries `model` but leads on `kind`, so a range query filtering only on `ts` read the table for every matching row — 146ms against 56ms over 30 days on a 190k-event database. Every `/v1/stats/summary` computes this, and the dashboard asks for one on an interval, so overlapping requests could queue faster than they drained and leave a panel waiting.

### Changed

- The pulse legend names what its colours compare against. The tiers are relative to each session's own median minute, but the labels read "cheap" and "expensive" as though absolute, so a short bar marked expensive looked like a contradiction rather than a quiet minute carrying a lot of context. The hover readout now prints the median beside the minute's own cost.

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
