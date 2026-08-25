# Changelog

All notable changes to Caprock. Format: [Keep a Changelog](https://keepachangelog.com/).
Versions map to the roadmap phases in `.ai/09-execution-plan.md`: **v0.1.0** = Observe,
**v0.2.0** = Control, **v0.3.0** = Orchestrate. **v0.4.x**/**v0.5.0** are post-Orchestrate
polish (plan-limit windows, orchestrator-lifecycle fixes, Homebrew formula, first-run UX).

## [Unreleased]

Phase 3 (Delight) has no plan by design.

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
